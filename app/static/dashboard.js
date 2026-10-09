'use strict';
/* TKE Governance dashboard — GitHub-style: overview -> detail -> tabs, AI side panel. */
let busy = false, compTimer = null, analysisTimer = null, detailTimer = null;
let panelReview = null;

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge = v => `<span class="badge st-${/^[A-Za-z_]+$/.test(v) ? v : 'x'}">${esc(v)}</span>`;
const fmtDate = ts => new Date(ts * 1000).toLocaleString();
const shortId = id => esc((id || '').slice(0, 12));

/* ---------- markdown renderer (no external deps; CSP is script-src 'self') ---------- */
function mdInline(s){
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}
function md(src){
  const lines = String(src || '').split('\n');
  let html = '', inList = null, inCode = false, para = [];
  const flushPara = () => { if(para.length){ html += `<p>${mdInline(para.join(' '))}</p>`; para = []; } };
  const closeList = () => { if(inList){ html += inList === 'ul' ? '</ul>' : '</ol>'; inList = null; } };
  for(const raw of lines){
    const line = raw.replace(/\s+$/, '');
    if(line.startsWith('```')){ flushPara(); closeList(); html += inCode ? '</code></pre>' : '<pre><code>'; inCode = !inCode; continue; }
    if(inCode){ html += esc(raw) + '\n'; continue; }
    let m;
    if(m = line.match(/^(#{1,3})\s+(.*)/)){ flushPara(); closeList(); const lvl = Math.min(m[1].length + 1, 3); html += `<h${lvl}>${mdInline(m[2])}</h${lvl}>`; continue; }
    if(/^---+$/.test(line)){ flushPara(); closeList(); html += '<hr>'; continue; }
    if(m = line.match(/^>\s?(.*)/)){ flushPara(); closeList(); html += `<blockquote>${mdInline(m[1])}</blockquote>`; continue; }
    if(m = line.match(/^(\s*)[-*]\s+(.*)/)){ flushPara(); if(inList !== 'ul'){ closeList(); html += '<ul>'; inList = 'ul'; } html += `<li>${mdInline(m[2])}</li>`; continue; }
    if(m = line.match(/^\s*\d+[.)]\s+(.*)/)){ flushPara(); if(inList !== 'ol'){ closeList(); html += '<ol>'; inList = 'ol'; } html += `<li>${mdInline(m[1])}</li>`; continue; }
    if(!line.trim()){ flushPara(); closeList(); continue; }
    para.push(line.trim());
  }
  flushPara(); closeList();
  if(inCode) html += '</code></pre>';
  return html || '<p class="muted">Empty response.</p>';
}

/* ---------- api ---------- */
async function api(path, opts = {}){
  const r = await fetch(path, opts);
  if(!r.ok) throw new Error(`Request failed (${r.status})`);
  return r.json();
}
function showError(msg){ const m = $('message'); m.hidden = !msg; m.textContent = msg || ''; }

/* ---------- router ---------- */
const TABS = ['overview', 'findings', 'scanners', 'coverage', 'evidence'];
const TAB_LABELS = {overview: 'Overview', findings: 'Findings', scanners: 'Scanners', coverage: 'Coverage', evidence: 'Evidence'};

function nav(hash){ if(location.hash === hash) route(); else location.hash = hash; }
function route(){
  const h = location.hash || '#reviews';
  let m;
  if(m = h.match(/^#review-([0-9a-f]{8,64})(?:\/([a-z]+))?/)){
    const tab = TABS.includes(m[2]) ? m[2] : 'overview';
    openDetail(m[1], tab, true);
  } else if(h === '#components'){
    showComponents(true);
  } else {
    showReviews(true);
  }
}
window.addEventListener('hashchange', route);

function setNav(view){
  $('nav-reviews').classList.toggle('active', view === 'reviews' || view === 'detail');
  $('nav-components').classList.toggle('active', view === 'components');
}
function showOnly(id){
  ['view-reviews', 'view-detail', 'view-components'].forEach(v => { $(v).hidden = v !== id; });
}

/* ---------- reviews overview ---------- */
async function showReviews(fromRoute){
  clearTimers();
  setNav('reviews'); showOnly('view-reviews');
  closePanel();
  if(!fromRoute && location.hash !== '#reviews') history.replaceState(null, '', '#reviews');
  await refreshList();
}
async function refreshList(){
  if(busy) return; busy = true;
  try{
    const data = await api('/api/v1/reviews');
    showError('');
    const rs = data.reviews || [];
    const n = s => rs.filter(x => x.status === s).length;
    $('metrics').innerHTML = [
      ['Total', rs.length, ''], ['Passed', n('PASS'), 's-pass'],
      ['Blocked', n('BLOCK'), 's-block'], ['Errors', n('ERROR'), 's-error'],
    ].map(([l, c, cls]) => `<div class="stat ${cls}"><span>${l}</span><strong>${c}</strong></div>`).join('');
    $('reviews').innerHTML = rs.map(r => `<tr class="clickable" data-review="${esc(r.review_id)}">
      <td>${badge(r.status)}</td>
      <td>${esc(r.request.repository)}</td>
      <td><span class="mono">${shortId(r.review_id)}</span><span class="sub">Run ${esc(r.request.ado_run_id)}</span></td>
      <td>${r.result?.duration_seconds != null ? esc(r.result.duration_seconds) + 's' : '—'}</td>
      <td>${badge(r.dojo?.status || 'pending')}</td>
      <td class="muted">${esc(fmtDate(r.created_at))}</td></tr>`).join('');
    $('empty').hidden = !!rs.length;
    $('updated').textContent = rs.length ? `Updated ${new Date().toLocaleTimeString()}` : '';
  }catch(e){ showError(e.message); }
  finally{ busy = false; }
}

/* ---------- review detail ---------- */
let detailId = null, detailTab = 'overview', detailData = null;

async function openDetail(id, tab, fromRoute){
  clearTimers();
  setNav('detail'); showOnly('view-detail');
  detailId = id; detailTab = TABS.includes(tab) ? tab : 'overview';
  if(!fromRoute) history.replaceState(null, '', '#review-' + id + (detailTab === 'overview' ? '' : '/' + detailTab));
  await renderDetail(false);
  if(panelReview && panelReview !== id) openPanel(id); // panel follows navigation
}
function clearTimers(){
  if(compTimer){ clearInterval(compTimer); compTimer = null; }
  if(detailTimer){ clearTimeout(detailTimer); detailTimer = null; }
  if(analysisTimer){ clearTimeout(analysisTimer); analysisTimer = null; }
}
function timeline(status){
  const steps = [['queued','Queued'], ['running','Running'], [status, status]];
  const terminal = ['PASS','BLOCK','ERROR'].includes(status);
  const color = status === 'PASS' ? '#1a7f37' : status === 'BLOCK' ? '#9a6700' : status === 'ERROR' ? '#d1242f' : '#0969da';
  return `<div class="timeline" style="--tc:${color}">` + steps.map(([key, label], i) => {
    const done = terminal ? true : (status === 'running' ? i <= 1 : i === 0);
    return `<div class="tstep${done ? ' done' : ''}"><div class="tnode">` +
      `<span class="tdot">${done ? '✓' : i + 1}</span><small>${esc(label)}</small></div>` +
      (i < 2 ? '<span class="tlink"></span>' : '') + `</div>`;
  }).join('') + '</div>';
}
function findingsCountLabel(findings){
  return findings.length ? `Findings <span class="count">${findings.length}</span>` : 'Findings';
}
async function renderDetail(keepPosition){
  const el = $('detail-panel');
  try{
    const r = await api(`/api/v1/reviews/${encodeURIComponent(detailId)}`);
    detailData = r;
    const d = r.result || {};
    $('crumb-id').textContent = detailId.slice(0, 12);
    $('detail-title').innerHTML = `${badge(r.status)}<span>${esc(r.request.repository)}</span>`;
    $('detail-rid').textContent = r.review_id;
    const inv = d.inventory || [], covered = inv.filter(x => x.status === 'covered').length;
    const findings = d.findings || [];

    $('detail-tabs').innerHTML = TABS.map(t =>
      `<button class="tab${t === detailTab ? ' on' : ''}" role="tab" data-tab="${t}">` +
      (t === 'findings' ? findingsCountLabel(findings) : TAB_LABELS[t]) + `</button>`).join('');

    const panels = {
      overview: `
        ${timeline(r.status)}
        <div class="reason">${esc((d.reasons || ['Review is waiting for a terminal decision.']).join(' · '))}</div>
        <div class="kv-grid">
          <div class="kv"><span>Commit</span><code>${esc(r.request.commit_sha)}</code></div>
          <div class="kv"><span>Policy</span>${esc(r.request.policy_version)} <span class="muted mono">${esc((r.request.policy_digest || '').slice(0, 16))}</span></div>
          <div class="kv"><span>Pipeline</span><a href="${esc(r.request.ado_run_url)}" target="_blank" rel="noopener noreferrer">Azure DevOps run ${esc(r.request.ado_run_id)}</a></div>
          <div class="kv"><span>DefectDojo</span>${badge(r.dojo?.status || 'pending')}${r.dojo?.url ? ` <a href="${esc(r.dojo.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}</div>
        </div>`,
      findings: `
        <div class="fbar" id="fbar">
          ${['ALL','CRITICAL','HIGH','MEDIUM','LOW'].map(s => `<button class="fbtn${s === 'ALL' ? ' on' : ''}" data-sev="${s}">${s === 'ALL' ? 'All' : s[0] + s.slice(1).toLowerCase()}</button>`).join('')}
          <span class="fcount" id="fcount"></span>
        </div>
        <div class="card" style="margin-top:0"><div class="table-wrap" id="findings-body">
        ${findings.length ? `<table class="tbl"><thead><tr><th>Severity</th><th>Finding</th><th>Location</th></tr></thead><tbody>` +
          findings.map(f => `<tr data-sevrow="${esc(f.severity)}"><td>${badge(f.severity)}</td>
            <td><strong>${esc(f.rule)}</strong> <span class="muted">${esc(f.tool || '')}</span><span class="sub">${esc(f.title)}</span>
            <span class="sub">${esc(f.remediation || '')}</span></td>
            <td class="mono">${esc(f.file)}:${esc(f.line)}</td></tr>`).join('') + `</tbody></table>`
          : '<p class="muted" style="padding:16px">No findings recorded.</p>'}</div></div>`,
      scanners: `
        <div class="card" style="margin-top:0"><div class="table-wrap"><table class="tbl">
        <thead><tr><th>Tool</th><th>Status</th><th>Duration</th><th>Outcome</th></tr></thead><tbody>
        ${Object.entries(d.scanners || {}).map(([name, s]) => `<tr>
          <td><strong>${esc(name)}</strong><span class="sub mono">${esc(s.image || '')}</span></td>
          <td>${badge(s.status)}</td>
          <td>${s.duration_seconds != null ? esc(s.duration_seconds) + 's' : '—'}</td>
          <td class="muted">${esc(s.error || `Exit ${JSON.stringify(s.exit_code)}${s.quality_gate ? ' · Quality Gate ' + s.quality_gate : ''}`)}</td>
        </tr>`).join('')}</tbody></table></div></div>`,
      coverage: `
        <p class="muted">Coverage · ${covered}/${inv.length} inputs</p>
        <div class="card" style="margin-top:12px"><div class="table-wrap"><table class="tbl">
        <thead><tr><th>Input</th><th>Required scans</th><th>Status</th></tr></thead><tbody>
        ${inv.map(x => `<tr><td class="mono">${esc(x.path)}</td><td class="muted">${esc((x.required_tools || []).join(', '))}</td><td>${badge(x.status)}</td></tr>`).join('')}
        </tbody></table></div></div>`,
      evidence: `
        <div class="chips">${Object.keys(d.artifacts || {}).map(n => `<button class="chip" data-artifact="${esc(n)}">↓ ${esc(n)}</button>`).join('')}
        <button class="chip" id="audit-btn">View audit trail</button></div>
        <pre id="audit-data" hidden></pre>`,
    };
    el.innerHTML = `<div class="tabpanel">${panels[detailTab]}</div>`;
    if(!keepPosition) window.scrollTo({top: 0, behavior: 'smooth'});
    if(detailTab === 'findings') filterFindings('ALL');
    showError('');
    // keep polling while the review is not terminal
    if(['queued', 'running'].includes(r.status)){
      detailTimer = setTimeout(() => { if(detailId) renderDetail(true); }, 10000);
    }
  }catch(e){ showError(e.message); }
}
function switchTab(tab){
  if(!TABS.includes(tab) || tab === detailTab) return;
  detailTab = tab;
  history.replaceState(null, '', '#review-' + detailId + (tab === 'overview' ? '' : '/' + tab));
  renderDetail(true);
}
function filterFindings(sev){
  document.querySelectorAll('#fbar .fbtn').forEach(b => b.classList.toggle('on', b.dataset.sev === sev));
  let vis = 0, total = 0;
  document.querySelectorAll('#findings-body [data-sevrow]').forEach(tr => {
    total++;
    const show = sev === 'ALL' || tr.dataset.sevrow === sev;
    tr.style.display = show ? '' : 'none';
    if(show) vis++;
  });
  const c = $('fcount');
  if(c) c.textContent = total ? `${vis} / ${total}` : '';
}

/* ---------- AI side panel ---------- */
function openPanel(id){
  panelReview = id;
  if(analysisTimer){ clearTimeout(analysisTimer); analysisTimer = null; }
  const p = $('ai-panel');
  p.classList.add('open'); p.setAttribute('aria-hidden', 'false');
  if(window.innerWidth <= 720) $('ai-scrim').hidden = false;
  loadBrief(id); loadChat(id);
}
function closePanel(){
  panelReview = null;
  if(analysisTimer){ clearTimeout(analysisTimer); analysisTimer = null; }
  $('ai-panel').classList.remove('open');
  $('ai-panel').setAttribute('aria-hidden', 'true');
  $('ai-scrim').hidden = true;
}
async function loadBrief(id, attempt = 0){
  const box = $('ai-brief');
  if(!box || panelReview !== id) return;
  try{
    const a = await api(`/api/v1/reviews/${encodeURIComponent(id)}/analysis`);
    if(panelReview !== id) return;
    box.innerHTML = `
      <p class="ai-meta">${esc(a.model)} · ${esc(fmtDate(a.generated_at))} · ${esc(a.duration_seconds)}s</p>
      <div class="md-body">${md(a.brief)}</div>
      <p class="ai-disclaimer">${esc(a.disclaimer)}</p>`;
  }catch(e){
    if(attempt < 8 && panelReview === id){
      box.innerHTML = `<div class="spinner">Generating brief…</div>`;
      analysisTimer = setTimeout(() => loadBrief(id, attempt + 1), 4000);
    }else if(panelReview === id){
      box.innerHTML = `<p class="muted">Brief unavailable for this review.</p>`;
    }
  }
}
function renderChat(messages){
  const log = $('chat-log');
  if(!messages.length){
    log.innerHTML = `<div class="chat-empty">Ask about this review's findings — e.g. “Which finding should I fix first?”</div>`;
    return;
  }
  log.innerHTML = messages.map(m => m.role === 'user'
    ? `<div class="msg user">${esc(m.content)}<time>${m.at ? esc(fmtDate(m.at)) : ''}</time></div>`
    : `<div class="msg bot"><div class="md-body">${md(m.content)}</div><time>${m.at ? esc(fmtDate(m.at)) : ''}${m.model ? ' · ' + esc(m.model) : ''}</time></div>`
  ).join('');
  log.scrollTop = log.scrollHeight;
}
async function loadChat(id){
  try{
    const d = await api(`/api/v1/reviews/${encodeURIComponent(id)}/chat`);
    if(panelReview === id) renderChat(d.messages || []);
  }catch(e){ /* leave placeholder */ }
}
async function sendChat(message){
  const log = $('chat-log'), input = $('chat-input'), btn = $('chat-send');
  const history = [];
  log.querySelectorAll('.msg').forEach(el => {
    const isUser = el.classList.contains('user');
    const text = el.querySelector('.md-body')?.textContent || el.childNodes[0]?.textContent || '';
    history.push({role: isUser ? 'user' : 'assistant', content: text.trim().slice(0, 2000)});
  });
  const empty = log.querySelector('.chat-empty'); if(empty) empty.remove();
  const um = document.createElement('div'); um.className = 'msg user'; um.textContent = message;
  const typing = document.createElement('div');
  typing.className = 'msg bot typing'; typing.textContent = 'Analyst is thinking…';
  log.append(um, typing); log.scrollTop = log.scrollHeight;
  input.value = ''; input.disabled = true; btn.disabled = true;
  try{
    const r = await fetch(`/api/v1/reviews/${encodeURIComponent(panelReview)}/chat`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message, history}),
    });
    if(!r.ok) throw new Error(`Chat failed (${r.status})`);
    await r.json();
    await loadChat(panelReview);
  }catch(e){
    typing.textContent = 'Chat unavailable: ' + e.message;
    typing.classList.remove('typing');
  }finally{
    input.disabled = false; btn.disabled = false; input.focus();
  }
}

/* ---------- components ---------- */
const COMP_META = {
  api:        {label: 'Gate API',   desc: 'Review API serving this dashboard'},
  worker:     {label: 'Worker',     desc: 'Background scanner orchestrator'},
  sonarqube:  {label: 'SonarQube',  desc: 'SAST · quality gate'},
  checkov:    {label: 'Checkov',    desc: 'IaC misconfiguration scan'},
  trivy:      {label: 'Trivy',      desc: 'Vulnerability scan'},
  gitleaks:   {label: 'Gitleaks',   desc: 'Secret scan'},
  defectdojo: {label: 'DefectDojo', desc: 'Findings evidence store'},
};
async function showComponents(fromRoute){
  clearTimers(); closePanel();
  setNav('components'); showOnly('view-components');
  if(!fromRoute && location.hash !== '#components') history.replaceState(null, '', '#components');
  await refreshComponents();
  compTimer = setInterval(() => { if(!$('view-components').hidden) refreshComponents(); }, 30000);
}
async function refreshComponents(){
  const grid = $('comp-grid'), banner = $('comp-banner');
  try{
    const data = await api('/api/v1/components');
    showError('');
    const comps = data.components || [];
    const bad = comps.filter(c => c.status !== 'up');
    if(bad.length){
      banner.hidden = false;
      banner.textContent = '⚠ ' + bad.map(c => (COMP_META[c.name] || {}).label || c.name).join(', ') + ' not healthy — coverage may be affected.';
    } else banner.hidden = true;
    grid.innerHTML = comps.map(c => {
      const meta = COMP_META[c.name] || {label: c.name, desc: ''};
      return `<div class="comp-card">
        <div class="comp-head"><span class="dot dot-${c.status}"></span>
          <div><strong>${esc(meta.label)}</strong><span class="desc">${esc(meta.desc)}</span></div>
          ${badge(c.status)}</div>
        <dl class="comp-meta">
          <div><dt>Version</dt><dd class="mono">${c.version ? esc(c.version) : '—'}</dd></div>
          <div><dt>Latency</dt><dd>${c.latency_ms != null ? esc(c.latency_ms) + ' ms' : '—'}</dd></div>
          <div><dt>Checked</dt><dd>${esc(fmtDate(c.checked_at))}</dd></div>
        </dl>
        ${c.error ? `<p class="comp-error">${esc(c.error)}</p>` : ''}</div>`;
    }).join('');
    $('comp-empty').hidden = true;
    $('comp-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }catch(e){
    $('comp-empty').hidden = false;
    banner.hidden = false;
    banner.textContent = '⚠ Could not reach the health endpoint: ' + e.message;
  }
}

/* ---------- events ---------- */
$('refresh').addEventListener('click', refreshList);
$('nav-reviews').addEventListener('click', () => nav('#reviews'));
$('nav-components').addEventListener('click', () => nav('#components'));
$('comp-refresh').addEventListener('click', refreshComponents);
$('ask-ai').addEventListener('click', () => { if(detailId) openPanel(detailId); });
$('ai-close').addEventListener('click', closePanel);
$('ai-scrim').addEventListener('click', closePanel);
document.addEventListener('keydown', e => { if(e.key === 'Escape' && panelReview) closePanel(); });

document.addEventListener('click', async e => {
  const tab = e.target.closest?.('.tab');
  if(tab && detailId){ switchTab(tab.dataset.tab); return; }
  const fbtn = e.target.closest?.('.fbtn');
  if(fbtn && detailId){ filterFindings(fbtn.dataset.sev); return; }
  if(e.target?.id === 'copy-link' && detailId){
    const url = location.origin + location.pathname + '#review-' + detailId;
    try{ await navigator.clipboard.writeText(url); e.target.textContent = 'Copied!'; }
    catch{ prompt('Copy review link:', url); return; }
    setTimeout(() => e.target.textContent = 'Copy link', 1500); return;
  }
  if(e.target?.id === 'copy-curl' && detailId){
    const cmd = `curl -sk "${location.origin}/api/v1/reviews/${detailId}" | python3 -m json.tool`;
    try{ await navigator.clipboard.writeText(cmd); e.target.textContent = 'Copied!'; }
    catch{ prompt('Copy curl:', cmd); return; }
    setTimeout(() => e.target.textContent = 'Copy curl', 1500); return;
  }
  try{
    const row = e.target.closest?.('[data-review]');
    if(row){ nav('#review-' + row.dataset.review); return; }
    const chip = e.target.closest?.('[data-artifact]');
    if(chip && detailId){
      const data = await api(`/api/v1/reviews/${detailId}/artifacts/${encodeURIComponent(chip.dataset.artifact)}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
      const a = document.createElement('a'); a.href = url; a.download = chip.dataset.artifact; a.click();
      URL.revokeObjectURL(url); return;
    }
    if(e.target?.id === 'audit-btn' && detailId){
      const d = await api(`/api/v1/reviews/${detailId}/audit`);
      const pre = $('audit-data'); pre.hidden = false; pre.textContent = JSON.stringify(d, null, 2);
      pre.scrollIntoView({behavior: 'smooth', block: 'nearest'}); return;
    }
  }catch(err){ showError(err.message); }
});
document.addEventListener('submit', e => {
  if(e.target?.id === 'chat-form'){
    e.preventDefault();
    const v = $('chat-input').value.trim();
    if(v && panelReview) sendChat(v);
  }
});

/* ---------- init ---------- */
route();
setInterval(() => { if(!$('view-reviews').hidden) refreshList(); }, 15000);
