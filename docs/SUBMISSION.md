# Submission text

**Project name:** RedGreen

**Tagline:** No proof, no fix. A GitHub app that turns bug reports into failing checks, with Gemma 4 running locally.

**Categories:** Best Use of Gemma 4 · Best Open-Source AI Project

**Repository:** https://github.com/samvit-srivastava/redgreen (Apache-2.0)
**Demo repos:** https://github.com/samvit-srivastava/tiny-shop (website) · https://github.com/samvit-srivastava/tiny-cart (library)
**Video:** <paste link>

## What it does
Most bug reports say "it's broken", and AI tools reply with confident guesses. RedGreen replies with proof. Install it on a repo as a GitHub app; when an issue is labelled `redgreen` or someone with write access comments `/redgreen`, RedGreen:
1. clones the repo, serves the site (or runs its test framework), and finds the relevant files with plain keyword search;
2. asks **Gemma 4 E4B, running locally in LM Studio**, to read the issue, the code and a **screenshot of the live page**, and write a test or browser steps;
3. runs them for real and accepts them **only if they fail on the current code** for the reason the issue describes;
4. replies on the issue with the failing check, the real output (e.g. expected $40.00, got $20.00) and where to look.

It never changes code by default. Optionally it also tries a fix and suggests it only after that same check passes and the repo's own tests still pass.

## How Gemma 4 is used
Gemma 4 does the interpretation: reading untrusted issue text, reading the page screenshot (multimodal), choosing selectors, writing tests/steps, diagnosing the cause, and (optionally) proposing a patch. Deterministic code does the judging: running tests and browsers, exit codes, and checks that reject Gemma's output when it doesn't reproduce the issue (e.g. a test that passes on buggy code, or an expected value the issue doesn't support). It runs fully offline on a laptop with a 6 GB RTX 4050.

## Why open source
Bug reproduction is useful to every maintainer, and running the model locally means private code never leaves the machine. The repo includes the GitHub app (created in one click through GitHub's app manifest flow), the dashboard, three input modes (GitHub websites, JavaScript libraries, an instrumented app with a recorder), CI on Windows and Linux, and 47 tests.

## Honest results
- Measured on our demo repos (docs/EVAL.md): reproduced in every run since the pipeline stabilised; fixes verified in 8 of 9 demo-shop runs when fixing is enabled.
- Small sample, small repos. Very large repos (e.g. microsoft/vscode) are refused with a clear message. Supports websites and JavaScript projects today.

## Safety
Issue text and page content are untrusted data in every prompt. Model-written tests run in a temp copy with timeouts (Node permission model for node:test); browser steps are data, not code; secrets are redacted before storage; only users with write access can trigger the bot; GitHub mode is opt-in.

## Team
Samvit Srivastava (product, AI integration, frontend) · Krishna Singh (backend, safety, CI)
