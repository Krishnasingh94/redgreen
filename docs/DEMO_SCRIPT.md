# RedGreen: 5-minute demo video

## Before you record (10 min)
- LM Studio: Gemma 4 E4B loaded, server on.
- `npm run dev:github` running. RedGreen open at http://localhost:3000, browser zoom 110%.
- On GitHub, open a **new issue #2** on `samvit-srivastava/tiny-shop` and paste the text of issue #1. Do NOT comment `/redgreen` yet.
- Do one full dry run on another new issue first, so you know it works and how long it takes.
- Tabs in order: RedGreen · tiny-shop issue #2 · tiny-shop live site (optional).
- Close notifications. Record at 1080p (OBS or Win+G).

If a live run fails on camera, open the dry run from **History** and say "here's the run from earlier". Never fake a result.

---

## 1. The problem (0:00 to 0:35)
**Screen:** RedGreen home. Let the headline light up red, then green.

**Say:**
"Hi, I'm Samvit, and with Krishna we built RedGreen.
Every open-source maintainer gets issues like 'the total is wrong' or 'search is broken'. Before anyone can fix it, someone has to reproduce it, and that is the slowest part.
AI tools today jump straight to a fix and guess. RedGreen does the opposite. No proof, no fix."

## 2. The idea (0:35 to 1:10)
**Screen:** Scroll slowly through FAILS / PASSES and the four steps.

**Say:**
"RedGreen turns a bug report into a check that fails on your code.
It reads the issue, clones the repo, runs the site or its tests, and Gemma 4 writes browser steps or a test.
Then RedGreen runs that check for real. It only counts if it fails the way the issue says. Red, or it didn't happen.
Fixing is optional. If you turn it on, a fix only counts when the same check turns green."

## 3. Live: the GitHub App (1:10 to 2:40)
**Screen:** GitHub App page in RedGreen, show it is installed. Then switch to tiny-shop issue #2.

**Say:**
"RedGreen is a GitHub App. Like any bot, you install it on your repo in one click.
Here's a real issue on our demo shop. Add Headphones, set quantity to 3, apply coupon SAVE20, set quantity back to 1. Expected forty dollars, it shows twenty.
I just comment slash redgreen."

**Action:** Comment `/redgreen`. Switch to RedGreen, the run opens by itself.

**Say (while it runs):**
"A worker on this laptop picks it up. It clones the repo and serves the site.
It searches the code for the files this issue is about, and you can see which ones.
It takes a screenshot of the real page, and Gemma 4, running locally in LM Studio, reads the issue, the code and the screenshot.
It writes browser steps. These are just data, so the model never runs its own code.
Now a real browser runs them…"

**When it turns red:**
"…and it fails. Expected forty dollars, got twenty. That's the bug, proven on the current code."

## 4. What the maintainer gets (2:40 to 3:30)
**Screen:** Scroll the run: steps with the red line, the before screenshot, "Where to look". Then refresh issue #2 on GitHub.

**Say:**
"Every line here comes from a real run, not the model's word.
It also says where to look: app.js, the setQuantity function.
And on GitHub, the bot posts this: Reproduced, the exact steps, the real output, and where to look.
It does not touch your code or open pull requests unless you allow it."

## 5. Reproduce from the website (3:30 to 4:05)
**Screen:** Reproduce page. Paste any issue URL, show the input, then open History.

**Say:**
"You don't need to install anything to try it. Paste any GitHub issue here, for a website or a JavaScript project.
For libraries it writes a test in their own runner, node test, Vitest, Jest or Mocha. For websites it drives a real browser.
Everything is saved in History."

## 6. Gemma 4 and safety (4:05 to 4:40)
**Screen:** Model page (status pill → Model). Show local LM Studio and the Gemini API option.

**Say:**
"It runs on Gemma 4. By default E4B, locally, so your code never leaves your machine.
If you deploy it, anyone can bring their own Gemma API key and use the bigger Gemma 4 models.
Generated code runs in a sandbox, issue text is treated as data, never instructions, and there's a safety check before anything runs."

## 7. Close (4:40 to 5:00)
**Screen:** Back to the home page headline.

**Say:**
"RedGreen. It's open source under Apache 2.0, and it works with any repo.
Proof first, then the fix. No proof, no fix. Thank you."
