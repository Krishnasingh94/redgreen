# Main Prompt for Claude: Decide Our Hackathon Project

Act as a skeptical hackathon product strategist, senior full-stack engineer, local-LLM engineer, and demo coach. Read every supplied context file first.

Your job is **not** to automatically agree with our current idea. You must independently decide what we should build for the online Hacktoberfest Hack Day New Delhi x ACTS EDC challenges.

## Our goals
We want a genuinely useful, distinctive developer-focused project with a memorable working demo. We want to target the Best Use of Gemma 4 and Best Open-Source AI Project categories if the official rules allow it. We prefer local Gemma inference, have two team members, and need an achievable scope.

## Step 1: Verify the event before proposing a build
Use current official sources first:
- Main event page: https://events.mlh.com/events/14935-hacktoberfest-hack-day-new-delhi-x-acts-edc
- Gemma 4 challenge page: https://www.mlh.com/events/hacktoberfest-hack-day-new-delhi-x-acts-edc/challenges/01a03b87-be22-9180-5e2d-b3beeb66666d
- Find the official Best Open-Source AI Project challenge page from the event page.

Verify and cite:
1. Whether online participants can submit to each category.
2. Whether submissions are open now.
3. Exact deadline and timezone, if published.
4. Exact required Gemma integration. Is local inference accepted, or is Gemini API integration required?
5. Whether the same project can be entered in both categories.
6. Required repository, demo, Devpost, or other submission artifacts.
7. Published judging criteria and prizes.
8. Any restrictions or eligibility conditions.

Do not invent missing facts. If official information is unclear, say so and propose the exact organizer question we should ask. Keep verified facts separate from assumptions.

## Step 2: Research originality and competition
Compare 3–5 project ideas. Include TraceBack PR, but do not privilege it. Consider uncommon developer problems such as runtime bug reproduction, agent execution debugging, environment drift, dependency migration failures, local-first diagnostics, or other ideas you discover.

For each candidate, assess:
- Concrete user and painful workflow.
- What existing products already do.
- What our version would do differently.
- Whether the distinction is meaningful or merely a renamed wrapper.
- How Gemma is essential to the workflow.
- Why local inference adds value, if it does.
- Two-person feasibility and hardware fit.
- A visual, 90-second demo with a clear before/after.
- Risks, dependencies, and what can be demonstrated honestly in one day.
- How it could be a genuinely useful open-source project after the event.

Do not claim that an idea has a “maximum chance of winning” or guarantee an award. Explain trade-offs and select the strongest evidence-backed direction for our stated goals.

## Step 3: Choose and define the project
Make a clear recommendation: choose, reject, or reshape TraceBack PR, or select another candidate. Provide:
- Product name and one-sentence pitch.
- User persona and problem statement.
- Core workflow and one standout capability.
- The precise novelty versus existing tools.
- Why Gemma 4 is needed, what it receives, and what it outputs.
- Which parts are deterministic tools rather than AI.
- What must work in the demo.
- What is explicitly out of scope.
- A fallback if local Gemma is too slow or does not fit VRAM. Do not silently switch to a cloud model if that violates the rules.

## Step 4: Architecture and build plan
Produce:
- A simple architecture diagram (Mermaid is fine).
- Proposed tech stack and rationale.
- Repository tree.
- API contracts and shared data schemas.
- Exact local Gemma proof-of-concept test to run first.
- Security model for running tests or generated patches in isolation.
- Privacy/redaction rules.
- Test plan and measurable acceptance criteria.
- A plan for a polished UI that visualizes real evidence, not fabricated output.

Hardware to account for: Lenovo LOQ, RTX 4050 6 GB VRAM, 16 GB RAM, subject to confirmation. Team: two people.

## Step 5: Divide work between Samvit and Krishna
Use these initial preferences but adjust if the project architecture warrants it:
- Samvit: AI/model integration, frontend, product experience, and demo.
- Krishna: backend, data handling, tooling/integration, test execution, and demo support.
Create:
- Separate task lists for Samvit and Krishna.
- Ownership boundaries.
- API/schema contracts so both can work in parallel.
- Integration checkpoints.
- Definition of done for every major task.
- A short collaboration protocol to avoid conflicting edits.

## Step 6: Demo and submission package
Create:
- A memorable 90-second demo script with exact actions and expected outputs.
- One failure scenario and one successful repair scenario.
- A backup demo plan in case live model inference fails.
- README structure and sample content.
- Recommended open-source license with rationale.
- Evaluation results we should collect honestly.
- Final submission checklist mapped to verified rules.
- A short message to the organizers asking any unanswered eligibility questions.

## Output style
Be direct, skeptical, and specific. Use concise tables where helpful. Avoid generic startup language, bloated architecture, unnecessary agents, and long lists of features. Prefer one end-to-end workflow with visible evidence. Cite sources for all current event claims. Distinguish facts from recommendations. If browsing or verification is unavailable, disclose that limitation instead of pretending it was checked.

Start with the event verification and project decision, not code. Do not start implementation until the direction and rules are clear.
