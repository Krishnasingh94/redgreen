// RedGreen dashboard. Renders only what the server reports; never invents results.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const getJSON = (p) => fetch(p).then((r) => r.json());
const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let state = null;          // current view state
let running = false, tick = null;

/* ---------- tiny JS highlighter (tokenise raw, escape per token) ---------- */
const KW = /^(import|from|export|function|const|let|var|return|if|else|new|throw|true|false|null|undefined|for|of|await|async)$/;
function hl(code) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [t, c, s, n, f, w] = m;
    out += c ? `<span class="c">${esc(c)}</span>` : s ? `<span class="s">${esc(s)}</span>` : n ? `<span class="nm">${n}</span>`
      : f ? (KW.test(f) ? `<span class="k">${f}</span>` : `<span class="f">${esc(f)}</span>`) : KW.test(w) ? `<span class="k">${w}</span>` : esc(w);
    last = m.index + t.length;
  }
  return out + esc(code.slice(last));
}
const codeBlock = (c) => `<pre><code>${hl(String(c ?? '').trim())}</code></pre>`;
const diffBlock = (d, live) => { let n = 0; return `<pre class="diff${live ? ' live' : ''}"><code>${String(d).split('\n').map((l) => {
  const i = `style="--i:${n++}"`;
  if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@')) return `<span class="hd">${esc(l)}</span>`;
  if (l.startsWith('+')) return `<span class="add" ${i}>${esc(l)}</span>`;
  if (l.startsWith('-')) return `<span class="del" ${i}>${esc(l)}</span>`;
  return `<span>${esc(l)}</span>`;
}).join('')}</code></pre>`; };
const assertion = (out = '') => ({
  actual: (out.match(/actual:\s*([^\n,]+)/) || out.match(/Received:\s*([^\n]+)/))?.[1]?.trim(),
  expected: (out.match(/expected:\s*([^\n,]+)/) || out.match(/Expected:\s*([^\n]+)/))?.[1]?.trim(),
});

/* ---------- status badges ---------- */
async function loadStatus() {
  try {
    const s = await getJSON('/api/status');
    const b = $('#modelBadge');
    if (s.model.ok) {
      b.className = 'badge on';
      b.innerHTML = `<i class="dot"></i><span><strong>${esc(prettyModel(s.model.model))}</strong> ${s.model.local ? 'running on this laptop' : 'on a remote endpoint'}</span>`;
      b.title = `${s.model.model} at ${s.model.baseUrl}`;
    } else {
      b.className = 'badge down';
      b.innerHTML = `<i class="dot"></i><span>Model offline. Start the LM Studio server.</span>`;
      b.title = s.model.error;
    }
    const iso = s.sandbox.permissionModel.startsWith('--');
    $('#sbxBadge').innerHTML = `<span>${iso ? 'Tests run sealed: read-only, no processes' : 'Tests run without file isolation'}, ${s.sandbox.timeoutMs / 1000} s limit</span>`;
    $('#sbxBadge').title = `Node ${s.sandbox.node}, ${s.sandbox.permissionModel}`;
    const bb = $('#botBadge');
    if (s.bot?.enabled) {
      bb.hidden = false; bb.className = 'badge ' + (s.bot.current ? 'on' : '');
      bb.innerHTML = s.bot.current ? `<i class="dot"></i><span>Bot working on <strong>${esc(s.bot.current.repo)}#${s.bot.current.number}</strong></span>` : `<i class="dot"></i><span>Bot watching ${s.bot.repos.map(esc).join(', ')}</span>`;
      bb.title = `Label an issue "${s.bot.label}" or comment /redgreen`;
    } else bb.hidden = true;
  } catch { $('#modelBadge').className = 'badge down'; $('#modelBadge').innerHTML = '<i class="dot"></i><span>RedGreen server unreachable</span>'; }
}
function prettyModel(id) {
  const m = id.match(/gemma[-_ ]?(\d+)[-_ ]?([a-z]?\d+[a-z]?)?/i);
  return m ? `Gemma ${m[1]}${m[2] ? ' ' + m[2].toUpperCase() : ''}` : id;
}

/* ---------- sidebar ---------- */
const VERDICT = {
  fixed_verified: { pip: 'green', text: 'Fix verified' },
  reproduced_not_fixed: { pip: 'red', text: 'Reproduced, no verified fix' },
  not_reproduced: { pip: 'amber', text: 'Could not reproduce' },
};
async function loadLists() {
  const [reports, runs] = await Promise.all([getJSON('/api/reports'), getJSON('/api/runs')]);
  $('#reports').innerHTML = reports.length ? reports.map((r) => `<li><button data-report="${esc(r.id)}" aria-current="${state?.report?.id === r.id && !state.savedRun}">
      <i class="pip ${r.kind === 'github' ? 'gh' : 'ink'}"></i><span><span class="t">${esc(r.description)}</span><span class="m">${r.kind === 'github' ? esc(r.repo) : `${r.sample ? 'Scripted sample' : clock(r.savedAt)}, ${r.events} events${r.screenshot ? ', screenshot' : ''}`}</span></span></button></li>`).join('')
    : '<li class="empty">No reports yet. Use the demo shop and press “Report bug”.</li>';
  $('#runs').innerHTML = runs.length ? runs.slice(0, 12).map((r) => `<li><button data-run="${esc(r.id)}" aria-current="${state?.savedRun === r.id}">
      <i class="pip ${VERDICT[r.verdict]?.pip || ''}"></i><span><span class="t">${VERDICT[r.verdict]?.text || esc(r.verdict)}</span><span class="m">${clock(r.startedAt)}</span></span></button></li>`).join('')
    : '<li class="empty">No runs yet.</li>';
}
document.addEventListener('click', (e) => {
  if (running) return;
  const r = e.target.closest('[data-report]'); if (r) return openReport(r.dataset.report);
  const run = e.target.closest('[data-run]'); if (run) return openRun(run.dataset.run);
});

/* ---------- GitHub issues ---------- */
async function loadIssue(form) {
  const input = form.querySelector('input'), err = form.querySelector('.gherr'), btn = form.querySelector('button');
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Loading';
  try {
    const r = await fetch('/api/issues', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: input.value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    input.value = '';
    await openReport(j.id);
  } catch (e) { err.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = form.id === 'ghSide' ? 'Load' : 'Load issue'; }
}
document.addEventListener('submit', (e) => { const f = e.target.closest('.ghform'); if (f) { e.preventDefault(); if (!running) loadIssue(f); } });

/* ---------- views ---------- */
function intro() {
  $('#main').innerHTML = `<section class="intro">
    <h1><span class="no">No proof,</span><span class="yes">no fix.</span></h1>
    <p>RedGreen turns a bug report into a test that fails on your code, asks Gemma 4 on this laptop for a patch, and calls it fixed only when that same test passes and nothing else breaks.</p>
    <form class="ghform big" id="ghIntro">
      <label for="ghUrlIntro">Paste a GitHub issue from a JavaScript repo</label>
      <div class="ghrow"><input id="ghUrlIntro" type="url" placeholder="https://github.com/owner/repo/issues/1" required><button type="submit">Load issue</button></div>
      <p class="gherr" role="alert"></p>
    </form>
    <ol class="how">
      <li><b>Find</b><span>From a GitHub issue, RedGreen clones the repo and finds the code it talks about. From the demo app, it captures what the user did, with private values removed.</span></li>
      <li><b>Reproduce</b><span>Gemma writes a test in the repo's own framework. It counts only if it fails on the current code.</span></li>
      <li><b>Prove</b><span>Gemma patches the code. The same test and the repo's own tests must pass before anything is called fixed.</span></li>
    </ol></section>`;
}

function shell(report, savedRun) {
  state = { report, savedRun, stages: {}, live: null, steps: [] };
  const gh = report.kind === 'github';
  const when = report.sample ? 'Scripted sample' : `Reported at ${clock(report.savedAt)}`;
  const metaLine = gh
    ? `<a href="${esc(report.issue.url)}" target="_blank" rel="noopener">${esc(report.repo.owner)}/${esc(report.repo.repo)} issue #${report.repo.number}</a>, opened by ${esc(report.issue.author || 'unknown')}. Loaded at ${clock(report.savedAt)}.${savedRun ? ` Showing a saved run from ${clock(savedRun.startedAt)}.` : ''}`
    : null;
  $('#main').innerHTML = `
  <div class="rhead">
    <div><p class="quote">${esc(report.description)}</p>
      <p class="rmeta">${gh ? metaLine : `${when} with ${report.events.length} captured events${report.screenshot ? ' and a screenshot' : ''}. ${report.redactions} private ${report.redactions === 1 ? 'value' : 'values'} removed before saving.${savedRun ? ` Showing a saved run from ${clock(savedRun.startedAt)}.` : ''}`}</p></div>
    ${savedRun ? `<button class="go" id="go" data-again="1">Run again</button>` : `<button class="go" id="go"><span class="lamps" aria-hidden="true"><i class="l r"></i><i class="l g"></i></span>Reproduce and fix</button>`}
  </div>
  <div id="notice"></div>
  <section class="proof" id="proof" aria-live="polite">
    <div class="side-p" id="pRed"><div class="lamp"></div><div class="cap">On the code as it is</div><div class="verdictword">Waiting</div><div class="fact">Gemma's test must fail here.</div></div>
    <div class="wire" aria-hidden="true"><svg viewBox="0 0 84 28" preserveAspectRatio="none"><path class="base" d="M4 14 H70"/><path class="flow" d="M4 14 H70"/><path class="head" d="M66 5 L80 14 L66 23 Z"/></svg></div>
    <div class="side-p" id="pGreen"><div class="lamp"></div><div class="cap">After Gemma's patch</div><div class="verdictword">Waiting</div><div class="fact">The same test must pass here.</div></div>
  </section>
  <ol class="track" id="track">
    ${[gh ? 'Clone and search' : 'Evidence', gh ? 'Repo tests' : 'Existing tests', 'Reproduce', 'Patch', 'Verify'].map((l, i) => `<li data-k="${i}"><span class="n">${i + 1}</span><span class="lbl">${l}</span><span class="tm">&nbsp;</span></li>`).join('')}
  </ol>
  <div class="cols">
    <div>
      ${gh ? `<section class="sect"><h3>The issue <small>untrusted text, read as data</small></h3><div class="body issue">${esc(report.issue.body || '(no description)')}</div></section>
      <section class="sect" id="pageSect" hidden><h3>The live page <small>Gemma 4 sees this screenshot</small></h3><div class="body shot"><img id="pageShot" alt="Screenshot of the site as cloned from GitHub"></div></section>
      <section class="sect"><h3>Files Gemma will read <small>chosen by keyword search, not AI</small></h3><ol class="files" id="files"><li class="empty">Found after the repo is cloned.</li></ol></section>` : `<section class="sect"><h3>What the user did <small>captured, private values removed</small></h3><ol class="tl" id="tl">${timeline(report)}</ol>
        ${report.screenshot ? `<div class="body shot"><p>Screenshot the user attached. Gemma 4 reads it.</p><img src="${report.screenshot}" alt="Screenshot attached to the bug report"></div>` : ''}</section>`}
      <section class="sect" id="hypSect" hidden><h3>Gemma's diagnosis</h3><div class="body hyp" id="hyp"></div></section>
    </div>
    <div>
      <section class="sect" id="outSect" hidden><h3 id="outTitle">Verified fix</h3><div class="body out" id="out"></div></section>
      <section class="sect"><h3>What Gemma tried <small>every result below is a real test run</small></h3><ol class="att" id="att"><li><i class="mk"></i><div><h4>Not started</h4><p class="sub">Press “Reproduce and fix” to begin.</p></div></li></ol></section>
    </div>
  </div>`;
  $('#go').addEventListener('click', () => analyze(report.id));
  loadLists();
}

function timeline(report, cited = []) {
  return report.events.map((e) => {
    const bad = e.type !== 'action';
    let what = '';
    if (e.type === 'action') {
      const args = (e.args || []).map((a) => typeof a === 'object' ? (a.name || a.id || '{…}') : JSON.stringify(a)).join(', ');
      const st = e.stateAfter || {};
      what = `<code>${esc(e.name)}(${esc(args)})</code><div class="st">${st.error ? 'Error: ' + esc(st.error) : `Total after: <b>$${Number(st.total).toFixed(2)}</b>${st.discount ? `, discount $${Number(st.discount).toFixed(2)}` : ''}`}</div>`;
    } else if (e.type === 'network.failed') {
      let msg = e.responseBody || e.error || ''; try { msg = JSON.parse(msg).error || msg; } catch {}
      what = `Request failed: <code>${esc(e.method)} ${esc(new URL(e.url, location.href).pathname)}</code> returned ${e.status}<div class="st">${esc(msg).slice(0, 180)}</div>`;
    } else what = `${e.type === 'uncaught' ? 'Crash' : 'Console error'}: ${esc(e.message)}`;
    const c = cited.includes(e.id);
    return `<li class="${bad ? 'bad' : ''} ${c ? 'cited' : ''}"><span class="at">${(e.t_ms / 1000).toFixed(1)}s</span><i class="nd"></i><div class="what">${what}${c ? '<span class="cite">cited by Gemma</span>' : ''}</div></li>`;
  }).join('');
}

/* ---------- proof bar + track ---------- */
function setPanel(id, cls, word, fact, ignite) {
  const p = $(id); if (!p) return;
  p.className = 'side-p ' + cls + (ignite ? ' ignite' : '');
  $('.verdictword', p).textContent = word;
  $('.fact', p).innerHTML = fact;
  $('#proof').classList.toggle('has-red', $('#pRed').classList.contains('red'));
  $('#proof').classList.toggle('has-green', $('#pGreen').classList.contains('green'));
}
function stage(k, cls, tm) {
  const li = $(`#track [data-k="${k}"]`); if (!li) return;
  li.className = cls;
  if (tm !== undefined) $('.tm', li).textContent = tm;
}
function addTime(k, ms) { state.stages[k] = (state.stages[k] || 0) + ms; stage(k, $(`#track [data-k="${k}"]`).className, secs(state.stages[k])); }

/* ---------- step rendering ---------- */
let liveMode = false;
function attempt(html) {
  const att = $('#att'); if (att.dataset.started !== '1') { att.innerHTML = ''; att.dataset.started = '1'; }
  $('#liveAtt')?.remove(); att.insertAdjacentHTML('beforeend', html);
  if (liveMode) att.lastElementChild.classList.add('enter');
}
const chip = (r) => `<span class="chip ${r.passed ? 'pass' : 'fail'}"><b>${r.passed ? 'PASS' : 'FAIL'}</b>${esc(r.file.replace('test/', ''))}${r.file === 'browser steps' || r.file === 'repo tests' ? '' : `, ${r.pass} passed, ${r.fail} failed`}</span>`;
const outBlock = (r, label = 'Test output') => `<details><summary>${label}</summary><pre>${esc(r.output.trim())}</pre></details>`;

function render(s, live) {
  liveMode = live;
  switch (s.type) {
    case 'evidence': stage(0, 'done', 'ready'); break;
    case 'prepare':
      if (s.stage === 'ready') { stage(0, 'done', secs(s.durationMs || 0)); attempt(`<li><i class="mk info"></i><div><h4>Repo ready</h4><p class="sub">${esc(s.note)}${s.sha ? `, commit ${esc(s.sha)}` : ''}</p></div></li>`); }
      else { stage(0, 'now', s.stage === 'install' ? 'installing' : 'cloning'); attempt(`<li id="liveAtt"><i class="mk live"></i><div><h4>${esc(s.note)}</h4><p class="sub">${s.stage === 'install' ? 'npm, with install scripts turned off' : 'shallow clone from GitHub'}</p></div></li>`); }
      break;
    case 'page':
      if ($('#pageSect')) { $('#pageSect').hidden = false; $('#pageShot').src = s.screenshot; if (live) $('#pageSect').classList.add('reveal'); }
      break;
    case 'located':
      $('#files').innerHTML = s.files.map((f, i) => `<li style="--i:${i}"><div class="fp"><code>${esc(f.path)}</code><span class="sc">${f.lines} lines</span></div><div class="tags">${f.terms.map((t) => `<span>${esc(t)}</span>`).join('')}</div></li>`).join('');
      if (live) $('#files').classList.add('live');
      break;
    case 'baseline':
      if (s.none) { stage(1, 'done', 'none'); attempt(`<li><i class="mk info"></i><div><h4>No automated tests in this repo</h4><p class="sub">The browser check is the proof.</p></div></li>`); break; }
      stage(1, s.result.passed ? 'done' : 'red', secs(s.result.durationMs));
      attempt(`<li><i class="mk ${s.result.passed ? 'info' : 'fail'}"></i><div><h4>${s.result.passed ? (s.result.pass ? `${state.report.kind === 'github' ? 'The repo\'s' : 'Your'} ${s.result.pass} existing tests pass` : 'The existing tests pass') : 'The existing tests already fail'}</h4>
        <p class="sub">${s.result.passed ? 'So they do not catch this bug.' : 'Fix those first; results below may be unreliable.'}</p><div class="res">${chip(s.result)}</div>${outBlock(s.result)}</div></li>`);
      break;
    case 'model.start': {
      const k = s.phase === 'reproduce' ? 2 : 3;
      stage(k, 'now');
      if (s.phase === 'reproduce') setPanel('#pRed', 'busy', 'Writing', `Gemma is writing a test from the evidence <span class="tick" id="tick">0 s</span>`);
      else $('#proof').classList.add('flowing'), setPanel('#pGreen', 'busy', 'Patching', `Gemma is rewriting the code <span class="tick" id="tick">0 s</span>`);
      if (live) {
        const t0 = Date.now(); clearInterval(tick);
        tick = setInterval(() => { const el = $('#tick'); if (el) el.textContent = Math.round((Date.now() - t0) / 1000) + ' s'; }, 250);
        attempt(`<li id="liveAtt"><i class="mk live"></i><div><h4>${s.phase === 'reproduce' ? 'Writing a reproduction test' : 'Proposing a patch'}</h4><p class="sub">Attempt ${s.attempt} of 3, on this laptop</p></div></li>`);
      }
      break; }
    case 'model.error':
      clearInterval(tick);
      attempt(`<li><i class="mk fail"></i><div><h4>Model error</h4><p class="why">${esc(s.error)}</p></div></li>`);
      break;
    case 'repro.rejected':
      clearInterval(tick); addTime(2, s.durationMs || 0);
      attempt(`<li><i class="mk warn"></i><div><h4>Test rejected</h4><p class="sub">Attempt ${s.attempt}, ${secs(s.durationMs || 0)}</p><p class="why">${esc(s.reason)}</p>${s.result ? `<div class="res">${chip(s.result)}</div>` : ''}<details><summary>${s.proposal?.steps ? "Gemma's browser steps" : "Gemma's test"}</summary>${proposalBody(s.proposal, s.result?.assertionFailure?.step)}</details></div></li>`);
      break;
    case 'repro.confirmed': {
      clearInterval(tick); addTime(2, s.durationMs || 0); stage(2, 'red');
      const af = s.result.assertionFailure;
      const a = af ? { expected: (s.proposal.steps?.[af.step - 1]?.value) || af.expected, actual: String(af.actual).replace(/^"|"$/g, '') } : assertion(s.result.output);
      setPanel('#pRed', 'red', 'Fails', a.expected ? `Expected <b>${esc(money(a.expected))}</b>, got <b>${esc(money(a.actual))}</b>. Bug reproduced.` : 'Bug reproduced by a failing test.', live);
      attempt(`<li><i class="mk fail"></i><div><h4>${s.proposal.steps ? 'Bug reproduced in a real browser' : 'Bug reproduced: the test fails on your code'}</h4><p class="sub">Attempt ${s.attempt}, ${secs(s.durationMs)}</p><div class="res">${chip(s.result)}</div>
        <details open><summary>${s.proposal.steps ? 'Browser steps, written by Gemma and run by RedGreen' : 'Reproduction test, written by Gemma'}</summary>${proposalBody(s.proposal, af?.step)}</details>${outBlock(s.result, s.proposal.steps ? 'Browser run log' : 'Failure output')}</div></li>`);
      if (s.result.screenshot && $('#pageShot')) { state.failShot = s.result.screenshot; }
      $('#hypSect').hidden = false;
      $('#hyp').innerHTML = `<p>${esc(s.proposal.hypothesis)}</p><dl class="ev"><dt>Expected</dt><dd class="exp">${esc(s.proposal.expected)}</dd><dt>Actual</dt><dd class="act">${esc(s.proposal.actual)}</dd><dt>Evidence</dt><dd>${(s.proposal.evidence_ids || []).map((x) => state.report.kind === 'github' ? `“${esc(x)}”` : esc(x)).join(', ') || 'none cited'}</dd></dl>`;
      if ($('#tl')) $('#tl').innerHTML = timeline(state.report, s.proposal.evidence_ids || []);
      if (live && $('#tl')) { $('#tl').classList.add('live'); [...$('#tl').querySelectorAll('li.cited')].forEach((li, i) => li.style.setProperty('--i', i)); }
      if (live) $('#hypSect').classList.add('reveal');
      break; }
    case 'fix.rejected':
      clearInterval(tick); addTime(3, s.durationMs || 0);
      for (const r of s.results || []) addTime(4, r.durationMs);
      attempt(`<li><i class="mk warn"></i><div><h4>Patch rejected</h4><p class="sub">Attempt ${s.attempt}, ${secs(s.durationMs || 0)}</p><p class="why">${esc(s.reason)}</p>${(s.results || []).length ? `<div class="res">${s.results.map(chip).join('')}</div>` : ''}${s.diff ? `<details><summary>Rejected change</summary>${diffBlock(s.diff)}</details>` : ''}</div></li>`);
      break;
    case 'fix.verified': {
      clearInterval(tick); addTime(3, s.durationMs || 0); stage(3, 'done');
      for (const r of s.results) addTime(4, r.durationMs);
      stage(4, 'green');
      const existing = s.results[1];
      $('#proof').classList.remove('flowing');
      const sameWhat = s.results[0].file === 'browser steps' ? 'Same browser check passes.' : 'Same test passes.';
      setPanel('#pGreen', 'green', 'Passes', !existing ? `${sameWhat} This repo has no other tests to run.` : `${sameWhat} ${existing.note ? 'No new failures in the repo\'s tests.' : existing.pass ? `All ${existing.pass} existing tests still pass.` : 'The existing tests still pass.'}`, live);
      if (live) { const p = $('#proof'); p.classList.remove('celebrate'); void p.offsetWidth; p.classList.add('celebrate'); }
      attempt(`<li><i class="mk ok"></i><div><h4>Patch verified</h4><p class="sub">Attempt ${s.attempt}, ${secs(s.durationMs)}</p><div class="res">${s.results.map(chip).join('')}</div>${outBlock(s.results[0], 'Passing output')}</div></li>`);
      state.verified = s;
      if (s.before && s.after) state.shots = { before: s.before, after: s.after };
      break; }
    case 'fatal':
      clearInterval(tick);
      $('#notice').innerHTML = `<div class="notice err">${esc(s.error)}</div>`;
      break;
  }
}
const stepText = (st) => {
  const t = st.target ? `<code>${esc(st.target)}</code>` : '';
  const v = st.value ? `<b>${esc(st.value)}</b>` : '';
  return ({ goto: `Open ${v || 'the page'}`, click: `Click ${t}`, fill: `Type ${v} into ${t}`, select: `Choose ${v} in ${t}`, press: `Press ${v}`, wait: `Wait ${v} ms`,
    expect_text: `Expect ${t || 'the page'} to show ${v}`, expect_value: `Expect ${t} to equal ${v}`, expect_visible: `Expect ${t} to be visible`, expect_hidden: `Expect ${t} to be hidden`,
    expect_count: `Expect ${v} of ${t}`, expect_no_errors: 'Expect no JavaScript errors' })[st.action] || esc(st.action);
};
const stepsBlock = (steps, failedAt) => `<ol class="steps">${steps.map((st, i) => `<li class="${st.action.startsWith('expect') ? 'ex' : ''} ${failedAt === i + 1 ? 'bad' : ''}">${stepText(st)}</li>`).join('')}</ol>`;
const proposalBody = (p, failedAt) => p?.steps ? stepsBlock(p.steps, failedAt) : codeBlock(p?.test_code);
const money = (v) => /^-?\d+(\.\d+)?$/.test(v) ? '$' + Number(v).toFixed(2) : v;

function finish(verdict, runId) {
  clearInterval(tick); $('#proof')?.classList.remove('flowing');
  if (verdict === 'not_reproduced') {
    stage(2, 'red');
    setPanel('#pRed', 'amber', 'Unproven', 'No test failed for the reported reason. Nothing was changed.');
    setPanel('#pGreen', '', 'Skipped', 'No patch without a failing test.');
  } else if (verdict === 'reproduced_not_fixed') {
    setPanel('#pGreen', 'amber', 'No fix', 'No patch passed. Your code is unchanged.');
  }
  if (runId) showOutcome(runId, verdict);
  loadLists();
}

async function showOutcome(runId, verdict) {
  const md = await fetch(`/api/runs/${runId}/pr.md`).then((r) => r.text());
  const v = state.verified;
  const sect = $('#outSect'); sect.hidden = false; sect.classList.add('reveal');
  $('#outTitle').textContent = v ? 'Verified fix' : 'Report for the maintainer';
  const patch = v ? `${v.diff}\n` : '';
  $('#out').innerHTML = `
    ${state.shots ? `<div class="ba"><figure><img src="${state.shots.before}" alt="The page before the patch, with the bug"><figcaption><i class="pip red"></i>Before the patch</figcaption></figure><figure><img src="${state.shots.after}" alt="The page after the patch"><figcaption><i class="pip green"></i>After the patch</figcaption></figure></div>` : ''}
    ${v ? `<p class="change"><b>What changed:</b> ${esc((v.proposal.change && v.proposal.change.length < 180 && !/[{};]\s*\S/.test(v.proposal.change)) ? v.proposal.change : (v.proposal.root_cause || v.proposal.change || '').slice(0, 400))}</p>${diffBlock(v.diff, true)}` : '<p>The bug is reproduced by a failing test, but no patch was verified. The report below includes the test so a person can take it from here.</p>'}
    <div class="actions" style="margin-top:12px">
      <button class="btn" id="copyPr">Copy PR description</button>
      <a class="btn" href="/api/runs/${esc(runId)}/pr.md" download="redgreen-${esc(runId)}.md">Download report</a>
      ${v ? `<a class="btn" id="dlPatch" download="redgreen-${esc(runId)}.diff">Download patch</a>` : ''}
    </div>
    <details><summary>Preview PR description</summary><pre>${esc(md)}</pre></details>`;
  $('#copyPr').onclick = () => navigator.clipboard.writeText(md).then(() => { $('#copyPr').textContent = 'Copied'; });
  if (v) $('#dlPatch').href = URL.createObjectURL(new Blob([patch], { type: 'text/x-diff' }));
}

/* ---------- actions ---------- */
const swap = (fn) => {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve(fn());
  const t = document.startViewTransition(fn);
  t.finished.catch(() => {}); t.ready.catch(() => {}); // a newer click can skip this transition; that's fine
  return t.updateCallbackDone;
};
async function openReport(id) { const r = await getJSON('/api/reports/' + encodeURIComponent(id)); await swap(() => shell(r, null)); }
async function openRun(id) {
  const run = await getJSON('/api/runs/' + encodeURIComponent(id));
  const report = await getJSON('/api/reports/' + encodeURIComponent(run.reportId));
  await swap(() => shell(report, { id: run.id, startedAt: run.startedAt }));
  state.savedRun = run.id;
  for (const s of run.steps) render(s, false);
  finish(run.verdict, run.id);
}
function analyze(id) {
  if (running) return;
  shell(state.report, null); // fresh view: clears timers, panels and attempts from any previous run
  running = true;
  const go = $('#go'); go.disabled = true; go.lastChild.textContent = 'Working';
  const es = new EventSource('/api/analyze/' + encodeURIComponent(id));
  es.onmessage = (m) => {
    const s = JSON.parse(m.data);
    if (s.type === 'done') { es.close(); running = false; go.disabled = false; go.lastChild.textContent = 'Run again'; finish(s.verdict, s.runId); return; }
    render(s, true);
  };
  es.onerror = () => { es.close(); running = false; clearInterval(tick); go.disabled = false; go.lastChild.textContent = 'Try again';
    $('#notice').innerHTML = '<div class="notice err">Lost the connection to the RedGreen server. Check the terminal running it, then try again.</div>'; };
}

/* ---------- follow bot runs live ---------- */
let botCase = null;
function followBot() {
  const es = new EventSource('/api/live');
  es.onmessage = async (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'bot.start') {
      if (running) return; // the person is busy with their own run
      botCase = ev.caseId; running = true;
      await openReport(ev.caseId);
      const go = $('#go'); if (go) { go.disabled = true; go.lastChild.textContent = 'Bot is working'; }
      $('#notice').innerHTML = `<div class="notice">The GitHub bot picked up this issue on ${esc(ev.repo)}. Following its run live.</div>`;
      loadStatus();
      return;
    }
    if (!botCase || ev.caseId !== botCase) return;
    if (ev.type === 'done') { running = false; botCase = null; const go = $('#go'); if (go) { go.disabled = false; go.lastChild.textContent = 'Run again'; } finish(ev.verdict, ev.runId); loadStatus(); return; }
    render(ev, true);
  };
}

intro(); loadStatus(); loadLists(); followBot(); setInterval(loadStatus, 10000);
