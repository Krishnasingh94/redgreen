// Pipeline robustness against bad model output, using a MOCK OpenAI-compatible server.
// One server per file (model.js reads GEMMA_BASE_URL once at import); each test queues its own answers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HDR = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createCart, addItem, setQuantity, applyCoupon, total } from '../src/cart.js';\n`;
const GOOD_TEST = HDR + `test('discount follows quantity changes', () => { const c = createCart(); addItem(c, { id: 'hp', name: 'H', price: 50 }, 1); setQuantity(c, 'hp', 3); applyCoupon(c, 'SAVE20'); setQuantity(c, 'hp', 1); assert.equal(total(c), 40); });`;
const repro = (test_code, extra = {}) => ({ hypothesis: 'stale discount', evidence_ids: ['e3', 'e4'], expected: '$40.00', actual: '$20.00', test_name: 'discount follows quantity', test_code, ...extra });
const GOOD = repro(GOOD_TEST);
const FIX_EDITS = [
  { find: '  cart.discount = round2(subtotal(cart) * pct);\n', replace: '' },
  { find: '  return round2(Math.max(0, subtotal(cart) - cart.discount));', replace: '  const pct = cart.coupon ? COUPONS[cart.coupon] : 0;\n  cart.discount = round2(subtotal(cart) * pct);\n  return round2(Math.max(0, subtotal(cart) - cart.discount));' },
];
const GOOD_FIX = { root_cause: 'discount cached at apply time', explanation: 'recompute at total time', edits: FIX_EDITS };

let queue = [], mock, runPipeline;
before(async () => {
  mock = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'google/gemma-4-e4b' }] }));
    req.resume(); req.on('end', () => {
      const a = queue.shift();
      if (a === undefined) { res.statusCode = 500; return res.end('{"error":"mock: no more answers queued"}'); }
      res.end(JSON.stringify({ choices: [{ message: { content: typeof a === 'string' ? a : JSON.stringify(a) } }] }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.GEMMA_BASE_URL = `http://127.0.0.1:${mock.address().port}/v1`;
  ({ runPipeline } = await import('../src/pipeline.js?validation'));
});
after(() => mock.close());

const report = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reports/rpt_sample.json'), 'utf8'));
async function run(answers) {
  queue = [...answers];
  const events = [];
  const r = await runPipeline({ report: report(), fixtureDir: path.join(ROOT, 'fixtures/shop'), emit: (e) => events.push(e) });
  // Every emitted proposal must be renderable by the UI (all fields present with the right types).
  for (const e of events.filter((e) => e.proposal)) {
    if (e.type.startsWith('repro')) { assert.equal(typeof e.proposal.test_code, 'string'); assert.ok(Array.isArray(e.proposal.evidence_ids)); for (const k of ['hypothesis', 'expected', 'actual']) assert.equal(typeof e.proposal[k], 'string'); }
    else { assert.equal(typeof e.proposal.root_cause, 'string'); assert.ok(Array.isArray(e.proposal.edits)); }
  }
  assert.equal(events.at(-1).type, 'done');
  return { run: r, events, rejected: events.filter((e) => e.type.endsWith('.rejected')) };
}

test('model returns garbage: non-JSON, wrong types, missing fields → rejected attempts, never crashes', async () => {
  const { run: r, rejected, events } = await run([
    'Sure! Here is your test: it() should work fine.',
    repro(GOOD_TEST, { evidence_ids: 'e3' }),
    { test_code: 42 },
  ]);
  assert.equal(r.verdict, 'not_reproduced');
  assert.equal(events.filter((e) => e.type === 'repro.confirmed').length, 0);
  assert.deepEqual(rejected.map((e) => e.rejection), ['invalid_json', 'invalid_shape', 'invalid_shape']);
  assert.match(rejected[0].reason, /not valid JSON/);
  assert.match(rejected[1].reason, /"evidence_ids" must be an array of strings \(got string\)/);
  assert.match(rejected[2].reason, /"test_code" must be a string \(got number\)/);
  assert.match(rejected[2].reason, /"hypothesis" must be a string \(got missing\)/);
});

test('model returns a test that crashes (syntax error) → rejected as crashed, retry succeeds', async () => {
  const { run: r, rejected } = await run([repro(HDR + `test('x', () => { total( ; });`), GOOD, GOOD_FIX]);
  assert.equal(rejected[0].rejection, 'crashed');
  assert.match(rejected[0].reason, /crashed instead of failing an assertion/);
  assert.equal(rejected[0].result.passed, false);
  assert.equal(r.verdict, 'fixed_verified');
});

test('model returns a patch whose find is not in the file → rejected, retry verified', async () => {
  const { run: r, rejected } = await run([GOOD, { ...GOOD_FIX, edits: [{ find: 'this text is not in cart.js', replace: 'x' }] }, { root_cause: 'x' }, GOOD_FIX]);
  assert.deepEqual(rejected.map((e) => e.rejection), ['patch_not_applicable', 'invalid_shape']);
  assert.match(rejected[0].reason, /"find" text not found in file/);
  assert.match(rejected[1].reason, /"functions" must be a non-empty array/);
  assert.equal(r.verdict, 'fixed_verified');
});

test('model returns a patch that breaks the existing suite → never verified', async () => {
  // Fixes the repro but deletes the invalid-coupon check, so an existing test fails.
  const breaks = { ...GOOD_FIX, edits: [...FIX_EDITS, { find: "  if (pct === undefined) throw new Error('Invalid coupon');\n", replace: '' }] };
  const { run: r, rejected } = await run([GOOD, breaks, breaks, breaks]);
  assert.equal(r.verdict, 'reproduced_not_fixed');
  assert.equal(r.fix, null);
  assert.equal(rejected.length, 3);
  for (const e of rejected) {
    assert.equal(e.rejection, 'broke_suite');
    assert.equal(e.results[0].passed, true, 'repro test passes with this patch');
    assert.equal(e.results[1].passed, false, 'existing suite fails');
  }
  assert.match(r.prMarkdown, /Reproduced, not fixed/);
});

test('model returns an infinite-loop test → killed at timeout, rejected as crashed (not reproduced)', async () => {
  const { sandboxInfo } = await import('../src/sandbox.js');
  const prev = sandboxInfo.timeoutMs; sandboxInfo.timeoutMs = 2000; // keep the test fast
  try {
    const hang = repro(HDR + `test('hang', () => { while (true) {} });`);
    const { run: r, rejected, events } = await run([hang, hang, hang]);
    assert.equal(r.verdict, 'not_reproduced');
    assert.equal(events.filter((e) => e.type === 'repro.confirmed').length, 0);
    assert.equal(rejected.length, 3);
    for (const e of rejected) {
      assert.equal(e.rejection, 'crashed');
      assert.match(e.reason, /crashed instead of failing an assertion \(killed at the 2000ms sandbox timeout: infinite loop or hang\)/);
      assert.equal(e.result.timedOut, true);
      assert.equal(e.result.passed, false);
    }
  } finally { sandboxInfo.timeoutMs = prev; }
});

test('whole-function patches: unknown function / malformed entry rejected, valid rewrite verified', async () => {
  const totalFix = { root_cause: 'stale discount', change: 'recompute discount in total', explanation: '', functions: [{ name: 'total', code: 'export function total(cart) {\n  const pct = cart.coupon ? COUPONS[cart.coupon] : 0;\n  cart.discount = round2(subtotal(cart) * pct);\n  return round2(Math.max(0, subtotal(cart) - cart.discount));\n}' }] };
  const { run: r, rejected } = await run([GOOD, { ...totalFix, functions: [{ name: 'checkout', code: 'export function checkout() { return 1; }' }] }, { ...totalFix, functions: [{ name: 'total' }] }, totalFix]);
  assert.deepEqual(rejected.map((e) => e.rejection), ['patch_not_applicable', 'invalid_shape']);
  assert.match(rejected[0].reason, /"checkout" does not exist/);
  assert.match(rejected[1].reason, /functions\[0\] must be \{"name": string, "code": string\}/);
  assert.equal(r.verdict, 'fixed_verified');
  assert.match(r.patch, /^\+  const pct = cart\.coupon/m);
});

test('model unreachable on every attempt → not_reproduced with an explicit "model unavailable" reason', async () => {
  const { run: r, events } = await run([]); // mock answers HTTP 500 when nothing is queued
  assert.equal(r.verdict, 'not_reproduced');
  assert.equal(events.filter((e) => e.type === 'model.error').length, 3);
  assert.equal(r.modelUnavailable, true);
  const done = events.at(-1);
  assert.equal(done.modelUnavailable, true);
  assert.match(done.reason, /Model unavailable in the reproduce phase .*No test was written or run/);
});

test('a real "not reproduced" (model answered, tests rejected) carries no model-unavailable reason', async () => {
  const weak = repro(HDR + `test('weak', () => { assert.equal(1, 1); });`);
  const { run: r, events } = await run([weak, weak, weak]);
  assert.equal(r.verdict, 'not_reproduced');
  assert.equal(r.modelUnavailable, undefined);
  assert.equal(events.at(-1).reason, undefined);
});
