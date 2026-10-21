// Website flow (called from the GitHub pipeline once the repo is cloned): screenshot -> browser steps must FAIL -> patch -> same steps PASS.
import fs from 'node:fs';
import path from 'node:path';
import { chatJson } from './model.js';
import { WEB_REPRO_SCHEMA, WEB_FIX_SCHEMA, webReproPrompt, webFixPrompt } from './prompts.js';
import { serveStatic, startDevServer, launchBrowser, snapshotPage, validateSteps, runSteps } from './web.js';
import { rankFiles, excerpt, WEB_EXT } from './locate.js';
import { runSuite, applyRepoPatch, resetRepo } from './repo.js';
import { installDeps } from './github.js';
import { lineDiff } from './diff.js';

const MAX_ATTEMPTS = 3;
const temp = (a) => [0.2, 0.6, 0.9][a - 1] ?? 0.9;
const UI_WORDS = /\b(click|button|page|screen|display|shows?|shown|form|ui|css|layout|website|site|browser|modal|menu|navbar|render|visible|hidden|style|color|colour|scroll|input|field|dropdown|checkbox|link|image|mobile|responsive|total|cart)\b/i;

export function wantsWebsite(site, project, issue) {
  if (!site) return false;
  if (!project) return true;
  return UI_WORDS.test(issue.title + ' ' + issue.body);
}

export async function runWebFlow({ kase, dir, site, project, step, run }) {
  const issue = kase.issue;
  let server, browser;
  try {
    if (site.kind === 'dev' && !fs.existsSync(path.join(dir, 'node_modules'))) { step('prepare', { stage: 'install', note: 'Installing dependencies (install scripts disabled)' }); await installDeps(dir); }
    step('prepare', { stage: 'serve', note: site.kind === 'static' ? `Serving the site from /${site.root}` : `Starting the site with npm run ${site.script}` });
    server = site.kind === 'static' ? await serveStatic(path.join(dir, site.root)) : await startDevServer(dir, site.script);
    browser = await launchBrowser();
    const snap = await snapshotPage(browser, server.url);
    step('prepare', { stage: 'ready', note: `Website mode: ${site.kind === 'static' ? 'static site' : 'dev server'} at ${server.url}`, mode: 'website' });
    step('page', { screenshot: snap.screenshot, url: server.url, errors: snap.errors });

    const located = rankFiles(dir, issue.title + '\n' + issue.body + '\n' + snap.outline, 3, WEB_EXT);
    const idx = path.posix.join(site.root || '', 'index.html').replace(/^\//, '');
    if (fs.existsSync(path.join(dir, idx)) && !located.source.some((f) => f.path === idx)) located.source.unshift({ path: idx, score: 0, terms: ['page entry'], lines: fs.readFileSync(path.join(dir, idx), 'utf8').split('\n').length });
    const files = located.source.slice(0, 4).map((f) => ({ ...f, text: excerpt(dir, f.path, f.terms, 260) }));
    step('located', { files: files.map(({ path: p, score, terms, lines }) => ({ path: p, score, terms, lines })), mode: 'website' });

    const hasSuite = project && project.testScript && !/no test specified/.test(project.testScript);
    const baseline = hasSuite ? await runSuite(dir) : null;
    step('baseline', baseline ? { result: baseline, note: baseline.passed ? 'The repo\'s tests pass on current code — they do not catch this bug.' : 'The repo\'s tests already fail on current code.' }
      : { result: { file: 'repo tests', passed: true, pass: 0, fail: 0, exitCode: 0, durationMs: 0, output: 'This repo has no automated test suite. RedGreen will rely on the browser check.' }, note: 'No automated tests in this repo; the browser check is the proof.', none: true });

    // RED: steps must fail on an expect_* step
    let repro = null, feedback = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !repro; attempt++) {
      step('model.start', { phase: 'reproduce', attempt });
      let ans;
      try { ans = await chatJson({ ...webReproPrompt({ issue, outline: snap.outline, files, feedback }), schemaName: 'web_repro', schema: WEB_REPRO_SCHEMA, images: [snap.screenshot], temperature: temp(attempt) }); }
      catch (e) { step('model.error', { phase: 'reproduce', attempt, error: e.message }); feedback = `Your response could not be used: ${e.message}`; continue; }
      const json = ans.json, meta = { attempt, model: ans.model, durationMs: ans.durationMs, proposal: json };
      const problems = validateSteps(json.steps);
      if (problems.length) { step('repro.rejected', { ...meta, reason: 'Steps rejected: ' + problems.join('; ') }); feedback = problems.join('\n'); continue; }
      const result = await runSteps(browser, server.url, json.steps);
      if (result.passed) { step('repro.rejected', { ...meta, result, reason: 'Every check PASSED on the current site, so the steps do not reproduce the bug.' }); feedback = 'All your expect_* checks passed on the current site. Re-read the issue: assert the value the issue says is WRONG should be correct.\nRun log:\n' + result.output; }
      else if (result.broken) { step('repro.rejected', { ...meta, result, reason: `The steps themselves failed: ${result.broken}` }); feedback = `Your steps could not run: ${result.broken}. Use selectors from the PAGE OUTLINE.\nRun log:\n${result.output}`; }
      else { repro = { ...json, result, model: ans.model, durationMs: ans.durationMs }; step('repro.confirmed', { ...meta, result }); }
    }
    if (!repro) { run.verdict = 'not_reproduced'; return null; }

    // GREEN: patch, then the same steps must pass (and the repo's tests must not get worse)
    feedback = '';
    const allowed = files.map((f) => f.path);
    const failure = `${repro.result.output}`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      step('model.start', { phase: 'fix', attempt });
      let ans;
      try { ans = await chatJson({ ...webFixPrompt({ files: files.map((f) => ({ ...f, text: f.lines <= 260 ? fs.readFileSync(path.join(dir, f.path), 'utf8') : f.text })), steps: repro.steps, failure, feedback }), schemaName: 'web_fix', schema: WEB_FIX_SCHEMA, images: [repro.result.screenshot], temperature: temp(attempt) }); }
      catch (e) { step('model.error', { phase: 'fix', attempt, error: e.message }); feedback = `Your response could not be used: ${e.message}`; continue; }
      const meta = { attempt, model: ans.model, durationMs: ans.durationMs, proposal: { ...ans.json, functions: ans.json.changes } };
      await resetRepo(dir);
      let before;
      try { before = applyWebChanges(dir, allowed, ans.json.changes); }
      catch (e) { await resetRepo(dir); step('fix.rejected', { ...meta, reason: 'Patch could not be applied: ' + e.message }); feedback = /changes nothing/.test(e.message) ? `You returned the code UNCHANGED. Your root cause was "${ans.json.root_cause}". Write the actual change.` : e.message; continue; }
      const diff = Object.keys(before).map((f) => lineDiff(before[f], fs.readFileSync(path.join(dir, f), 'utf8'), f)).join('\n');
      if (site.kind === 'dev') await new Promise((r) => setTimeout(r, 2000)); // let hot reload pick it up
      const r1 = await runSteps(browser, server.url, repro.steps);
      const r2 = hasSuite ? await runSuite(dir) : null;
      const suiteOk = !r2 || r2.passed || (baseline && !baseline.passed && r2.fail <= baseline.fail);
      const results = [r1, ...(r2 ? [{ ...r2, passed: suiteOk }] : [])];
      if (r1.passed && suiteOk) {
        step('fix.verified', { ...meta, diff, results, before: repro.result.screenshot, after: r1.screenshot });
        run.fix = { ...ans.json, diff };
        await resetRepo(dir);
        return { repro, fix: { ...ans.json, diff, results }, baseline };
      }
      await resetRepo(dir);
      const which = !r1.passed ? (r1.broken ? `the steps could not run after the patch (${r1.broken})` : 'the browser check still fails') : 'it broke the repo\'s tests';
      step('fix.rejected', { ...meta, diff, results, reason: `Patch applied but ${which}.` });
      feedback = `After your patch, ${which}.\nRun log:\n${r1.output}${r2 && !suiteOk ? '\nTest output:\n' + r2.output.slice(-1200) : ''}`;
    }
    return { repro, fix: null, baseline };
  } finally {
    try { await browser?.close(); } catch {}
    try { server?.close(); } catch {}
  }
}

function applyWebChanges(dir, allowed, changes) {
  if (!Array.isArray(changes) || !changes.length) throw new Error('patch has no changes');
  if (changes.length > 5) throw new Error('patch too large (max 5 changes)');
  const before = {};
  for (const [i, c] of changes.entries()) {
    const file = String(c?.file || '').replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!allowed.includes(file)) throw new Error(`change ${i + 1}: "${file}" is not one of the files shown (${allowed.join(', ')})`);
    const abs = path.join(dir, file);
    before[file] ??= fs.readFileSync(abs, 'utf8');
    if (c.name) { applyRepoPatch(dir, allowed, [{ file, name: c.name, code: c.code }]); continue; }
    const src = fs.readFileSync(abs, 'utf8');
    if (!c.find) throw new Error(`change ${i + 1}: give either "name" (function or "*") or an exact "find" snippet`);
    const n = src.split(c.find).length - 1;
    if (!n) throw new Error(`change ${i + 1}: "find" snippet not found in ${file}`);
    if (n > 1) throw new Error(`change ${i + 1}: "find" snippet matches ${n} places in ${file}; include more context`);
    fs.writeFileSync(abs, src.replace(c.find, () => c.code));
  }
  if (Object.entries(before).every(([f, s]) => fs.readFileSync(path.join(dir, f), 'utf8') === s)) throw new Error('patch changes nothing');
  return before;
}
