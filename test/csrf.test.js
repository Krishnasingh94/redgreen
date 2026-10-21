// The local API must refuse requests driven by other websites (CSRF) or arriving under a foreign Host
// (DNS rebinding), while RedGreen's own pages and plain scripts keep working.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let srv, port, data;
before(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-csrf-'));
  port = 20000 + Math.floor(Math.random() * 20000);
  srv = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--allow-repo-code'], { env: { ...process.env, PORT: String(port), REDGREEN_DATA: data, GEMMA_BASE_URL: 'http://127.0.0.1:9/v1' }, stdio: 'ignore' });
  for (let t = 0; t < 60; t++) { try { await fetch(`http://127.0.0.1:${port}/api/runs`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });

// raw request so we control Host / Origin / Sec-Fetch-* exactly like a browser would send them
const req = (method, p, headers = {}, body = '') => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `localhost:${port}`, ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  r.on('error', reject); r.end(body);
});
const evil = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };

test('cross-site form POST cannot plant a bot token, add repos, change settings or load issues', async () => {
  const body = JSON.stringify({ token: 'ghp_attacker', url: 'https://github.com/attacker/evil/issues/1', repo: 'attacker/evil', tryFix: true });
  for (const p of ['/api/bot/token', '/api/bot/repos', '/api/bot/settings', '/api/bot/app', '/api/issues', '/api/reports']) {
    const r = await req('POST', p, { ...evil, 'content-type': 'text/plain' }, body);
    assert.equal(r.status, 403, `${p} → ${r.status} ${r.body}`);
    assert.match(r.body, /cross-site/);
  }
  assert.equal(fs.existsSync(path.join(data, 'bot-config.json')), false, 'nothing written');
});

test('cross-site GET (e.g. <img src>) cannot start a run; Origin-only browsers are covered too', async () => {
  assert.equal((await req('GET', '/api/analyze/rpt_sample', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await req('GET', '/api/analyze/rpt_sample', { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await req('POST', '/api/bot/token', { origin: 'http://evil.example', 'content-type': 'text/plain' }, '{}')).status, 403);
  assert.equal((await req('POST', '/api/bot/token', { origin: 'null', 'content-type': 'text/plain' }, '{}')).status, 403);
});

test('DNS rebinding: a foreign Host header is refused', async () => {
  assert.equal((await req('GET', '/api/status', { host: `attacker.example:${port}` })).status, 403);
  assert.equal((await req('GET', '/api/status', { host: `127.0.0.1:${port}` })).status, 200);
  assert.equal((await req('GET', '/api/status', { host: `[::1]:${port}` })).status, 200);
});

test('RedGreen\'s own pages (same-origin) and plain scripts still work; GitHub\'s manifest redirect is not blocked by the guard', async () => {
  const same = { origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin' };
  assert.equal((await req('GET', '/api/status', same)).status, 200);
  const r = await req('POST', '/api/reports', { ...same, 'content-type': 'application/json' }, JSON.stringify({ schema: 'redgreen.evidence/v1', events: [] }));
  assert.equal(r.status, 201, r.body);
  assert.equal((await req('GET', '/api/runs')).status, 200, 'no Origin / Sec-Fetch headers (scripts) → allowed');
  const m = await req('GET', '/api/bot/manifest?code=x&state=wrong', { 'sec-fetch-site': 'cross-site' });
  assert.notEqual(m.status, 403, 'manifest callback is handled by its own state check');
  assert.equal((await req('GET', '/', { 'sec-fetch-site': 'cross-site' })).status, 200, 'pages (not API) are not affected');
});
