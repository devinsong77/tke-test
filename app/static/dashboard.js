'use strict';
/* TKE Governance dashboard — GitHub-style: overview -> detail -> tabs, persistent AI panel. */
let busy = false, compTimer = null, detailTimer = null;
let panelReview = null, chatMessages = [], routeVersion = 0;
let reviewsCache = [], listPage = 0;
const PAGE_SIZE = 12;

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge = v => `<span class="badge st-${/^[A-Za-z_]+$/.test(v) ? v : 'x'}">${esc(v)}</span>`;
const fmtDate = ts => ts ? new Date(ts * 1000).toLocaleString() : '—';
const fmtDuration = n => n == null ? '—' : n < 60 ? `${Number(n).toFixed(1)}s` : `${Math.floor(Math.round(n) / 60)}m ${Math.round(n) % 60}s`;
const isPipeline = r => /^\d+$/.test(r.request.ado_run_id) && Number(r.request.ado_run_id) > 0;
const sourceLabel = r => `Run #${r.request.ado_run_id}`;
const shortId = id => esc((id || '').slice(0, 12));

// Links always use an immutable scanned revision, never the default branch.
function githubUrl(r, file = '', line = 0, revision = ''){
  const repo = r.repository_url;
  const sha = revision || r.request.commit_sha;
  if(!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '') || !/^[a-f0-9]{40}$/i.test(sha || '')) return null;
  if(!file) return `${repo}/commit/${sha}`;
  const path = String(file).replace(/^\/src\//, '').replace(/^\.\//, '');
  if(path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '..' || p === '.')) return null;
  const number = Number(line);
  return `${repo}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}${Number.isSafeInteger(number) && number > 0 ? '#L' + number : ''}`;
}
function commitLink(r, short = false){
  const label = esc(short ? r.request.commit_sha.slice(0, 10) : r.request.commit_sha);
  const url = githubUrl(r);
  return url ? `<a class="mono" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="View scanned commit on GitHub">${label} ↗</a>` : `<span class="mono">${label}</span>`;
}
function findingLocation(r, finding){
  if(!finding.file) return '<span class="muted">No source location</span>';
  const line = Number(finding.line);
  const label = esc(finding.file) + (Number.isSafeInteger(line) && line > 0 ? ':' + line : '');
  const url = githubUrl(r, finding.file, finding.line, finding.commit_sha);
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="View finding in GitHub at its recorded revision">${label} ↗</a>` : label;
}

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
  const token = /"(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;
  let html = '', offset = 0;
  for(const match of src.matchAll(token)){
    html += esc(src.slice(offset, match.index));
    const value = match[0];
    const kind = value.startsWith('"') ? (value.trimEnd().endsWith(':') ? 'b' : 's') : /^(true|false|null)$/.test(value) ? 'k' : 'n';
    html += `<span class="tok-${kind}">${esc(value)}</span>`;
    offset = match.index + value.length;
  }
  return html + esc(src.slice(offset));
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
  if(!r.ok){ const error = new Error(`Request failed (${r.status})`); error.status = r.status; throw error; }
  return r.json();
}
function showError(msg){ const m = $('message'); m.hidden = !msg; m.textContent = msg || ''; }

/* ---------- router ---------- */
const TABS = ['overview', 'coverage', 'findings', 'evidence'];
const TAB_LABELS = {overview: 'Overview', findings: 'Findings', coverage: 'Coverage', evidence: 'Evidence'};

function nav(hash){ if(location.hash === hash) route(); else location.hash = hash; }
function route(){
  routeVersion++;
  closePreview();
  showError('');
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
  if(id !== 'view-detail'){ $('ai-panel').classList.remove('open'); $('ai-scrim').hidden = true; syncPanelAccessibility(); }
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
  $('refresh').disabled = true; $('refresh').textContent = 'Refreshing…';
  if(!reviewsCache.length) $('reviews').innerHTML = '<tr><td colspan="6"><div class="loading-state">Loading reviews…</div></td></tr>';
  try{
    const data = await api('/api/v1/reviews');
    if(!$('view-reviews').hidden) showError('');
    reviewsCache = (data.reviews || []).filter(isPipeline);
    const n = status => reviewsCache.filter(x => x.status === status).length;
    $('metrics').innerHTML = [
      ['Reviews', reviewsCache.length, '', 'Latest 100 Azure Pipeline reviews'], ['Passed', n('PASS'), 's-pass', 'All required checks satisfied'],
      ['Blocked', n('BLOCK'), 's-block', 'Policy violations detected'], ['Errors', n('ERROR'), 's-error', 'Incomplete or failed checks'],
    ].map(([label, count, cls, note]) => `<div class="stat ${cls}"><span>${label}</span><strong>${count}</strong><small>${note}</small></div>`).join('');
    renderLatest(); renderReviewRows();
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString()} · Refreshes every 15 seconds · Times shown in your local timezone`;
  }catch(e){
    if(!$('view-reviews').hidden) showError(`Could not refresh reviews. ${e.message}${reviewsCache.length ? ' Showing the last successful response.' : ''}`);
    if(!reviewsCache.length) $('reviews').innerHTML = '<tr><td colspan="6"><div class="loading-state">Reviews unavailable. Use Refresh to try again.</div></td></tr>';
  }finally{ busy = false; $('refresh').disabled = false; $('refresh').textContent = 'Refresh'; }
}
function renderLatest(){
  const r = reviewsCache.find(isPipeline), el = $('latest-review');
  el.hidden = !r;
  if(!r) return;
  const d = r.result || {};
  el.innerHTML = `<div class="latest-main"><span class="eyebrow">Latest pipeline review</span><div class="latest-title">${badge(r.status)}<strong>${esc(r.request.repository)}</strong><span class="muted">${esc(sourceLabel(r))}</span></div><p>${esc((d.reasons || ['Awaiting a terminal decision.']).join(' · '))}</p></div><div class="latest-side"><span class="mono">${commitLink(r, true)}</span><a class="btn" href="#review-${esc(r.review_id)}">View review <span aria-hidden="true">↗</span></a></div>`;
}
function renderReviewRows(){
  const query = $('review-search').value.trim().toLowerCase();
  const decision = $('decision-filter').value;
  const rs = reviewsCache.filter(r => (decision === 'all' || r.status === decision) &&
    [r.review_id, r.request.repository, r.request.commit_sha, r.request.ado_run_id, sourceLabel(r)].some(v => String(v).toLowerCase().includes(query)));
  const pages = Math.max(1, Math.ceil(rs.length / PAGE_SIZE));
  listPage = Math.min(listPage, pages - 1);
  $('reviews').innerHTML = rs.slice(listPage * PAGE_SIZE, (listPage + 1) * PAGE_SIZE).map(r => `<tr class="clickable" data-review="${esc(r.review_id)}">
    <td>${badge(r.status)}</td><td><a class="review-link" href="#review-${esc(r.review_id)}">${esc(sourceLabel(r))} <span aria-hidden="true">↗</span></a><span class="sub mono">${shortId(r.review_id)}</span></td>
    <td><strong class="repo-name">${esc(r.request.repository)}</strong><span class="sub mono">${commitLink(r, true)}</span></td>
    <td class="duration">${fmtDuration(r.result?.duration_seconds)}</td><td>${badge(r.dojo?.status || 'pending')}</td>
    <td class="muted date-cell">${esc(fmtDate(r.created_at))}</td></tr>`).join('');
  $('empty').hidden = !!rs.length;
  $('list-count').textContent = rs.length ? `${listPage * PAGE_SIZE + 1}–${Math.min((listPage + 1) * PAGE_SIZE, rs.length)} of ${rs.length} reviews` : '0 reviews';
  $('prev-page').disabled = listPage === 0; $('next-page').disabled = listPage >= pages - 1;
}

/* ---------- review detail ---------- */
let detailId = null, detailTab = 'overview', detailData = null, compHealth = null;

async function openDetail(id, tab, fromRoute){
  clearTimers();
  setNav('detail'); showOnly('view-detail');
  if(detailId !== id){ $('detail-title').textContent = 'Loading review…'; $('detail-rid').textContent = id; $('detail-tabs').innerHTML = ''; $('detail-panel').innerHTML = '<div class="loading-state">Loading decision and evidence…</div>'; }
  detailId = id; detailTab = TABS.includes(tab) ? tab : 'overview';
  if(!fromRoute) history.replaceState(null, '', '#review-' + id + (detailTab === 'overview' ? '' : '/' + detailTab));
  restorePanelState();
  if(panelReview !== id){ panelReview = id; initAi(id); }
  await renderDetail(false);
}
function clearTimers(){
  if(compTimer){ clearInterval(compTimer); compTimer = null; }
  if(detailTimer){ clearTimeout(detailTimer); detailTimer = null; }
}
function timeline(status){
  const terminal = ['PASS','BLOCK','ERROR'].includes(status);
  const steps = ['Queued', 'Scanning', terminal ? status : 'Decision'];
  return `<div class="timeline outcome-${esc(status)}" aria-label="Review progress">` + steps.map((label, i) => {
    const done = i === 0 || (i === 1 && terminal) || (i === 2 && terminal);
    const active = (i === 0 && status === 'queued') || (i === 1 && status === 'running');
    const icon = i === 2 && terminal && status !== 'PASS' ? '!' : done ? '✓' : i + 1;
    return `<div class="tstep${done ? ' done' : ''}${active ? ' current' : ''}"><div class="tnode"><span class="tdot">${icon}</span><small>${esc(label)}</small></div>${i < 2 ? '<span class="tlink"></span>' : ''}</div>`;
  }).join('') + '</div>';
}
function stageCard(name, s, comp){
  const st = s?.status || (['PASS','BLOCK','ERROR'].includes(detailData?.status) ? 'not_recorded' : 'pending');
  const cls = st === 'success' ? '' : st === 'failed' ? 'st-failed' :
              (st === 'running' || st === 'queued') ? 'st-running' : '';
  const health = comp ? `<span class="stage-health" title="${esc(comp.version || '')}${comp.latency_ms != null ? ' · ' + comp.latency_ms + 'ms' : ''}${comp.error ? ' · ' + comp.error : ''}"><span class="dot dot-${comp.status}"></span>Health now · ${esc(comp.status)}</span>` : '';
  const stIcon = st === 'success' ? '✓' : st === 'failed' ? '✕' : (st === 'running' || st === 'queued') ? '●' : '○';
  return `<div class="stage ${cls}">
    <div class="stage-head"><span class="stage-name"><span class="stage-icon st-ic-${st}">${stIcon}</span><strong>${esc(COMP_META[name]?.label || name)}</strong></span>${badge(st)}</div>
    <div class="stage-sub"><span class="dur">${s?.duration_seconds != null ? fmtDuration(s.duration_seconds) : (st === 'running' || st === 'queued' ? 'In progress…' : 'Recorded result')}</span>${health}</div>
    ${s?.error ? `<p class="err">${esc(s.error)}</p>` : ''}
    ${s?.version ? `<div class="img">Version: ${esc(s.version)}</div>` : ''}
    ${s?.exit_code != null ? `<div class="img">Exit code: ${esc(s.exit_code)}</div>` : ''}
    ${s?.image ? `<div class="img">${esc(s.image)}</div>` : ''}
  </div>`;
}
async function loadCompHealth(){
  try{
    const data = await api('/api/v1/components');
    compHealth = data.components || [];
  }catch(e){ compHealth = null; }
}
function findingsCountLabel(findings){
  return findings.length ? `Findings <span class="count">${findings.length}</span>` : 'Findings';
}
async function renderDetail(keepPosition){
  const el = $('detail-panel'), requestedId = detailId, version = routeVersion;
  try{
    const [r] = await Promise.all([api(`/api/v1/reviews/${encodeURIComponent(detailId)}`), loadCompHealth()]);
    if(version !== routeVersion || requestedId !== detailId || $('view-detail').hidden) return;
    detailData = r;
    const d = r.result || {};
    $('crumb-id').textContent = detailId.slice(0, 12);
    $('detail-title').innerHTML = `${badge(r.status)}<span>${esc(r.request.repository)}</span>`;
    $('detail-rid').textContent = r.review_id;
    const inv = d.inventory || [], covered = inv.filter(x => x.status === 'covered').length;
    const applicable = inv.filter(x => x.status !== 'N/A').length;
    const coverageLabel = applicable ? `${Math.round(100 * covered / applicable)}% (${covered}/${applicable} applicable)` : (inv.length ? 'N/A — no applicable inputs' : 'No coverage evidence');
    const findings = d.findings || [];
    const scanners = d.scanners || {};
    const dojo = r.dojo || {};

    $('detail-tabs').innerHTML = TABS.map(t =>
      `<button class="tab${t === detailTab ? ' on' : ''}" role="tab" id="tab-${t}" aria-selected="${t === detailTab}" aria-controls="detail-panel" tabindex="${t === detailTab ? 0 : -1}" data-tab="${t}">` +
      (t === 'findings' ? findingsCountLabel(findings) : TAB_LABELS[t]) + `</button>`).join('');

    const stageNames = ['sonarqube', 'checkov', 'trivy', 'gitleaks'];
    const compMap = {};
    (compHealth || []).forEach(c => { compMap[c.name] = c; });
    const panels = {
      overview: `
        <div class="decision-summary outcome-${esc(r.status)}"><div class="decision-copy"><span class="eyebrow">Gate decision</span><h2>${({PASS:'Security checks passed',BLOCK:'Release blocked by policy',ERROR:'Review could not complete',running:'Security review in progress',queued:'Review queued'})[r.status] || esc(r.status)}</h2><p>${esc((d.reasons || ['Waiting for a terminal decision. Publishing remains blocked.']).join(' · '))}</p></div>${timeline(r.status)}</div>
        <div class="review-facts"><div><span>Blocking findings</span><strong>${d.blocking_count ?? '—'}</strong></div><div><span>Inputs covered</span><strong>${covered}<small> / ${inv.length}</small></strong></div><div><span>Total findings</span><strong>${findings.length}</strong></div><div><span>Duration</span><strong>${fmtDuration(d.duration_seconds)}</strong></div></div>
        <h3 class="section-h">Scan results & report delivery</h3><p class="section-note">Results belong to this review. Health labels show the current component status.</p>
        <div class="stages">
          ${stageNames.map(n => stageCard(n, scanners[n], compMap[n])).join('')}
          ${stageCard('defectdojo', {status: dojo.status === 'synced' ? 'success' : (dojo.status || 'pending'),
            duration_seconds: dojo.duration_seconds, error: dojo.error}, compMap['defectdojo'])}
        </div>
        <div class="kv-grid">
          <div class="kv"><span>Commit</span>${commitLink(r)}</div>
          <div class="kv"><span>Policy</span>${esc(r.request.policy_version)} <span class="muted mono">${esc((r.request.policy_digest || '').slice(0, 16))}</span></div>
          <div class="kv"><span>Source</span><a href="${esc(r.request.ado_run_url)}" target="_blank" rel="noopener noreferrer">Azure DevOps run #${esc(r.request.ado_run_id)} ↗</a></div>
          <div class="kv"><span>DefectDojo</span>${badge(dojo.status || 'pending')}${dojo.url ? ` <a href="${esc(dojo.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}</div>
        </div>`,
      findings: `
        <p class="section-note">${findings.length} reported findings · ${d.blocking_count ?? '—'} blocking. Maintainability findings remain visible even when the security policy passes.</p>
        <div class="fbar" id="fbar">
          ${['ALL','CRITICAL','HIGH','MEDIUM','LOW','INFO'].map(s => `<button class="fbtn${s === 'ALL' ? ' on' : ''}" data-sev="${s}">${s === 'ALL' ? 'All' : s[0] + s.slice(1).toLowerCase()}</button>`).join('')}
          <span class="fcount" id="fcount"></span>
        </div>
        <div class="card findings-card"><div class="table-wrap" id="findings-body">
        ${findings.length ? `<table class="tbl"><thead><tr><th>Severity</th><th>Finding</th><th>Location</th></tr></thead><tbody>` +
          findings.map(f => `<tr data-sevrow="${esc(f.severity)}"><td>${badge(f.severity)}</td>
            <td><strong>${esc(f.rule)}</strong> <span class="muted">${esc(f.tool || '')}${f.category ? ' · ' + esc(f.category.replaceAll('_',' ').toLowerCase()) : ''}</span><span class="sub">${esc(f.title)}</span>
            <span class="sub">${esc(f.remediation || '')}</span></td>
            <td class="mono">${findingLocation(r, f)}</td></tr>`).join('') + `</tbody></table>`
          : '<p class="empty-note">No findings recorded.</p>'}</div></div>`,
      coverage: `
        <p class="muted">Coverage · ${esc(coverageLabel)} · ${inv.length - applicable} N/A</p>
        <div class="card"><div class="table-wrap"><table class="tbl">
        <thead><tr><th>Input</th><th>Required scans</th><th>Status / reason</th></tr></thead><tbody>
        ${inv.map(x => `<tr><td class="mono">${esc(x.path)}</td><td class="muted">${esc((x.required_tools || []).join(', '))}</td><td>${badge(x.status)}${x.reason ? `<span class="sub">${esc(x.reason)}</span>` : ''}</td></tr>`).join('')}
        </tbody></table></div></div>`,
      evidence: `
        <p class="section-note">Server evidence is bound to this review and checked against its SHA-256 digest before download.</p>
        <div class="evidence-list">${Object.entries(d.artifacts || {}).map(([n, hash]) => `<button class="evidence-item" data-artifact="${esc(n)}"><span class="file-icon" aria-hidden="true">{ }</span><span><strong>${esc(n)}</strong><small class="mono">SHA-256 ${esc(hash.slice(0, 20))}…</small></span><span class="evidence-open">Preview ↗</span></button>`).join('')}</div>
        <button class="btn audit-button" id="audit-btn">View audit trail</button>
        <pre id="audit-data" hidden></pre>`,
    };
    $('detail-panel').setAttribute('aria-labelledby', 'tab-' + detailTab);
    el.innerHTML = `<div class="tabpanel">${panels[detailTab]}</div>`;
    if(!keepPosition) window.scrollTo({top: 0});
    if(detailTab === 'findings') filterFindings('ALL');
    showError('');
    // live polling while the review is not terminal (3s)
    if(['queued', 'running'].includes(r.status)){
      detailTimer = setTimeout(() => { if(detailId) renderDetail(true); }, 3000);
    }
  }catch(e){ if(version === routeVersion) showError(`Could not load review. ${e.message}`); }
}
function switchTab(tab){
  if(!TABS.includes(tab) || tab === detailTab) return;
  clearTimers(); routeVersion++;
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
    tr.hidden = !show;
    if(show) vis++;
  });
  const c = $('fcount');
  if(c) c.textContent = total ? `${vis} / ${total}` : '';
}

/* ---------- AI side panel (persistent, collapsible) ---------- */
function isMobile(){ return window.innerWidth < 1024; }
function restorePanelState(){
  const p = $('ai-panel');
  const collapsed = localStorage.getItem('tke-ai-collapsed') !== '0';
  p.classList.toggle('collapsed', collapsed && !isMobile());
  $('ai-collapse').textContent = collapsed ? '›' : '‹';
  $('ai-collapse').title = collapsed ? 'Expand' : 'Collapse';
  $('ai-collapse').setAttribute('aria-label', collapsed ? 'Expand AI analyst' : 'Collapse AI analyst');
  if(isMobile()){ p.classList.remove('open'); $('ai-scrim').hidden = true; $('ai-collapse').textContent = '×'; $('ai-collapse').setAttribute('aria-label','Close AI analyst'); }
  syncPanelAccessibility();
}
function togglePanel(force){
  const p = $('ai-panel');
  if(isMobile()){
    const open = force !== undefined ? force : !p.classList.contains('open');
    p.classList.toggle('open', open);
    $('ai-scrim').hidden = !open;
    syncPanelAccessibility();
    if(open) $('chat-input').focus(); else $('ai-fab').focus();
    return;
  }
  const collapsed = force !== undefined ? !force : !p.classList.contains('collapsed');
  p.classList.toggle('collapsed', collapsed);
  localStorage.setItem('tke-ai-collapsed', collapsed ? '1' : '0');
  syncPanelAccessibility();
  $('ai-collapse').textContent = collapsed ? '›' : '‹';
  $('ai-collapse').title = collapsed ? 'Expand' : 'Collapse';
  $('ai-collapse').setAttribute('aria-label', collapsed ? 'Expand AI analyst' : 'Collapse AI analyst');
}
function syncPanelAccessibility(){
  const p = $('ai-panel'), hidden = isMobile() && !p.classList.contains('open');
  p.inert = hidden; p.setAttribute('aria-hidden', String(hidden));
  p.querySelector('.ai-panel-inner').inert = hidden || (!isMobile() && p.classList.contains('collapsed'));
}
let aiLoading = false, aiNotice = '', chatBusy = false;
async function fetchBrief(id){
  try{ return await api(`/api/v1/reviews/${encodeURIComponent(id)}/analysis`); }
  catch(e){ return {unavailable: e.status === 404 ? 'No saved brief is available yet. You can still ask a question about this review.' : 'The saved brief is unavailable. Try opening this review again.'}; }
}
async function initAi(id){
  chatMessages = []; aiLoading = true; aiNotice = ''; chatBusy = false; $('chat-input').disabled = false; $('chat-send').disabled = false; renderChat();
  const [brief, chat] = await Promise.all([
    fetchBrief(id),
    api(`/api/v1/reviews/${encodeURIComponent(id)}/chat`).catch(() => ({messages: []})),
  ]);
  if(panelReview !== id) return;
  aiLoading = false; aiNotice = brief?.unavailable || '';
  const history = (chat.messages || []).map(m => ({role: m.role, content: m.content, at: m.at, model: m.model}));
  chatMessages = history;
  if(!history.length && brief && brief.brief){
    chatMessages.push({role: 'assistant', content: brief.brief, at: brief.generated_at, model: brief.model, kind: 'brief'});
  }
  renderChat();
}
function renderChat(){
  const log = $('chat-log');
  if(!chatMessages.length && !aiLoading){
    log.innerHTML = `<div class="chat-empty"><div class="chat-empty-icon">✦</div><p>${esc(aiNotice || 'Ask about the decision, scanners, coverage or findings.')}<div class="chat-suggestions"><button type="button" data-question="Explain this gate decision and its evidence.">Explain this decision ↗</button><button type="button" data-question="What should I investigate or fix first?">What should I fix first? ↗</button></div></p></div>`;
    return;
  }
  log.innerHTML = chatMessages.map(m => {
    const t = m.at ? `<time>${esc(fmtDate(m.at))}${m.model ? ' · ' + esc(m.model) : ''}</time>` : '';
    return m.role === 'user'
      ? `<div class="msg user"><span>${esc(m.content)}</span>${t}</div>`
      : `<div class="msg bot"><div class="md-body">${md(m.content)}</div>${t}</div>`;
  }).join('') + (aiLoading ? `<div class="msg bot typing"><span class="typing-dots"><i></i><i></i><i></i></span> Loading saved analysis…</div>` : '');
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

async function sendChat(message){
  if(chatBusy) return;
  chatBusy = true;
  const reviewId = panelReview;
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
    const r = await fetch(`/api/v1/reviews/${encodeURIComponent(reviewId)}/chat`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message, history, tab: detailTab}),
    });
    if(!r.ok) throw new Error(`Chat failed (${r.status})`);
    const data = await r.json();
    if(panelReview !== reviewId) return;
    chatMessages.push({role: 'assistant', content: data.reply, at: Date.now() / 1000, model: data.model});
    renderChat();
  }catch(e){
    if(panelReview !== reviewId) return;
    typing.textContent = 'Chat unavailable: ' + e.message;
    typing.classList.remove('typing');
  }finally{
    if(panelReview === reviewId){ chatBusy = false; input.disabled = false; btn.disabled = false; input.focus(); }
  }
}

/* ---------- artifact preview ---------- */
let previewName = null, previewRaw = null, previewTrigger = null, previewVersion = 0;
async function openPreview(name){
  const modal = $('preview-modal'), version = ++previewVersion, reviewId = detailId;
  previewTrigger = document.activeElement;
  $('preview-download').disabled = true;
  previewName = name; previewRaw = null;
  $('preview-title').textContent = name;
  $('preview-body').innerHTML = `<div class="spinner preview-loading">Loading…</div>`;
  modal.hidden = false; document.body.classList.add('modal-open'); $('preview-close').focus();
  try{
    const response = await fetch(`/api/v1/reviews/${encodeURIComponent(reviewId)}/artifacts/${encodeURIComponent(name)}`);
    if(!response.ok) throw new Error(`Request failed (${response.status})`);
    const original = await response.text();
    if(version !== previewVersion) return;
    previewRaw = original; $('preview-download').disabled = false;
    const text = /\.json$/i.test(name) ? JSON.stringify(JSON.parse(original), null, 2) : original;
    if(text.length > 600000){
      $('preview-body').innerHTML = `<p class="empty-note">File too large for preview (${(text.length / 1024).toFixed(0)} KB). Use Download.</p>`;
      return;
    }
    const highlighted = /\.json$/i.test(name) ? hlJson(text) : esc(text);
    $('preview-body').innerHTML = `<div class="code-dark">${withLineNumbers(highlighted)}</div>`;
  }catch(e){
    if(version !== previewVersion) return;
    $('preview-body').innerHTML = `<p class="empty-note">Preview failed: ${esc(e.message)}</p>`;
  }
}
function closePreview(){ if($('preview-modal').hidden) return; previewVersion++; $('preview-modal').hidden = true; document.body.classList.remove('modal-open'); previewName = null; previewRaw = null; previewTrigger?.focus(); }
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
['review-search','decision-filter'].forEach(id => $(id).addEventListener(id === 'review-search' ? 'input' : 'change', () => { listPage = 0; renderReviewRows(); }));
$('clear-filters').addEventListener('click', () => { $('review-search').value = ''; $('decision-filter').value = 'all'; listPage = 0; renderReviewRows(); });
$('prev-page').addEventListener('click', () => { listPage--; renderReviewRows(); });
$('next-page').addEventListener('click', () => { listPage++; renderReviewRows(); });
$('detail-tabs').addEventListener('keydown', e => {
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
  e.preventDefault();
  let i = TABS.indexOf(detailTab);
  i = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
  switchTab(TABS[i]);
  document.querySelector(`[data-tab="${TABS[i]}"]`)?.focus();
});
$('preview-modal').addEventListener('keydown', e => {
  if(e.key !== 'Tab') return;
  const items = [...$('preview-modal').querySelectorAll('button:not(:disabled)')], first = items[0], last = items.at(-1);
  if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
});
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
let previousMobile = isMobile();
window.addEventListener('resize', () => { const mobile = isMobile(); if(mobile !== previousMobile && panelReview) restorePanelState(); previousMobile = mobile; });

document.addEventListener('click', async e => {
  const suggestion = e.target.closest?.('[data-question]');
  if(suggestion && panelReview){ $('chat-input').value = suggestion.dataset.question; $('chat-input').focus(); return; }
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
  try{
    if(e.target.closest?.('a')) return;
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
