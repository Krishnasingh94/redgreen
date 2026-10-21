# Samvit — Proposed Workstream

This is a proposed split, not a locked assignment. Update it after the project decision.

## Primary ownership
- Product UI and interaction design.
- Local Gemma integration and prompt/schema design.
- Model evaluation and quality checks.
- Demo narrative and visual evidence presentation.

## Suggested tasks
1. Run the minimal local Gemma proof of concept on the target laptop.
2. Confirm the chosen model/runtime can handle the required input type and returns usable structured output.
3. Build the frontend flow: input/session selection, analysis progress, evidence timeline, hypotheses, suggested actions, and test results.
4. Define model input/output schemas with Krishna before implementation.
5. Implement model guardrails: structured output validation, uncertainty, evidence references, and safe handling of untrusted trace content.
6. Add loading/error states and a deterministic demo mode that is clearly labelled as prerecorded/mock fallback if used.
7. Run evaluation cases and document both successes and failures.
8. Prepare the 90-second demo and screen recording.

## Deliverables
- Working frontend integrated with the agreed API.
- Local model adapter or documented proof-of-concept.
- Prompt and schema files.
- Evaluation notes and sample fixtures.
- Demo script and screenshots/video, if time permits.

## Definition of done
- A fresh user can follow the main workflow without verbal explanation.
- Every displayed model claim is tied to evidence or clearly labelled as a hypothesis.
- Errors are handled visibly.
- No API keys, secrets, cookies, or private traces are exposed.
- Demo results can be reproduced from the repository instructions.
