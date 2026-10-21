const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const api = (p) => fetch(p).then((r) => r.json());
let current = null, running = false;

async function loadStatus() {
  const s = await api('/api/status');
  const mp = $('#modelPill');
  if (s.model.ok) { mp.textContent = `${s.model.model} · ${s.model.local ? 'local, offline' : 'remote'}`; mp.className = 'pill ' + (s.model.gemma4 ? 'ok' : ''); }
  else { mp.textContent = 'model offline: start LM Studio server'; mp.className = 'pill bad'; mp.title = s.model.error; }
  $('#sbxPill').textContent = `sandbox: node ${s.sandbox.node} · ${s.sandbox.permissionModel.startsWith('--') ? 'fs-isolated' : 'no fs isolation'} · ${s.sandbox.timeoutMs / 1000}s timeout`;
}

async function loadLists() {
  const [reports, runs] = await Promise.all([api('/api/reports'), api('/api/runs')]);
  $('#reports').innerHTML = reports.map((r) => `<li data-r="${r.id}" class="${current?.id === r.id ? 'active' : ''}"><div class="t">${esc(r.description)}</div><div class="m">${r.id} · ${r.events} events${r.screenshot ? ' · 🖼' : ''}${r.sample ? ' · <span style="color:var(--amber)">scripted sample</span>' : ''}</div></li>`).join('') || '<li class="m">none yet</li>';
  $('#runs').innerHTML = runs.map((r) => `<li data-run="${r.id}"><div class="t">${verdictLabel(r.verdict).text}</div><div class="m">${r.id} · ${new Date(r.startedAt).toLocaleTimeString()}</div></li>`).join('') || '<li class="m">none yet</li>';
}
document.addEventListener('click', (e) => {
  const r = e.target.closest('[data-r]'); if (r && !running) return openReport(r.dataset.r);
  const run = e.target.closest('[data-run]'); if (run && !running) return openRun(run.dataset.run);
});

function verdictLabel(v) {
  return ({ fixed_verified: { cls: 'green', big: 'GREEN', text: 'Fix verified: failing test now passes, existing tests still pass' },
    reproduced_not_fixed: { cls: 'amber', big: 'RED', text: 'Bug reproduced, but no proposed patch passed. Nothing claimed fixed.' },
    not_reproduced: { cls: 'amber', big: '—', text: 'Could not reproduce from the evidence. No fix proposed.' },
    running: { cls: 'run', big: '…', text: 'Running' } })[v] || { cls: 'run', big: '?', text: v };
}

function evidenceHtml(report, cited = []) {
  return report.events.map((e) => {
    const bad = e.type !== 'action';
    let detail = '';
    if (e.type === 'action') detail = `${esc(e.name)}(${esc(JSON.stringify(e.args).slice(1, -1)).slice(0, 70)})<div class="st">${e.stateAfter?.error ? 'error: ' + esc(e.stateAfter.error) : `subtotal ${e.stateAfter?.subtotal} · discount ${e.stateAfter?.discount} · total <b>${e.stateAfter?.total}</b>`}</div>`;
    else if (e.type === 'network.failed') detail = `${esc(e.method)} ${esc(new URL(e.url, location.href).pathname)} → <b>${e.status}</b><div class="st">${esc(e.responseBody || e.error || '').slice(0, 160)}</div>`;
    else detail = esc(e.message);
    return `<div class="ev ${bad ? 'bad' : ''} ${cited.includes(e.id) ? 'cited' : ''}"><span class="id">${e.id}</span><span class="ty">${esc(e.type.replace('console.', '').replace('network.', 'net.'))}</span><span>${detail}</span></div>`;
  }).join('');
}

function shell(report, { sample, savedRun } = {}) {
  current = report;
  $('#main').innerHTML = `
  <div class="head">
    <div><h2>${esc(report.description)}</h2>
      <div class="muted">${report.id} · ${report.events.length} events · ${report.redactions} values redacted before storage ${sample ? '<span class="tag sample">scripted sample</span>' : ''} ${savedRun ? `<span class="tag">saved run ${savedRun}</span>` : ''}</div></div>
    <div>${savedRun ? '' : '<button class="go" id="go">Reproduce & fix with Gemma 4</button>'}</div>
  </div>
  <div id="verdict"></div>
  <div class="rail" id="rail"><span data-k="evidence">1 evidence</span><span data-k="baseline">2 baseline</span><span data-k="red">3 repro → RED</span><span data-k="patch">4 patch</span><span data-k="green">5 verify → GREEN</span><span data-k="pr">6 PR</span></div>
  <div class="grid">
    <div><div class="card"><h3>Captured evidence <span class="tag">redacted</span></h3><div id="evidence">${evidenceHtml(report)}</div>${report.screenshot ? `<div class="shot"><div class="meta">screenshot (read by Gemma 4 vision)</div><img src="${report.screenshot}" alt="User screenshot"></div>` : ''}</div>
      <div class="card" id="hypCard" hidden><h3>Gemma's hypothesis</h3><div id="hyp"></div></div></div>
    <div><div class="card"><h3>Run log <span class="tag">every claim backed by a real test run</span></h3><div id="log"><p class="muted">Not run yet.</p></div></div>
      <div class="card" id="prCard" hidden><h3>PR description <span><button id="copy">Copy</button> <a id="dl" class="tag" download>.md</a></span></h3><pre id="pr"></pre></div></div>
  </div>`;
  $('#go')?.addEventListener('click', () => analyze(report.id));
  loadLists();
}

const rail = (k, cls = 'on') => { const el = $(`#rail [data-k="${k}"]`); if (el) el.className = cls; };
function resultBadge(r) { return `<span class="result ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'}</span><span class="meta">${esc(r.file)} · ${r.pass} passed / ${r.fail} failed · exit ${r.exitCode} · ${r.durationMs}ms</span>`; }
const out = (r, open) => `<details ${open ? 'open' : ''}><summary>test output</summary><pre>${esc(r.output.trim())}</pre></details>`;
const codeBlock = (c) => `<pre>${esc(c)}</pre>`;
const diffBlock = (d) => `<pre>${d.split('\n').map((l) => `<span class="${l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''}">${esc(l) || ' '}</span>`).join('\n')}</pre>`;

function renderStep(s) {
  const log = $('#log'); if (log.querySelector('.muted')) log.innerHTML = '';
  $('.step.live', log)?.remove();
  const meta = s.model ? `<div class="meta">${esc(s.model)} · ${(s.durationMs / 1000).toFixed(1)}s · attempt ${s.attempt}</div>` : '';
  let h = '';
  switch (s.type) {
    case 'evidence': rail('evidence', 'green'); h = `<div class="step ok"><div class="ttl">Evidence loaded</div><div class="meta">${s.events} events${s.screenshot ? ' + screenshot' : ''} · ${s.redactions} redactions applied before storage</div></div>`; break;
    case 'baseline': rail('baseline', 'on'); h = `<div class="step ${s.result.passed ? 'warn' : 'fail'}"><div class="ttl">Existing test suite on current code</div>${resultBadge(s.result)}<div class="why">${esc(s.note)}</div>${out(s.result)}</div>`; break;
    case 'model.start': h = `<div class="step live"><div class="ttl">Gemma 4 is ${s.phase === 'reproduce' ? 'writing a reproduction test' : 'proposing a minimal patch'}…</div><div class="meta">attempt ${s.attempt} · running locally</div></div>`; break;
    case 'model.error': h = `<div class="step fail"><div class="ttl">Model error</div><div class="why">${esc(s.error)}</div></div>`; break;
    case 'repro.rejected': h = `<div class="step warn"><div class="ttl">Reproduction attempt rejected</div>${meta}<div class="why">${esc(s.reason)}</div>${s.result ? resultBadge(s.result) : ''}<details><summary>proposed test</summary>${codeBlock(s.proposal.test_code)}</details></div>`; break;
    case 'repro.confirmed':
      rail('red', 'red');
      h = `<div class="step fail"><div class="ttl">Bug reproduced: the test FAILS on current code</div>${meta}${resultBadge(s.result)}<details open><summary>test/repro.test.js (written by Gemma)</summary>${codeBlock(s.proposal.test_code)}</details>${out(s.result)}</div>`;
      $('#hypCard').hidden = false;
      $('#hyp').innerHTML = `<p class="hyp">${esc(s.proposal.hypothesis)}</p><div class="ee"><b>expected</b><span class="green">${esc(s.proposal.expected)}</span><b>actual</b><span class="red">${esc(s.proposal.actual)}</span><b>cites</b><span>${s.proposal.evidence_ids.map(esc).join(', ')}</span></div>`;
      $('#evidence').innerHTML = evidenceHtml(current, s.proposal.evidence_ids);
      break;
    case 'fix.rejected': h = `<div class="step warn"><div class="ttl">Patch rejected</div>${meta}<div class="why">${esc(s.reason)}</div>${s.diff ? `<details><summary>proposed diff</summary>${diffBlock(s.diff)}</details>` : ''}${(s.results || []).map((r) => resultBadge(r) + '<br>').join('')}</div>`; break;
    case 'fix.verified':
      rail('patch', 'green'); rail('green', 'green');
      h = `<div class="step ok"><div class="ttl">Patch verified: same test now PASSES, nothing else broke</div>${meta}<div class="why">${esc(s.proposal.root_cause)}</div>${diffBlock(s.diff)}${s.results.map((r) => `<div>${resultBadge(r)}</div>`).join('')}${out(s.results[0])}</div>`; break;
    case 'fatal': h = `<div class="step fail"><div class="ttl">Run failed</div><div class="why">${esc(s.error)}</div></div>`; break;
  }
  log.insertAdjacentHTML('beforeend', h);
}

function renderVerdict(v) {
  const l = verdictLabel(v);
  $('#verdict').innerHTML = `<div class="verdict ${l.cls}"><span class="big">${l.big}</span><span>${esc(l.text)}</span></div>`;
}

async function showPr(runId) {
  const md = await fetch(`/api/runs/${runId}/pr.md`).then((r) => r.text());
  $('#prCard').hidden = false; $('#pr').textContent = md; rail('pr', 'green');
  $('#dl').href = `/api/runs/${runId}/pr.md`; $('#dl').setAttribute('download', `redgreen-${runId}.md`);
  $('#copy').onclick = () => navigator.clipboard.writeText(md).then(() => ($('#copy').textContent = 'Copied'));
}

async function openReport(id) { const r = await api('/api/reports/' + id); shell(r, { sample: r.sample }); }

async function openRun(id) {
  const run = await api('/api/runs/' + id);
  const report = await api('/api/reports/' + run.reportId);
  shell(report, { sample: report.sample, savedRun: new Date(run.startedAt).toLocaleString() });
  run.steps.filter((s) => s.type !== 'model.start').forEach(renderStep);
  renderVerdict(run.verdict);
  if (run.prMarkdown) showPr(run.id);
}

function analyze(id) {
  running = true; $('#go').disabled = true; $('#go').textContent = 'Running…';
  renderVerdict('running');
  const es = new EventSource('/api/analyze/' + id);
  es.onmessage = (m) => {
    const s = JSON.parse(m.data);
    if (s.type === 'done') { es.close(); running = false; renderVerdict(s.verdict); $('#go').disabled = false; $('#go').textContent = 'Run again'; loadLists(); if (s.verdict !== 'not_reproduced') showPr(s.runId); return; }
    renderStep(s);
  };
  es.onerror = () => { es.close(); running = false; $('#go').disabled = false; $('#go').textContent = 'Retry'; };
}

loadStatus(); loadLists(); setInterval(loadStatus, 15000);
