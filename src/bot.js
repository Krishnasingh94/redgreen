// RedGreen GitHub bot (local, polling). No public URL needed: it polls the repos you list.
// Trigger: an issue labelled "redgreen", or a "/redgreen" comment by someone with write access.
// Result: a comment on the issue, and a PR only when the fix is verified red -> green.
const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function botConfig() {
  const repos = String(process.env.REDGREEN_BOT_REPOS || '').split(',').map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s));
  return { token: process.env.GITHUB_TOKEN || '', repos, label: process.env.REDGREEN_BOT_LABEL || 'redgreen', intervalMs: Number(process.env.REDGREEN_BOT_INTERVAL_MS || 30000), openPrs: process.env.REDGREEN_BOT_OPEN_PRS === '1' };
}

export function createBot({ createCase, runCase, log = console.log, loadState, saveState }) {
  const cfg = botConfig();
  const status = { enabled: false, mode: cfg.openPrs ? 'pr' : 'suggest', repos: cfg.repos, label: cfg.label, current: null, last: null, error: null, login: null };
  if (!cfg.token || !cfg.repos.length) { status.error = 'Set GITHUB_TOKEN and REDGREEN_BOT_REPOS to enable the bot.'; return { status, start() {} }; }
  const state = { handled: {}, since: new Date(Date.now() - 60_000).toISOString(), ...(loadState?.() || {}) };
  const queue = [];
  let working = false;

  async function gh(method, path, body) {
    const res = await fetch(API + path, { method, headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'redgreen-bot', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  const comment = (repo, n, body) => gh('POST', `/repos/${repo}/issues/${n}/comments`, { body });

  async function poll() {
    for (const repo of cfg.repos) {
      try {
        const labelled = await gh('GET', `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(cfg.label)}&per_page=20`);
        for (const i of labelled) if (!i.pull_request && !state.handled[`${repo}#${i.number}:label`]) enqueue(repo, i.number, `${repo}#${i.number}:label`, 'label', `${i.title}\n${i.body || ''}`);
        const since = state.since;
        state.since = new Date().toISOString();
        const comments = await gh('GET', `/repos/${repo}/issues/comments?since=${since}&per_page=50`);
        for (const c of comments) {
          if (!/(^|\s)\/redgreen\b/i.test(c.body || '') || c.user?.login === status.login || state.handled[`c${c.id}`]) continue;
          if (!TRUSTED.has(c.author_association)) { state.handled[`c${c.id}`] = 'ignored'; continue; } // strangers can't make this machine run code
          enqueue(repo, Number(c.issue_url.split('/').pop()), `c${c.id}`, `comment by @${c.user.login}`, c.body);
        }
      } catch (e) { status.error = e.message; log('[bot] ' + e.message); }
    }
    saveState?.(state);
    drain();
  }

  function enqueue(repo, number, key, why, text = '') {
    if (queue.some((q) => q.key === key)) return;
    state.handled[key] = 'queued';
    queue.push({ repo, number, key, why, text });
    log(`[bot] queued ${repo}#${number} (${why})`);
  }

  async function drain() {
    if (working || !queue.length) return;
    working = true;
    const job = queue.shift();
    status.current = { repo: job.repo, number: job.number, startedAt: new Date().toISOString() };
    try { await handle(job); } catch (e) { status.error = e.message; log('[bot] ' + e.message); try { await comment(job.repo, job.number, `⚠️ RedGreen stopped: ${e.message.slice(0, 300)}`); } catch {} }
    state.handled[job.key] = 'done'; saveState?.(state);
    status.current = null; working = false;
    drain();
  }

  async function handle({ repo, number, why, text }) {
    const [owner, name] = repo.split('/');
    // Fork workflow: the trigger may point at an UPSTREAM issue; we read that issue but work on (and push to) this repo.
    const m = String(text).match(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/i);
    const upstream = m && `${m[1]}/${m[2]}`.toLowerCase() !== repo.toLowerCase() ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
    await comment(repo, number, `🔴🟢 **RedGreen** picked this up (${why})${upstream ? `: upstream issue ${upstream.owner}/${upstream.repo}#${upstream.number}, reproduced on this fork` : ''}. Reproducing it locally with Gemma 4.\n\n${cfg.openPrs ? "I'll open a pull request **only if** a check fails on the current code and passes after my patch." : "I'll reply with a failing check that proves the bug, where to look, and a suggested fix only if I've verified it makes that check pass. I won't change your code."}`);
    const kase = await createCase({ owner, repo: name, number, upstream });
    const run = await runCase(kase);
    status.last = { repo, number, verdict: run.verdict, runId: run.id, at: new Date().toISOString() };
    const repro = run.steps.find((s) => s.type === 'repro.confirmed');
    const howTo = repro?.proposal?.steps
      ? repro.proposal.steps.map((s, i) => `${i + 1}. \`${s.action}\`${s.target ? ` \`${s.target}\`` : ''}${s.value ? ` ${JSON.stringify(s.value)}` : ''}`).join('\n')
      : repro ? '```js\n' + String(repro.proposal.test_code).trim() + '\n```' : '';
    const proof = repro ? '```\n' + String(repro.result.output).slice(-1200) + '\n```' : '';

    const verified = run.steps.find((s) => s.type === 'fix.verified');
    const located = run.steps.find((s) => s.type === 'located');
    const where = located?.files?.length ? located.files.slice(0, 3).map((f) => `\`${f.path}\``).join(', ') : null;
    const cause = verified?.proposal?.root_cause || repro?.proposal?.hypothesis;
    const kind = repro?.proposal?.steps ? 'browser check' : 'test';
    const footer = `\n\n<sub>RedGreen run \`${run.id}\` · Gemma 4 running locally on the maintainer's machine · every result above comes from an actual run, not from the model's word.</sub>`;

    if (run.verdict === 'fixed_verified' && verified) {
      const suggestion = `### 🟢 Suggested fix (verified)\nWith this change the ${kind} above **passes**${run.patch?.testPath ? ' and the repo\'s own tests still pass' : ''}. RedGreen ran it; it did not commit anything.\n\n\`\`\`diff\n${String(verified.diff).slice(0, 6000)}\n\`\`\``;
      let prLine = '';
      if (cfg.openPrs && run.patch?.files) {
        const pr = await openPullRequest(repo, number, kase.issue.title, run, upstream);
        prLine = `\n\n➡️ Opened #${pr.number} with this fix.${upstream ? ` [Send it upstream](https://github.com/${upstream.owner}/${upstream.repo}/compare/${pr.base.ref}...${owner}:${pr.head.ref}?expand=1).` : ''}`;
        log(`[bot] ${repo}#${number}: PR #${pr.number}`);
      }
      await comment(repo, number, `## 🔴 Reproduced\nThis ${kind} **fails** on the current code:\n${howTo}\n\n${proof}\n\n### 🔍 Where to look\n${where ? `Files: ${where}\n\n` : ''}${cause ? `Likely cause: ${cause}` : ''}\n\n${suggestion}${prLine}${footer}`);
    } else if (repro) {
      await comment(repo, number, `## 🔴 Reproduced\nThis ${kind} **fails** on the current code:\n${howTo}\n\n${proof}\n\n### 🔍 Where to look\n${where ? `Files: ${where}\n\n` : ''}${cause ? `Likely cause: ${cause}` : ''}\n\n### No verified fix yet\nNone of the patches RedGreen tried made this ${kind} pass without breaking anything, so it isn't suggesting one. The failing ${kind} above is ready to use as a regression check.${footer}`);
    } else {
      const why = run.steps.filter((s) => s.reason || s.error).map((s) => `- ${s.reason || s.error}`).slice(-3).join('\n');
      await comment(repo, number, `## ⚪ Not reproduced\nRedGreen could not make a check fail for the reason described, so it is not claiming anything about this issue.\n\n${why}\n\nMore detail in the issue (exact steps, expected vs. actual values) usually helps.${footer}`);
    }
  }

  async function openPullRequest(repo, number, title, run, upstream) {
    const ref0 = upstream ? `${upstream.owner}/${upstream.repo}#${upstream.number}` : `#${number}`;
    const info = await gh('GET', `/repos/${repo}`);
    const base = info.default_branch;
    const ref = await gh('GET', `/repos/${repo}/git/ref/heads/${base}`);
    const baseSha = ref.object.sha;
    const baseCommit = await gh('GET', `/repos/${repo}/git/commits/${baseSha}`);
    const tree = await gh('POST', `/repos/${repo}/git/trees`, { base_tree: baseCommit.tree.sha, tree: Object.entries(run.patch.files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })) });
    const commit = await gh('POST', `/repos/${repo}/git/commits`, { message: `Fix ${ref0}: ${title}\n\nVerified by RedGreen: the reproduction ${run.patch.testPath ? 'test' : 'browser check'} failed before this change and passes after it.`, tree: tree.sha, parents: [baseSha] });
    const branch = `redgreen/${upstream ? `${upstream.repo}-${upstream.number}` : `issue-${number}`}-${Date.now().toString(36)}`;
    await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    const body = (run.prMarkdown || `Fixes #${number}.`).replace(/Fixes #\d+\./, `Fixes ${ref0}.`).replace(/## Fix #\d+:/, `## Fix ${ref0}:`);
    return gh('POST', `/repos/${repo}/pulls`, { title: `Fix ${ref0}: ${title}`, head: branch, base, body });
  }

  return {
    status,
    async start() {
      try { status.login = (await gh('GET', '/user')).login; } catch (e) { status.error = 'Token rejected by GitHub: ' + e.message; log('[bot] ' + status.error); return; }
      status.enabled = true; status.error = null;
      log(`[bot] watching ${cfg.repos.join(', ')} as @${status.login} (label "${cfg.label}" or a /redgreen comment)`);
      poll(); setInterval(poll, cfg.intervalMs);
    },
  };
}
