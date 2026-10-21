# Project Decision Brief

## Decision criteria
Score candidates using evidence, not vibes. Suggested weighting:
- Distinctive problem and differentiation: 25%
- Live-demo clarity and impact: 20%
- Meaningful Gemma 4 role: 15%
- Open-source value beyond the hackathon: 15%
- Two-person feasibility: 15%
- Reliability, privacy, and safety: 10%

These are our internal decision weights, **not official MLH judging criteria**.

## Questions Claude must answer
- What does this do that existing tools do not already do well?
- Can we demonstrate the difference in 90 seconds?
- Does Gemma add a necessary capability, or is it an unnecessary wrapper?
- Can the core workflow run on the target hardware?
- Can we make the demo repeatable with a controlled fixture?
- Can we publish a useful open-source tool, not just a hackathon mockup?
- Does the project comply with each target challenge's exact rules?

## Candidate direction
TraceBack PR is only a starting hypothesis: capture runtime evidence, reproduce a hard-to-reproduce bug, analyse it with local Gemma, propose a regression test/patch, and validate in isolation.

Claude may reject this if existing products make the idea insufficiently distinct or if the scope is unrealistic.

## Required decision output
- Selected concept and why.
- Alternatives rejected and evidence.
- Exact MVP.
- One memorable demo scenario.
- Feasibility risks and fallback plan.
- Verified competition compliance, or a list of unresolved organizer questions.
- Samvit/Krishna task split.
- Acceptance tests and final checklist.

## Submission integrity
Never invent metrics, user impact, novelty claims, judging criteria, prizes, deadlines, or test results. Clearly label synthetic demo data. Do not imply a fix passed unless the test actually ran and passed.
