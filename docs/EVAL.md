# Evaluation log (real runs, no estimates)

Hardware: Lenovo LOQ, RTX 4050 6 GB, 16 GB RAM, Windows. Model: `google/gemma-4-e4b` (Q4_K_M) in LM Studio, local.
Scenario: the one planted bug in `fixtures/shop` (stale coupon discount after quantity change), same captured report each run.
Max 3 attempts per phase. A run counts as GREEN only if the reproduction test failed before the patch and it plus the existing suite passed after.

| Run | Pipeline version | Verdict | Total time | Repro attempts | Fix attempts |
|---|---|---|---|---|---|
| run_mvhlxcd9 | v1 (find/replace patches) | not reproduced* | 79s | 3 | 0 |
| run_mvhm3nki | v1 | reproduced, not fixed | 119s | 1 | 3 |
| run_mvhm90bn | v2 (whole-function patches) | **GREEN** | 73s | 1 | 2 |
| run_mvhmeivl | v2 | **GREEN** | 77s | 1 | 1 |
| run_mvhmgg02 | v2 | reproduced, not fixed | 171s | 2 | 3 |
| run_mvhmkcau | v2 | **GREEN** | 64s | 1 | 1 |
| run_mvhmlx7q | v2 | **GREEN** | 125s | 1 | 3 |
| run_mvhmp74x | v3 (+ retry temperature, "change" field) | **GREEN** | 138s | 1 | 3 |
| run_mvhmt9tu | v4 (+ deterministic test facts) | **GREEN** | 128s | 3 | 1 |
| run_mvhmwoiu | v5 (+ object-literal typo repair) | **GREEN** | 75s | 1 | 2 |
| run_mvhmyhmz | v5 | **GREEN** | 71s | 2 | 1 |

\* Run 1 failed because of a sandbox crash on Windows + Node 20 (fixed), not the model.

**Since v2: 8 of 9 runs reached verified GREEN; 9 of 9 reproduced the bug.** No run ever reported a fix that the tests did not confirm.
Typical model latency: 17–50s to write the reproduction test, 20–42s per patch attempt.

Failure modes seen and what we changed:
- Exact find/replace edits from a 4B-class model were unreliable (overlapping, no-op, non-matching) → whole-function rewrites.
- Model returned the original function unchanged, and repeated it at low temperature → retry temperature 0.2 / 0.6 / 0.9, plus feedback naming the unchanged function and the test's call order.
- Model fixated on the wrong function → prompt gets deterministic facts: the test's call order and the assertion's expected/actual.
- Typo `name': 'x'` in object literals → deterministic repair (never valid JS) + an example in the prompt.
- One reproduction test passed on the buggy code → correctly rejected by the gate, retried.

Limitations: one bug, one app, small sample. These numbers say the loop works on this hardware, not that it generalises.
