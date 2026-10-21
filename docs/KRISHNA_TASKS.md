# Krishna — tasks for today (submissions close 5:00 PM IST)

**Project: RedGreen.** A bug report with captured evidence goes to local Gemma 4, which writes a test that must FAIL on the buggy code (RED). Gemma then proposes a patch, and RedGreen only calls it fixed when that same test PASSES and the existing tests still pass (GREEN).
Read `README.md` first (5 min). Samvit owns model/prompts + UI; you own repo, verification, video, submission.

## Setup (10 min)
1. Install Node.js 22 LTS (check with `node -v`; ≥ 22.13 gives full sandbox isolation).
2. Unzip, open a terminal in the folder, and run:
   ```bash
   npm test               # expect: 5 pass, 0 fail
   npm run check:sandbox  # expect: ✅ PASS
   ```
   No `npm install` is needed. There are zero dependencies.
3. No GPU? You don't need Gemma for your tasks. The dashboard and shop still run with `npm start` (the model pill shows "offline").

## Task 1: GitHub repo (by 10:15)
- Create a **public** repo `redgreen` (Apache-2.0 is already in `LICENSE`).
- ```bash
  git init && git add . && git commit -m "RedGreen: bug report -> failing test -> verified fix on local Gemma 4"
  git branch -M main && git remote add origin https://github.com/<you>/redgreen.git && git push -u origin main
  ```
- Add Samvit as a collaborator. Topics: `gemma`, `gemma-4`, `lm-studio`, `hacktoberfest`, `local-llm`, `testing`, `debugging`.
- **Don't** commit `data/runs/` or private reports (`.gitignore` already excludes them).
- Rule to avoid conflicts: Samvit edits `src/prompts.js`, `src/model.js`, `ui/`. You edit `README.md`, `docs/`, `fixtures/`, `test/`. Pull before you push.

## Task 2: Submission recon (by 10:30)
- Make sure you are **checked in** on Organizer HQ (step 2 on the event page).
- Open https://www.mlh.com/events/hacktoberfest-hack-day-new-delhi-x-acts-edc/submissions/new and write down **every field** (title, description, repo URL, video URL? demo URL? screenshots? team members? category checkboxes?). Send the list to Samvit.
- Note: the challenge page says "One submission can enter every category it qualifies for", so tick **both** Best Use of Gemma 4 **and** Best Open-Source AI Project.

## Task 3: Manual QA of the demo shop (10:30–11:30)
Run `npm start`, open http://localhost:3000/shop/ and check:
- [ ] Add Headphones → qty 3 → coupon `SAVE20` → qty 1 → total shows **$20.00** (bug) → Checkout fails with "Total mismatch … $40.00".
- [ ] 🐞 Report bug → "Saved report rpt_… (N values redacted)".
- [ ] Open `data/reports/rpt_….json`: the email and `Authorization` must be `[REDACTED…]`.
- [ ] Report with a screenshot attached (PNG < 4 MB) saves and shows 🖼 in the dashboard list.
- [ ] Invalid coupon, qty 0, and double-clicking Apply don't crash the page.
- [ ] Dashboard: open each report, check that layout works at a narrow window width, and that Copy/.md work on a finished run.
Log any bug with exact steps and send it to Samvit. **Don't fix** `src/` files yourself.

## Task 4: Demo video (record ~3:30 PM, ≤ 2 min, aim 90 s)
Use OBS or Win+G (Xbox Game Bar), 1080p. Upload to YouTube (Unlisted) or Drive (anyone with link).
Shot list (Samvit will finalise the script):
1. (0–10s) Problem: "Users say 'it's broken'. AI tools say 'fixed!'. Neither is proof."
2. (10–30s) Shop: reproduce the bug ($20 instead of $40), checkout fails, Report bug + screenshot.
3. (30–60s) RedGreen: click Reproduce → Gemma writes test → **RED**. Show the cited evidence highlighted.
4. (60–80s) Patch → **GREEN**, existing 5 tests still pass. Show the LM Studio window = local, offline.
5. (80–90s) Copy PR description. "No proof, no fix. Open source, runs on a laptop."
Show only **real** runs. If a run fails on camera, re-record; don't edit fake results.

## Task 5: Submission (submit by **4:30 PM**, not 4:59)
Paste the repo URL, video URL, and the description Samvit sends. Take a screenshot of the confirmation.

## Definition of done
Public repo pushed with README ✔ · tests pass on a clean clone ✔ · video uploaded and link opens in incognito ✔ · submitted to both categories ✔ · confirmation screenshot ✔
