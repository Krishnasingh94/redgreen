// Second planted bug (scenario 2): applying an invalid coupon silently drops the coupon already applied,
// while the stale discount stays on screen, so checkout fails. Proves it is real, missed by the existing
// suite, independent of bug 1, and fixable — all runs go through the sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace, removeWorkspace, runTestFile } from '../src/sandbox.js';
import { applyEdits } from '../src/guard.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'shop');
const SOURCE = fs.readFileSync(path.join(FIXTURE, 'src/cart.js'), 'utf8');
const HDR = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createCart, addItem, setQuantity, applyCoupon, total } from '../src/cart.js';\n`;
const COUPON_REPRO = HDR + `test('invalid coupon keeps the coupon already applied', () => { const c = createCart(); addItem(c, { id: 'hp', name: 'H', price: 50 }, 1); applyCoupon(c, 'SAVE20'); assert.throws(() => applyCoupon(c, 'SAVE50'), /Invalid coupon/); assert.equal(c.coupon, 'SAVE20'); assert.equal(total(c), 40); });`;
const QTY_REPRO = HDR + `test('discount follows quantity changes', () => { const c = createCart(); addItem(c, { id: 'hp', name: 'H', price: 50 }, 1); setQuantity(c, 'hp', 3); applyCoupon(c, 'SAVE20'); setQuantity(c, 'hp', 1); assert.equal(total(c), 40); });`;
const FIX_QTY = [
  { find: '  cart.discount = round2(subtotal(cart) * pct);\n', replace: '' },
  { find: '  return round2(Math.max(0, subtotal(cart) - cart.discount));', replace: '  const pct = cart.coupon ? COUPONS[cart.coupon] : 0;\n  cart.discount = round2(subtotal(cart) * pct);\n  return round2(Math.max(0, subtotal(cart) - cart.discount));' },
];
const FIX_COUPON = [{ find: '  cart.coupon = COUPONS[code] !== undefined ? code : null;\n', replace: '' }, { find: "  if (pct === undefined) throw new Error('Invalid coupon');\n", replace: "  if (pct === undefined) throw new Error('Invalid coupon');\n  cart.coupon = code;\n" }];

async function runAll(source) {
  const ws = createWorkspace(FIXTURE);
  fs.writeFileSync(path.join(ws, 'src/cart.js'), source);
  fs.writeFileSync(path.join(ws, 'test/coupon.test.js'), COUPON_REPRO);
  fs.writeFileSync(path.join(ws, 'test/qty.test.js'), QTY_REPRO);
  const [existing, coupon, qty] = [await runTestFile(ws, 'test/cart.test.js'), await runTestFile(ws, 'test/coupon.test.js'), await runTestFile(ws, 'test/qty.test.js')];
  removeWorkspace(ws);
  return { existing, coupon, qty };
}

test('scenario 2 is missed by the existing suite and reproduces with an assertion failure', async () => {
  const r = await runAll(SOURCE);
  assert.equal(r.existing.passed, true, r.existing.output);
  assert.equal(r.existing.pass, 5);
  assert.equal(r.coupon.passed, false); assert.equal(r.coupon.assertionFailure, true, r.coupon.output);
  assert.equal(r.qty.passed, false); assert.equal(r.qty.assertionFailure, true);
});

test('the two bugs are independent: fixing either one leaves the other failing', async () => {
  const afterQty = await runAll(applyEdits(SOURCE, FIX_QTY));
  assert.ok(afterQty.qty.passed && afterQty.existing.passed);
  assert.equal(afterQty.coupon.passed, false, 'bug-1 fix must not fix bug 2');
  const afterCoupon = await runAll(applyEdits(SOURCE, FIX_COUPON));
  assert.ok(afterCoupon.coupon.passed && afterCoupon.existing.passed, afterCoupon.coupon.output);
  assert.equal(afterCoupon.qty.passed, false, 'bug-2 fix must not fix bug 1');
  const both = await runAll(applyEdits(applyEdits(SOURCE, FIX_QTY), FIX_COUPON));
  assert.ok(both.coupon.passed && both.qty.passed && both.existing.passed);
});

test('scripted coupon sample report matches what the real cart + server check produce', () => {
  const rpt = JSON.parse(fs.readFileSync(path.join(FIXTURE, '../../data/reports/rpt_sample_coupon.json'), 'utf8'));
  assert.equal(rpt.sample, true);
  const net = rpt.events.find((e) => e.type === 'network.failed');
  assert.match(net.responseBody, /client sent \$40\.00, server computed \$50\.00/);
  assert.equal(JSON.parse(net.requestBody).coupon, null);
  assert.doesNotMatch(JSON.stringify(rpt), /priya|demo_FAKE/);
});
