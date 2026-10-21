// eval script: exits non-zero when the model is offline; with a (mock) model, counts come from real runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const runEval = (args, env) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts/eval.js'), ...args], { env: { ...process.env, ...env } });
  let out = ''; p.stdout.on('data', (d) => out += d); p.stderr.on('data', (d) => out += d);
  p.on('close', (code) => resolve({ code, out }));
});

test('eval exits with an error when the model is offline, and writes nothing', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-eval-'));
  const { code, out } = await runEval(['1'], { GEMMA_BASE_URL: 'http://127.0.0.1:9/v1', GEMMA_MODEL: '', REDGREEN_DATA: data });
  assert.equal(code, 1);
  assert.match(out, /Model offline/);
  assert.equal(fs.existsSync(path.join(data, 'eval')), false);
  fs.rmSync(data, { recursive: true, force: true });
});

test('eval counts reproduced/verified from actual runs (mock model: 1 fixed, 1 not reproduced)', async () => {
  const GOOD = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createCart, addItem, setQuantity, applyCoupon, total } from '../src/cart.js';\ntest('t', () => { const c = createCart(); addItem(c, { id: 'hp', name: 'H', price: 50 }, 1); setQuantity(c, 'hp', 3); applyCoupon(c, 'SAVE20'); setQuantity(c, 'hp', 1); assert.equal(total(c), 40); });`;
  const r = (test_code) => ({ hypothesis: 'h', evidence_ids: ['e4'], expected: '40', actual: '20', test_name: 't', test_code });
  const fix = { root_cause: 'stale', explanation: '', edits: [
    { find: '  cart.discount = round2(subtotal(cart) * pct);\n', replace: '' },
    { find: '  return round2(Math.max(0, subtotal(cart) - cart.discount));', replace: '  const pct = cart.coupon ? COUPONS[cart.coupon] : 0;\n  cart.discount = round2(subtotal(cart) * pct);\n  return round2(Math.max(0, subtotal(cart) - cart.discount));' }] };
  const queue = [r(GOOD), fix, 'garbage', 'garbage', 'garbage'];
  const mock = http.createServer((req, res) => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'google/gemma-4-e4b' }] }));
    req.resume(); req.on('end', () => { const a = queue.shift(); res.end(JSON.stringify({ choices: [{ message: { content: typeof a === 'string' ? a : JSON.stringify(a) } }] })); });
  });
  await new Promise((ok) => mock.listen(0, '127.0.0.1', ok));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-eval-'));
  try {
    const { code, out } = await runEval(['2'], { GEMMA_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1`, GEMMA_MODEL: '', REDGREEN_DATA: data });
    assert.equal(code, 0, out);
    assert.match(out, /Reproduced\s+: 1\/2/); assert.match(out, /Verified fixed : 1\/2/);
    const [f] = fs.readdirSync(path.join(data, 'eval'));
    assert.match(f, /^eval-\d{4}-\d\d-\d\dT[\d-]+Z\.json$/);
    const { summary, runs } = JSON.parse(fs.readFileSync(path.join(data, 'eval', f), 'utf8'));
    assert.equal(summary.model, 'google/gemma-4-e4b');
    assert.deepEqual([summary.reproduced, summary.verified], [1, 1]);
    assert.deepEqual(summary.attemptsUsed, { reproduce: 4, fix: 1, maxPerPhase: 3 });
    assert.deepEqual(runs.map((x) => x.verdict), ['fixed_verified', 'not_reproduced']);
    assert.equal(runs[1].phasesS.fix, null);
    assert.equal(summary.avgSecondsPerPhase.fix.n, 1);
  } finally { mock.close(); fs.rmSync(data, { recursive: true, force: true }); }
});
