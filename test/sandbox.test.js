// Sandbox unit tests: Windows path masking, and isolation basics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskPaths } from '../src/sandbox.js';

test('maskPaths hides Windows workspace paths in every form (backslash, slash, file URL, any case)', () => {
  const ws = 'C:\\Users\\KRISHNA SINGH\\AppData\\Local\\Temp\\redgreen-AbC123';
  const out = [
    `at file:///C:/Users/KRISHNA%20SINGH/AppData/Local/Temp/redgreen-AbC123/test/repro.test.js:3:9`,
    `Error: C:\\Users\\KRISHNA SINGH\\AppData\\Local\\Temp\\redgreen-AbC123\\src\\cart.js`,
    `c:\\users\\krishna singh\\appdata\\local\\temp\\redgreen-abc123\\test\\repro.test.js`,
    `C:/Users/KRISHNA SINGH/AppData/Local/Temp/redgreen-AbC123/x`,
  ].join('\n');
  const masked = maskPaths(out, ws, true);
  assert.doesNotMatch(masked, /KRISHNA|redgreen-AbC123/i, masked);
  assert.equal(masked.split('<sandbox>').length - 1, 4);
});

test('maskPaths on POSIX is case-sensitive and handles spaces', () => {
  const ws = '/tmp/pr guardian/redgreen-x1';
  assert.equal(maskPaths('file:///tmp/pr%20guardian/redgreen-x1/a.js and /tmp/pr guardian/redgreen-x1/b.js', ws, false), 'file://<sandbox>/a.js and <sandbox>/b.js');
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace, removeWorkspace, runTestFile } from '../src/sandbox.js';
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'shop');

test('an infinite-loop test is killed at the timeout and reported as a failed, non-assertion run', async () => {
  const ws = createWorkspace(FIXTURE);
  fs.writeFileSync(path.join(ws, 'test', 'hang.test.js'), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/cart.js';\ntest('hang', () => { while (true) {} assert.equal(1, 2); });`);
  const r = await runTestFile(ws, 'test/hang.test.js', 1500);
  removeWorkspace(ws);
  assert.equal(r.timedOut, true);
  assert.equal(r.passed, false);
  assert.notEqual(r.exitCode, 0);
  assert.equal(r.assertionFailure, false, 'a timeout must never count as a reproducing assertion failure');
  assert.match(r.output, /killed after 1500ms timeout/);
  assert.ok(r.durationMs >= 1500 && r.durationMs < 6000, `durationMs=${r.durationMs}`);
});
