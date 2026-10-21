import fs from 'node:fs';
import path from 'node:path';
import { chatJson } from './model.js';
import { reproPrompt, fixPrompt, REPRO_SCHEMA, FIX_SCHEMA } from './prompts.js';
import { checkTestCode, applyEdits, replaceFunctions, normalizeTestCode } from './guard.js';
import { createWorkspace, removeWorkspace, runTestFile, sandboxInfo } from './sandbox.js';
import { lineDiff } from './diff.js';
import { buildReport } from './report.js';

const MAX_ATTEMPTS = 3;
const CART_FNS = ['createCart', 'addItem', 'setQuantity', 'applyCoupon', 'subtotal', 'total'];

// Deterministic facts extracted from the failing test + its output (no AI): call order and the assertion values.
function testFacts(testCode, output) {
  const calls = [...testCode.matchAll(new RegExp(`\\b(${CART_FNS.join('|')})\\s*\\(`, 'g'))].map((m) => m[1]);
  const actual = output.match(/actual:\s*([^\n,]+)/)?.[1]?.trim();
  const expected = output.match(/expected:\s*([^\n,]+)/)?.[1]?.trim();
  return { calls, actual, expected };
}
// Retries at higher temperature: at low temperature a small model tends to repeat the exact answer we just rejected.
const retryTemp = (attempt) => [0.2, 0.6, 0.9][attempt - 1] ?? 0.9;
const SOURCE = 'src/cart.js';
const EXISTING = 'test/cart.test.js';
const REPRO = 'test/repro.test.js';

export async function runPipeline({ report, fixtureDir, emit }) {
  const run = { id: 'run_' + Date.now().toString(36), reportId: report.id, startedAt: new Date().toISOString(), steps: [], verdict: 'running', sandbox: sandboxInfo };
  const step = (type, data) => { const s = { type, at: new Date().toISOString(), ...data }; run.steps.push(s); emit?.(s); return s; };
  const source = fs.readFileSync(path.join(fixtureDir, SOURCE), 'utf8');
  const existingTests = fs.readFileSync(path.join(fixtureDir, EXISTING), 'utf8');

  step('evidence', { events: report.events.length, redactions: report.redactions, description: report.description, screenshot: !!report.screenshot });

  // 0. Baseline: existing suite on original code (deterministic, no AI)
  let ws = createWorkspace(fixtureDir);
  const baseline = await runTestFile(ws, EXISTING);
  removeWorkspace(ws);
  step('baseline', { result: baseline, note: baseline.passed ? 'Existing tests pass on current code — they do not catch this bug.' : 'Existing tests already fail.' });

  // 1. Reproduce: model writes test; we only accept it if it FAILS on current code with an assertion
  let repro = null, feedback = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !repro; attempt++) {
    step('model.start', { phase: 'reproduce', attempt });
    let ans;
    try { ans = await chatJson({ ...reproPrompt({ evidence: { description: report.description, env: report.env, events: report.events }, source, existingTests, feedback, hasScreenshot: !!report.screenshot }), schemaName: 'repro', schema: REPRO_SCHEMA, images: report.screenshot ? [report.screenshot] : [], temperature: retryTemp(attempt) }); }
    catch (e) { step('model.error', { phase: 'reproduce', attempt, error: e.message }); feedback = `Your response could not be used: ${e.message}`; continue; }
    const { json } = ans;
    json.test_code = normalizeTestCode(json.test_code);
    const problems = checkTestCode(json.test_code);
    if (problems.length) { step('repro.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: json, reason: 'Static safety check failed: ' + problems.join('; ') }); feedback = problems.join('\n'); continue; }
    ws = createWorkspace(fixtureDir);
    fs.writeFileSync(path.join(ws, REPRO), json.test_code);
    const result = await runTestFile(ws, REPRO);
    removeWorkspace(ws);
    if (result.passed) {
      step('repro.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: json, result, reason: 'Test PASSED on the buggy code, so it does not reproduce the bug.' });
      feedback = 'Your test passed on the current (buggy) code, so it does not reproduce the reported bug. Re-read the evidence: replay the exact action order and assert what the user should have seen.';
    } else if (!result.assertionFailure) {
      step('repro.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: json, result, reason: 'Test crashed instead of failing an assertion (syntax/import/runtime error).' });
      feedback = 'Your test crashed instead of failing an assertion. Output:\n' + result.output.slice(-1500);
    } else {
      repro = { ...json, result, model: ans.model, durationMs: ans.durationMs };
      step('repro.confirmed', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: json, result });
    }
  }
  if (!repro) { run.verdict = 'not_reproduced'; return finish(run, emit); }

  // 2. Fix: model proposes find/replace edits; verified only if repro test AND existing tests pass
  feedback = '';
  let fix = null;
  const facts = testFacts(repro.test_code, repro.result.output);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !fix; attempt++) {
    step('model.start', { phase: 'fix', attempt });
    let ans;
    try { ans = await chatJson({ ...fixPrompt({ source, testCode: repro.test_code, failure: repro.result.output.slice(-2500), feedback, facts }), schemaName: 'fix', schema: FIX_SCHEMA, temperature: retryTemp(attempt) }); }
    catch (e) { step('model.error', { phase: 'fix', attempt, error: e.message }); feedback = `Your response could not be used: ${e.message}`; continue; }
    let patched;
    try { patched = Array.isArray(ans.json.functions) ? replaceFunctions(source, ans.json.functions) : applyEdits(source, ans.json.edits); }
    catch (e) {
      step('fix.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: ans.json, reason: 'Patch could not be applied: ' + e.message });
      feedback = /changes nothing/.test(e.message)
        ? `You returned ${(ans.json.functions || []).map((f) => f.name).join(', ') || 'the functions'} UNCHANGED. If you could not find a change to make there, the fix probably belongs in a different function: the test calls, in order, ${facts.calls.join(' → ')}. The value is still correct after some calls and wrong after a later one; change the function where it goes wrong (or the function that computes the final value). Write real code changes.`
        : e.message;
      continue;
    }
    const diff = lineDiff(source, patched);
    ws = createWorkspace(fixtureDir);
    fs.writeFileSync(path.join(ws, SOURCE), patched);
    fs.writeFileSync(path.join(ws, REPRO), repro.test_code);
    const r1 = await runTestFile(ws, REPRO);
    const r2 = await runTestFile(ws, EXISTING);
    removeWorkspace(ws);
    if (r1.passed && r2.passed) {
      fix = { ...ans.json, diff, patched, results: [r1, r2], model: ans.model, durationMs: ans.durationMs };
      step('fix.verified', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: ans.json, diff, results: [r1, r2] });
    } else {
      const which = !r1.passed ? 'the reproduction test still fails' : 'it broke the existing tests';
      step('fix.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: ans.json, diff, results: [r1, r2], reason: `Patch applied but ${which}.` });
      feedback = `After your patch, ${which}. Output:\n` + (!r1.passed ? r1.output : r2.output).slice(-1500);
    }
  }
  run.verdict = fix ? 'fixed_verified' : 'reproduced_not_fixed';
  run.repro = repro; run.fix = fix;
  run.prMarkdown = buildReport({ report, run, repro, fix, baseline });
  return finish(run, emit);
}

function finish(run, emit) {
  run.finishedAt = new Date().toISOString();
  emit?.({ type: 'done', verdict: run.verdict, runId: run.id });
  return run;
}
