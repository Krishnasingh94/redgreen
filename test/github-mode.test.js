// GitHub mode safety: off unless explicitly enabled; node:test repro tests run under the permission model,
// and a test that only "fails" because the sandbox denied it never counts as a reproduction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOne, brokenTest } from '../src/repo.js';
import { sandboxInfo } from '../src/sandbox.js';
import { redact } from '../src/redact.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
async function withServer(env, fn) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-gh-'));
  fs.mkdirSync(path.join(data, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(data, 'reports', 'gh_case1.json'), JSON.stringify({ schema: 'redgreen.issue/v1', kind: 'github', id: 'gh_case1', description: 't', issue: { title: 't', body: '' }, repo: { owner: 'o', repo: 'r', number: 1 }, events: [], redactions: 0, savedAt: new Date().toISOString() }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const { REDGREEN_ALLOW_REPO_CODE, ...base } = process.env;
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...base, ...env, PORT: String(port), REDGREEN_DATA: data, GEMMA_BASE_URL: 'http://127.0.0.1:9/v1' }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let t = 0; t < 50; t++) { try { await fetch(url + '/api/runs'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    await fn(url, data);
  } finally { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); }
}
const postIssue = (url, body) => fetch(url + '/api/issues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('GitHub mode is OFF by default: loading an issue → 403 with the reason, running a stored case → fatal, nothing cloned', async () => {
  await withServer({}, async (url, data) => {
    const r = await postIssue(url, { url: 'https://github.com/o/r/issues/1' });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /outside the RedGreen sandbox.*REDGREEN_ALLOW_REPO_CODE=1/);
    const st = await (await fetch(url + '/api/status')).json();
    assert.equal(st.githubMode.enabled, false);
    const sse = await (await fetch(url + '/api/analyze/gh_case1')).text();
    assert.match(sse, /"type":"fatal".*GitHub mode is off/);
    assert.equal(fs.existsSync(path.join(data, 'repos', 'o__r')), false, 'must not clone when disabled');
  });
});

test('GitHub mode enabled: still validates the URL before touching the network', async () => {
  await withServer({ REDGREEN_ALLOW_REPO_CODE: '1' }, async (url) => {
    assert.equal((await (await fetch(url + '/api/status')).json()).githubMode.enabled, true);
    const r = await postIssue(url, { url: 'https://evil.example/o/r/issues/1' });
    assert.equal(r.status, 400);
  });
});

test('issue text is redacted with the same rules as bug reports', () => {
  const { value, count } = redact({ title: 'Crash for x.y@corp.io', body: 'token ghp_' + 'A'.repeat(36) + ' and Authorization: Bearer abc.def.ghi12345', comments: [{ body: 'mail me a@b.com' }] });
  const s = JSON.stringify(value);
  assert.ok(count >= 3, String(count));
  assert.doesNotMatch(s, /x\.y@corp\.io|a@b\.com|abc\.def\.ghi12345/);
});

test('node:test repo runner: repro test runs under the permission model; sandbox denials never count as a reproduction', { skip: !sandboxInfo.permissionModel.startsWith('--') && 'no permission model on this Node' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg repo '));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }));
    fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'src', 'add.js'), 'export const add = (a, b) => a - b;\n');
    const project = { runner: 'node', esm: true, testDir: 'test' };
    const outside = path.join(os.tmpdir(), `rg-pwned-${process.pid}.txt`);
    const files = {
      'test/real.test.mjs': "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/add.js'; test('add', () => assert.equal(add(2, 2), 4));",
      'test/write.test.mjs': `import { test } from 'node:test'; import fs from 'node:fs'; test('w', () => { fs.writeFileSync(${JSON.stringify(outside)}, 'x'); throw new Error('should not get here'); });`,
      'test/spawn.test.mjs': "import { test } from 'node:test'; import cp from 'node:child_process'; test('s', () => { cp.execSync('echo hi'); });",
    };
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
    const real = await runOne(dir, project, 'test/real.test.mjs');
    assert.equal(real.passed, false); assert.equal(real.broken, null, real.output); assert.match(real.output, /AssertionError|ERR_ASSERTION/);
    const w = await runOne(dir, project, 'test/write.test.mjs');
    assert.equal(fs.existsSync(outside), false, 'write outside must be blocked');
    assert.match(w.broken || '', /ERR_ACCESS_DENIED/, w.output);
    const s = await runOne(dir, project, 'test/spawn.test.mjs');
    assert.match(s.broken || '', /ERR_ACCESS_DENIED/, s.output);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('brokenTest flags sandbox denials and broken tests, not real assertion failures', () => {
  assert.match(brokenTest("Error [ERR_ACCESS_DENIED]: Access to this API has been restricted"), /ERR_ACCESS_DENIED/);
  assert.match(brokenTest('SyntaxError: Unexpected token'), /SyntaxError/);
  assert.equal(brokenTest('AssertionError [ERR_ASSERTION]: 0 == 4'), null);
});
