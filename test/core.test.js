import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redact.js';
import { checkTestCode, applyEdits } from '../src/guard.js';
import { extractJson } from '../src/model.js';

test('redacts tokens, emails, auth headers, including inside JSON strings', () => {
  const { value, count } = redact({ headers: { Authorization: 'Bearer abc.def.ghi12345' }, body: JSON.stringify({ email: 'a@b.com', key: 'sk_' + 'live_ABCDEFGH1234' }), note: 'mail me at x.y@z.io' });
  const s = JSON.stringify(value);
  assert.ok(!s.includes('a@b.com') && !s.includes('x.y@z.io') && !s.includes('sk_' + 'live_ABCDEFGH1234') && !s.includes('abc.def'));
  assert.ok(count >= 4);
});

test('guard rejects dangerous generated tests', () => {
  assert.ok(checkTestCode("import { test } from 'node:test'; import fs from 'node:fs'; import { total } from '../src/cart.js';").some((p) => p.includes('node:fs')));
  assert.ok(checkTestCode("import { test } from 'node:test'; import { total } from '../src/cart.js'; process.exit(0)").length > 0);
  assert.deepEqual(checkTestCode("import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/cart.js';\ntest('x', () => assert.equal(1, 1));"), []);
});

test('applyEdits requires unique exact matches', () => {
  assert.equal(applyEdits('a b c', [{ find: 'b', replace: 'B' }]), 'a B c');
  assert.throws(() => applyEdits('a a', [{ find: 'a', replace: 'b' }]), /2 places/);
  assert.throws(() => applyEdits('abc', [{ find: 'zz', replace: 'b' }]), /not found/);
});

test('extractJson handles fences and preambles', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a": "}{"}\n```'), { a: '}{' });
  assert.deepEqual(extractJson('x {"b":1} y'), { b: 1 });
});

import { replaceFunctions } from '../src/guard.js';
test('replaceFunctions swaps a whole function and rejects bad patches', () => {
  const src = "export function a(x) {\n  if (x) { return '}'; }\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n";
  const out = replaceFunctions(src, [{ name: 'a', code: 'export function a(x) {\n  return 3;\n}' }]);
  assert.match(out, /return 3/); assert.match(out, /function b\(\)/); assert.doesNotMatch(out, /return 1/);
  assert.throws(() => replaceFunctions(src, [{ name: 'zz', code: 'export function zz() {}' }]), /does not exist/);
  assert.throws(() => replaceFunctions(src, [{ name: 'a', code: 'export function a(x) {\n  return 3;\n}\nreturn x;' }]), /exactly one complete function/);
  assert.throws(() => replaceFunctions(src, [{ name: 'b', code: 'export function b() {\n  return 2;\n}' }]), /changes nothing/);
});
