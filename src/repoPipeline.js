// GitHub mode pipeline: issue -> clone -> locate -> RED (test must fail) -> patch -> GREEN (test + repo suite pass).
// Emits the same event types as the demo pipeline so the dashboard renders both.
import fs from 'node:fs';
import path from 'node:path';
import { chatJson } from './model.js';
import { REPRO_SCHEMA, REPO_FIX_SCHEMA, repoReproPrompt, repoFixPrompt } from './prompts.js';
import { cloneRepo, detectProject, installDeps } from './github.js';
import { rankFiles, excerpt, listFiles } from './locate.js';
import { reproTestPath, frameworkHint, runOne, runSuite, checkRepoTest, applyRepoPatch, resetRepo } from './repo.js';
import { lineDiff } from './diff.js';

const MAX_ATTEMPTS = 3;
const temp = (a) => [0.2, 0.6, 0.9][a - 1] ?? 0.9;

export async function runRepoPipeline({ kase, reposDir, emit }) {
  const run = { id: 'run_' + Date.now().toString(36), reportId: kase.id, kind: 'github', startedAt: new Date().toISOString(), steps: [], verdict: 'running', sandbox: { node: process.version, permissionModel: 'temp clone + timeout (third-party runners)', timeoutMs: 60000 } };
  const step = (type, data) => { const s = { type, at: new Date().toISOString(), ...data }; run.steps.push(s); emit?.(s); return s; };
  const fail = (verdict, reason) => { step('fatal', { error: reason }); run.verdict = verdict; return finish(run, emit); };
  const { owner, repo } = kase.repo;
  const dir = path.join(reposDir, `${owner}__${repo}`);

  // 1. prepare (deterministic)
  let sha, project;
  try {
    step('prepare', { stage: 'clone', note: `Cloning ${owner}/${repo}` });
    const t0 = Date.now();
    if (fs.existsSync(path.join(dir, '.git'))) { await resetRepo(dir); sha = kase.repo.sha; } else sha = await cloneRepo(kase.repo, dir);
    project = detectProject(dir);
    if (project.needsInstall && !fs.existsSync(path.join(dir, 'node_modules'))) { step('prepare', { stage: 'install', note: 'Installing dependencies (install scripts disabled)' }); await installDeps(dir); }
    step('prepare', { stage: 'ready', note: `${project.name}: ${project.runner} tests`, durationMs: Date.now() - t0, project, sha });
  } catch (e) { return fail('not_reproduced', e.message); }

  const issueText = [kase.issue.title, kase.issue.body, ...(kase.issue.comments || []).map((c) => c.body)].join('\n');
  const located = rankFiles(dir, issueText, 3);
  if (!located.source.length) return fail('not_reproduced', 'No source file in the repo matches the issue text, so there is nothing to point Gemma at.');
  const files = located.source.map((f) => ({ ...f, text: excerpt(dir, f.path, f.terms) }));
  const testPath = reproTestPath(project);
  const exampleRel = located.tests[0]?.path || listFiles(dir).find((f) => /(^|\/)(test|tests|__tests__)\/.*\.[cm]?js$|\.test\.[cm]?js$/.test(f));
  const exampleTest = exampleRel ? { path: exampleRel, text: fs.readFileSync(path.join(dir, exampleRel), 'utf8').split('\n').slice(0, 60).join('\n') } : null;
  step('located', { files: located.source.map(({ path: p, score, terms, lines }) => ({ path: p, score, terms, lines })), testPath, runner: project.runner });

  // 2. baseline: the repo's own suite
  const baseline = await runSuite(dir);
  step('baseline', { result: baseline, note: baseline.passed ? 'The repo\'s test suite passes on current code — it does not catch this bug.' : 'The repo\'s test suite already fails on current code; RedGreen will require the patch not to make it worse.' });

  // 3. RED
  let repro = null, feedback = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !repro; attempt++) {
    step('model.start', { phase: 'reproduce', attempt });
    let ans;
    try { ans = await chatJson({ ...repoReproPrompt({ issue: kase.issue, project, files, testPath, exampleTest, hint: frameworkHint(project), feedback }), schemaName: 'repro', schema: REPRO_SCHEMA, temperature: temp(attempt) }); }
    catch (e) { step('model.error', { phase: 'reproduce', attempt, error: e.message }); feedback = `Your response could not be used: ${e.message}`; continue; }
    const json = ans.json; json.test_code = String(json.test_code || '').replace(/^\s*```(?:[jt]s|javascript)?\s*\n?|```\s*$/g, '');
    const meta = { attempt, model: ans.model, durationMs: ans.durationMs, proposal: json };
    const problems = checkRepoTest(json.test_code);
    if (problems.length) { step('repro.rejected', { ...meta, reason: 'Safety check failed: ' + problems.join('; ') }); feedback = problems.join('\n'); continue; }
    await resetRepo(dir);
    fs.mkdirSync(path.dirname(path.join(dir, testPath)), { recursive: true });
    fs.writeFileSync(path.join(dir, testPath), json.test_code);
    const result = await runOne(dir, project, testPath);
    if (result.passed) { step('repro.rejected', { ...meta, result, reason: 'Test PASSED on the current code, so it does not reproduce the bug.' }); feedback = 'Your test passed on the current code, so it does not reproduce the issue. Re-read the issue and assert the behaviour it says is wrong.'; }
    else if (result.broken) { step('repro.rejected', { ...meta, result, reason: `The test itself is broken (${result.broken}), not the code under test.` }); feedback = `Your test failed because the test itself is broken: ${result.broken}\nOutput:\n${result.output.slice(-1500)}`; }
    else { repro = { ...json, result, model: ans.model, durationMs: ans.durationMs }; step('repro.confirmed', { ...meta, result }); }
  }
  await resetRepo(dir);
  if (!repro) { run.verdict = 'not_reproduced'; return finish(run, emit); }

  // 4. patch + GREEN
  feedback = '';
  let fix = null;
  const allowed = files.map((f) => f.path);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !fix; attempt++) {
    step('model.start', { phase: 'fix', attempt });
    let ans;
    try { ans = await chatJson({ ...repoFixPrompt({ files, testPath, testCode: repro.test_code, failure: repro.result.output.slice(-2500), feedback }), schemaName: 'fix', schema: REPO_FIX_SCHEMA, temperature: temp(attempt) }); }
    catch (e) { step('model.error', { phase: 'fix', attempt, error: e.message }); feedback = `Your response could not be used: ${e.message}`; continue; }
    const meta = { attempt, model: ans.model, durationMs: ans.durationMs, proposal: ans.json };
    await resetRepo(dir);
    let before;
    try { before = applyRepoPatch(dir, allowed, ans.json.functions); }
    catch (e) {
      step('fix.rejected', { ...meta, reason: 'Patch could not be applied: ' + e.message });
      feedback = /changes nothing/.test(e.message) ? `You returned the code UNCHANGED. Your own root cause was: "${ans.json.root_cause}". Write the actual code change.` : e.message;
      continue;
    }
    const diff = Object.keys(before).map((f) => lineDiff(before[f], fs.readFileSync(path.join(dir, f), 'utf8'), f)).join('\n');
    fs.mkdirSync(path.dirname(path.join(dir, testPath)), { recursive: true });
    fs.writeFileSync(path.join(dir, testPath), repro.test_code);
    const r1 = await runOne(dir, project, testPath);
    fs.rmSync(path.join(dir, testPath), { force: true }); // run the repo's own suite without our test, then judge
    const r2 = await runSuite(dir);
    await resetRepo(dir);
    const suiteOk = r2.passed || (!baseline.passed && r2.fail <= baseline.fail && r2.fail > 0);
    const results = [r1, { ...r2, passed: suiteOk, note: !r2.passed && suiteOk ? 'already failing before; no new failures' : undefined }];
    if (r1.passed && suiteOk) { fix = { ...ans.json, diff, results, model: ans.model, durationMs: ans.durationMs }; step('fix.verified', { ...meta, diff, results }); }
    else {
      const which = !r1.passed ? 'the reproduction test still fails' : 'it broke the repo\'s existing tests';
      step('fix.rejected', { ...meta, diff, results, reason: `Patch applied but ${which}.` });
      feedback = `After your patch, ${which}. Output:\n` + (!r1.passed ? r1.output : r2.output).slice(-1500);
    }
  }
  run.verdict = fix ? 'fixed_verified' : 'reproduced_not_fixed';
  run.prMarkdown = repoReport({ kase, run, repro, fix, baseline, project, sha, testPath });
  return finish(run, emit);
}

function finish(run, emit) { run.finishedAt = new Date().toISOString(); emit?.({ type: 'done', verdict: run.verdict, runId: run.id }); return run; }

function repoReport({ kase, run, repro, fix, baseline, project, sha, testPath }) {
  const i = kase.issue;
  return `## Fix #${kase.repo.number}: ${i.title}

${fix ? `Fixes #${kase.repo.number}.

✅ **Verified by RedGreen**: the new test \`${testPath}\` failed on \`${sha}\` and passes with this patch; the repo's own test suite ${fix.results[1].note ? 'has no new failures' : 'passes'}.` : `⚠️ Reproduced #${kase.repo.number} with a failing test; no patch passed verification yet.`}

### Root cause
${fix ? fix.root_cause : repro.hypothesis}

### Reproduction test (\`${testPath}\`)
\`\`\`js
${repro.test_code.trim()}
\`\`\`

Before the patch: **FAILED** (exit ${repro.result.exitCode}).
${fix ? `
### Patch
\`\`\`diff
${fix.diff}
\`\`\`

After the patch: reproduction test **${fix.results[0].passed ? 'PASSED' : 'FAILED'}**, \`npm test\` **${fix.results[1].passed ? 'OK' : 'FAILED'}**${fix.results[1].note ? ` (${fix.results[1].note})` : ''}.
` : ''}
Baseline \`npm test\` before any change: ${baseline.passed ? 'passing' : 'already failing'}.

---
_Generated by RedGreen run \`${run.id}\` with ${repro.model} running locally. Test runner: ${project.runner}. Every result above comes from an actual test run._
`;
}
