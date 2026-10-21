# RedGreen — 90-second demo script

Record at 1080p (OBS or Win+G). Before recording:
- LM Studio: Gemma 4 E4B loaded, server on.
- `npm run dev:github` running; RedGreen open at http://localhost:3000 (dark home page).
- Browser tabs, in order: RedGreen · tiny-shop issue #1 on GitHub · the tiny-shop site (optional).
- On GitHub, have a **fresh issue** ready on tiny-shop (copy issue #1's text into a new issue #2) so the bot replies live. Do one dry run first.
- Close notifications. Zoom browser to 110%.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:10 | RedGreen home, headline lights up red then green | "Maintainers get issues like 'the total is wrong'. AI tools answer with confident guesses. RedGreen answers with proof." |
| 0:10–0:25 | Replay card on the home page, then GitHub tiny-shop issue #2 | "It's a GitHub app. Anyone installs it on their repo. I comment `/redgreen` on this issue…" (post the comment) |
| 0:25–0:55 | Switch to RedGreen: the dashboard opens the run by itself. Clone and search → the page screenshot → "Writing" with the live timer → the red lamp ignites: "Fails. Expected $40.00, got $20.00." | "…and a worker on this laptop picks it up. It clones the site, takes a screenshot, and Gemma 4 — running locally in LM Studio, offline — reads the issue, the code and the screenshot, and writes browser steps. RedGreen runs them in a real browser. It only counts if the check fails on the current code. Here it does: expected forty dollars, got twenty." |
| 0:55–1:10 | Scroll: "Files Gemma will read", Gemma's diagnosis, the browser steps with step 6 in red | "It points to where to look: `app.js`, `setQuantity`. Every line here is a real run, not the model's word." |
| 1:10–1:22 | Back to GitHub: refresh issue #2 — the bot's "🔴 Reproduced" comment with the steps and actual output | "And the maintainer gets this on the issue: a failing check they can run, and where to look. It never touches their code unless they allow it." |
| 1:22–1:30 | RedGreen home | "RedGreen. No proof, no fix. Open source, Gemma 4 on a laptop." |

**If the live run is slow or fails on camera:** open the saved run from "Past runs" (labelled with its time) and narrate it the same way, saying "here's a run from earlier". Never fake a result.

**Optional 10 s (if time):** Bot page → toggle "Also try a fix" → show a verified fix from Past runs (red → green lamps, diff, before/after screenshots).
