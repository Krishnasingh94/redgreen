// Redaction: every secret/PII shape we know is removed; ordinary values (ids, prices, timestamps, prose) are kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redact.js';

const j = (o) => JSON.stringify(redact(o).value);
// Built from parts so the repo itself never contains a string that looks like a real secret.
const S = {
  github: 'ghp' + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  githubFine: 'github' + '_pat_' + '11ABCDEFG0' + 'x'.repeat(70),
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  slack: 'xoxb' + '-1234567890-abcdefghijkl',
  google: 'AIza' + 'SyD' + 'x'.repeat(32),
  openai: 'sk' + '-proj-' + 'A'.repeat(40),
  stripe: 'sk' + '_live_' + 'ABCDEFGH1234',
  jwt: 'eyJ' + 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  card: '4111 1111 1111 1111',
};

test('secrets in free text are redacted', () => {
  const cases = {
    github: `token ${S.github}`, githubFine: S.githubFine, aws: S.aws, slack: S.slack, google: S.google, openai: S.openai, stripe: S.stripe, jwt: S.jwt,
    pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    bearer: 'Authorization: Bearer abc.def.ghi12345', basic: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    kv: 'login failed password=hunter2 for user', kv2: 'api_key: "zz9-secret"', query: 'GET /x?session=abc123&page=2',
    card: `paid with ${S.card}`, email: 'mail priya.sharma@example.com', phone: 'call +91 98765 43210',
  };
  const { value, count } = redact(cases);
  for (const [k, original] of Object.entries(cases)) {
    assert.notEqual(value[k], original, `${k} not redacted`);
    assert.match(value[k], /\[REDACTED/, k);
  }
  for (const secret of [...Object.values(S), 'hunter2', 'zz9-secret', 'abc123', 'priya.sharma', '98765 43210', 'dXNlcjpwYXNzd29yZA', 'MIIEow']) assert.ok(!JSON.stringify(value).includes(secret), `leaked: ${secret}`);
  assert.ok(count >= Object.keys(cases).length, String(count));
  assert.match(value.query, /page=2/, 'non-secret query params are kept');
});

test('URL credentials are removed but the host stays readable', () => {
  assert.equal(redact('postgres://admin:hunter2@db.internal:5432/app').value, 'postgres://[REDACTED]@db.internal:5432/app');
});

test('sensitive keys in any casing / separator style are redacted', () => {
  const s = j({ accessToken: 'v1', 'Access-Token': 'v2', api_key: 'v3', apiKey: 'v4', 'X-Api-Key': 'v5', client_secret: 'v6', Cookie: 'v7', 'set-cookie': ['v8'], refreshToken: 'v9', cardNumber: 'v10' });
  for (let i = 1; i <= 10; i++) assert.ok(!s.includes(`"v${i}"`), `v${i} leaked: ${s}`);
});

test('JSON-encoded request bodies are parsed and redacted inside', () => {
  const body = JSON.stringify({ email: 'a@b.com', password: 'p4ss', items: [{ id: 'hp', qty: 1 }] });
  const out = JSON.parse(redact({ requestBody: body }).value.requestBody);
  assert.equal(out.password, '[REDACTED]'); assert.equal(out.email, '[REDACTED_EMAIL]'); assert.deepEqual(out.items, [{ id: 'hp', qty: 1 }]);
});

test('ordinary values are NOT redacted (no false positives)', () => {
  const benign = {
    order: 'Order 1729500000000 placed', ts: 'took 1234567890123ms', iso: '2026-10-21T05:30:00.000Z', price: '$1,299.00', ver: 'v1.2.3',
    prose: 'Basic information about the token flow', qty: 'qty 3 of item 12345678901234', total: 'Total mismatch: client sent $40.00, server computed $50.00',
    path: '/shop/api/checkout', sk: 'the sk-calculation step', keyword: 'the secret sauce is love',
  };
  const { value, count } = redact(benign);
  assert.deepEqual(value, benign);
  assert.equal(count, 0);
});

test('the demo shop evidence shape still redacts exactly the auth header and the email', () => {
  const { value, count } = redact({ requestHeaders: { 'Content-Type': 'application/json', Authorization: 'Bearer demo_FAKE_token_not_a_real_secret_0000' }, requestBody: JSON.stringify({ email: 'priya.sharma@example.com', items: [{ id: 'hp', price: 50, qty: 1 }], coupon: 'SAVE20', clientTotal: 40 }) });
  assert.equal(count, 2);
  assert.equal(value.requestHeaders['Content-Type'], 'application/json');
  assert.match(value.requestBody, /"clientTotal":40/);
});
