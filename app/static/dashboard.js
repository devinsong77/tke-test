'use strict';
/* TKE Governance Lab dashboard — read-only review explorer + AI analyst. */
let selected = null, busy = false, analysisTimer = null, activeTab = 'overview';

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge = v => `<span class="badge st-${/^[A-Za-z_]+$/.test(v) ? v : 'x'}">${esc(v)}</span>`;
const fmtDate = ts => new Date(ts * 1000).toLocaleString();

/* ---------- tiny markdown renderer (no external deps; CSP is script-src 'self') ---------- */
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
  if(!r.ok) throw new Error(`Request failed (${r.status}). Check access or service health.`);
  return r.json();
}
function showError(msg){ const m = $('message'); m.hidden = !msg; m.textContent = msg || ''; }

/* ---------- list view ---------- */
async function refresh(){
  if(busy) return; busy = true;
  try{
    const data = await api('/api/v1/reviews');
    showError('');
    const rs = data.reviews || [];
    const n = s => rs.filter(x => x.status === s).length;
    $('metrics').innerHTML = [
      ['Total reviews', rs.length, ''],
      ['Passed', n('PASS'), 's-pass'],
      ['Blocked', n('BLOCK'), 's-block'],
      ['Errors', n('ERROR'), 's-error'],
    ].map(([l, c, cls]) => `<div class="stat ${cls}"><span>${l}</span><strong>${c}</strong></div>`).join('');
    $('reviews').innerHTML = rs.map(r => `<tr>
      <td>${badge(r.status)}</td>
      <td>${esc(r.request.repository)}<small><code>${esc((r.request.commit_sha || '').slice(0, 12))}</code></small></td>
      <td><button class="rowlink" data-review="${esc(r.review_id)}">${esc(r.review_id.slice(0, 12))}</button><small>Run ${esc(r.request.ado_run_id)}</small></td>
      <td>${r.result?.duration_seconds != null ? esc(r.result.duration_seconds) + 's' : '—'}</td>
      <td>${badge(r.dojo?.status || 'pending')}</td>
      <td>${esc(fmtDate(r.created_at))}</td></tr>`).join('');
    $('empty').hidden = !!rs.length;
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    if(selected) await details(selected, true);
  }catch(e){ showError(e.message); }
  finally{ busy = false; }
}

/* ---------- timeline ---------- */
function timeline(status){
  const steps = [['queued','Queued'], ['running','Running'], [status, status]];
  const terminal = ['PASS','BLOCK','ERROR'].includes(status);
  const color = status === 'PASS' ? '#35701a' : status === 'BLOCK' ? '#a34e22' : status === 'ERROR' ? '#a1304f' : '#375f96';
  return `<div class="timeline" style="--tc:${color}">` + steps.map(([key, label], i) => {
    const done = terminal ? true : (status === 'running' ? i <= 1 : i === 0);
    return `<div class="tstep${done ? ' done' : ''}"><div class="tnode">
      <span class="tdot">${done ? '✓' : i + 1}</span><small>${esc(label)}</small></div>`
      + (i < 2 ? '<span class="tlink"></span>' : '') + `</div>`;
  }).join('') + '</div>';
}

/* ---------- detail view ---------- */
async function details(id, keepScroll, initialTab){
  if(analysisTimer){ clearInterval(analysisTimer); analysisTimer = null; }
  selected = id;
  activeTab = initialTab || 'overview';
  const r = await api(`/api/v1/reviews/${encodeURIComponent(id)}`);
  const d = r.result || {};
  const el = $('detail');
  el.hidden = false;
  const inv = d.inventory || [], covered = inv.filter(x => x.status === 'covered').length;
  const findings = d.findings || [];

  const tabs = [
    ['overview', 'Overview'],
    ['findings', `Findings${findings.length ? ` (${findings.length})` : ''}`],
    ['scanners', 'Scanners'],
    ['coverage', 'Coverage'],
    ['analyst', 'AI Analyst'],
    ['evidence', 'Evidence'],
  ];

  const tabOverview = `
  ${timeline(r.status)}
  <div class="reason">${esc((d.reasons || ['Review is waiting for a terminal decision.']).join(' · '))}</div>
  <div class="kv-grid">
    <div class="kv"><span>Commit / policy</span><code>${esc(r.request.commit_sha)}</code><div class="small muted" style="margin-top:6px">${esc(r.request.policy_version)} · ${esc((r.request.policy_digest || '').slice(0, 16))}</div></div>
    <div class="kv"><span>Pipeline provenance</span><a href="${esc(r.request.ado_run_url)}" target="_blank" rel="noopener noreferrer">Azure DevOps run ${esc(r.request.ado_run_id)} ↗</a></div>
    <div class="kv"><span>DefectDojo</span>${badge(r.dojo?.status || 'pending')} <span class="small muted">${esc(r.dojo?.error || '')}</span>
    ${r.dojo?.url ? `<a href="${esc(r.dojo.url)}" target="_blank" rel="noopener noreferrer">Open engagement ↗</a>` : ''}</div>
  </div>`;

  const tabFindings = `
  <div class="fbar" id="fbar">
    ${['ALL','CRITICAL','HIGH','MEDIUM','LOW'].map(s => `<button class="fbtn${s === 'ALL' ? ' on' : ''}" data-sev="${s}">${s[0] + s.slice(1).toLowerCase()}</button>`).join('')}
    <span class="fcount" id="fcount"></span>
  </div>
  <div id="findings-body">${findings.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Severity</th><th>Rule / finding</th><th>Location / remediation</th></tr></thead>
  <tbody>${findings.map(f => `<tr data-sevrow="${esc(f.severity)}"><td>${badge(f.severity)}</td>
    <td><strong>${esc(f.rule)}</strong> <span class="small muted">${esc(f.tool || '')}</span><small>${esc(f.title)}</small></td>
    <td><code>${esc(f.file)}:${esc(f.line)}</code><small>${esc(f.remediation)}</small></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">No findings recorded. Coverage and scanner health remain part of the decision.</p>'}</div>`;

  const tabScanners = `
  <div class="table-wrap"><table class="tbl"><thead><tr><th>Tool</th><th>Status</th><th>Duration</th><th>Evidence / outcome</th></tr></thead>
  <tbody>${Object.entries(d.scanners || {}).map(([name, s]) => `<tr>
    <td><strong>${esc(name)}</strong><small>${esc(s.image || '')}</small></td>
    <td>${badge(s.status)}</td>
    <td>${s.duration_seconds != null ? esc(s.duration_seconds) + 's' : '—'}</td>
    <td class="small">${esc(s.error || `Exit ${JSON.stringify(s.exit_code)}${s.quality_gate ? ' · Quality Gate ' + s.quality_gate : ''}`)}</td>
  </tr>`).join('')}</tbody></table></div>`;

  const tabCoverage = `
  <p class="muted">Coverage · ${covered}/${inv.length} objects</p>
  <div class="table-wrap"><table class="tbl"><thead><tr><th>Input</th><th>Required scans</th><th>Status</th></tr></thead>
  <tbody>${inv.map(x => `<tr><td><code>${esc(x.path)}</code></td><td class="small">${esc((x.required_tools || []).join(', '))}</td><td>${badge(x.status)}</td></tr>`).join('')}</tbody></table></div>`;

  const tabAnalyst = `
  <div class="ai-card">
    <div class="ai-head"><h3>AI analyst</h3><span class="ai-tag">Advisory only</span></div>
    <p class="small muted" style="margin:0">Generated automatically when the review reaches a terminal decision. Never part of the gate decision.</p>
    <div id="ai-body"><div class="spinner">Waiting for analysis…</div></div>
    <div class="chat" id="chat">
      <div class="ai-head"><h3 style="font-size:14px">Ask about these findings</h3></div>
      <div class="chat-log" id="chat-log"><div class="chat-empty">Ask anything about this review&rsquo;s findings — e.g. &ldquo;Which finding should I fix first?&rdquo;</div></div>
      <form class="chat-form" id="chat-form">
        <input id="chat-input" type="text" placeholder="Ask about the findings…" autocomplete="off" maxlength="2000">
        <button class="btn btn-primary" type="submit" id="chat-send">Send</button>
      </form>
      <p class="chat-hint">Read-only: the analyst can explain findings but cannot change the review or its decision.</p>
    </div>
  </div>`;

  const tabEvidence = `
  <div class="chips">${Object.keys(d.artifacts || {}).map(n => `<button class="chip" data-artifact="${esc(n)}">↓ ${esc(n)}</button>`).join('')}
  <button class="chip" id="audit-btn">View audit trail</button></div>
  <pre id="audit-data" hidden></pre>`;

  const panels = {overview: tabOverview, findings: tabFindings, scanners: tabScanners,
                  coverage: tabCoverage, analyst: tabAnalyst, evidence: tabEvidence};

  el.innerHTML = `
  <div class="detail-top">
    <div><p class="eyebrow">Review detail</p>
      <h2>${badge(r.status)}&nbsp;&nbsp;${esc(r.request.repository)}</h2>
      <div class="review-id">${esc(r.review_id)}</div>
    </div>
    <div class="detail-actions">
      <button class="btn btn-ghost btn-sm" id="copy-link">Copy link</button>
      <button class="btn btn-ghost btn-sm" id="copy-curl">Copy curl</button>
    </div>
  </div>
  <nav class="tabs" role="tablist">
    ${tabs.map(([key, label]) => `<button class="tab${key === activeTab ? ' on' : ''}" role="tab" data-tab="${key}">${label}</button>`).join('')}
  </nav>
  <div class="tab-panels">
    ${tabs.map(([key]) => `<section class="tabpanel" data-panel="${key}"${key === activeTab ? '' : ' hidden'}>${panels[key]}</section>`).join('')}
  </div>`;

  if(!keepScroll) el.scrollIntoView({behavior:'smooth', block:'start'});
  if(activeTab === 'analyst'){ loadAnalysis(id); loadChat(id); }
  filterFindings('ALL');
}

/* ---------- tab switching ---------- */
function switchTab(tab){
  if(!selected) return;
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
  document.querySelectorAll('.tabpanel').forEach(p => { p.hidden = p.dataset.panel !== tab; });
  history.replaceState(null, '', '#review-' + selected + (tab === 'overview' ? '' : '/' + tab));
  if(tab === 'analyst'){ loadAnalysis(selected); loadChat(selected); }
  if(tab === 'findings'){ filterFindings('ALL'); }
}
/* ---------- AI analysis (auto-generated server-side) ---------- */
async function loadAnalysis(id, attempt = 0){
  const box = $('ai-body');
  if(!box || selected !== id) return;
  try{
    const a = await api(`/api/v1/reviews/${encodeURIComponent(id)}/analysis`);
    if(selected !== id) return;
    box.innerHTML = `
      <p class="ai-meta">Model <strong>${esc(a.model)}</strong> · generated ${esc(fmtDate(a.generated_at))} · took ${esc(a.duration_seconds)}s</p>
      <div class="md-body">${md(a.brief)}</div>
      <p class="ai-disclaimer">${esc(a.disclaimer)}</p>`;
  }catch(e){
    // Not ready yet (auto-generation runs after terminal state) — retry a few times
    if(attempt < 8 && selected === id){
      box.innerHTML = `<div class="spinner">Analysis generating…</div>`;
      analysisTimer = setTimeout(() => loadAnalysis(id, attempt + 1), 4000);
    }else if(selected === id){
      box.innerHTML = `<p class="muted">AI brief unavailable for this review.</p>`;
    }
  }
}

/* ---------- chat ---------- */
function renderChat(messages){
  const log = $('chat-log');
  if(!messages.length){
    log.innerHTML = `<div class="chat-empty">Ask anything about this review&rsquo;s findings — e.g. &ldquo;Which finding should I fix first?&rdquo;</div>`;
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
    if(selected === id) renderChat(d.messages || []);
  }catch(e){ /* chat unavailable — leave placeholder */ }
}
async function sendChat(message){
  const log = $('chat-log'), input = $('chat-input'), btn = $('chat-send');
  const history = [];
  log.querySelectorAll('.msg').forEach(el => {
    const isUser = el.classList.contains('user');
    const text = el.querySelector('.md-body')?.textContent || el.childNodes[0]?.textContent || '';
    history.push({role: isUser ? 'user' : 'assistant', content: text.trim().slice(0, 2000)});
  });
  const typing = document.createElement('div');
  typing.className = 'msg bot typing'; typing.textContent = 'Analyst is thinking…';
  // remove empty placeholder
  const empty = log.querySelector('.chat-empty'); if(empty) empty.remove();
  const um = document.createElement('div'); um.className = 'msg user'; um.textContent = message;
  log.append(um, typing); log.scrollTop = log.scrollHeight;
  input.value = ''; input.disabled = true; btn.disabled = true;
  try{
    const r = await fetch(`/api/v1/reviews/${encodeURIComponent(selected)}/chat`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({message, history}),
    });
    if(!r.ok) throw new Error(`Chat failed (${r.status})`);
    await r.json();
    await loadChat(selected); // re-render from server (canonical history)
  }catch(e){
    typing.textContent = 'Chat unavailable: ' + e.message;
    typing.classList.remove('typing');
  }finally{
    input.disabled = false; btn.disabled = false; input.focus();
  }
}

/* ---------- findings filter ---------- */
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
  if(c) c.textContent = total ? `showing ${vis}/${total}` : '';
}

/* ---------- events ---------- */
$('refresh').addEventListener('click', refresh);
$('nav-reviews').addEventListener('click', () => { selected = null; $('detail').hidden = true; refresh(); });
document.addEventListener('click', async e => {
  const tab = e.target.closest?.('.tab');
  if(tab && selected){ switchTab(tab.dataset.tab); return; }
  const fbtn = e.target.closest?.('.fbtn');
  if(fbtn && selected){ filterFindings(fbtn.dataset.sev); return; }
  if(e.target?.id === 'copy-link'){
    const url = location.origin + location.pathname + '#review-' + selected;
    try{ await navigator.clipboard.writeText(url); e.target.textContent = 'Copied!'; }
    catch{ prompt('Copy review link:', url); return; }
    setTimeout(() => e.target.textContent = 'Copy link', 1500); return;
  }
  if(e.target?.id === 'copy-curl'){
    const cmd = `curl -sk "${location.origin}/api/v1/reviews/${selected}" | python3 -m json.tool`;
    try{ await navigator.clipboard.writeText(cmd); e.target.textContent = 'Copied!'; }
    catch{ prompt('Copy curl:', cmd); return; }
    setTimeout(() => e.target.textContent = 'Copy curl', 1500); return;
  }
  try{
    const review = e.target.closest?.('[data-review]');
    if(review){ await details(review.dataset.review); return; }
    const artifact = e.target.closest?.('[data-artifact]');
    if(artifact){
      const data = await api(`/api/v1/reviews/${selected}/artifacts/${encodeURIComponent(artifact.dataset.artifact)}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}));
      const a = document.createElement('a'); a.href = url; a.download = artifact.dataset.artifact; a.click();
      URL.revokeObjectURL(url); return;
    }
    if(e.target?.id === 'audit-btn'){
      const d = await api(`/api/v1/reviews/${selected}/audit`);
      const pre = $('audit-data'); pre.hidden = false; pre.textContent = JSON.stringify(d, null, 2);
      pre.scrollIntoView({behavior:'smooth', block:'nearest'}); return;
    }
  }catch(err){ showError(err.message); }
});

document.addEventListener('submit', e => {
  if(e.target?.id === 'chat-form'){
    e.preventDefault();
    const v = $('chat-input').value.trim();
    if(v && selected) sendChat(v);
  }
});

// deep link: #review-<id>[/<tab>]
function parseHash(){
  const m = location.hash.match(/^#review-([0-9a-f]+)(?:\/([a-z]+))?/);
  return m ? {id: m[1], tab: m[2] || 'overview'} : null;
}
const _dl = parseHash();
if(_dl) details(_dl.id, false, _dl.tab).catch(() => {});

setInterval(refresh, 15000);
