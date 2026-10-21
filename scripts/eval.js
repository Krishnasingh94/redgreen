// Honest eval: runs the FULL pipeline N times on the scripted sample report against the REAL model
// (LM Studio by default). Every number printed is measured; nothing is estimated. Model offline → exit 1.
//   npm run eval -- 5                      (bug 1 sample)
//   npm run eval -- 5 rpt_sample_coupon    (bug 2 sample)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { status } from '../src/model.js';
import { runPipeline } from '../src/pipeline.js';
import { sandboxInfo } from '../src/sandbox.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.REDGREEN_DATA || path.join(ROOT, 'data');
const N = Number(process.argv[2] ?? 5);
const REPORT = process.argv[3] || 'rpt_sample';
if (!/^rpt_sample[a-z0-9_]*$/.test(REPORT)) { console.error('report must be a scripted sample id, e.g. rpt_sample or rpt_sample_coupon'); process.exit(2); }
if (!Number.isInteger(N) || N < 1 || N > 100) { console.error('Usage: npm run eval -- <runs 1-100>'); process.exit(2); }

const s = await status();
if (!s.ok) { console.error(`❌ Model offline at ${s.baseUrl}: ${s.error}. Start the LM Studio server with Gemma 4 loaded. No eval was run.`); process.exit(1); }
console.log(`Model: ${s.model} @ ${s.baseUrl}${s.local ? ' (local)' : ' (REMOTE)'}${s.gemma4 ? '' : '  ⚠ not detected as Gemma 4'}`);
console.log(`Sandbox: Node ${sandboxInfo.node}, ${sandboxInfo.permissionModel}, timeout ${sandboxInfo.timeoutMs}ms`);

const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reports', REPORT + '.json'), 'utf8'));
const secs = (ms) => Math.round(ms) / 1000;
const runs = [];
for (let k = 1; k <= N; k++) {
  const t0 = Date.now(); const ev = [];
  const emit = (e) => ev.push({ ...e, t: Date.now() });
  let run;
  try { run = await runPipeline({ report, fixtureDir: path.join(ROOT, 'fixtures', 'shop'), emit }); }
  catch (e) { runs.push({ n: k, error: e.message, totalS: secs(Date.now() - t0) }); console.log(`run ${k}/${N}: ERROR ${e.message}`); continue; }
  const tBase = ev.find((e) => e.type === 'baseline')?.t ?? t0;
  const fixStart = ev.find((e) => e.type === 'model.start' && e.phase === 'fix')?.t;
  const tDone = ev.find((e) => e.type === 'done').t;
  const isFix = (e) => e.type.startsWith('fix.') || (e.phase === 'fix');
  const modelMs = (fix) => ev.filter((e) => e.durationMs && e.model && isFix(e) === fix).reduce((a, e) => a + e.durationMs, 0);
  const r = {
    n: k, runId: run.id, verdict: run.verdict,
    attempts: { reproduce: ev.filter((e) => e.type === 'model.start' && e.phase === 'reproduce').length, fix: ev.filter((e) => e.type === 'model.start' && e.phase === 'fix').length },
    modelErrors: ev.filter((e) => e.type === 'model.error').map((e) => e.error),
    rejections: ev.filter((e) => e.type.endsWith('.rejected')).map((e) => ({ type: e.type, attempt: e.attempt, rejection: e.rejection, reason: e.reason })),
    phasesS: { baseline: secs(tBase - t0), reproduce: secs((fixStart ?? tDone) - tBase), fix: fixStart ? secs(tDone - fixStart) : null, total: secs(tDone - t0) },
    modelS: { reproduce: secs(modelMs(false)), fix: fixStart ? secs(modelMs(true)) : null },
  };
  runs.push(r);
  console.log(`run ${k}/${N}: ${r.verdict}  attempts repro=${r.attempts.reproduce} fix=${r.attempts.fix}  ${r.phasesS.total}s${r.modelErrors.length ? `  (${r.modelErrors.length} model errors)` : ''}`);
}

const ok = runs.filter((r) => !r.error);
const avg = (xs) => { const v = xs.filter((x) => typeof x === 'number'); return v.length ? { avgS: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10, n: v.length } : { avgS: null, n: 0 }; };
const sum = (f) => ok.reduce((a, r) => a + f(r), 0);
const summary = {
  model: s.model, baseUrl: s.baseUrl, local: s.local, node: sandboxInfo.node, permissionModel: sandboxInfo.permissionModel,
  report: `${REPORT} (scripted sample)`, runsRequested: N, runsCompleted: ok.length, runsErrored: runs.length - ok.length,
  reproduced: ok.filter((r) => r.verdict !== 'not_reproduced').length,
  verified: ok.filter((r) => r.verdict === 'fixed_verified').length,
  attemptsUsed: { reproduce: sum((r) => r.attempts.reproduce), fix: sum((r) => r.attempts.fix), maxPerPhase: 3 },
  modelErrors: sum((r) => r.modelErrors.length),
  avgSecondsPerPhase: { baseline: avg(ok.map((r) => r.phasesS.baseline)), reproduce: avg(ok.map((r) => r.phasesS.reproduce)), fix: avg(ok.map((r) => r.phasesS.fix)), total: avg(ok.map((r) => r.phasesS.total)) },
  avgModelSeconds: { reproduce: avg(ok.map((r) => r.modelS.reproduce)), fix: avg(ok.map((r) => r.modelS.fix)) },
};
const at = new Date().toISOString();
const file = path.join(DATA, 'eval', `eval-${at.replace(/[:.]/g, '-')}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ at, summary, runs }, null, 2));

const f = (p) => p.avgS === null ? 'n/a' : `${p.avgS}s (n=${p.n})`;
console.log(`\n=== RedGreen eval: ${s.model} on ${REPORT} ===
Runs           : ${ok.length}/${N} completed${summary.runsErrored ? `, ${summary.runsErrored} errored` : ''}
Reproduced     : ${summary.reproduced}/${ok.length}
Verified fixed : ${summary.verified}/${ok.length}
Attempts used  : reproduce ${summary.attemptsUsed.reproduce}, fix ${summary.attemptsUsed.fix} (max 3 per phase per run)${summary.modelErrors ? `\nModel errors   : ${summary.modelErrors}` : ''}
Avg per phase  : baseline ${f(summary.avgSecondsPerPhase.baseline)} · reproduce ${f(summary.avgSecondsPerPhase.reproduce)} · fix ${f(summary.avgSecondsPerPhase.fix)} · total ${f(summary.avgSecondsPerPhase.total)}
  of which model: reproduce ${f(summary.avgModelSeconds.reproduce)} · fix ${f(summary.avgModelSeconds.fix)}
Saved          : ${path.relative(process.cwd(), file)}`);
process.exit(ok.length ? 0 : 1);
