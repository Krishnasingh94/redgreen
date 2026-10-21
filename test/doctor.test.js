// npm run doctor: honest pre-demo checks. Exit 0 only when the core demo can run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const doctor = (env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts/doctor.js'), '--quick'], { env: { ...process.env, GEMMA_MODEL: '', PORT: '1', ...env } });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});
async function withModels(ids, fn) {
  const srv = http.createServer((req, res) => res.end(JSON.stringify({ data: ids.map((id) => ({ id })) })));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}/v1`); } finally { srv.close(); }
}

test('doctor: LM Studio offline → exit 1 with the fix, and no duplicate model line', async () => {
  const { code, out } = await doctor({ GEMMA_BASE_URL: 'http://127.0.0.1:9/v1' });
  assert.equal(code, 1);
  assert.match(out, /✗ LM Studio reachable[\s\S]*→ Open LM Studio → Developer tab → Start Server/);
  assert.doesNotMatch(out, /Gemma model loaded/);
});

test('doctor: server up but no Gemma loaded → exit 1, says what to load', async () => {
  await withModels(['qwen2.5-7b-instruct'], async (url) => {
    const { code, out } = await doctor({ GEMMA_BASE_URL: url });
    assert.equal(code, 1);
    assert.match(out, /✓ LM Studio reachable/);
    assert.match(out, /✗ Gemma model loaded[\s\S]*Gemma 4 E4B/);
  });
});

test('doctor: Gemma 4 loaded locally → ready (exit 0)', async () => {
  await withModels(['google/gemma-4-e4b'], async (url) => {
    const { code, out } = await doctor({ GEMMA_BASE_URL: url });
    assert.equal(code, 0, out);
    assert.match(out, /✓ Gemma model loaded\s+google\/gemma-4-e4b/);
    assert.match(out, /✓ Model is Gemma 4/);
    assert.match(out, /✓ Model endpoint is local/);
    assert.match(out, /✅ Ready for the demo/);
  });
});
