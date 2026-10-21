// GitHub-mode pipeline robustness (no network): a local git repo stands in for the clone, a mock model answers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HAS_GIT = spawnSync('git', ['--version']).status === 0;
let queue = [], mock, runRepoPipeline, reposDir;
before(async () => {
  mock = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'google/gemma-4-e4b' }] }));
    req.resume(); req.on('end', () => {
      const a = queue.shift();
      if (a === undefined) { res.statusCode = 500; return res.end('{"error":"mock: nothing queued"}'); }
      res.end(JSON.stringify({ choices: [{ message: { content: typeof a === 'string' ? a : JSON.stringify(a) } }] }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.GEMMA_BASE_URL = `http://127.0.0.1:${mock.address().port}/v1`;
  ({ runRepoPipeline } = await import('../src/repoPipeline.js'));
  // A tiny node:test repo with a planted bug, committed so resetRepo (git checkout/clean) works.
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg repos '));
  const dir = path.join(reposDir, 'acme__calc');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'calc', type: 'module', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(dir, 'src', 'add.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  fs.writeFileSync(path.join(dir, 'test', 'add.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/add.js';\ntest('zero', () => assert.equal(add(0, 0), 0));\n");
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init');
});
after(() => { mock?.close(); if (reposDir) fs.rmSync(reposDir, { recursive: true, force: true }); });

const kase = { id: 'gh_test', kind: 'github', repo: { owner: 'acme', repo: 'calc', number: 7, sha: 'abc1234' }, issue: { title: '`add(2, 2)` returns 0 instead of 4', body: 'Calling `add` in src/add.js subtracts instead of adding.', comments: [] } };
const GOOD = { hypothesis: 'add subtracts', evidence_ids: ['issue body'], expected: '4', actual: '0', test_name: 'add adds', test_code: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\ntest('add adds', () => assert.equal(add(2, 2), 4));\n" };
const FIX = { root_cause: 'uses minus', change: 'a + b', explanation: '', functions: [{ file: 'src/add.js', name: 'add', code: 'export function add(a, b) {\n  return a + b;\n}' }] };

async function run(answers) {
  queue = [...answers]; const events = [];
  const r = await runRepoPipeline({ kase, reposDir, emit: (e) => events.push(e) });
  for (const e of events.filter((x) => x.proposal)) {
    if (e.type.startsWith('repro')) { assert.equal(typeof e.proposal.test_code, 'string'); assert.ok(Array.isArray(e.proposal.evidence_ids)); }
    else { assert.equal(typeof e.proposal.root_cause, 'string'); assert.ok(Array.isArray(e.proposal.functions)); }
  }
  assert.equal(events.at(-1).type, 'done');
  return { r, events, rejected: events.filter((e) => e.type.endsWith('.rejected')) };
}

test('GitHub mode: malformed model output is rejected with reasons, then RED → GREEN on the real repo tests', { skip: !HAS_GIT && 'git not installed' }, async () => {
  const { r, rejected } = await run(['not json at all', { test_code: 5 }, GOOD, { root_cause: 'x', functions: [{ name: 'add' }] }, FIX]);
  assert.deepEqual(rejected.map((e) => `${e.type}:${e.rejection}`), ['repro.rejected:invalid_json', 'repro.rejected:invalid_shape', 'fix.rejected:invalid_shape']);
  assert.match(rejected[2].reason, /functions\[0\] must be \{"file": string, "name": string, "code": string\}/);
  assert.equal(r.verdict, 'fixed_verified', JSON.stringify(r.steps.filter((s) => s.reason || s.error), null, 1));
  assert.match(r.prMarkdown, /Verified by RedGreen/);
  // the clone is left clean for the next run
  assert.equal(fs.readFileSync(path.join(reposDir, 'acme__calc', 'src', 'add.js'), 'utf8'), 'export function add(a, b) {\n  return a - b;\n}\n');
});

test('GitHub mode: model unreachable on every attempt → not_reproduced with an explicit reason', { skip: !HAS_GIT && 'git not installed' }, async () => {
  const { r, events } = await run([]);
  assert.equal(r.verdict, 'not_reproduced');
  assert.equal(events.at(-1).modelUnavailable, true);
  assert.match(events.at(-1).reason, /Model unavailable in the reproduce phase/);
});
