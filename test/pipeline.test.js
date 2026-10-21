// End-to-end pipeline against a MOCK OpenAI-compatible server (no real model needed).
// Verifies the gate logic: a test that passes on buggy code is rejected; a real repro is accepted; the fix is verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEAK = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createCart, addItem, total } from '../src/cart.js';\ntest('weak', () => { const c = createCart(); addItem(c, { id: 'hp', name: 'H', price: 50 }, 1); assert.equal(total(c), 50); });`;
const GOOD = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createCart, addItem, setQuantity, applyCoupon, total } from '../src/cart.js';\ntest('discount follows quantity changes', () => { const c = createCart(); addItem(c, { id: 'hp', name: 'H', price: 50 }, 1); setQuantity(c, 'hp', 3); applyCoupon(c, 'SAVE20'); setQuantity(c, 'hp', 1); assert.equal(total(c), 40); });`;
const answers = [
  { hypothesis: 'weak', evidence_ids: ['e1'], expected: '50', actual: '50', test_name: 'weak', test_code: WEAK },
  { hypothesis: 'Discount is a fixed amount computed when the coupon is applied, so it goes stale when quantity changes.', evidence_ids: ['e3', 'e4', 'e5'], expected: '$40.00', actual: '$20.00', test_name: 'discount follows quantity changes', test_code: GOOD },
  { root_cause: 'discount cached at apply time', explanation: 'compute from coupon at total time', edits: [
    { find: '  cart.discount = round2(subtotal(cart) * pct);\n', replace: '' },
    { find: '  return round2(Math.max(0, subtotal(cart) - cart.discount));', replace: '  const pct = cart.coupon ? COUPONS[cart.coupon] : 0;\n  cart.discount = round2(subtotal(cart) * pct);\n  return round2(Math.max(0, subtotal(cart) - cart.discount));' },
  ] },
];

test('pipeline: rejects non-reproducing test, confirms repro, verifies fix', async () => {
  let i = 0;
  const mock = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'google/gemma-4-e4b' }] }));
    req.resume(); req.on('end', () => res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answers[i++]) } }], usage: { completion_tokens: 100 } })));
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.GEMMA_BASE_URL = `http://127.0.0.1:${mock.address().port}/v1`;
  const { runPipeline } = await import('../src/pipeline.js?' + Date.now());
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/rpt_sample.json'), 'utf8'));
  const run = await runPipeline({ report, fixtureDir: path.join(ROOT, 'fixtures/shop') });
  mock.close();
  const types = run.steps.map((s) => s.type);
  assert.equal(run.steps.find((s) => s.type === 'baseline').result.passed, true);
  assert.ok(types.includes('repro.rejected'), 'weak test must be rejected');
  assert.ok(types.includes('repro.confirmed'));
  assert.equal(run.verdict, 'fixed_verified', JSON.stringify(run.steps.filter((s) => s.reason), null, 1));
  assert.match(run.prMarkdown, /Verified/);
});
