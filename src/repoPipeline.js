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
import { detectSite } from './web.js';
import { runWebFlow, wantsWebsite } from './webPipeline.js';
import { validateRepro, normalizeRepro, isBadOutput, markModelUnavailable } from './pipeline.js';

// Same rule as the demo pipeline: the model is untrusted, so check its JSON before use and only ever emit
// proposals with every field present and the right type (the UI renders them directly).
const isStr = (v) => typeof v === 'string';
export function validateRepoFix(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return ['response must be a JSON object'];
  const errs = [];
  if (!isStr(j.root_cause)) errs.push('"root_cause" must be a string');
  if (!Array.isArray(j.functions) || !j.functions.length) errs.push('"functions" must be a non-empty array of {file, name, code}');
  else j.functions.forEach((f, i) => { if (!f || !isStr(f.file) || !isStr(f.name) || !isStr(f.code)) errs.push(`functions[${i}] must be {"file": string, "name": string, "code": string}`); });
  return errs;
}
export function normalizeRepoFix(j) {
  const o = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  const s = (v) => (isStr(v) ? v : v === undefined ? '' : JSON.stringify(v)).slice(0, 20000);
  return { root_cause: s(o.root_cause), change: s(o.change), explanation: s(o.explanation), functions: Array.isArray(o.functions) ? o.functions.slice(0, 20).map((f) => ({ file: s(f?.file).slice(0, 300), name: s(f?.name).slice(0, 120), code: s(f?.code) })) : [] };
}
const REPRO_SHAPE = 'Return ONE JSON object with: hypothesis, expected, actual, test_name, test_code (strings) and evidence_ids (array of strings).';
const FIX_SHAPE = 'Return ONE JSON object with: root_cause, change, explanation (strings) and functions (non-empty array of {"file", "name", "code"} strings).';

const MAX_ATTEMPTS = 3;
const temp = (a) => [0.2, 0.6, 0.9][a - 1] ?? 0.9;

export async function runRepoPipeline({ kase, reposDir, emit, token }) {
  const run = { id: 'run_' + Date.now().toString(36), reportId: kase.id, kind: 'github', startedAt: new Date().toISOString(), steps: [], verdict: 'running', sandbox: { node: process.version, permissionModel: 'temp clone + timeout (third-party runners)', timeoutMs: 60000 } };
  const step = (type, data) => { const s = { type, at: new Date().toISOString(), ...data }; run.steps.push(s); emit?.(s); return s; };
  const fail = (verdict, reason) => { step('fatal', { error: reason }); run.verdict = verdict; return finish(run, emit); };
  const { owner, repo } = kase.repo;
  const dir = path.join(reposDir, `${owner}__${repo}`);

  // 1. prepare (deterministic)
  let sha, project = null, site = null;
  try {
    step('prepare', { stage: 'clone', note: `Cloning ${owner}/${repo}` });
    const t0 = Date.now();
    if (fs.existsSync(path.join(dir, '.git'))) { await resetRepo(dir); sha = kase.repo.sha; } else sha = await cloneRepo(kase.repo, dir, token);
    let projectErr = null;
    try { project = detectProject(dir); } catch (e) { projectErr = e; }
    site = detectSite(dir);
    if (wantsWebsite(site, project, kase.issue)) {
      step('prepare', { stage: 'detected', note: `${project?.name || repo}: website`, durationMs: Date.now() - t0, sha, mode: 'website' });
      const out = await runWebFlow({ kase, dir, site, project, step, run });
      if (!out) { if (run.verdict === 'running') run.verdict = 'not_reproduced'; return finish(run, emit); }
      run.verdict = out.fix ? 'fixed_verified' : 'reproduced_not_fixed';
      run.prMarkdown = webReport({ kase, run, ...out, sha });
      return finish(run, emit);
    }
    if (!project) throw projectErr || new Error('Unsupported project');
    if (project.needsInstall && !fs.existsSync(path.join(dir, 'node_modules'))) { step('prepare', { stage: 'install', note: 'Installing dependencies (install scripts disabled)' }); await installDeps(dir); }
    step('prepare', { stage: 'ready', note: `${project.name}: ${project.runner} tests`, durationMs: Date.now() - t0, project, sha });
  } catch (e) { return fail(run.verdict === 'running' ? 'not_reproduced' : run.verdict, e.message); }

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
    catch (e) {
      if (isBadOutput(e)) { step('repro.rejected', { attempt, proposal: normalizeRepro(null), rejection: 'invalid_json', reason: `Model output was not valid JSON (${e.message}).` }); feedback = `Your response was not valid JSON. ${REPRO_SHAPE}`; }
      else { step('model.error', { phase: 'reproduce', attempt, error: e.message }); feedback = `Your response could not be used: ${e.message}`; }
      continue;
    }
    const invalid = validateRepro(ans.json);
    if (invalid.length) { step('repro.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: normalizeRepro(ans.json), rejection: 'invalid_shape', reason: 'Model JSON has missing or wrong-type fields: ' + invalid.join('; ') }); feedback = `Your JSON did not match the schema:\n- ${invalid.join('\n- ')}\n${REPRO_SHAPE}`; continue; }
    const json = normalizeRepro(ans.json); json.test_code = json.test_code.replace(/^\s*```(?:[jt]s|javascript)?\s*\n?|```\s*$/g, '');
    const meta = { attempt, model: ans.model, durationMs: ans.durationMs, proposal: json };
    const problems = checkRepoTest(json.test_code);
    if (problems.length) { step('repro.rejected', { ...meta, rejection: 'unsafe', reason: 'Safety check failed: ' + problems.join('; ') }); feedback = problems.join('\n'); continue; }
    await resetRepo(dir);
    fs.mkdirSync(path.dirname(path.join(dir, testPath)), { recursive: true });
    fs.writeFileSync(path.join(dir, testPath), json.test_code);
    const result = await runOne(dir, project, testPath);
    if (result.passed) { step('repro.rejected', { ...meta, result, rejection: 'passed', reason: 'Test PASSED on the current code, so it does not reproduce the bug.' }); feedback = 'Your test passed on the current code, so it does not reproduce the issue. Re-read the issue and assert the behaviour it says is wrong.'; }
    else if (result.broken) { step('repro.rejected', { ...meta, result, rejection: 'crashed', reason: `The test itself is broken (${result.broken}), not the code under test.` }); feedback = `Your test failed because the test itself is broken: ${result.broken}\nOutput:\n${result.output.slice(-1500)}`; }
    else { repro = { ...json, result, model: ans.model, durationMs: ans.durationMs }; step('repro.confirmed', { ...meta, result }); }
  }
  await resetRepo(dir);
  if (!repro) { run.verdict = 'not_reproduced'; markModelUnavailable(run, 'reproduce'); return finish(run, emit); }

  // 4. patch + GREEN
  feedback = '';
  let fix = null;
  const allowed = files.map((f) => f.path);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !fix; attempt++) {
    step('model.start', { phase: 'fix', attempt });
    let ans;
    try { ans = await chatJson({ ...repoFixPrompt({ files, testPath, testCode: repro.test_code, failure: repro.result.output.slice(-2500), feedback }), schemaName: 'fix', schema: REPO_FIX_SCHEMA, temperature: temp(attempt) }); }
    catch (e) {
      if (isBadOutput(e)) { step('fix.rejected', { attempt, proposal: normalizeRepoFix(null), rejection: 'invalid_json', reason: `Model output was not valid JSON (${e.message}).` }); feedback = `Your response was not valid JSON. ${FIX_SHAPE}`; }
      else { step('model.error', { phase: 'fix', attempt, error: e.message }); feedback = `Your response could not be used: ${e.message}`; }
      continue;
    }
    const invalidFix = validateRepoFix(ans.json);
    if (invalidFix.length) { step('fix.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: normalizeRepoFix(ans.json), rejection: 'invalid_shape', reason: 'Model JSON has missing or wrong-type fields: ' + invalidFix.join('; ') }); feedback = `Your JSON did not match the schema:\n- ${invalidFix.join('\n- ')}\n${FIX_SHAPE}`; continue; }
    const proposal = normalizeRepoFix(ans.json);
    const meta = { attempt, model: ans.model, durationMs: ans.durationMs, proposal };
    await resetRepo(dir);
    let before;
    try { before = applyRepoPatch(dir, allowed, proposal.functions); }
    catch (e) {
      step('fix.rejected', { ...meta, rejection: 'patch_not_applicable', reason: 'Patch could not be applied: ' + e.message });
      feedback = /changes nothing/.test(e.message) ? `You returned the code UNCHANGED. Your own root cause was: "${proposal.root_cause}". Write the actual code change.` : e.message;
      continue;
    }
    const diff = Object.keys(before).map((f) => lineDiff(before[f], fs.readFileSync(path.join(dir, f), 'utf8'), f)).join('\n');
    const patchedFiles = Object.fromEntries(Object.keys(before).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
    fs.mkdirSync(path.dirname(path.join(dir, testPath)), { recursive: true });
    fs.writeFileSync(path.join(dir, testPath), repro.test_code);
    const r1 = await runOne(dir, project, testPath);
    fs.rmSync(path.join(dir, testPath), { force: true }); // run the repo's own suite without our test, then judge
    const r2 = await runSuite(dir);
    await resetRepo(dir);
    const suiteOk = r2.passed || (!baseline.passed && r2.fail <= baseline.fail && r2.fail > 0);
    const results = [r1, { ...r2, passed: suiteOk, note: !r2.passed && suiteOk ? 'already failing before; no new failures' : undefined }];
    if (r1.passed && suiteOk) {
      fix = { ...proposal, diff, results, model: ans.model, durationMs: ans.durationMs };
      run.patch = { files: { ...patchedFiles, [testPath]: repro.test_code }, testPath, sha }; // verified change + the new regression test
      step('fix.verified', { ...meta, diff, results });
    }
    else {
      const which = !r1.passed ? 'the reproduction test still fails' : 'it broke the repo\'s existing tests';
      step('fix.rejected', { ...meta, diff, results, rejection: !r1.passed ? 'repro_still_fails' : 'broke_suite', reason: `Patch applied but ${which}.` });
      feedback = `After your patch, ${which}. Output:\n` + (!r1.passed ? r1.output : r2.output).slice(-1500);
    }
  }
  run.verdict = fix ? 'fixed_verified' : 'reproduced_not_fixed';
  if (!fix) markModelUnavailable(run, 'fix');
  run.prMarkdown = repoReport({ kase, run, repro, fix, baseline, project, sha, testPath });
  return finish(run, emit);
}

function finish(run, emit) { run.finishedAt = new Date().toISOString(); emit?.({ type: 'done', verdict: run.verdict, runId: run.id, ...(run.reason ? { reason: run.reason, modelUnavailable: true } : {}) }); return run; }

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

function webReport({ kase, run, repro, fix, baseline, sha }) {
  const i = kase.issue;
  const steps = repro.steps.map((s, k) => `${k + 1}. \`${s.action}\`${s.target ? ` \`${s.target}\`` : ''}${s.value ? ` ${JSON.stringify(s.value)}` : ''}`).join('\n');
  return `## Fix #${kase.repo.number}: ${i.title}

${fix ? `Fixes #${kase.repo.number}.

✅ **Verified by RedGreen in a real browser**: the steps below failed on \`${sha}\` and pass with this patch${fix.results[1] ? `; the repo's own tests ${fix.results[1].passed ? 'pass' : 'fail'}` : ''}.` : `⚠️ Reproduced #${kase.repo.number} in a real browser; no patch passed verification yet.`}

### Root cause
${fix ? fix.root_cause : repro.hypothesis}

### Browser steps that reproduce it
${steps}

Before the patch:
\`\`\`
${repro.result.output}
\`\`\`
${fix ? `
### Patch
\`\`\`diff
${fix.diff}
\`\`\`

After the patch:
\`\`\`
${fix.results[0].output}
\`\`\`
` : ''}
---
_Generated by RedGreen run \`${run.id}\` with ${repro.model} running locally (it also read a screenshot of the page). Every result above comes from an actual browser run._
`;
}
