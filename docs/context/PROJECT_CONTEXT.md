# Project Context: Online Hackathon Project Selection

## Event
- Event: Hacktoberfest Hack Day New Delhi x ACTS EDC
- Official event page: https://events.mlh.com/events/14935-hacktoberfest-hack-day-new-delhi-x-acts-edc
- The user selected offline participation but received an email saying they were not shortlisted for the in-person event and could still participate in online Hacktoberfest challenges.
- The user is comfortable participating online.
- Date in the conversation: October 21, 2026.
- Previous page checks indicated that the challenge pages displayed “Submissions aren't open.” This must be rechecked directly on official pages; do not assume that submissions are open or that the deadline is known.

## Target categories
We want to evaluate both, if rules permit:
1. Best Use of Gemma 4
2. Best Open-Source AI Project

Official challenge pages previously referenced in conversation:
- Gemma 4 challenge: https://www.mlh.com/events/hacktoberfest-hack-day-new-delhi-x-acts-edc/challenges/01a03b87-be22-9180-5e2d-b3beeb66666d
- Best Open-Source AI Project: find the current official challenge page from the event page and verify its exact rules.

Important uncertainty: previous checks suggested the Gemma 4 category may encourage using Gemma through the Gemini API, while the open-source AI category expects open-source/open-weight AI to be integral. We prefer local Gemma inference, but must verify whether local inference qualifies for the Gemma 4 prize. Do not assume one implementation automatically qualifies for both categories.

## Team
Two people:
- Samvit: interested in frontend, AI integration, product design, and the demo. Has experience with web development and AI coding tools.
- Krishna: proposed backend, data handling, integration, testing, and demo support. Exact division should be agreed after the architecture is chosen.
- Team size: 2.

## Hardware and technical constraints
- Samvit has a Lenovo LOQ laptop with NVIDIA RTX 4050 6 GB VRAM and 16 GB RAM (from prior context; ask to confirm if needed).
- Preference: run Gemma locally, where feasible.
- Must test model memory requirements, image/text support, inference speed, and whether the selected quantization/runtime works on this machine.
- Do not assume a model tag, endpoint, or API works until tested against current official docs and the actual installation.
- Use local-first architecture where feasible, but respect challenge requirements if they require a specific integration.

## Current candidate concept, NOT a locked decision
Working name: TraceBack PR (name is provisional and may be changed).

Core hypothesis:
Developers sometimes cannot reproduce bugs from a user's vague report. A local-first tool captures a privacy-conscious runtime evidence bundle (user-approved interaction sequence, browser console errors, failed network requests, timing, relevant environment details), then helps reconstruct the failure and generate reproducible steps. An AI agent analyses the evidence and relevant code, proposes a minimal fix or regression test, and runs checks in an isolated workspace. It must show evidence and test outcomes rather than claim a fix works just because the model says so.

Potential differentiator:
- Start with a real, controlled demo application containing a subtle bug.
- Capture evidence that ordinary PR review tools do not have.
- Reproduce the failure from the captured bundle.
- Suggest a targeted patch and regression test.
- Run the test before and after the patch, and display verifiable results.
- Export a shareable, sanitized bug report.
- Keep sensitive data local where possible and redact secrets before exporting.

This is a hypothesis, not a commitment. Claude should evaluate alternatives, existing products, novelty, feasibility, and whether this idea is actually distinct enough.

## User's goals
- Create a genuinely useful product that solves a real developer problem.
- Avoid generic or overdone ideas such as a basic AI code reviewer, chatbot, or repository summarizer.
- Deliver a memorable, reliable, visually clear live demo.
- Build something open source that other developers could actually use.
- If possible, qualify for both challenge categories without misrepresenting compliance.
- Keep scope achievable for two people and the available hardware/time.
- Claude should decide the best project direction after evidence-based comparison, not merely validate the initial idea.

## Non-negotiable engineering principles
- Use real tools for deterministic tasks: Git, test runners, browser automation, linters, scanners, etc.
- Use the model for interpretation, hypotheses, explanation, and proposing tests/patches.
- Never claim a bug is confirmed without evidence.
- Never claim a fix is verified unless relevant tests actually ran and results are available.
- Run generated code/tests in an isolated workspace with timeouts and restricted permissions.
- Do not execute arbitrary model-generated commands on the host.
- Redact secrets, tokens, cookies, personal data, and sensitive URLs from captured/exported traces.
- Keep scope tight: one excellent end-to-end workflow beats many incomplete features.
- Do not fabricate impact statistics, evaluation scores, benchmarks, judging criteria, or competition rules.

## Expected final deliverables from Claude
1. A direct recommendation: choose, reject, or reshape TraceBack PR.
2. A comparison of 3–5 candidate ideas, including existing alternatives and differentiation.
3. Verified official challenge requirements, eligibility, model integration rules, submission status, deadlines, judging criteria, and submission route, with links and clear uncertainty notes.
4. A 90-second demo script designed to show a real problem and working outcome.
5. An MVP feature list and explicit out-of-scope list.
6. Architecture and a repository/file structure.
7. Local Gemma feasibility plan for the RTX 4050 6 GB, including a minimal proof-of-concept test.
8. Work split for Samvit and Krishna, with interfaces/contracts between their components.
9. Milestones and acceptance tests.
10. README outline, open-source license recommendation, safety/privacy notes, and submission checklist.
