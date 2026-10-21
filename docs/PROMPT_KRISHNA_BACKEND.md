# Prompt for Krishna's Claude (backend owner)

Copy everything below the line into Claude together with the project folder (or the GitHub repo).

---

You are my pair programmer for a hackathon. Submissions close **today, Oct 21 2026, 5:00 PM IST**, and I need my work merged by **2:30 PM IST**. Be fast, careful and concise. Don't rewrite working code.

## Project
**RedGreen**: bug report → failing test → verified fix, using **Gemma 4 running locally in LM Studio**. Read `README.md` first, then the files listed below.
Flow: the demo shop's recorder captures user actions, errors and failed requests (plus an optional screenshot). The report is redacted and saved. Gemma writes a reproduction test, which we accept only if it **fails with an assertion** on the current code (RED). Gemma then proposes find/replace edits, and we accept them only if that same test **and** the existing suite **pass** (GREEN). Finally we build a PR description from the real outputs. Zero npm dependencies; Node ≥ 20 (≥ 22.13 for the permission-model sandbox).

## Ownership (strict — do not edit files outside mine)
- **Me (Krishna, backend):** `server.js`, `src/pipeline.js`, `src/sandbox.js`, `src/guard.js`, `src/redact.js`, `src/report.js`, `src/diff.js`, `scripts/`, `test/`, `fixtures/shop/src/`, `fixtures/shop/test/`, `data/`.
- **Samvit (frontend + AI):** `ui/`, `fixtures/shop/public/`, `src/model.js`, `src/prompts.js`. If I need a change there, write it down as a request for Samvit instead of editing.

## Contracts I must NOT break (Samvit's UI depends on them)
- `GET /api/status` → `{ model:{ok,model,baseUrl,local,gemma4,error?}, sandbox:{permissionModel,timeoutMs,node}, busy }`
- `POST /api/reports` (body `redgreen.evidence/v1` bundle, optional `screenshot` data URL) → `201 {id, redactions}`
- `GET /api/reports`, `GET /api/reports/:id`, `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/pr.md`
- `GET /api/analyze/:reportId` = SSE stream. Event `type`s: `evidence, baseline, model.start, model.error, repro.rejected, repro.confirmed, fix.rejected, fix.verified, fatal, done`. Fields used by the UI: `result{file,passed,pass,fail,exitCode,durationMs,output}`, `proposal{hypothesis,evidence_ids,expected,actual,test_code | root_cause,edits}`, `diff`, `results[]`, `reason`, `model`, `durationMs`, `attempt`, `verdict`, `runId`.
- Verdicts: `fixed_verified | reproduced_not_fixed | not_reproduced`.
You may ADD fields/endpoints. Do not rename or remove any. Tell me exactly what you added so I can tell Samvit.

## Non-negotiables
- Never mark anything reproduced or verified unless the test actually ran; verdicts come from exit codes, not the model.
- Model-generated code never runs on the host outside `src/sandbox.js`. No shell, timeout always on.
- Redact before storing or sending to the model. Never commit secrets or real user data.
- Don't add npm dependencies.
- After every change: `npm test` and `npm run check:sandbox` must pass. Show me the output.

## Tasks, in priority order (stop and report after each)
1. **Windows check (most important).** I'm on Windows. Run `npm test` and `npm run check:sandbox`. If the sandbox fails or the permission flag path is wrong on Windows (`--allow-fs-read` with backslash paths / `*` wildcard), fix `src/sandbox.js` so: the generated test can read the sandbox dir, cannot write anywhere, cannot spawn processes. Also verify paths with spaces work (folder may be named `pr guardian`). Confirm `<sandbox>` path masking in output works with Windows paths.
2. **Validate model JSON in `src/pipeline.js`** before use. If fields are missing or the wrong type (e.g. `evidence_ids` not an array, `edits` missing, `test_code` not a string), treat it as a rejected attempt with a clear `reason` and feedback for the retry. Never crash and never emit a `proposal` the UI can't render. Add tests in `test/` for: model returns garbage, model returns a test that crashes (syntax error), model returns a patch whose `find` isn't in the file, model returns a patch that breaks the existing suite. Use a mock OpenAI-compatible server the way `test/pipeline.test.js` does.
3. **Sandbox timeout test.** Add a test proving an infinite-loop test is killed at the timeout and reported as a failed run (not an assertion failure → should be rejected as "crashed").
4. **Patch download.** Add `GET /api/runs/:id/patch.diff` returning the verified unified diff plus the repro test as a new file, so a maintainer can `git apply` it. Return 404 if the run isn't `fixed_verified`.
5. **Honest eval script.** Add `scripts/eval.js` (`npm run eval -- 5`) that runs the full pipeline N times on `data/reports/rpt_sample.json` against the real LM Studio model and prints: reproduced count, verified count, attempts used, average seconds per phase, and model id. Save results to `data/eval/eval-<timestamp>.json`. No made-up numbers; if the model is offline, exit with an error.
6. **Second scenario (only if 1–5 are done before 1:30 PM).** Add a second planted bug to `fixtures/shop/src/cart.js` that the existing tests miss and a user could hit through the UI, without changing existing exported function signatures. Tell Samvit what UI steps reproduce it.

## Output style
Short. For each task: what changed (files), test output, anything Samvit must know. Ask me before deleting files or changing a contract.
