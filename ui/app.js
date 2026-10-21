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
const diffBlock = (d) => `<pre class="diff"><code>${String(d).split('\n').map((l) => {
  if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@')) return `<span class="hd">${esc(l)}</span>`;
  if (l.startsWith('+')) return `<span class="add">${esc(l)}</span>`;
  if (l.startsWith('-')) return `<span class="del">${esc(l)}</span>`;
  return `<span>${esc(l)}</span>`;
}).join('')}</code></pre>`;
const assertion = (out = '') => ({ actual: out.match(/actual:\s*([^\n,]+)/)?.[1]?.trim(), expected: out.match(/expected:\s*([^\n,]+)/)?.[1]?.trim() });

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
      <i class="pip ink"></i><span><span class="t">${esc(r.description)}</span><span class="m">${r.sample ? 'Scripted sample' : clock(r.savedAt)}, ${r.events} events${r.screenshot ? ', screenshot' : ''}</span></span></button></li>`).join('')
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

/* ---------- views ---------- */
function intro() {
  $('#main').innerHTML = `<section class="intro">
    <h1><span class="no">No proof,</span><span class="yes">no fix.</span></h1>
    <p>RedGreen turns a user's bug report into a test that fails on your code, asks Gemma 4 on this laptop for a patch, and calls it fixed only when that same test passes and nothing else breaks.</p>
    <ol class="how">
      <li><b>Capture</b><span>The app records what the user did, what broke, and what the server said. Private values are removed first.</span></li>
      <li><b>Reproduce</b><span>Gemma writes a test from that evidence. It counts only if it fails on the current code.</span></li>
      <li><b>Prove</b><span>Gemma patches the code. The same test plus your existing tests must pass, in a sealed sandbox.</span></li>
    </ol></section>`;
}

function shell(report, savedRun) {
  state = { report, savedRun, stages: {}, live: null, steps: [] };
  const when = report.sample ? 'Scripted sample' : `Reported at ${clock(report.savedAt)}`;
  $('#main').innerHTML = `
  <div class="rhead">
    <div><p class="quote">${esc(report.description)}</p>
      <p class="rmeta">${when} with ${report.events.length} captured events${report.screenshot ? ' and a screenshot' : ''}. ${report.redactions} private ${report.redactions === 1 ? 'value' : 'values'} removed before saving.${savedRun ? ` Showing a saved run from ${clock(savedRun.startedAt)}.` : ''}</p></div>
    ${savedRun ? `<button class="go" id="go" data-again="1">Run again</button>` : `<button class="go" id="go"><span class="lamps" aria-hidden="true"><i class="l r"></i><i class="l g"></i></span>Reproduce and fix</button>`}
  </div>
  <div id="notice"></div>
  <section class="proof" id="proof" aria-live="polite">
    <div class="side-p" id="pRed"><div class="lamp"></div><div class="cap">On the code as it is</div><div class="verdictword">Waiting</div><div class="fact">Gemma's test must fail here.</div></div>
    <div class="wire" aria-hidden="true"><svg viewBox="0 0 64 24"><path d="M2 12 H54 M46 4 L56 12 L46 20"/></svg></div>
    <div class="side-p" id="pGreen"><div class="lamp"></div><div class="cap">After Gemma's patch</div><div class="verdictword">Waiting</div><div class="fact">The same test must pass here.</div></div>
  </section>
  <ol class="track" id="track">
    ${['Evidence', 'Existing tests', 'Reproduce', 'Patch', 'Verify'].map((l, i) => `<li data-k="${i}"><span class="n">${i + 1}</span><span class="lbl">${l}</span><span class="tm">&nbsp;</span></li>`).join('')}
  </ol>
  <div class="cols">
    <div>
      <section class="sect"><h3>What the user did <small>captured, private values removed</small></h3><ol class="tl" id="tl">${timeline(report)}</ol>
        ${report.screenshot ? `<div class="body shot"><p>Screenshot the user attached. Gemma 4 reads it.</p><img src="${report.screenshot}" alt="Screenshot attached to the bug report"></div>` : ''}</section>
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
function attempt(html) { const att = $('#att'); if (att.dataset.started !== '1') { att.innerHTML = ''; att.dataset.started = '1'; } $('#liveAtt')?.remove(); att.insertAdjacentHTML('beforeend', html); }
const chip = (r) => `<span class="chip ${r.passed ? 'pass' : 'fail'}"><b>${r.passed ? 'PASS' : 'FAIL'}</b>${esc(r.file.replace('test/', ''))}, ${r.pass} passed, ${r.fail} failed</span>`;
const outBlock = (r, label = 'Test output') => `<details><summary>${label}</summary><pre>${esc(r.output.trim())}</pre></details>`;

function render(s, live) {
  switch (s.type) {
    case 'evidence': stage(0, 'done', 'ready'); break;
    case 'baseline':
      stage(1, s.result.passed ? 'done' : 'red', secs(s.result.durationMs));
      attempt(`<li><i class="mk ${s.result.passed ? 'info' : 'fail'}"></i><div><h4>${s.result.passed ? `Your ${s.result.pass} existing tests pass` : 'Your existing tests already fail'}</h4>
        <p class="sub">${s.result.passed ? 'So they do not catch this bug.' : 'Fix those first; results below may be unreliable.'}</p><div class="res">${chip(s.result)}</div>${outBlock(s.result)}</div></li>`);
      break;
    case 'model.start': {
      const k = s.phase === 'reproduce' ? 2 : 3;
      stage(k, 'now');
      if (s.phase === 'reproduce') setPanel('#pRed', 'busy', 'Writing', `Gemma is writing a test from the evidence. <span id="tick">0 s</span>`);
      else setPanel('#pGreen', 'busy', 'Patching', `Gemma is rewriting the code. <span id="tick">0 s</span>`);
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
      attempt(`<li><i class="mk warn"></i><div><h4>Test rejected</h4><p class="sub">Attempt ${s.attempt}, ${secs(s.durationMs || 0)}</p><p class="why">${esc(s.reason)}</p>${s.result ? `<div class="res">${chip(s.result)}</div>` : ''}<details><summary>Gemma's test</summary>${codeBlock(s.proposal?.test_code)}</details></div></li>`);
      break;
    case 'repro.confirmed': {
      clearInterval(tick); addTime(2, s.durationMs || 0); stage(2, 'red');
      const a = assertion(s.result.output);
      setPanel('#pRed', 'red', 'Fails', a.expected ? `Expected <b>${esc(money(a.expected))}</b>, got <b>${esc(money(a.actual))}</b>. Bug reproduced.` : 'Bug reproduced by a failing test.', live);
      attempt(`<li><i class="mk fail"></i><div><h4>Bug reproduced: the test fails on your code</h4><p class="sub">Attempt ${s.attempt}, ${secs(s.durationMs)}</p><div class="res">${chip(s.result)}</div>
        <details open><summary>test/repro.test.js, written by Gemma</summary>${codeBlock(s.proposal.test_code)}</details>${outBlock(s.result, 'Failure output')}</div></li>`);
      $('#hypSect').hidden = false;
      $('#hyp').innerHTML = `<p>${esc(s.proposal.hypothesis)}</p><dl class="ev"><dt>Expected</dt><dd class="exp">${esc(s.proposal.expected)}</dd><dt>Actual</dt><dd class="act">${esc(s.proposal.actual)}</dd><dt>Evidence</dt><dd>${(s.proposal.evidence_ids || []).map(esc).join(', ') || 'none cited'}</dd></dl>`;
      $('#tl').innerHTML = timeline(state.report, s.proposal.evidence_ids || []);
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
      setPanel('#pGreen', 'green', 'Passes', `Same test passes. All ${existing.pass} existing tests still pass.`, live);
      attempt(`<li><i class="mk ok"></i><div><h4>Patch verified</h4><p class="sub">Attempt ${s.attempt}, ${secs(s.durationMs)}</p><div class="res">${s.results.map(chip).join('')}</div>${outBlock(s.results[0], 'Passing output')}</div></li>`);
      state.verified = s;
      break; }
    case 'fatal':
      clearInterval(tick);
      $('#notice').innerHTML = `<div class="notice err">The run stopped: ${esc(s.error)}</div>`;
      break;
  }
}
const money = (v) => /^-?\d+(\.\d+)?$/.test(v) ? '$' + Number(v).toFixed(2) : v;

function finish(verdict, runId) {
  clearInterval(tick);
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
  const sect = $('#outSect'); sect.hidden = false;
  $('#outTitle').textContent = v ? 'Verified fix' : 'Report for the maintainer';
  const patch = v ? `${v.diff}\n` : '';
  $('#out').innerHTML = `
    ${v ? `<p class="change"><b>What changed:</b> ${esc(v.proposal.change || v.proposal.root_cause)}</p>${diffBlock(v.diff)}` : '<p>The bug is reproduced by a failing test, but no patch was verified. The report below includes the test so a person can take it from here.</p>'}
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
async function openReport(id) { const r = await getJSON('/api/reports/' + encodeURIComponent(id)); shell(r, null); }
async function openRun(id) {
  const run = await getJSON('/api/runs/' + encodeURIComponent(id));
  const report = await getJSON('/api/reports/' + encodeURIComponent(run.reportId));
  shell(report, { id: run.id, startedAt: run.startedAt });
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

intro(); loadStatus(); loadLists(); setInterval(loadStatus, 15000);
