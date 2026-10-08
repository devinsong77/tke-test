'use strict';
let token = '', selected = null, busy = false;
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const badge = value => `<span class="status ${/^[A-Za-z_]+$/.test(value) ? value : ''}">${escape(value)}</span>`;
const date = ts => new Date(ts * 1000).toLocaleString();
async function api(path) { const response = await fetch(path, {headers:{Authorization:`Bearer ${token}`}}); if(!response.ok) throw new Error(`Request failed (${response.status}). Check access or service health.`); return response.json(); }
async function refresh(){
 if(!token || busy) return; busy=true;
 try{
  const data=await api('/api/v1/reviews'); $('message').textContent=''; $('login').hidden=true; $('workspace').hidden=false;
  $('metrics').innerHTML=[['Total reviews',data.reviews.length],['Passed',data.reviews.filter(x=>x.status==='PASS').length],['Blocked',data.reviews.filter(x=>x.status==='BLOCK').length],['Errors',data.reviews.filter(x=>x.status==='ERROR').length]].map(([label,count])=>`<div class="metric"><span>${label}</span><strong>${count}</strong></div>`).join('');
  $('reviews').innerHTML=data.reviews.map(r=>`<tr><td>${badge(r.status)}</td><td>${escape(r.request.repository)}<small><code>${escape(r.request.commit_sha.slice(0,12))}</code></small></td><td><button class="link" data-review="${escape(r.review_id)}">${escape(r.review_id.slice(0,12))}</button><small>Run ${escape(r.request.ado_run_id)}</small></td><td>${r.result?.duration_seconds != null ? escape(r.result.duration_seconds)+'s':'—'}</td><td>${badge(r.dojo.status||'pending')}</td><td>${escape(date(r.created_at))}</td></tr>`).join('');
  $('empty').hidden=!!data.reviews.length; $('updated').textContent=`Updated ${new Date().toLocaleTimeString()}`;
  if(selected) await details(selected);
 }catch(e){$('message').textContent=e.message;}finally{busy=false;}
}
async function details(id){
 selected=id; const r=await api(`/api/v1/reviews/${encodeURIComponent(id)}`); const d=r.result||{};
 $('detail').hidden=false;
 $('detail').innerHTML=`<div class="section-title"><div><p class="eyebrow">REVIEW DETAIL</p><h2>${badge(r.status)} &nbsp; ${escape(r.request.repository)}</h2></div><code>${escape(r.review_id)}</code></div><div class="reason">${escape((d.reasons||['Review is waiting for a terminal decision.']).join(' · '))}</div><div class="detail-grid"><div><span>Commit / policy</span><code>${escape(r.request.commit_sha)}</code><small>${escape(r.request.policy_version)}</small></div><div><span>Pipeline provenance</span><a href="${escape(r.request.ado_run_url)}" target="_blank" rel="noopener noreferrer">Azure DevOps Run ${escape(r.request.ado_run_id)}</a></div></div><h3>Scanner execution</h3><div class="table-wrap"><table><thead><tr><th>Tool</th><th>Status</th><th>Duration</th><th>Evidence / outcome</th></tr></thead><tbody>${Object.entries(d.scanners||{}).map(([name,s])=>`<tr><td>${escape(name)}<small>${escape(s.image||'')}</small></td><td>${badge(s.status)}</td><td>${escape(s.duration_seconds??'—')}s</td><td>${escape(s.error||`Exit ${JSON.stringify(s.exit_code)}${s.quality_gate?' · Quality Gate '+s.quality_gate:''}`)}</td></tr>`).join('')}</tbody></table></div><h3>Coverage · ${(d.inventory||[]).filter(x=>x.status==='covered').length}/${(d.inventory||[]).length} objects covered</h3><div class="table-wrap"><table><thead><tr><th>Input</th><th>Required scans</th><th>Status</th></tr></thead><tbody>${(d.inventory||[]).map(x=>`<tr><td><code>${escape(x.path)}</code></td><td>${escape(x.required_tools.join(', '))}</td><td>${badge(x.status)}</td></tr>`).join('')}</tbody></table></div><h3>Findings · ${(d.findings||[]).length}</h3>${(d.findings||[]).length?`<div class="table-wrap"><table><thead><tr><th>Severity</th><th>Rule / finding</th><th>Location / remediation</th></tr></thead><tbody>${d.findings.map(f=>`<tr><td>${badge(f.severity)}</td><td>${escape(f.rule)}<small>${escape(f.title)}</small></td><td><code>${escape(f.file)}:${escape(f.line)}</code><small>${escape(f.remediation)}</small></td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No findings recorded. Coverage and scanner health remain part of the decision.</p>'}<h3>DefectDojo</h3><p>${badge(r.dojo.status||'pending')} ${escape(r.dojo.error||'')} ${r.dojo.url?`<a target="_blank" rel="noopener noreferrer" href="${escape(r.dojo.url)}">Open engagement ↗</a>`:''}</p><h3>Evidence artifacts</h3><div class="artifacts">${Object.keys(d.artifacts||{}).map(name=>`<button data-artifact="${escape(name)}">↓ ${escape(name)}</button>`).join('')}<button id="audit">View audit trail</button></div><pre id="audit-data" hidden></pre>`;
}
$('login-form').addEventListener('submit',e=>{e.preventDefault();token=$('token').value.trim();$('token').value='';refresh();});
$('refresh').addEventListener('click',refresh);
$('overview').addEventListener('click',()=>{selected=null;$('detail').hidden=true;refresh();});
document.addEventListener('click',async e=>{try{
 const review=e.target.closest('[data-review]'); if(review){await details(review.dataset.review);$('detail').scrollIntoView({behavior:'smooth'});}
 const artifact=e.target.closest('[data-artifact]'); if(artifact){const data=await api(`/api/v1/reviews/${selected}/artifacts/${encodeURIComponent(artifact.dataset.artifact)}`); const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})); const a=document.createElement('a');a.href=url;a.download=artifact.dataset.artifact;a.click();URL.revokeObjectURL(url);}
 if(e.target.id==='audit'){const d=await api(`/api/v1/reviews/${selected}/audit`);$('audit-data').hidden=false;$('audit-data').textContent=JSON.stringify(d,null,2);}
}catch(error){$('message').textContent=error.message;}});
setInterval(refresh,15000);
