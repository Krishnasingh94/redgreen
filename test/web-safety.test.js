// Website mode + GitHub App setup safety: model-written browser steps stay on the site under test, the cloned
// repo's dev server gets no secrets, and the app-manifest callback needs the one-time state from this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stepTarget, allowedRequest, validateSteps, startDevServer } from '../src/web.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://127.0.0.1:4123/';

test('goto steps cannot leave the site (prefix tricks, other schemes, other local services)', () => {
  for (const ok of ['/', '/cart?x=1', '#top', 'checkout', 'http://127.0.0.1:4123/p']) assert.ok(stepTarget(ok, BASE), ok);
  for (const bad of ['http://localhost:3000/api/reports', 'http://localhost:1234/v1/models', 'http://localhost.evil.com/', 'http://localhost@evil.com/', '//evil.com/x', 'https://evil.com', 'file:///C:/Users/me/.ssh/id_rsa', 'javascript:alert(1)', 'data:text/html,x']) {
    assert.equal(stepTarget(bad, BASE), null, bad);
  }
  const step = (value) => validateSteps([{ action: 'goto', value }, { action: 'expect_visible', target: 'body' }]);
  for (const bad of ['http://localhost@evil.com/', 'http://localhost.evil.com/', '//evil.com', 'file:///etc/passwd', 'javascript:1']) assert.equal(step(bad).length, 1, bad);
  assert.deepEqual(step('/cart'), []);
});

test('the page itself cannot reach local files or other services on this machine', () => {
  assert.equal(allowedRequest('http://127.0.0.1:4123/app.js', BASE), true);
  assert.equal(allowedRequest('https://cdn.jsdelivr.net/npm/x.js', BASE), true);
  assert.equal(allowedRequest('data:image/png;base64,AA', BASE), true);
  for (const bad of ['file:///C:/Windows/win.ini', 'http://localhost:3000/api/bot', 'http://127.0.0.1:1234/v1/models', 'http://127.0.0.2:4123/', 'http://[::1]:3000/', 'http://0.0.0.0:3000/', 'http://admin.localhost/']) assert.equal(allowedRequest(bad, BASE), false, bad);
});

test('the cloned repo\'s dev server does not get our GITHUB_TOKEN or other secrets', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-dev-'));
  const prev = process.env.GITHUB_TOKEN; process.env.GITHUB_TOKEN = 'ghp_SECRET_FROM_PARENT'; process.env.REDGREEN_APP_KEY_FILE = '/secret/app.pem';
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'site', scripts: { dev: 'node dev.js' } }));
    fs.writeFileSync(path.join(dir, 'dev.js'), "require('fs').writeFileSync('env-seen.json', JSON.stringify({ token: process.env.GITHUB_TOKEN || null, key: process.env.REDGREEN_APP_KEY_FILE || null, port: process.env.PORT, pid: process.pid })); console.log('ready on http://localhost:' + process.env.PORT + '/'); setInterval(() => {}, 1000);");
    const srv = await startDevServer(dir, 'dev', 30000);
    try {
      const seen = JSON.parse(fs.readFileSync(path.join(dir, 'env-seen.json'), 'utf8'));
      assert.equal(seen.token, null, 'GITHUB_TOKEN leaked to the repo\'s dev server');
      assert.equal(seen.key, null, 'app key path leaked to the repo\'s dev server');
      assert.match(String(seen.port), /^\d+$/);
      assert.match(srv.url, /^http:\/\/localhost:\d+\/$/);
    } finally { srv.close(); }
    // the dev server's own process (a child of npm) must be gone too, not left running in the background
    const seen2 = JSON.parse(fs.readFileSync(path.join(dir, 'env-seen.json'), 'utf8'));
    // dead = gone, or a zombie waiting to be reaped (no init in some containers); poll up to 3 s
    const running = (pid) => { try { process.kill(pid, 0); } catch { return false; } if (process.platform === 'win32') return true; const st = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim(); return st !== '' && !st.startsWith('Z'); };
    let alive = true; for (let i = 0; i < 30 && alive; i++) { alive = running(seen2.pid); if (alive) await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(alive, false, `dev server process ${seen2.pid} still running after close()`);
  } finally { if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev; delete process.env.REDGREEN_APP_KEY_FILE; await new Promise((r) => setTimeout(r, 200)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GitHub App manifest callback: no state, wrong state or a reused state never installs an app', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-man-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--allow-repo-code'], { env: { ...process.env, PORT: String(port), REDGREEN_DATA: data, GEMMA_BASE_URL: 'http://127.0.0.1:9/v1' }, stdio: 'ignore' });
  const get = (p, headers = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, headers: { host: `localhost:${port}`, ...headers } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body: b })); }); r.on('error', reject); r.end(); });
  try {
    for (let t = 0; t < 60; t++) { try { await get('/api/runs'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const before = await get('/api/bot/manifest?code=ATTACKER_CODE', { 'sec-fetch-site': 'cross-site' });   // the old null === null hole
    assert.equal(before.status, 302); assert.equal(before.location, '/#bot-error');
    const form = JSON.parse((await get('/api/bot/manifest-form')).body);
    const state = new URL(form.action).searchParams.get('state');
    assert.match(state, /^[0-9a-f]{48}$/, 'state is 24 random bytes');
    assert.equal((await get('/api/bot/manifest?code=x&state=' + 'f'.repeat(48))).location, '/#bot-error', 'wrong state');
    assert.equal((await get(`/api/bot/manifest?code=x&state=${state}`)).location, '/#bot-error', 'state was consumed by the failed attempt above (one-time)');
    assert.equal(fs.existsSync(path.join(data, 'bot-config.json')), false, 'nothing was installed');
  } finally { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); }
});
