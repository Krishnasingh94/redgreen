// RedGreen server: zero dependencies. `node server.js` then open http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './src/redact.js';
import { runPipeline } from './src/pipeline.js';
import { runRepoPipeline } from './src/repoPipeline.js';
import { parseIssueUrl, fetchIssue } from './src/github.js';
import { status as modelStatus, modelConfig } from './src/model.js';
import { sandboxInfo } from './src/sandbox.js';
import { COUPONS } from './fixtures/shop/src/cart.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, 'fixtures', 'shop');
const DATA = process.env.REDGREEN_DATA || path.join(ROOT, 'data');
const REPORTS = path.join(DATA, 'reports');
const RUNS = path.join(DATA, 'runs');
const REPOS = path.join(DATA, 'repos');
// GitHub mode runs a cloned repo's own code (its `npm test`, its runner, and Gemma's patch to it) on this machine.
// Only node:test repro tests can run under the permission model; everything else is outside the sandbox.
// So it is OFF unless explicitly enabled for repos you trust.
const REPO_CODE_ALLOWED = process.env.REDGREEN_ALLOW_REPO_CODE === '1';
const REPO_MODE_OFF = 'GitHub mode is off: it runs the repository\'s own code and tests on this machine, outside the RedGreen sandbox. Only enable it for repos you trust: restart with REDGREEN_ALLOW_REPO_CODE=1.';
fs.mkdirSync(REPORTS, { recursive: true }); fs.mkdirSync(RUNS, { recursive: true });
const PORT = Number(process.env.PORT || 3000);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2', '.diff': 'text/x-diff; charset=utf-8' };

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const safeId = (s) => /^[a-z0-9_]{3,40}$/i.test(s) ? s : null;
function serveFile(res, base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (!p.startsWith(base + path.sep) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return send(res, 404, { error: 'not found' });
  send(res, 200, fs.readFileSync(p), TYPES[path.extname(p)] || 'application/octet-stream');
}
async function readBody(req, limit = 8_000_000) {
  let size = 0; const chunks = [];
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  for await (const c of req) { size += c.length; if (size > limit) throw fail(413, `body too large (max ${limit} bytes)`); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw fail(400, 'invalid JSON body'); }
}
// One corrupt or half-written file must not take down the whole list: skip it (and log once).
const skipped = new Set();
const readJsonSafe = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (!skipped.has(f)) { skipped.add(f); console.warn(`[redgreen] skipping unreadable ${path.basename(f)}: ${e.message}`); } return null; } };
const listJson = (dir, valid) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJsonSafe(path.join(dir, f))).filter((o) => o && typeof o === 'object' && valid(o)).sort((a, b) => (b.savedAt || b.startedAt || '').localeCompare(a.savedAt || a.startedAt || ''));

let busy = false;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    // ---- RedGreen UI
    if (p === '/' || p === '/index.html') return serveFile(res, path.join(ROOT, 'ui'), 'index.html');
    if (p.startsWith('/ui/')) return serveFile(res, path.join(ROOT, 'ui'), p.slice(4));

    // ---- Demo shop (the app under test)
    if (p === '/shop' || p === '/shop/') return serveFile(res, path.join(FIXTURE, 'public'), 'index.html');
    if (p.startsWith('/shop/src/')) return serveFile(res, path.join(FIXTURE, 'src'), p.slice(10));
    if (p.startsWith('/shop/public/')) return serveFile(res, path.join(FIXTURE, 'public'), p.slice(13));
    if (p === '/shop/api/checkout' && req.method === 'POST') {
      // Server-side price check (independent of the client cart module)
      const b = await readBody(req);
      const sub = (b.items || []).reduce((s, it) => s + it.price * it.qty, 0);
      const expected = Math.round((sub - sub * (COUPONS[b.coupon] ?? 0)) * 100) / 100;
      if (Math.abs(expected - b.clientTotal) > 0.009) return send(res, 422, { error: `Total mismatch: client sent $${Number(b.clientTotal).toFixed(2)}, server computed $${expected.toFixed(2)}` });
      return send(res, 200, { ok: true, charged: expected });
    }

    // ---- API
    if (p === '/api/status') return send(res, 200, { model: await modelStatus(), sandbox: sandboxInfo, busy, githubMode: { enabled: REPO_CODE_ALLOWED, isolation: 'node:test repro tests run under the permission model; the repo\'s own suite and other runners run unsandboxed (temp clone, timeout, minimal env, install scripts disabled)' } });
    if (p === '/api/reports' && req.method === 'POST') {
      const raw = await readBody(req);
      if (raw.schema !== 'redgreen.evidence/v1' || !Array.isArray(raw.events)) return send(res, 400, { error: 'invalid evidence bundle' });
      // Screenshot is user-approved and kept local; it is excluded from text redaction (regexes would corrupt base64).
      const screenshot = typeof raw.screenshot === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw.screenshot) ? raw.screenshot : null;
      delete raw.screenshot;
      const { value, count } = redact(raw);
      if (screenshot) value.screenshot = screenshot;
      const id = 'rpt_' + Date.now().toString(36);
      const rec = { ...value, id, redactions: count, savedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(REPORTS, id + '.json'), JSON.stringify(rec, null, 2));
      return send(res, 201, { id, redactions: count });
    }
    if (p === '/api/issues' && req.method === 'POST') {
      // GitHub mode: store the issue as a case; cloning/installing happens when the run starts (streamed live).
      if (!REPO_CODE_ALLOWED) return send(res, 403, { error: REPO_MODE_OFF });
      const { url } = await readBody(req, 10000);
      let ref; try { ref = parseIssueUrl(url); } catch (e) { return send(res, 400, { error: e.message }); }
      let fetched; try { fetched = await fetchIssue(ref); } catch (e) { return send(res, 502, { error: e.message }); }
      // Issue text is untrusted user content: redact it before it is stored or sent to the model.
      const { value: issue, count: issueRedactions } = redact(fetched);
      const id = 'gh_' + Date.now().toString(36);
      const rec = { schema: 'redgreen.issue/v1', kind: 'github', id, description: issue.title, issue, repo: ref, events: [], redactions: issueRedactions, savedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(REPORTS, id + '.json'), JSON.stringify(rec, null, 2));
      return send(res, 201, { id, title: issue.title });
    }
    if (p === '/api/reports' && req.method === 'GET') return send(res, 200, listJson(REPORTS, (r) => typeof r.id === 'string' && Array.isArray(r.events)).map(({ id, description, savedAt, events, redactions, sample, screenshot, kind, repo }) => ({ id, description, savedAt, events: events.length, redactions, sample: !!sample, screenshot: !!screenshot, kind: kind || 'report', repo: repo ? `${repo.owner}/${repo.repo}#${repo.number}` : undefined })));
    let m;
    if ((m = p.match(/^\/api\/reports\/([^/]+)$/))) {
      const id = safeId(m[1]); const f = id && path.join(REPORTS, id + '.json');
      return f && fs.existsSync(f) ? send(res, 200, fs.readFileSync(f, 'utf8')) : send(res, 404, { error: 'not found' });
    }
    if (p === '/api/runs' && req.method === 'GET') return send(res, 200, listJson(RUNS, (r) => typeof r.id === 'string' && typeof r.verdict === 'string').map(({ id, reportId, startedAt, verdict, reason }) => ({ id, reportId, startedAt, verdict, ...(reason ? { reason } : {}) })));
    if ((m = p.match(/^\/api\/runs\/([^/]+)\/patch\.diff$/))) {
      // Verified unified diff + repro test as a new file, for `git apply` from the repo root. Verified runs only.
      const id = safeId(m[1]); const f = id && path.join(RUNS, id + '.json');
      const run = f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
      if (!run || run.verdict !== 'fixed_verified' || !run.patch) return send(res, 404, { error: run ? 'no verified patch for this run' : 'not found' });
      res.writeHead(200, { 'Content-Type': 'text/x-diff; charset=utf-8', 'Content-Disposition': `attachment; filename="redgreen-${run.id}.patch"`, 'Cache-Control': 'no-store' });
      return res.end(run.patch);
    }
    if ((m = p.match(/^\/api\/runs\/([^/]+)(\/pr\.md)?$/))) {
      const id = safeId(m[1]); const f = id && path.join(RUNS, id + '.json');
      if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      if (m[2]) return send(res, 200, JSON.parse(fs.readFileSync(f, 'utf8')).prMarkdown || '# No verified result', 'text/markdown; charset=utf-8');
      return send(res, 200, fs.readFileSync(f, 'utf8'));
    }
    if ((m = p.match(/^\/api\/analyze\/([^/]+)$/))) {
      // Server-Sent Events stream of pipeline steps
      const id = safeId(m[1]); const f = id && path.join(REPORTS, id + '.json');
      if (!f || !fs.existsSync(f)) return send(res, 404, { error: 'report not found' });
      if (busy) return send(res, 409, { error: 'a run is already in progress' });
      busy = true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const emit = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      const ping = setInterval(() => res.write(': ping\n\n'), 10000);
      try {
        const report = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (report.kind === 'github' && !REPO_CODE_ALLOWED) { emit({ type: 'fatal', error: REPO_MODE_OFF }); return; }
        const run = report.kind === 'github'
          ? await runRepoPipeline({ kase: report, reposDir: REPOS, emit })
          : await runPipeline({ report, fixtureDir: FIXTURE, emit });
        fs.writeFileSync(path.join(RUNS, run.id + '.json'), JSON.stringify(run, null, 2));
      } catch (e) {
        emit({ type: 'fatal', error: e.message });
      } finally { clearInterval(ping); busy = false; res.end(); }
      return;
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    // 413: the rest of the upload is still unread, so close the connection instead of reusing it.
    if (e.status === 413) res.setHeader('Connection', 'close');
    if (!res.headersSent) send(res, e.status || 500, { error: e.message }); else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RedGreen  → http://localhost:${PORT}`);
  console.log(`Demo shop → http://localhost:${PORT}/shop/`);
  console.log(`Model     → ${modelConfig.baseUrl} ${modelConfig.model ? '(' + modelConfig.model + ')' : '(auto-detect Gemma)'}`);
  console.log(`Sandbox   → Node ${sandboxInfo.node}, permission model: ${sandboxInfo.permissionModel}`);
});
