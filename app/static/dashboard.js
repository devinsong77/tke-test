'use strict';
/* TKE Governance dashboard — GitHub-style: overview -> detail -> tabs, persistent AI panel. */
let busy = false, compTimer = null, detailTimer = null;
let panelReview = null, chatMessages = [];

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

/* ---------- tiny JSON syntax highlighter (no deps) ---------- */
function hlJson(src){
  let s = esc(src);
  s = s.replace(/(&quot;([^&]|&(?!quot;))*?&quot;)(\s*:)?/g, (m, q, _inner, colon) =>
    colon ? `<span class="tok-b">${q}</span>:` : `<span class="tok-s">${q}</span>`);
  s = s.replace(/\b(-?\d+\.?\d*(e[+-]?\d+)?)\b/g, '<span class="tok-n">$1</span>');
  s = s.replace(/\b(true|false|null)\b/g, '<span class="tok-k">$1</span>');
  return s;
}
function withLineNumbers(html){
  const lines = html.split('\n');
  if(lines.length && lines[lines.length - 1] === '') lines.pop();
  const rows = lines.map((l, i) =>
    `<tr><td class="ln">${i + 1}</td><td class="lc">${l || ' '}</td></tr>`).join('');
  return `<table class="code-table">${rows}</table>`;
}

/* ---------- api ---------- */
async function api(path, opts = {}){
  const r = await fetch(path, opts);
  if(!r.ok) throw new Error(`Request failed (${r.status})`);
  return r.json();
}
function showError(msg){ const m = $('message'); m.hidden = !msg; m.textContent = msg || ''; }

/* ---------- router ---------- */
const TABS = ['overview', 'findings', 'coverage', 'evidence'];
const TAB_LABELS = {overview: 'Overview', findings: 'Findings', coverage: 'Coverage', evidence: 'Evidence'};

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
  document.body.classList.toggle('has-detail', id === 'view-detail');
}

/* ---------- reviews overview ---------- */
async function showReviews(fromRoute){
  clearTimers();
  setNav('reviews'); showOnly('view-reviews');
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
let detailId = null, detailTab = 'overview', detailData = null, compHealth = null;

async function openDetail(id, tab, fromRoute){
  clearTimers();
  setNav('detail'); showOnly('view-detail');
  detailId = id; detailTab = TABS.includes(tab) ? tab : 'overview';
  if(!fromRoute) history.replaceState(null, '', '#review-' + id + (detailTab === 'overview' ? '' : '/' + detailTab));
  restorePanelState();
  await renderDetail(false);
  if(panelReview !== id){ panelReview = id; chatMessages = []; loadBrief(id); loadChat(id); }
}
function clearTimers(){
  if(compTimer){ clearInterval(compTimer); compTimer = null; }
  if(detailTimer){ clearTimeout(detailTimer); detailTimer = null; }
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
function stageCard(name, s){
  const st = s?.status || 'pending';
  const cls = st === 'success' ? '' : st === 'failed' ? 'st-failed' :
              (st === 'running' || st === 'queued') ? 'st-running' : '';
  return `<div class="stage ${cls}">
    <div class="stage-head"><strong>${esc(name)}</strong>${badge(st)}</div>
    <div class="dur">${s?.duration_seconds != null ? esc(s.duration_seconds) + 's' : (st === 'running' || st === 'queued' ? 'in progress…' : '—')}</div>
    ${s?.error ? `<p class="err">${esc(s.error)}</p>` : ''}
    ${s?.image ? `<div class="img">${esc(s.image)}</div>` : ''}
  </div>`;
}
async function loadCompHealth(){
  try{
    const data = await api('/api/v1/components');
    compHealth = data.components || [];
  }catch(e){ compHealth = null; }
}
function healthBadges(){
  if(!compHealth) return '';
  return `<div class="health-row"><span class="muted" style="font-size:12px">Component health:</span>` +
    compHealth.map(c => {
      const ok = c.status === 'up';
      return `<span class="health-badge ${ok ? 'ok' : 'bad'}" title="${esc(c.version || '')}${c.latency_ms != null ? ' · ' + c.latency_ms + 'ms' : ''}${c.error ? ' · ' + c.error : ''}">
        <span class="dot dot-${c.status}"></span>${esc(c.name)}</span>`;
    }).join('') + '</div>';
}
function findingsCountLabel(findings){
  return findings.length ? `Findings <span class="count">${findings.length}</span>` : 'Findings';
}
async function renderDetail(keepPosition){
  const el = $('detail-panel');
  try{
    const [r] = await Promise.all([api(`/api/v1/reviews/${encodeURIComponent(detailId)}`), loadCompHealth()]);
    detailData = r;
    const d = r.result || {};
    $('crumb-id').textContent = detailId.slice(0, 12);
    $('detail-title').innerHTML = `${badge(r.status)}<span>${esc(r.request.repository)}</span>`;
    $('detail-rid').textContent = r.review_id;
    const inv = d.inventory || [], covered = inv.filter(x => x.status === 'covered').length;
    const findings = d.findings || [];
    const scanners = d.scanners || {};
    const dojo = r.dojo || {};

    $('detail-tabs').innerHTML = TABS.map(t =>
      `<button class="tab${t === detailTab ? ' on' : ''}" role="tab" data-tab="${t}">` +
      (t === 'findings' ? findingsCountLabel(findings) : TAB_LABELS[t]) + `</button>`).join('');

    const stageNames = ['sonarqube', 'checkov', 'trivy', 'gitleaks'];
    const panels = {
      overview: `
        ${timeline(r.status)}
        <div class="reason">${esc((d.reasons || ['Review is waiting for a terminal decision.']).join(' · '))}</div>
        <h3 style="margin:20px 0 4px">Execution stages</h3>
        <div class="stages">
          ${stageNames.map(n => stageCard(n, scanners[n])).join('')}
          ${stageCard('defectdojo', {status: dojo.status === 'synced' ? 'success' : (dojo.status || 'pending'),
            duration_seconds: dojo.duration_seconds, error: dojo.error})}
        </div>
        ${healthBadges()}
        <div class="kv-grid">
          <div class="kv"><span>Commit</span><code>${esc(r.request.commit_sha)}</code></div>
          <div class="kv"><span>Policy</span>${esc(r.request.policy_version)} <span class="muted mono">${esc((r.request.policy_digest || '').slice(0, 16))}</span></div>
          <div class="kv"><span>Pipeline</span><a href="${esc(r.request.ado_run_url)}" target="_blank" rel="noopener noreferrer">Azure DevOps run ${esc(r.request.ado_run_id)}</a></div>
          <div class="kv"><span>DefectDojo</span>${badge(dojo.status || 'pending')}${dojo.url ? ` <a href="${esc(dojo.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}</div>
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
      coverage: `
        <p class="muted">Coverage · ${covered}/${inv.length} inputs</p>
        <div class="card" style="margin-top:12px"><div class="table-wrap"><table class="tbl">
        <thead><tr><th>Input</th><th>Required scans</th><th>Status</th></tr></thead><tbody>
        ${inv.map(x => `<tr><td class="mono">${esc(x.path)}</td><td class="muted">${esc((x.required_tools || []).join(', '))}</td><td>${badge(x.status)}</td></tr>`).join('')}
        </tbody></table></div></div>`,
      evidence: `
        <div class="chips">${Object.keys(d.artifacts || {}).map(n => `<button class="chip" data-artifact="${esc(n)}">👁 ${esc(n)}</button>`).join('')}
        <button class="chip" id="audit-btn">View audit trail</button></div>
        <pre id="audit-data" hidden></pre>`,
    };
    el.innerHTML = `<div class="tabpanel">${panels[detailTab]}</div>`;
    if(!keepPosition) window.scrollTo({top: 0});
    if(detailTab === 'findings') filterFindings('ALL');
    showError('');
    // live polling while the review is not terminal (3s)
    if(['queued', 'running'].includes(r.status)){
      detailTimer = setTimeout(() => { if(detailId) renderDetail(true); }, 3000);
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

/* ---------- AI side panel (persistent, collapsible) ---------- */
function isMobile(){ return window.innerWidth < 1024; }
function restorePanelState(){
  const p = $('ai-panel');
  const collapsed = localStorage.getItem('tke-ai-collapsed') === '1';
  p.classList.toggle('collapsed', collapsed && !isMobile());
  $('ai-collapse').textContent = collapsed ? '›' : '‹';
  $('ai-collapse').title = collapsed ? 'Expand' : 'Collapse';
  if(isMobile()){ p.classList.remove('open'); $('ai-scrim').hidden = true; }
}
function togglePanel(force){
  const p = $('ai-panel');
  if(isMobile()){
    const open = force !== undefined ? force : !p.classList.contains('open');
    p.classList.toggle('open', open);
    $('ai-scrim').hidden = !open;
    return;
  }
  const collapsed = force !== undefined ? !force : !p.classList.contains('collapsed');
  p.classList.toggle('collapsed', collapsed);
  localStorage.setItem('tke-ai-collapsed', collapsed ? '1' : '0');
  $('ai-collapse').textContent = collapsed ? '›' : '‹';
  $('ai-collapse').title = collapsed ? 'Expand' : 'Collapse';
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
    if(attempt < 10 && panelReview === id){
      box.innerHTML = `<div class="spinner">Generating brief…</div>`;
      setTimeout(() => loadBrief(id, attempt + 1), 4000);
    }else if(panelReview === id){
      box.innerHTML = `<p class="muted">Brief unavailable for this review.</p>`;
    }
  }
}
function renderChat(){
  const log = $('chat-log');
  if(!chatMessages.length){
    log.innerHTML = `<div class="chat-empty">Ask about anything on this page — the decision, scanners, coverage, findings, Dojo sync…</div>`;
    return;
  }
  log.innerHTML = chatMessages.map(m => {
    const t = m.at ? `<time>${esc(fmtDate(m.at))}${m.model ? ' · ' + esc(m.model) : ''}</time>` : '';
    return m.role === 'user'
      ? `<div class="msg user"><span>${esc(m.content)}</span>${t}</div>`
      : `<div class="msg bot"><div class="md-body">${md(m.content)}</div>${t}</div>`;
  }).join('');
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}
async function loadChat(id){
  try{
    const d = await api(`/api/v1/reviews/${encodeURIComponent(id)}/chat`);
    if(panelReview !== id) return;
    chatMessages = (d.messages || []).map(m => ({
      role: m.role, content: m.content, at: m.at, model: m.model,
    }));
    renderChat();
  }catch(e){ /* leave placeholder */ }
}
async function sendChat(message){
  const input = $('chat-input'), btn = $('chat-send');
  const history = chatMessages.slice(-10).map(m => ({role: m.role, content: m.content}));
  chatMessages.push({role: 'user', content: message, at: Date.now() / 1000});
  renderChat();
  const typing = document.createElement('div');
  typing.className = 'msg bot typing'; typing.textContent = 'Analyst is thinking…';
  $('chat-log').append(typing);
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
  input.value = ''; input.disabled = true; btn.disabled = true;
  try{
    const r = await fetch(`/api/v1/reviews/${encodeURIComponent(panelReview)}/chat`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message, history, tab: detailTab}),
    });
    if(!r.ok) throw new Error(`Chat failed (${r.status})`);
    const data = await r.json();
    chatMessages.push({role: 'assistant', content: data.reply, at: Date.now() / 1000, model: data.model});
    renderChat();
  }catch(e){
    typing.textContent = 'Chat unavailable: ' + e.message;
    typing.classList.remove('typing');
  }finally{
    input.disabled = false; btn.disabled = false; input.focus();
  }
}

/* ---------- artifact preview ---------- */
let previewName = null, previewRaw = null;
async function openPreview(name){
  const modal = $('preview-modal');
  previewName = name; previewRaw = null;
  $('preview-title').textContent = name;
  $('preview-body').innerHTML = `<div class="spinner" style="padding:24px">Loading…</div>`;
  modal.hidden = false;
  try{
    const data = await api(`/api/v1/reviews/${encodeURIComponent(detailId)}/artifacts/${encodeURIComponent(name)}`);
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    previewRaw = text;
    if(text.length > 600000){
      $('preview-body').innerHTML = `<p class="muted" style="padding:20px">File too large for preview (${(text.length / 1024).toFixed(0)} KB). Use Download.</p>`;
      return;
    }
    const highlighted = /\.json$/i.test(name) ? hlJson(text) : esc(text);
    $('preview-body').innerHTML = `<div class="code-dark">${withLineNumbers(highlighted)}</div>`;
  }catch(e){
    $('preview-body').innerHTML = `<p class="muted" style="padding:20px">Preview failed: ${esc(e.message)}</p>`;
  }
}
function closePreview(){ $('preview-modal').hidden = true; previewName = null; previewRaw = null; }
function downloadPreview(){
  if(!previewRaw || !previewName) return;
  const url = URL.createObjectURL(new Blob([previewRaw], {type: 'application/octet-stream'}));
  const a = document.createElement('a'); a.href = url; a.download = previewName; a.click();
  URL.revokeObjectURL(url);
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
  clearTimers();
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
$('ai-collapse').addEventListener('click', () => togglePanel());
$('ai-expand').addEventListener('click', () => togglePanel(true));
$('ai-fab').addEventListener('click', () => togglePanel(true));
$('ai-scrim').addEventListener('click', () => togglePanel(false));
$('preview-close').addEventListener('click', closePreview);
$('preview-download').addEventListener('click', downloadPreview);
$('preview-modal').addEventListener('click', e => { if(e.target === $('preview-modal')) closePreview(); });
document.addEventListener('keydown', e => {
  if(e.key === 'Escape'){
    if(!$('preview-modal').hidden) closePreview();
    else if(isMobile()) togglePanel(false);
  }
});
window.addEventListener('resize', () => { if(panelReview) restorePanelState(); });

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
    if(chip && detailId){ openPreview(chip.dataset.artifact); return; }
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
