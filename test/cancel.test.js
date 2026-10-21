// A run whose browser disconnects is cancelled at the next checkpoint, so the single run slot frees up
// (no lingering 409 "a run is already in progress") and the server keeps working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('client disconnect cancels the run; next run starts immediately; nothing half-saved', async () => {
  let modelCalls = 0;
  // Slow model that always returns a passing (non-reproducing) test, so an uncancelled run would take 3 × 1.5 s+.
  const weak = { hypothesis: 'h', evidence_ids: ['e1'], expected: '1', actual: '1', test_name: 't', test_code: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createCart } from '../src/cart.js';\ntest('t', () => { assert.ok(createCart()); });" };
  const mock = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'google/gemma-4-e4b' }] }));
    req.resume(); req.on('end', () => { modelCalls++; setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(weak) } }] })), 1500); });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-cancel-'));
  fs.mkdirSync(path.join(data, 'reports'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data/reports/rpt_sample.json'), path.join(data, 'reports/rpt_sample.json'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), REDGREEN_DATA: data, GEMMA_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1` }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let t = 0; t < 50; t++) { try { await fetch(base + '/api/runs'); break; } catch { await sleep(100); } }
    // start a run, read the first event, then disconnect
    const ac = new AbortController();
    const r = await fetch(base + '/api/analyze/rpt_sample', { signal: ac.signal });
    assert.equal(r.status, 200);
    const reader = r.body.getReader(); await reader.read();
    ac.abort();
    // the slot frees within one model call (≈1.5 s), far sooner than a full 3-attempt run
    let freed = false;
    for (let t = 0; t < 40 && !freed; t++) { await sleep(150); freed = (await (await fetch(base + '/api/status')).json()).busy === false; }
    assert.ok(freed, 'run slot was not freed after the client disconnected');
    assert.ok(modelCalls <= 2, `run kept calling the model after cancel (${modelCalls} calls)`);
    assert.deepEqual(await (await fetch(base + '/api/runs')).json(), [], 'a cancelled run must not be saved as a result');
    // and a new run can start right away
    const again = await fetch(base + '/api/analyze/rpt_sample');
    assert.equal(again.status, 200);
    await again.body.cancel();
    assert.equal((await fetch(base + '/api/status')).status, 200, 'server still healthy');
  } finally { srv.kill(); mock.close(); fs.rmSync(data, { recursive: true, force: true }); }
});
