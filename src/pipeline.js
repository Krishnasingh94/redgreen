import fs from 'node:fs';
import path from 'node:path';
import { chatJson } from './model.js';
import { reproPrompt, fixPrompt, REPRO_SCHEMA, FIX_SCHEMA } from './prompts.js';
import { checkTestCode, applyEdits, replaceFunctions, normalizeTestCode } from './guard.js';
import { createWorkspace, removeWorkspace, runTestFile, sandboxInfo } from './sandbox.js';
import { lineDiff, buildPatch } from './diff.js';
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

// Oracle check (deterministic): numbers that independent sources in the evidence report — failed responses,
// console errors, crashes. If any exist, the test's expected value must be one of them; a test that "fails"
// against a made-up expectation proves nothing.
function evidenceNumbers(report) {
  const texts = report.events.filter((e) => e.type !== 'action').map((e) => [e.message, e.responseBody, e.error].filter(Boolean).join(' '));
  return [...new Set(texts.join(' ').match(/-?\d+(?:\.\d+)?/g)?.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n < 1e9) || [])];
}
// Retries at higher temperature: at low temperature a small model tends to repeat the exact answer we just rejected.
const retryTemp = (attempt) => [0.2, 0.6, 0.9][attempt - 1] ?? 0.9;
const SOURCE = 'src/cart.js';
const EXISTING = 'test/cart.test.js';
const REPRO = 'test/repro.test.js';

// ---- Model output validation. The model is untrusted: check shape before use, and only ever
// emit normalised proposals (all fields present, right types) so the UI can always render them.
const isStr = (v) => typeof v === 'string';
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const kindOf = (v) => v === undefined ? 'missing' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const asText = (v) => (isStr(v) ? v : v === undefined ? '' : JSON.stringify(v)).slice(0, 20000);

export function validateRepro(j) {
  if (!isObj(j)) return [`response must be a JSON object (got ${kindOf(j)})`];
  const errs = [];
  for (const k of ['hypothesis', 'expected', 'actual', 'test_name', 'test_code']) if (!isStr(j[k])) errs.push(`"${k}" must be a string (got ${kindOf(j[k])})`);
  if (!Array.isArray(j.evidence_ids) || !j.evidence_ids.every(isStr)) errs.push(`"evidence_ids" must be an array of strings (got ${kindOf(j.evidence_ids)})`);
  return errs;
}

export function validateFix(j) {
  if (!isObj(j)) return [`response must be a JSON object (got ${kindOf(j)})`];
  const errs = [];
  if (!isStr(j.root_cause)) errs.push(`"root_cause" must be a string (got ${kindOf(j.root_cause)})`);
  for (const k of ['explanation', 'change']) if (j[k] !== undefined && !isStr(j[k])) errs.push(`"${k}" must be a string (got ${kindOf(j[k])})`);
  const hasFns = Array.isArray(j.functions) && j.functions.length > 0, hasEdits = Array.isArray(j.edits) && j.edits.length > 0;
  if (!hasFns && !hasEdits) errs.push(`"functions" must be a non-empty array of {name, code} (got ${kindOf(j.functions)})`);
  else if (hasFns) j.functions.forEach((f, i) => { if (!isObj(f) || !isStr(f.name) || !isStr(f.code)) errs.push(`functions[${i}] must be {"name": string, "code": string}`); });
  else j.edits.forEach((e, i) => { if (!isObj(e) || !isStr(e.find) || !isStr(e.replace)) errs.push(`edits[${i}] must be {"find": string, "replace": string}`); });
  return errs;
}

export function normalizeRepro(j) {
  const o = isObj(j) ? j : {};
  return { hypothesis: asText(o.hypothesis), evidence_ids: Array.isArray(o.evidence_ids) ? o.evidence_ids.map((x) => asText(x).slice(0, 40)).slice(0, 50) : [], expected: asText(o.expected), actual: asText(o.actual), test_name: asText(o.test_name), test_code: asText(o.test_code) };
}

export function normalizeFix(j) {
  const o = isObj(j) ? j : {};
  return {
    root_cause: asText(o.root_cause), change: asText(o.change), explanation: asText(o.explanation),
    functions: Array.isArray(o.functions) ? o.functions.slice(0, 20).map((f) => ({ name: asText(f?.name).slice(0, 80), code: asText(f?.code) })) : [],
    edits: Array.isArray(o.edits) ? o.edits.slice(0, 20).map((e) => ({ find: asText(e?.find), replace: asText(e?.replace) })) : [],
  };
}

// chatJson throws these when the endpoint answered but the text wasn't a JSON object.
export const isBadOutput = (e) => /did not return valid JSON|empty model response/.test(e.message);
const REPRO_SHAPE = 'Return ONE JSON object with: hypothesis (string), evidence_ids (array of strings), expected (string), actual (string), test_name (string), test_code (string).';
const FIX_SHAPE = 'Return ONE JSON object with: root_cause (string), change (string), functions (non-empty array of {"name": string, "code": string} where code is the complete rewritten function), explanation (string).';

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

  const oracle = evidenceNumbers(report);
  const oracleOk = (output) => { const e = Number(testFacts('', output).expected); return !Number.isFinite(e) || oracle.includes(e); };

  // 1. Reproduce: model writes test; we only accept it if it FAILS on current code with an assertion
  let repro = null, feedback = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !repro; attempt++) {
    step('model.start', { phase: 'reproduce', attempt });
    let ans;
    try { ans = await chatJson({ ...reproPrompt({ evidence: { description: report.description, env: report.env, events: report.events }, source, existingTests, feedback, hasScreenshot: !!report.screenshot }), schemaName: 'repro', schema: REPRO_SCHEMA, images: report.screenshot ? [report.screenshot] : [], temperature: retryTemp(attempt) }); }
    catch (e) {
      if (isBadOutput(e)) { step('repro.rejected', { attempt, proposal: normalizeRepro(null), rejection: 'invalid_json', reason: `Model output was not valid JSON (${e.message}).` }); feedback = `Your response was not valid JSON. ${REPRO_SHAPE} No prose, no markdown.`; }
      else { step('model.error', { phase: 'reproduce', attempt, error: e.message }); feedback = `Your response could not be used: ${e.message}`; }
      continue;
    }
    const invalid = validateRepro(ans.json);
    if (invalid.length) { step('repro.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: normalizeRepro(ans.json), rejection: 'invalid_shape', reason: 'Model JSON has missing or wrong-type fields: ' + invalid.join('; ') }); feedback = `Your JSON did not match the schema:\n- ${invalid.join('\n- ')}\n${REPRO_SHAPE}`; continue; }
    const json = normalizeRepro(ans.json);
    json.test_code = normalizeTestCode(json.test_code);
    const problems = checkTestCode(json.test_code);
    if (problems.length) { step('repro.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: json, rejection: 'unsafe', reason: 'Static safety check failed: ' + problems.join('; ') }); feedback = problems.join('\n'); continue; }
    ws = createWorkspace(fixtureDir);
    fs.writeFileSync(path.join(ws, REPRO), json.test_code);
    const result = await runTestFile(ws, REPRO);
    removeWorkspace(ws);
    if (result.passed) {
      step('repro.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: json, result, rejection: 'passed', reason: 'Test PASSED on the buggy code, so it does not reproduce the bug.' });
      feedback = 'Your test passed on the current (buggy) code, so it does not reproduce the reported bug. Re-read the evidence: replay the exact action order and assert what the user should have seen.';
    } else if (!result.assertionFailure) {
      const why = result.timedOut ? `killed at the ${sandboxInfo.timeoutMs}ms sandbox timeout: infinite loop or hang` : 'syntax/import/runtime error';
      step('repro.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: json, result, rejection: 'crashed', reason: `Test crashed instead of failing an assertion (${why}).` });
      feedback = result.timedOut ? 'Your test never finished: it was killed at the sandbox timeout. Remove loops or waits that never end; the test must run synchronously and fail an assertion.'
        : 'Your test crashed instead of failing an assertion. Output:\n' + result.output.slice(-1500);
    } else if (oracle.length && !oracleOk(result.output)) {
      const exp = testFacts(json.test_code, result.output).expected;
      step('repro.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: json, result, rejection: 'unsupported_expected', reason: `The test expects ${exp}, but no independent source in the evidence reports that value. Values reported by the server/errors: ${oracle.join(', ')}.` });
      feedback = `Your test asserts an expected value of ${exp}, which is not supported by the evidence. Independent sources in the evidence (server responses, error messages) report these values: ${oracle.join(', ')}. Use the correct expected value the evidence supports.`;
    } else {
      repro = { ...json, result, model: ans.model, durationMs: ans.durationMs };
      step('repro.confirmed', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: json, result });
    }
  }
  if (!repro) { run.verdict = 'not_reproduced'; markModelUnavailable(run, 'reproduce'); return finish(run, emit); }

  // 2. Fix: model rewrites whole functions (or find/replace edits); verified only if repro test AND existing tests pass
  feedback = '';
  let fix = null;
  const facts = testFacts(repro.test_code, repro.result.output);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !fix; attempt++) {
    step('model.start', { phase: 'fix', attempt });
    let ans;
    try { ans = await chatJson({ ...fixPrompt({ source, testCode: repro.test_code, failure: repro.result.output.slice(-2500), feedback, facts }), schemaName: 'fix', schema: FIX_SCHEMA, temperature: retryTemp(attempt) }); }
    catch (e) {
      if (isBadOutput(e)) { step('fix.rejected', { attempt, proposal: normalizeFix(null), rejection: 'invalid_json', reason: `Model output was not valid JSON (${e.message}).` }); feedback = `Your response was not valid JSON. ${FIX_SHAPE} No prose, no markdown.`; }
      else { step('model.error', { phase: 'fix', attempt, error: e.message }); feedback = `Your response could not be used: ${e.message}`; }
      continue;
    }
    const invalid = validateFix(ans.json);
    if (invalid.length) { step('fix.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal: normalizeFix(ans.json), rejection: 'invalid_shape', reason: 'Model JSON has missing or wrong-type fields: ' + invalid.join('; ') }); feedback = `Your JSON did not match the schema:\n- ${invalid.join('\n- ')}\n${FIX_SHAPE}`; continue; }
    const proposal = normalizeFix(ans.json);
    let patched;
    try { patched = proposal.functions.length ? replaceFunctions(source, proposal.functions) : applyEdits(source, proposal.edits); }
    catch (e) {
      step('fix.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal, rejection: 'patch_not_applicable', reason: 'Patch could not be applied: ' + e.message });
      feedback = /changes nothing/.test(e.message)
        ? `You returned ${proposal.functions.map((f) => f.name).join(', ') || 'the functions'} UNCHANGED. If you could not find a change to make there, the fix probably belongs in a different function: the test calls, in order, ${facts.calls.join(' → ')}. The value is still correct after some calls and wrong after a later one; change the function where it goes wrong (or the function that computes the final value). Write real code changes.`
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
      fix = { ...proposal, diff, patched, results: [r1, r2], model: ans.model, durationMs: ans.durationMs };
      step('fix.verified', { attempt, model: ans.model, durationMs: ans.durationMs, proposal, diff, results: [r1, r2] });
    } else {
      const which = !r1.passed ? 'the reproduction test still fails' : 'it broke the existing tests';
      step('fix.rejected', { attempt, model: ans.model, durationMs: ans.durationMs, proposal, diff, results: [r1, r2], rejection: !r1.passed ? 'repro_still_fails' : 'broke_suite', reason: `Patch applied but ${which}.` });
      feedback = `After your patch, ${which}. Output:\n` + (!r1.passed ? r1.output : r2.output).slice(-1500);
    }
  }
  run.verdict = fix ? 'fixed_verified' : 'reproduced_not_fixed';
  if (!fix) markModelUnavailable(run, 'fix');
  run.repro = repro; run.fix = fix;
  // git-applicable patch (source change + repro test as a new file), only for verified fixes.
  if (fix) run.patch = buildPatch({ source, patched: fix.patched, testCode: repro.test_code });
  run.prMarkdown = buildReport({ report, run, repro, fix, baseline });
  return finish(run, emit);
}

// If EVERY attempt in a phase failed to reach the model, nothing was tested: say so instead of implying
// the model tried and failed. The verdict keeps its contract value; `reason` + `modelUnavailable` explain it.
export function markModelUnavailable(run, phase) {
  const attempts = run.steps.filter((s) => s.type === 'model.start' && s.phase === phase).length;
  const errors = run.steps.filter((s) => s.type === 'model.error' && s.phase === phase);
  if (attempts && errors.length === attempts) {
    run.modelUnavailable = true;
    run.reason = `Model unavailable in the ${phase} phase (${errors.at(-1).error}). ${phase === 'reproduce' ? 'No test was written or run' : 'No patch was proposed or run'}; start the LM Studio server and run again.`;
  }
}

function finish(run, emit) {
  run.finishedAt = new Date().toISOString();
  emit?.({ type: 'done', verdict: run.verdict, runId: run.id, ...(run.reason ? { reason: run.reason, modelUnavailable: true } : {}) });
  return run;
}
