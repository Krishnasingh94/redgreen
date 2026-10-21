import os from 'node:os';
import { createAppAuth } from './githubApp.js';
import { redact } from './redact.js';

// Everything the bot posts is public. Strip secrets (same rules as bug reports) and this machine's home
// folder / user name, which can appear in test output and stack traces.
export function sanitizeForGitHub(text) {
  let t = redact(String(text)).value;
  const home = os.homedir();
  const forms = [...new Set([home, home.replaceAll('\\', '/'), encodeURI(home.replaceAll('\\', '/'))])].filter((h) => h && h.length > 3).sort((a, b) => b.length - a.length);
  for (const h of forms) t = t.split(h).join('~');
  let user = ''; try { user = os.userInfo().username; } catch {}
  if (user && user.length > 2) t = t.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user>');
  return t;
}
// RedGreen GitHub bot (local, polling). No public URL needed: it polls the repos you list.
// Trigger: an issue labelled "redgreen", or a "/redgreen" comment by someone with write access.
// Result: a comment on the issue, and a PR only when the fix is verified red -> green.
const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function envConfig() {
  const repos = String(process.env.REDGREEN_BOT_REPOS || '').split(',').map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s));
  // GitHub App mode: only installations on these accounts are acted on (plus the app owner's own account).
  const allowAccounts = String(process.env.REDGREEN_BOT_ALLOW || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { token: process.env.GITHUB_TOKEN || '', repos, allowAccounts, label: process.env.REDGREEN_BOT_LABEL || 'redgreen', intervalMs: Number(process.env.REDGREEN_BOT_INTERVAL_MS || 30000), openPrs: process.env.REDGREEN_BOT_OPEN_PRS === '1' };
}

export function createBot({ createCase, runCase, log: log0 = console.log, loadState, saveState, getConfig = envConfig }) {
  let cfg = getConfig();
  const activity = [];
  const log = (msg) => { log0(msg); activity.unshift({ at: new Date().toISOString(), msg: String(msg).replace(/^\[bot\] /, '') }); activity.length = Math.min(activity.length, 40); };
  const status = { enabled: false, mode: cfg.openPrs ? 'pr' : 'suggest', repos: cfg.repos, label: cfg.label, current: null, last: null, error: null, login: null, activity };
  const state = { handled: {}, since: new Date(Date.now() - 60_000).toISOString(), ...(loadState?.() || {}) };
  const queue = [];
  let working = false, timer = null;

  let app = null; // GitHub App mode (installable by anyone); otherwise a personal token
  const ignoredAccounts = new Set();
  async function tokenFor(repo) { return app ? app.tokenFor(repo) : cfg.token; }
  async function gh(method, path, body, repo) {
    const token = await tokenFor(repo || (path.match(/^\/repos\/([^/]+\/[^/?]+)/)?.[1] ?? ''));
    const res = await fetch(API + path, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'redgreen-bot', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  const comment = (repo, n, body) => gh('POST', `/repos/${repo}/issues/${n}/comments`, { body: sanitizeForGitHub(body) });

  async function poll() {
    cfg = getConfig(); status.mode = cfg.openPrs ? 'pr' : 'suggest';
    if (!status.enabled) return;
    let repos = cfg.repos;
    if (app) {
      try {
        // Anyone can install a GitHub App on their own repos, and on their own repo they can add the trigger label.
        // Running their code here would let strangers execute code on this machine, so only allowed accounts count.
        const inst = await app.repos();
        const allowed = new Set([...(cfg.allowAccounts || []), ...(status.owner ? [status.owner.toLowerCase()] : [])]);
        const ok = inst.filter((r) => allowed.has(String(r.account || '').toLowerCase()));
        for (const r of inst) if (!ok.includes(r) && !ignoredAccounts.has(r.account)) { ignoredAccounts.add(r.account); log(`[bot] ignoring installation on @${r.account} (not in the allowed accounts; add it with REDGREEN_BOT_ALLOW or the Bot page)`); }
        status.installations = ok; status.ignoredInstallations = inst.length - ok.length; repos = ok.map((r) => r.repo);
      } catch (e) { status.error = e.message; log('[bot] ' + e.message); return; }
    }
    status.repos = repos;
    for (const repo of repos) {
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

  async function postResult(repo, number, kase, run, upstream = null) {
    const [owner] = repo.split('/');
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
    const footer = `\n\n<sub>RedGreen run \`${run.id}\` · Gemma 4 running locally on the machine that ran RedGreen · every result above comes from an actual run, not from the model's word.</sub>`;

    if (run.verdict === 'fixed_verified' && verified) {
      const suggestion = `### 🟢 Suggested fix (verified)\nWith this change the ${kind} above **passes**${run.patch?.testPath ? ' and the repo\'s own tests still pass' : ''}. RedGreen ran it; it did not commit anything.\n\n\`\`\`diff\n${String(verified.diff).slice(0, 6000)}\n\`\`\``;
      let prLine = '';
      if (cfg.openPrs && run.patch?.files) {
        const pr = await openPullRequest(repo, number, kase.issue.title, run, upstream);
        prLine = `\n\n➡️ Opened #${pr.number} with this fix.${upstream ? ` [Send it upstream](https://github.com/${upstream.owner}/${upstream.repo}/compare/${pr.base.ref}...${owner}:${pr.head.ref}?expand=1).` : ''}`;
        log(`[bot] ${repo}#${number}: PR #${pr.number}`);
      }
      await comment(repo, number, `## 🔴 Reproduced\nThis ${kind} **fails** on the current code:\n${howTo}\n\n${proof}\n\n### 🔍 Where to look\n${where ? `Files: ${where}\n\n` : ''}${cause ? `Likely cause: ${cause}` : ''}\n\n${suggestion}${prLine}${footer}`);
    } else if (repro && run.verdict === 'reproduced') {
      await comment(repo, number, `## 🔴 Reproduced\nThis ${kind} **fails** on the current code:\n${howTo}\n\n${proof}\n\n### 🔍 Where to look\n${where ? `Files: ${where}\n\n` : ''}${cause ? `Likely cause: ${cause}` : ''}\n\nRedGreen only reproduces bugs here; it didn't change any code. The failing ${kind} above is ready to use as a regression check.${footer}`);
    } else if (repro) {
      await comment(repo, number, `## 🔴 Reproduced\nThis ${kind} **fails** on the current code:\n${howTo}\n\n${proof}\n\n### 🔍 Where to look\n${where ? `Files: ${where}\n\n` : ''}${cause ? `Likely cause: ${cause}` : ''}\n\n### No verified fix yet\nNone of the patches RedGreen tried made this ${kind} pass without breaking anything, so it isn't suggesting one. The failing ${kind} above is ready to use as a regression check.${footer}`);
    } else {
      const why = run.steps.filter((s) => s.reason || s.error).map((s) => `- ${s.reason || s.error}`).slice(-3).join('\n');
      await comment(repo, number, `## ⚪ Not reproduced\nRedGreen could not make a check fail for the reason described, so it is not claiming anything about this issue.\n\n${why}\n\nMore detail in the issue (exact steps, expected vs. actual values) usually helps.${footer}`);
    }
  }


  async function handle({ repo, number, why, text }) {
    const [owner, name] = repo.split('/');
    // Fork workflow: the trigger may point at an UPSTREAM issue; we read that issue but work on (and push to) this repo.
    const m = String(text).match(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/i);
    const upstream = m && `${m[1]}/${m[2]}`.toLowerCase() !== repo.toLowerCase() ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
    await comment(repo, number, `🔴🟢 **RedGreen** picked this up (${why})${upstream ? `: upstream issue ${upstream.owner}/${upstream.repo}#${upstream.number}, reproduced on this fork` : ''}. Reproducing it locally with Gemma 4.\n\n${!cfg.tryFix ? "I'll reply with a failing check that proves the bug and where to look. I won't change your code." : cfg.openPrs ? "I'll open a pull request **only if** a check fails on the current code and passes after my patch." : "I'll reply with a failing check that proves the bug, where to look, and a suggested fix only if I've verified it makes that check pass. I won't change your code."}`);
    const token = await tokenFor(repo); // installation token: lets the worker read private repos it was installed on; never stored
    const kase = await createCase({ owner, repo: name, number, upstream }, upstream ? undefined : token);
    const run = await runCase(kase, token);
    status.last = { repo, number, verdict: run.verdict, runId: run.id, at: new Date().toISOString() };
    await postResult(repo, number, kase, run, upstream);
    log(`${repo}#${number}: ${run.verdict.replace(/_/g, ' ')}`);
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
    return gh('POST', `/repos/${repo}/pulls`, { title: `Fix ${ref0}: ${title}`, head: branch, base, body: sanitizeForGitHub(body) });
  }

  return {
    status,
    async start() {
      cfg = getConfig();
      status.enabled = false; status.login = null; status.installUrl = null; status.kind = null; app = null;
      try {
        if (cfg.appId && cfg.privateKey) {
          app = createAppAuth({ appId: cfg.appId, privateKey: cfg.privateKey });
          const info = await app.info();
          status.kind = 'app'; status.owner = info.owner?.login || null; status.login = `${info.slug}[bot]`; status.appName = info.name; status.installUrl = `${info.html_url}/installations/new`;
        } else if (cfg.token) {
          status.kind = 'token'; status.login = (await gh('GET', '/user')).login;
        } else { status.error = 'Set up the GitHub App (or connect a token) on the Bot page to turn the bot on.'; return; }
      } catch (e) { app = null; status.error = 'GitHub rejected the credentials: ' + e.message.slice(0, 160); log('[bot] ' + status.error); return; }
      status.enabled = true; status.error = null;
      log(`[bot] connected as @${status.login}${status.kind === 'app' ? ' (GitHub App: watching every repo it is installed on)' : `; watching ${cfg.repos.join(', ') || 'no repos yet'}`}`);
      if (!timer) { timer = setInterval(poll, cfg.intervalMs); timer.unref?.(); } // the HTTP server keeps the process alive, not the bot
      poll();
    },
    gh: (m, p, b) => gh(m, p, b),
    postResult: (repo, number, kase, run) => postResult(repo, number, kase, run, kase.upstream || null),
  };
}
