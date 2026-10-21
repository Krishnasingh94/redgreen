// Website mode: serve a cloned site, look at it in a real browser, and run browser steps as DATA (never code).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { npmCli } from './github.js';
import { ENV } from './repo.js';

// Browser steps come from the model, which read untrusted issue text. They may only act on the site under test:
// no file: URLs, no other origins, and no other services on this machine (RedGreen's own API, LM Studio...).
const LOCALISH = (h) => /^(localhost|127(?:\.\d+){3}|\[::1\]|::1|0\.0\.0\.0)$/i.test(h) || /\.localhost$/i.test(h);
export function stepTarget(value, baseUrl) {
  const v = String(value ?? '/').trim() || '/';
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^https?:/i.test(v)) return null; // file:, javascript:, data: ...
  let u, b; try { b = new URL(baseUrl); u = new URL(v, b); } catch { return null; }
  return u.origin === b.origin ? u.href : null;
}
// Static check (the site's port isn't known yet): a path, or an absolute http(s) URL on this machine.
function gotoLooksLocal(value) {
  const v = String(value ?? '/').trim() || '/';
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^https?:/i.test(v)) return false;
  if (/^\/\//.test(v)) return false;
  if (!/^https?:/i.test(v)) return true;
  try { return LOCALISH(new URL(v).hostname); } catch { return false; }
}
export function allowedRequest(url, baseUrl) {
  let u, b; try { u = new URL(url); b = new URL(baseUrl); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return false;
  if (u.origin === b.origin || (u.host === b.host)) return true;
  return !LOCALISH(u.hostname); // public CDNs etc. are fine; other local services are not
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain' };
const BUILD_TOOLS = ['vite', 'webpack', 'parcel', 'next', 'react-scripts', '@angular/cli', 'nuxt', '@sveltejs/kit', 'astro', 'gatsby', 'svelte', 'vue'];

export function detectSite(dir) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const built = BUILD_TOOLS.some((d) => deps[d]);
  const staticRoot = ['', 'public', 'docs', 'site', 'www', 'src', 'dist'].find((r) => fs.existsSync(path.join(dir, r, 'index.html')));
  if (staticRoot !== undefined && !built) return { kind: 'static', root: staticRoot };
  const script = pkg?.scripts?.dev ? 'dev' : pkg?.scripts?.start ? 'start' : null;
  if (pkg && script) return { kind: 'dev', script, root: staticRoot ?? '' };
  if (staticRoot !== undefined) return { kind: 'static', root: staticRoot };
  return null;
}

export function serveStatic(root) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const p = path.normalize(path.join(root, rel));
      if (!p.startsWith(path.normalize(root)) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() }));
  });
}

// Stop the whole process tree: `npm run dev` starts the real server as a child, and killing only npm leaves
// that server running in the background after every run.
export function killTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else {
      // npm may start the script in its own process group, so walk the process list for all descendants.
      const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout || '';
      const kids = new Map();
      for (const line of ps.trim().split('\n')) { const [pid, ppid] = line.trim().split(/\s+/).map(Number); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
      const all = [], stack = [child.pid];
      while (stack.length) { const p = stack.pop(); all.push(p); stack.push(...(kids.get(p) || [])); }
      for (const p of all.reverse()) { try { process.kill(p, 'SIGKILL'); } catch {} }
    }
  } catch { try { child.kill('SIGKILL'); } catch {} }
}

export function startDevServer(dir, script, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const port = 4100 + Math.floor(Math.random() * 800);
    // The repo's dev server is untrusted code: give it the same minimal environment as its tests (no tokens).
    const child = spawn(process.execPath, [npmCli(), 'run', script, '--', '--port', String(port)], { cwd: dir, env: { ...ENV(), NODE_ENV: 'development', PORT: String(port), BROWSER: 'none', CI: '1' }, shell: false, windowsHide: true });
    let out = '', done = false;
    const finish = (err, url) => { if (done) return; done = true; clearTimeout(t); err ? (killTree(child), reject(err)) : resolve({ url, close: () => killTree(child) }); };
    const onData = (d) => { out += d.toString(); const m = out.replace(/\x1b\[[0-9;]*m/g, '').match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+\/?/); if (m) finish(null, m[0].replace('[::1]', '127.0.0.1').replace(/\/?$/, '/')); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (c) => finish(new Error(`dev server exited (${c}): ${out.slice(-400)}`)));
    const t = setTimeout(() => finish(new Error('dev server did not print a local URL within 90s')), timeoutMs);
  });
}

let pw = null;
export async function launchBrowser() {
  pw ??= await import('playwright-core').catch(() => null);
  if (!pw) throw new Error('Website mode needs playwright-core: run "npm install" in the RedGreen folder.');
  const tries = [process.env.CHROME_PATH && { executablePath: process.env.CHROME_PATH }, { channel: 'chrome' }, { channel: 'msedge' }, {}, fs.existsSync('/opt/pw-browsers/chromium') && { executablePath: '/opt/pw-browsers/chromium' }].filter(Boolean);
  let last;
  for (const opt of tries) { try { return await pw.chromium.launch({ headless: true, ...opt }); } catch (e) { last = e; } }
  throw new Error('No Chrome or Edge found for website mode. Install Chrome or set CHROME_PATH. ' + (last?.message || '').split('\n')[0]);
}

// What the model sees about the page: a screenshot + a compact outline of visible, meaningful elements.
export async function snapshotPage(browser, url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(400);
  const shot = 'data:image/jpeg;base64,' + (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64');
  const outline = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('h1,h2,h3,button,a,input,select,textarea,label,[id],[role=button],[data-testid]')) {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
      const tag = el.tagName.toLowerCase();
      const bits = [tag + (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '')];
      for (const a of ['type', 'name', 'placeholder', 'aria-label', 'data-testid', 'value']) if (el.getAttribute(a)) bits.push(`${a}="${el.getAttribute(a).slice(0, 40)}"`);
      const txt = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60); if (txt && !['input', 'select', 'textarea'].includes(tag)) bits.push(`"${txt}"`);
      out.push(bits.join(' ')); if (out.length >= 70) break;
    }
    return out.join('\n');
  });
  await page.close();
  return { screenshot: shot, outline, errors };
}

export const STEP_ACTIONS = ['goto', 'click', 'fill', 'select', 'press', 'wait', 'expect_text', 'expect_value', 'expect_visible', 'expect_hidden', 'expect_count', 'expect_no_errors'];

export function validateSteps(steps) {
  const p = [];
  if (!Array.isArray(steps) || !steps.length) return ['steps must be a non-empty array'];
  if (steps.length > 25) p.push('too many steps (max 25)');
  steps.forEach((s, i) => {
    if (!STEP_ACTIONS.includes(s?.action)) p.push(`step ${i + 1}: unknown action "${s?.action}" (allowed: ${STEP_ACTIONS.join(', ')})`);
    if (['click', 'fill', 'select', 'expect_visible', 'expect_hidden', 'expect_count', 'expect_value'].includes(s?.action) && !s.target) p.push(`step ${i + 1}: "${s.action}" needs a target`);
    if (s?.action === 'goto' && !gotoLooksLocal(s.value)) p.push(`step ${i + 1}: goto must stay on the site (use a path like "/")`);
  });
  if (!steps.some((s) => String(s?.action).startsWith('expect'))) p.push('there must be at least one expect_* step that checks the correct behaviour');
  return p;
}

function locate(page, target) {
  const t = String(target).trim();
  if (/^(css=|xpath=)/.test(t)) return page.locator(t);
  const TAGS = /^(button|input|select|textarea|a|h[1-6]|p|span|div|li|ul|ol|table|tr|td|th|form|label|img|nav|main|header|footer|section|article|dialog|strong|em|code)$/;
  if (/^[#.\[]/.test(t) || /^[a-z][a-z0-9-]*[#.\[:]/.test(t) || TAGS.test(t) || /^[\w#.\[\]="'-]+\s*[>~+]\s*[\w#.\[]/.test(t)) return page.locator(t).first();
  return page.getByRole('button', { name: t }).or(page.getByRole('link', { name: t })).or(page.getByLabel(t)).or(page.getByPlaceholder(t)).or(page.getByText(t)).first();
}

// Execute steps deterministically. Action failures mean the TEST is broken; expect_* failures mean the SITE is.
export async function runSteps(browser, baseUrl, steps, { stepTimeout = 4000 } = {}) {
  const t0 = Date.now();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  // Network guard: the page (and the steps) can't reach local files or other services on this machine.
  await page.route('**/*', (route) => (allowedRequest(route.request().url(), baseUrl) ? route.continue() : route.abort('blockedbyclient')));
  const errors = [], log = [];
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  let assertionFailure = null, broken = null;
  try {
    if (steps[0]?.action !== 'goto') await page.goto(baseUrl, { waitUntil: 'load', timeout: 20000 });
    for (const [i, s] of steps.entries()) {
      const label = `${i + 1}. ${s.action}${s.target ? ` "${s.target}"` : ''}${s.value ? ` ${JSON.stringify(s.value)}` : ''}`;
      try {
        switch (s.action) {
          case 'goto': { const to = stepTarget(s.value, baseUrl); if (!to) throw new Error(`goto ${JSON.stringify(s.value)} leaves the site under test`); await page.goto(to, { waitUntil: 'load', timeout: 20000 }); break; }
          case 'click': await locate(page, s.target).click({ timeout: stepTimeout }); break;
          case 'fill': await locate(page, s.target).fill(String(s.value ?? ''), { timeout: stepTimeout }); await locate(page, s.target).dispatchEvent('change').catch(() => {}); break;
          case 'select': await locate(page, s.target).selectOption(String(s.value), { timeout: stepTimeout }); break;
          case 'press': await page.keyboard.press(String(s.value || 'Enter')); break;
          case 'wait': await page.waitForTimeout(Math.min(Number(s.value) || 300, 3000)); break;
          default: {
            const loc = s.target ? locate(page, s.target) : page.locator('body');
            let ok = false, got = '';
            const deadline = Date.now() + stepTimeout;
            while (Date.now() < deadline) {
              if (s.action === 'expect_text') { got = (await loc.innerText({ timeout: 1000 }).catch(() => '')).replace(/\s+/g, ' ').trim(); ok = got.includes(String(s.value)); }
              else if (s.action === 'expect_value') { got = await loc.inputValue({ timeout: 1000 }).catch(() => ''); ok = got === String(s.value); }
              else if (s.action === 'expect_visible') { ok = await loc.isVisible().catch(() => false); got = ok ? 'visible' : 'not visible'; }
              else if (s.action === 'expect_hidden') { ok = !(await loc.isVisible().catch(() => false)); got = ok ? 'hidden' : 'visible'; }
              else if (s.action === 'expect_count') { const n = await page.locator(s.target).count().catch(() => -1); got = String(n); ok = n === Number(s.value); }
              else if (s.action === 'expect_no_errors') { ok = errors.length === 0; got = errors.join(' | ').slice(0, 300) || 'no errors'; }
              if (ok) break;
              await page.waitForTimeout(150);
            }
            if (!ok) {
              const want = s.action === 'expect_text' ? `text containing ${JSON.stringify(s.value)}` : s.action === 'expect_no_errors' ? 'no page errors' : s.action === 'expect_count' ? `${s.value} elements` : s.action === 'expect_value' ? JSON.stringify(s.value) : s.action.replace('expect_', '');
              assertionFailure = { step: i + 1, expected: want, actual: s.action === 'expect_text' ? JSON.stringify(got.slice(0, 160)) : got };
              log.push(`✗ ${label}\n    expected: ${want}\n    actual:   ${assertionFailure.actual}`);
              throw Object.assign(new Error('assert'), { assert: true });
            }
          }
        }
        log.push(`✓ ${label}`);
      } catch (e) {
        if (e.assert) break;
        broken = `step ${i + 1} (${s.action}) could not run: ${String(e.message).split('\n')[0].slice(0, 200)}`;
        log.push(`! ${label}\n    ${broken}`);
        break;
      }
    }
  } catch (e) { broken = 'page failed to load: ' + String(e.message).split('\n')[0]; log.push('! ' + broken); }
  // Crop the screenshot to the area of the last checked element, so the before/after is readable.
  let clip;
  const lastExpect = [...steps].reverse().find((st) => String(st.action).startsWith('expect') && st.target);
  if (lastExpect) {
    const box = await locate(page, lastExpect.target).boundingBox({ timeout: 1000 }).catch(() => null);
    if (box) { const w = 640, h = 400; const x = Math.max(0, Math.min(1280 - w, box.x + box.width / 2 - w / 2)), y = Math.max(0, Math.min(800 - h, box.y + box.height / 2 - h / 2)); clip = { x, y, width: w, height: h }; }
  }
  const screenshot = 'data:image/jpeg;base64,' + (await page.screenshot({ type: 'jpeg', quality: 70, ...(clip ? { clip } : {}) }).catch(() => Buffer.from(''))).toString('base64');
  await page.close();
  const passed = !assertionFailure && !broken;
  if (errors.length) log.push(`page errors: ${errors.slice(0, 3).join(' | ').slice(0, 300)}`);
  return { file: 'browser steps', passed, pass: passed ? 1 : 0, fail: passed ? 0 : 1, exitCode: passed ? 0 : 1, durationMs: Date.now() - t0, output: log.join('\n'), assertionFailure, broken, screenshot };
}
