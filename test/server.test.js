// Server robustness: bad input gets a 4xx (not 500), and corrupt data files don't break list endpoints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let srv, base, data;
before(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-srv-'));
  fs.mkdirSync(path.join(data, 'reports')); fs.mkdirSync(path.join(data, 'runs'));
  fs.copyFileSync(path.join(ROOT, 'data/reports/rpt_sample.json'), path.join(data, 'reports/rpt_sample.json'));
  fs.writeFileSync(path.join(data, 'reports/rpt_broken.json'), '{"id": "rpt_broken", "events": [');   // half-written
  fs.writeFileSync(path.join(data, 'reports/rpt_noevents.json'), '{"id": "rpt_noevents"}');            // wrong shape
  fs.writeFileSync(path.join(data, 'runs/run_ok.json'), JSON.stringify({ id: 'run_ok', reportId: 'rpt_sample', startedAt: new Date().toISOString(), verdict: 'not_reproduced' }));
  fs.writeFileSync(path.join(data, 'runs/run_broken.json'), 'not json');
  const port = 20000 + Math.floor(Math.random() * 20000);
  srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), REDGREEN_DATA: data, GEMMA_BASE_URL: 'http://127.0.0.1:9/v1' }, stdio: 'ignore' });
  base = `http://127.0.0.1:${port}`;
  for (let t = 0; t < 50; t++) { try { await fetch(base + '/api/runs'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
});
after(() => { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); });
const post = (u, body) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

test('invalid JSON body → 400 on reports and checkout', async () => {
  for (const u of ['/api/reports', '/shop/api/checkout']) {
    const r = await post(u, '{oops');
    assert.equal(r.status, 400, u);
    assert.match((await r.json()).error, /invalid JSON/);
  }
});

test('oversized body → 413', async () => {
  const r = await post('/api/reports', JSON.stringify({ schema: 'redgreen.evidence/v1', events: [], pad: 'x'.repeat(8_100_000) })).catch((e) => e);
  // Node may reset the socket after the 413 is written; either way it must not be a 500/201.
  if (r instanceof Error) return;
  assert.equal(r.status, 413);
});

test('corrupt or wrong-shape data files are skipped, lists still work', async () => {
  const reports = await (await fetch(base + '/api/reports')).json();
  assert.deepEqual(reports.map((r) => r.id), ['rpt_sample']);
  const runs = await (await fetch(base + '/api/runs')).json();
  assert.deepEqual(runs.map((r) => r.id), ['run_ok']);
  assert.equal((await fetch(base + '/api/status')).status, 200);
});

test('valid report still saves after bad requests (201 + redactions)', async () => {
  const r = await post('/api/reports', JSON.stringify({ schema: 'redgreen.evidence/v1', description: 'mail me at a@b.com', events: [] }));
  assert.equal(r.status, 201);
  const { id, redactions } = await r.json();
  assert.ok(redactions >= 1);
  assert.doesNotMatch(fs.readFileSync(path.join(data, 'reports', id + '.json'), 'utf8'), /a@b\.com/);
});
