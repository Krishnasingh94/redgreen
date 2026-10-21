// patch.diff: unified diffs must be accepted by `git apply`, and the endpoint must only serve verified runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unifiedDiff, newFileDiff, buildPatch } from '../src/diff.js';
import { applyEdits } from '../src/guard.js';
import { runTestFile } from '../src/sandbox.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAS_GIT = spawnSync('git', ['--version']).status === 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rg patch '));
function gitApply(dir, patch) {
  fs.writeFileSync(path.join(dir, 'x.patch'), patch);
  // autocrlf=false: these tests check the diff byte for byte (Windows runners set core.autocrlf=true globally)
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', 'x.patch'], { cwd: dir, encoding: 'utf8' });
  fs.rmSync(path.join(dir, 'x.patch'));
  return r;
}

test('unifiedDiff / newFileDiff round-trip through git apply (multi-hunk, no final newline, new file)', { skip: !HAS_GIT && 'git not installed' }, () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const cases = [
    [a, a.replace('line 3\n', 'LINE three\n').replace('line 25\n', 'line 25\nadded\n')], // two hunks
    [a, a.replace('line 1\n', '')],                    // delete first line
    [a, a + 'tail'],                                    // add line with no final newline
    ['x\ny', 'x\ny\n'],                                 // add final newline
    ['only\n', 'changed\n'],
  ];
  for (const [before, after] of cases) {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'f.js'), before);
    const r = gitApply(d, unifiedDiff(before, after, 'f.js') + newFileDiff('new\nfile', 'sub/new.js'));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(d, 'f.js'), 'utf8'), after);
    assert.equal(fs.readFileSync(path.join(d, 'sub/new.js'), 'utf8'), 'new\nfile');
    fs.rmSync(d, { recursive: true, force: true });
  }
  assert.equal(unifiedDiff(a, a, 'f.js'), '');
});

const FIX_EDITS = [
  { find: '  cart.discount = round2(subtotal(cart) * pct);\n', replace: '' },
  { find: '  return round2(Math.max(0, subtotal(cart) - cart.discount));', replace: '  const pct = cart.coupon ? COUPONS[cart.coupon] : 0;\n  cart.discount = round2(subtotal(cart) * pct);\n  return round2(Math.max(0, subtotal(cart) - cart.discount));' },
];
const REPRO = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createCart, addItem, setQuantity, applyCoupon, total } from '../src/cart.js';\ntest('discount follows quantity changes', () => { const c = createCart(); addItem(c, { id: 'hp', name: 'H', price: 50 }, 1); setQuantity(c, 'hp', 3); applyCoupon(c, 'SAVE20'); setQuantity(c, 'hp', 1); assert.equal(total(c), 40); });`;

test('GET /api/runs/:id/patch.diff serves a git-applicable verified patch; 404 otherwise', async () => {
  const data = tmp();
  fs.mkdirSync(path.join(data, 'runs'), { recursive: true }); fs.mkdirSync(path.join(data, 'reports'), { recursive: true });
  const source = fs.readFileSync(path.join(ROOT, 'fixtures/shop/src/cart.js'), 'utf8');
  const patch = buildPatch({ source, patched: applyEdits(source, FIX_EDITS), testCode: REPRO });
  const runs = { run_ok1: { verdict: 'fixed_verified', patch }, run_nofix: { verdict: 'reproduced_not_fixed' }, run_norepro: { verdict: 'not_reproduced' } };
  for (const [id, r] of Object.entries(runs)) fs.writeFileSync(path.join(data, 'runs', id + '.json'), JSON.stringify({ id, reportId: 'rpt_sample', startedAt: new Date().toISOString(), ...r }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), REDGREEN_DATA: data, GEMMA_BASE_URL: 'http://127.0.0.1:9/v1' }, stdio: 'ignore' });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let t = 0; t < 50; t++) { try { await fetch(base + '/api/runs'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const ok = await fetch(base + '/api/runs/run_ok1/patch.diff');
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/x-diff/);
    const body = await ok.text();
    assert.equal(body, patch);
    assert.match(body, /^diff --git a\/fixtures\/shop\/src\/cart\.js/m);
    assert.match(body, /^new file mode 100644\n--- \/dev\/null\n\+\+\+ b\/fixtures\/shop\/test\/repro\.test\.js/m);
    for (const id of ['run_nofix', 'run_norepro', 'run_missing']) assert.equal((await fetch(`${base}/api/runs/${id}/patch.diff`)).status, 404, id);
    assert.equal((await fetch(base + '/api/runs/run_ok1')).status, 200); // existing route unchanged

    if (HAS_GIT) { // apply to a clean copy of the repo layout, then run both suites in the sandbox
      const repo = tmp();
      fs.cpSync(path.join(ROOT, 'fixtures/shop'), path.join(repo, 'fixtures/shop'), { recursive: true });
      const r = gitApply(repo, body);
      assert.equal(r.status, 0, r.stderr);
      const ws = path.join(repo, 'fixtures/shop');
      const [r1, r2] = [await runTestFile(ws, 'test/repro.test.js'), await runTestFile(ws, 'test/cart.test.js')];
      assert.ok(r1.passed && r2.passed, r1.output + r2.output);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  } finally { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); }
});
