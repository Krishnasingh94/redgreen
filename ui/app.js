// RedGreen dashboard. Renders only what the server reports; never invents results.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const getJSON = (p) => fetch(p).then((r) => r.json());
const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

let state = null;          // current view state
let tryFixSetting = false; // reproduce-only unless switched on in the Bot page
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
    tryFixSetting = !!s.tryFix;
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
      bb.innerHTML = s.bot.current ? `<i class="dot"></i><span>Bot working on <strong>${esc(s.bot.current.repo)}#${s.bot.current.number}</strong></span>` : `<i class="dot"></i><span>${s.bot.kind === 'app' ? `GitHub App live on ${s.bot.repos.length} ${s.bot.repos.length === 1 ? 'repo' : 'repos'}` : `Bot watching ${s.bot.repos.map(esc).join(', ')}`}</span>`;
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
  reproduced: { pip: 'red', text: 'Reproduced' },
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
    if (form.id === 'ghIntro') setTimeout(() => analyze(j.id), 400); // "Reproduce it" starts right away
  } catch (e) { err.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = form.id === 'ghSide' ? 'Load' : 'Reproduce it'; }
}
document.addEventListener('submit', (e) => { const f = e.target.closest('.ghform'); if (f) { e.preventDefault(); if (!running) loadIssue(f); } });

/* ---------- views ---------- */
function intro() {
  $('#main').innerHTML = `<section class="home">
    <div class="hero">
      <div class="hero-copy">
        <h1><span class="no">No proof,</span><span class="yes">no fix.</span></h1>
        <p class="sub1">“It's broken” isn't a bug report. RedGreen turns a GitHub issue into a <b>check that fails on your code</b>, then shows where to look. Gemma 4 runs on this laptop, and every claim comes from a real run.</p>
        <form class="ghform big" id="ghIntro">
          <label for="ghUrlIntro">Paste a GitHub issue from a website or JavaScript project</label>
          <div class="ghrow"><input id="ghUrlIntro" type="url" placeholder="https://github.com/owner/repo/issues/1" required><button type="submit">Reproduce it</button></div>
          <p class="gherr" role="alert"></p>
        </form>
        <div class="chips"><span>Gemma 4 E4B, offline</span><span>Runs on a 6 GB laptop GPU</span><span>Never edits your code by default</span></div>
      </div>
      <figure class="replay" aria-label="A real exchange on GitHub: an issue, then RedGreen's reply">
        <div class="gh-card issue-card">
          <div class="gh-head"><span class="state">Open</span><b>Cart total is wrong after changing quantity with a coupon applied</b></div>
          <p>Add Headphones, set quantity to 3, apply SAVE20, then set quantity back to 1.<br>Expected <b>$40.00</b>. Actual: the total shows <b>$20.00</b>.</p>
          <div class="cmt"><span class="who">samvit-srivastava</span> commented <code>/redgreen</code></div>
        </div>
        <div class="gh-card bot-card">
          <div class="gh-head"><span class="avatar"><i class="l r"></i><i class="l g"></i></span><b>redgreen</b><span class="botpill">bot</span></div>
          <h3><i class="dotred"></i>Reproduced</h3>
          <p class="small">This browser check <b>fails</b> on the current code:</p>
          <pre class="mini"><span class="ok">✓ 1. click "button.add[data-id=hp]"</span><span class="ok">✓ 2. fill "Quantity of Headphones" "3"</span><span class="ok">✓ 3. fill "#coupon" "SAVE20"</span><span class="ok">✓ 4. click "#apply"</span><span class="ok">✓ 5. fill "Quantity of Headphones" "1"</span><span class="bad">✗ 6. expect "#total" to show "$40.00"</span><span class="bad">     actual: "$20.00"</span></pre>
          <p class="small where">🔍 Where to look: <code>app.js</code>, <code>setQuantity()</code></p>
        </div>
        <figcaption>A real reply RedGreen posted on <a href="https://github.com/samvit-srivastava/tiny-shop/issues/1" target="_blank" rel="noopener">tiny-shop#1</a></figcaption>
      </figure>
    </div>

    <ol class="how">
      <li><span class="num">1</span><b>Find</b><span>Clones the repo, serves the site or runs its tests, and finds the code the issue talks about. Issue text is treated as data, never as instructions.</span></li>
      <li><span class="num r">2</span><b>Reproduce</b><span>Gemma 4 reads the issue, the code and a screenshot of the page, then writes a test or browser steps. It only counts if it fails on the current code.</span></li>
      <li><span class="num g">3</span><b>Point</b><span>You get the failing check, the real output and where to look. Optionally a fix, suggested only after it made that check pass.</span></li>
    </ol>

    <div class="appcta">
      <div><b>Add RedGreen to your repos.</b> Install it as a GitHub app, then label an issue <code>redgreen</code> or comment <code>/redgreen</code>. It replies on the issue, like the one above.</div>
      <button class="btn primary" id="ctaApp" type="button">Set up RedGreen for GitHub</button>
    </div>
    <p class="foot">Open source, Apache-2.0 · <a href="https://github.com/samvit-srivastava/redgreen" target="_blank" rel="noopener">github.com/samvit-srivastava/redgreen</a></p>
  </section>`;
  $('#ctaApp').addEventListener('click', () => botView());
}

function shell(report, savedRun) {
  state = { report, savedRun, stages: {}, live: null, steps: [], tryFix: tryFixSetting };
  const gh = report.kind === 'github';
  const when = report.sample ? 'Scripted sample' : `Reported at ${clock(report.savedAt)}`;
  const metaLine = gh
    ? `<a href="${esc(report.issue.url)}" target="_blank" rel="noopener">${esc(report.repo.owner)}/${esc(report.repo.repo)} issue #${report.repo.number}</a>, opened by ${esc(report.issue.author || 'unknown')}. Loaded at ${clock(report.savedAt)}.${savedRun ? ` Showing a saved run from ${clock(savedRun.startedAt)}.` : ''}`
    : null;
  $('#main').innerHTML = `
  <div class="rhead">
    <div><p class="quote">${esc(report.description)}</p>
      <p class="rmeta">${gh ? metaLine : `${when} with ${report.events.length} captured events${report.screenshot ? ' and a screenshot' : ''}. ${report.redactions} private ${report.redactions === 1 ? 'value' : 'values'} removed before saving.${savedRun ? ` Showing a saved run from ${clock(savedRun.startedAt)}.` : ''}`}</p></div>
    ${savedRun ? `<button class="go" id="go" data-again="1">Run again</button>` : `<button class="go" id="go"><span class="lamps" aria-hidden="true"><i class="l r"></i><i class="l g"></i></span>${state.tryFix ? 'Reproduce and fix' : 'Reproduce'}</button>`}
  </div>
  <div id="notice"></div>
  <section class="proof" id="proof" aria-live="polite">
    <div class="side-p" id="pRed"><div class="lamp"></div><div class="cap">On the code as it is</div><div class="verdictword">Waiting</div><div class="fact">Gemma's check must fail here.</div></div>
    <div class="wire" aria-hidden="true"><svg viewBox="0 0 84 28" preserveAspectRatio="none"><path class="base" d="M4 14 H70"/><path class="flow" d="M4 14 H70"/><path class="head" d="M66 5 L80 14 L66 23 Z"/></svg></div>
    <div class="side-p" id="pGreen"><div class="lamp"></div><div class="cap">${state.tryFix === false ? 'Where to look' : "After Gemma's patch"}</div><div class="verdictword">Waiting</div><div class="fact">${state.tryFix === false ? 'Found after the bug is reproduced.' : 'The same test must pass here.'}</div></div>
  </section>
  <ol class="track" id="track">
    ${[gh ? 'Clone and search' : 'Evidence', gh ? 'Repo tests' : 'Existing tests', 'Reproduce', state.tryFix ? 'Patch' : 'Where to look', state.tryFix ? 'Verify' : 'Report'].map((l, i) => `<li data-k="${i}"><span class="n">${i + 1}</span><span class="lbl">${l}</span><span class="tm">&nbsp;</span></li>`).join('')}
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
      <section class="sect"><h3>What Gemma tried <small>every result below is a real test run</small></h3><ol class="att" id="att"><li><i class="mk"></i><div><h4>Not started</h4><p class="sub">Press “${state.tryFix ? 'Reproduce and fix' : 'Reproduce'}” to begin.</p></div></li></ol></section>
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
      state.files = s.files;
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
      state.cause = s.proposal.hypothesis;
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
  } else if (verdict === 'reproduced') {
    stage(3, 'done', state.files?.length ? `${state.files.length} files` : 'done'); stage(4, 'done', 'ready');
    const where = (state.files || []).slice(0, 2).map((f) => `<code>${esc(f.path)}</code>`).join(' and ');
    $('#pGreen .cap').textContent = 'Where to look';
    setPanel('#pGreen', 'amber', 'Located', `${where ? `Start in ${where}. ` : ''}${state.cause ? esc(state.cause).slice(0, 180) : 'See the diagnosis below.'}`, true);
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
  $('#outTitle').textContent = v ? 'Verified fix' : verdict === 'reproduced' ? 'Bug report with proof' : 'Report for the maintainer';
  const patch = v ? `${v.diff}\n` : '';
  $('#out').innerHTML = `
    ${state.shots ? `<div class="ba"><figure><img src="${state.shots.before}" alt="The page before the patch, with the bug"><figcaption><i class="pip red"></i>Before the patch</figcaption></figure><figure><img src="${state.shots.after}" alt="The page after the patch"><figcaption><i class="pip green"></i>After the patch</figcaption></figure></div>` : ''}
    ${v ? `<p class="change"><b>What changed:</b> ${esc((v.proposal.change && v.proposal.change.length < 180 && !/[{};]\s*\S/.test(v.proposal.change)) ? v.proposal.change : (v.proposal.root_cause || v.proposal.change || '').slice(0, 400))}</p>${diffBlock(v.diff, true)}` : (verdict === 'reproduced' ? '<p>The bug is proven by a failing check. RedGreen did not change any code; the report below has the check, where to look, and the real output, ready for a developer.</p>' : '<p>The bug is reproduced by a failing test, but no patch was verified. The report below includes the test so a person can take it from here.</p>')}
    <div class="actions" style="margin-top:12px">
      <button class="btn" id="copyPr">${v ? 'Copy PR description' : 'Copy report'}</button>
      <a class="btn" href="/api/runs/${esc(runId)}/pr.md" download="redgreen-${esc(runId)}.md">Download report</a>
      ${v ? `<a class="btn" id="dlPatch" download="redgreen-${esc(runId)}.diff">Download patch</a>` : ''}
      ${state.report.kind === 'github' ? `<button class="btn" id="postGh">Post result to the GitHub issue</button>` : ''}
    </div>
    <details><summary>Preview PR description</summary><pre>${esc(md)}</pre></details>`;
  $('#postGh')?.addEventListener('click', async (e) => {
    const btn = e.target; btn.disabled = true; btn.textContent = 'Posting';
    const r = await fetch(`/api/bot/post/${runId}`, { method: 'POST' }); const j = await r.json();
    if (r.ok) { btn.outerHTML = `<a class="btn" href="${esc(j.url)}" target="_blank" rel="noopener">Posted. View on GitHub</a>`; } else { btn.disabled = false; btn.textContent = 'Post result to the GitHub issue'; $('#notice').innerHTML = `<div class="notice err">${esc(j.error)}</div>`; }
  });
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

/* ---------- GitHub bot page ---------- */
async function botView() {
  const b = await getJSON('/api/bot');
  state = null;
  const isApp = b.kind === 'app';
  const installs = (b.installations || []);
  const repoItems = isApp
    ? (installs.map((r) => `<li><a href="https://github.com/${esc(r.repo)}/issues" target="_blank" rel="noopener"><code>${esc(r.repo)}</code></a><span class="hint">installed by @${esc(r.account || '')}</span></li>`).join('') || '<li class="empty">Not installed anywhere yet. Use the install button.</li>')
    : ((b.repos || []).map((r) => `<li><a href="https://github.com/${esc(r)}/issues" target="_blank" rel="noopener"><code>${esc(r)}</code></a><button class="btn small" data-unwatch="${esc(r)}">Remove</button></li>`).join('') || '<li class="empty">No repos yet.</li>');
  const act = (b.activity || []).map((a) => `<li><span class="at">${clock(a.at)}</span>${esc(a.msg)}</li>`).join('') || '<li class="empty">Nothing yet.</li>';
  await swap(() => { $('#main').innerHTML = `
  <section class="botpage">
    <h1 class="bh">RedGreen for GitHub</h1>
    <p class="lead">Install RedGreen on any repo, like any GitHub app. When an issue gets the <code>redgreen</code> label, or someone with write access comments <code>/redgreen</code>, RedGreen reproduces the bug and replies with the failing check, where to look, and a fix only if it verified one. It does not change code unless you allow it.</p>
    ${!b.githubMode ? `<div class="notice err">${esc(b.error)}</div>` : ''}
    ${isApp && b.enabled ? `<div class="installbar"><div><b>${esc(b.appName || 'RedGreen')}</b> is live as <code>@${esc(b.login)}</code>. Anyone can add it to their repos:</div><a class="go" href="${esc(b.installUrl)}" target="_blank" rel="noopener"><span class="lamps" aria-hidden="true"><i class="l r"></i><i class="l g"></i></span>Install RedGreen on a repo</a></div>` : ''}
    <div class="botgrid">
      <section class="sect"><h3>${isApp ? 'GitHub App' : '1. Set up the GitHub App'} ${b.enabled ? '<small class="ok">running</small>' : ''}</h3><div class="body">
        ${isApp && b.enabled ? `<p>This computer is the worker: it checks every repo the app is installed on and does the red → green work with Gemma 4.</p><button class="btn" id="removeApp">Remove app credentials</button>`
        : `<p>Create your own RedGreen app on GitHub in one click. GitHub fills in everything and sends the keys straight back here. You type nothing.</p>
          <button class="go" id="createApp" type="button"><span class="lamps" aria-hidden="true"><i class="l r"></i><i class="l g"></i></span>Create RedGreen on GitHub</button>
          <details class="manual"><summary>Already registered an app? Enter its details by hand</summary>
            <form id="appForm" class="appform"><input id="appId" inputmode="numeric" placeholder="App ID" required><label class="file"><input id="appKey" type="file" accept=".pem" required><span>Choose .pem key</span></label><button type="submit" class="btn">Save</button></form>
          </details>`}
        <p class="gherr" id="appErr">${b.appConfigured && !b.enabled && b.error ? esc(b.error) : ''}</p></div></section>
      <section class="sect"><h3>${isApp ? 'Installed on' : '2. Repos'}</h3><div class="body">
        <ul class="repolist">${repoItems}</ul>
        ${isApp ? '<p class="hint">New installs are picked up within 30 seconds.</p>' : `
        <details ${b.kind === 'token' ? 'open' : ''}><summary>Or use a personal token instead of an app</summary>
          ${b.kind === 'token' ? `<p>Connected as <b>@${esc(b.login)}</b>. <button class="btn small" id="disconnect">Disconnect</button></p>
            <form id="repoForm" class="ghrow"><input id="repoIn" placeholder="owner/repo" required><button type="submit" class="btn">Add repo</button></form>`
          : `<form id="tokForm" class="ghrow"><input id="tok" type="password" autocomplete="off" placeholder="github_pat_…" required><button type="submit" class="btn">Connect</button></form>`}
          <p class="gherr" id="tokErr"></p></details>`}
        <p class="hint">Contributing to someone else's project? Install RedGreen on your fork and comment <code>/redgreen https://github.com/owner/project/issues/42</code> on an issue there.</p></div></section>
      <section class="sect"><h3>What RedGreen does</h3><div class="body">
        <p class="hint" style="margin-top:0">By default RedGreen only <b>reproduces</b>: it proves the bug with a failing check and points to where to look. It never changes code.</p>
        <label class="check"><input type="checkbox" id="tryFix" ${b.tryFix ? 'checked' : ''} ${b.githubMode ? '' : 'disabled'}> Also try a fix, and suggest it only if it makes the failing check pass</label>
        <label class="check" style="margin-top:8px"><input type="checkbox" id="openPrs" ${b.openPrs ? 'checked' : ''} ${b.enabled && b.tryFix ? '' : 'disabled'}> Also open a pull request for verified fixes</label>
        </div></section>
      <section class="sect"><h3>Activity ${b.current ? `<small>working on ${esc(b.current.repo)}#${b.current.number}</small>` : ''}</h3><ul class="activity">${act}</ul></section>
    </div>
  </section>`; });
  const post = (url, body, method = 'POST') => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ ok: r.ok, j: await r.json() }));
  $('#appForm')?.addEventListener('submit', async (e) => {
    e.preventDefault(); const f = $('#appKey').files[0]; if (!f) return;
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Checking';
    const { ok, j } = await post('/api/bot/app', { appId: $('#appId').value, privateKey: await f.text() });
    btn.disabled = false; btn.textContent = 'Save';
    if (!ok) $('#appErr').textContent = j.error; else { botView(); loadStatus(); }
  });
  $('#createApp')?.addEventListener('click', async () => {
    const { action, manifest } = await getJSON('/api/bot/manifest-form');
    const f = document.createElement('form'); f.method = 'post'; f.action = action;
    const i = document.createElement('input'); i.type = 'hidden'; i.name = 'manifest'; i.value = manifest; f.appendChild(i);
    document.body.appendChild(f); f.submit();
  });
  $('#appKey')?.addEventListener('change', (e) => { e.target.nextElementSibling.textContent = e.target.files[0]?.name || 'Choose .pem key'; });
  $('#removeApp')?.addEventListener('click', async () => { await post('/api/bot/app', null, 'DELETE'); botView(); loadStatus(); });
  $('#tokForm')?.addEventListener('submit', async (e) => { e.preventDefault(); const { ok, j } = await post('/api/bot/token', { token: $('#tok').value }); $('#tok').value = ''; if (!ok) $('#tokErr').textContent = j.error; else { botView(); loadStatus(); } });
  $('#disconnect')?.addEventListener('click', async () => { await post('/api/bot/token', null, 'DELETE'); botView(); loadStatus(); });
  $('#repoForm')?.addEventListener('submit', async (e) => { e.preventDefault(); const { ok, j } = await post('/api/bot/repos', { repo: $('#repoIn').value }); if (!ok) $('#tokErr').textContent = j.error; else { botView(); loadStatus(); } });
  $('#openPrs')?.addEventListener('change', (e) => post('/api/bot/settings', { openPrs: e.target.checked }));
  $('#tryFix')?.addEventListener('change', async (e) => { await post('/api/bot/settings', { tryFix: e.target.checked }); botView(); });
  document.querySelectorAll('[data-unwatch]').forEach((btn) => btn.addEventListener('click', async () => { const [o, r] = btn.dataset.unwatch.split('/'); await post(`/api/bot/repos/${o}/${r}`, null, 'DELETE'); botView(); loadStatus(); }));
}
document.addEventListener('click', (e) => { if (e.target.closest('#botLink') && !running) botView(); });

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

intro(); loadStatus(); loadLists(); followBot();
if (location.hash.startsWith('#bot')) { botView().then(() => { if (location.hash === '#bot-error') $('#appErr').textContent = 'GitHub did not finish creating the app. Try again.'; history.replaceState(null, '', '/'); }); } setInterval(loadStatus, 10000);
