// RedGreen server: zero dependencies. `node server.js` then open http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './src/redact.js';
import { runPipeline } from './src/pipeline.js';
import { status as modelStatus, modelConfig } from './src/model.js';
import { sandboxInfo } from './src/sandbox.js';
import { COUPONS } from './fixtures/shop/src/cart.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, 'fixtures', 'shop');
const DATA = process.env.REDGREEN_DATA || path.join(ROOT, 'data');
const REPORTS = path.join(DATA, 'reports');
const RUNS = path.join(DATA, 'runs');
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
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('body too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
const listJson = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).sort((a, b) => (b.savedAt || b.startedAt || '').localeCompare(a.savedAt || a.startedAt || ''));

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
    if (p === '/api/status') return send(res, 200, { model: await modelStatus(), sandbox: sandboxInfo, busy });
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
    if (p === '/api/reports' && req.method === 'GET') return send(res, 200, listJson(REPORTS).map(({ id, description, savedAt, events, redactions, sample, screenshot }) => ({ id, description, savedAt, events: events.length, redactions, sample: !!sample, screenshot: !!screenshot })));
    let m;
    if ((m = p.match(/^\/api\/reports\/([^/]+)$/))) {
      const id = safeId(m[1]); const f = id && path.join(REPORTS, id + '.json');
      return f && fs.existsSync(f) ? send(res, 200, fs.readFileSync(f, 'utf8')) : send(res, 404, { error: 'not found' });
    }
    if (p === '/api/runs' && req.method === 'GET') return send(res, 200, listJson(RUNS).map(({ id, reportId, startedAt, verdict }) => ({ id, reportId, startedAt, verdict })));
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
        const run = await runPipeline({ report, fixtureDir: FIXTURE, emit });
        fs.writeFileSync(path.join(RUNS, run.id + '.json'), JSON.stringify(run, null, 2));
      } catch (e) {
        emit({ type: 'fatal', error: e.message });
      } finally { clearInterval(ping); busy = false; res.end(); }
      return;
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`RedGreen  → http://localhost:${PORT}`);
  console.log(`Demo shop → http://localhost:${PORT}/shop/`);
  console.log(`Model     → ${modelConfig.baseUrl} ${modelConfig.model ? '(' + modelConfig.model + ')' : '(auto-detect Gemma)'}`);
  console.log(`Sandbox   → Node ${sandboxInfo.node}, permission model: ${sandboxInfo.permissionModel}`);
});
