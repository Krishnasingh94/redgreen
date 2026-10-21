# Hackathon Context Pack

This folder gives Claude the context needed to independently evaluate and shape our project for the online track of **Hacktoberfest Hack Day New Delhi x ACTS EDC**.

## Files
- `PROJECT_CONTEXT.md`: Background, goals, constraints, and what is known vs. unverified.
- `CLAUDE_DECISION_PROMPT.md`: Main prompt to give Claude. Ask Claude to research, challenge assumptions, and choose the strongest direction rather than blindly accepting our current idea.
- `SAMVIT_WORKSTREAM.md`: Proposed responsibilities for Samvit.
- `KRISHNA_WORKSTREAM.md`: Proposed responsibilities for Krishna.
- `DECISION_BRIEF.md`: A compact project-selection framework and deliverables checklist.

## How to use
1. Give Claude all the files in this folder.
2. Paste the full contents of `CLAUDE_DECISION_PROMPT.md` as the instruction.
3. Ask Claude to return a decision with evidence and then produce an implementation plan.
4. Do not start building until Claude has checked official challenge requirements, submission status, allowed Gemma integration methods, and deadlines.

## Important
The current concept is **only a candidate**, not a final decision: a local-first developer debugging agent that captures runtime evidence, helps reproduce hard-to-reproduce bugs, and validates suggested repairs. Claude should compare it against other original developer-tool ideas and may reject or reshape it.
