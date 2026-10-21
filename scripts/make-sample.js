// Generates SCRIPTED sample reports by replaying real actions against the real cart module
// (so state values are genuine), plus the real server response for the checkout. Labelled sample: true.
//   npm run sample                 → data/reports/rpt_sample.json         (bug 1: stale discount after qty change)
//   npm run sample -- coupon       → data/reports/rpt_sample_coupon.json  (bug 2: invalid coupon drops the applied one)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../fixtures/shop/src/cart.js';
import { redact } from '../src/redact.js';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenario = process.argv[2] || 'quantity';
if (!['quantity', 'coupon'].includes(scenario)) { console.error('scenario must be "quantity" or "coupon"'); process.exit(2); }
const cart = C.createCart(); const events = []; let t = 0, n = 0;
const snap = () => ({ items: cart.items.map((i) => ({ id: i.id, qty: i.qty, price: i.price })), coupon: cart.coupon, discount: cart.discount, subtotal: C.subtotal(cart), total: C.total(cart) });
const HP = { id: 'hp', name: 'Headphones', price: 50 };
// Mirrors the shop UI's act(): on error it records { error } as the state and logs console.error.
const act = (name, args, fn) => {
  try { fn(); events.push({ id: 'e' + ++n, t_ms: (t += 900 + n * 137), type: 'action', name, args, stateAfter: snap() }); }
  catch (e) { events.push({ id: 'e' + ++n, t_ms: (t += 900 + n * 137), type: 'action', name, args, stateAfter: { error: e.message } }); events.push({ id: 'e' + ++n, t_ms: t + 1, type: 'console.error', message: e.message }); }
};
let description, id;
if (scenario === 'quantity') {
  id = 'rpt_sample';
  description = 'Total looked way too low after I changed the quantity, then checkout failed.';
  act('addItem', [HP, 1], () => C.addItem(cart, HP, 1));
  act('setQuantity', ['hp', 3], () => C.setQuantity(cart, 'hp', 3));
  act('applyCoupon', ['SAVE20'], () => C.applyCoupon(cart, 'SAVE20'));
  act('setQuantity', ['hp', 1], () => C.setQuantity(cart, 'hp', 1));
} else {
  id = 'rpt_sample_coupon';
  description = 'I typed a wrong coupon code by mistake. The page still showed my SAVE20 discount, but checkout said the total did not match.';
  act('addItem', [HP, 1], () => C.addItem(cart, HP, 1));
  act('applyCoupon', ['SAVE20'], () => C.applyCoupon(cart, 'SAVE20'));
  act('applyCoupon', ['SAVE50'], () => C.applyCoupon(cart, 'SAVE50'));
}
// Same computation as the server's /shop/api/checkout price check.
const sub = cart.items.reduce((s, it) => s + it.price * it.qty, 0), expected = Math.round((sub - sub * (C.COUPONS[cart.coupon] ?? 0)) * 100) / 100;
const err = `Total mismatch: client sent $${C.total(cart).toFixed(2)}, server computed $${expected.toFixed(2)}`;
events.push({ id: 'e' + ++n, t_ms: (t += 2100), type: 'network.failed', method: 'POST', url: 'http://localhost:3000/shop/api/checkout', status: 422,
  requestHeaders: { 'Content-Type': 'application/json', Authorization: 'Bearer demo_FAKE_token_not_a_real_secret_0000' },
  requestBody: JSON.stringify({ email: 'priya.sharma@example.com', items: cart.items, coupon: cart.coupon, clientTotal: C.total(cart) }),
  responseBody: JSON.stringify({ error: err }), duration_ms: 14 });
events.push({ id: 'e' + ++n, t_ms: t + 3, type: 'console.error', message: 'Checkout failed: ' + err });
const raw = { schema: 'redgreen.evidence/v1', app: 'demo-shop', sample: true, description, captured_at: new Date().toISOString(), env: { userAgent: 'scripted-sample', url: 'http://localhost:3000/shop/', viewport: '1280x800' }, events };
const { value, count } = redact(raw);
fs.mkdirSync(path.join(ROOT, 'data', 'reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'reports', id + '.json'), JSON.stringify({ ...value, id, redactions: count, savedAt: '2000-01-01T00:00:00.000Z' }, null, 2));
console.log(`wrote data/reports/${id}.json —`, events.length, 'events,', count, 'redactions');
