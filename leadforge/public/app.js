'use strict';
/* LeadForge SPA */
let curJob = null, curPage = 1, curTotal = 0, selectedIds = new Set(), evtSource = null;
const FIELDS = ['title','metaDescription','headings','mainText','emails','phones','links','socialLinks','tables','lists','images','jsonLd','openGraph'];
let enabledFields = new Set(FIELDS);

function toast(m){const d=document.createElement('div');d.textContent=m;document.getElementById('toasts').appendChild(d);setTimeout(()=>d.remove(),4000);}
async function api(path, opts={}){
  const res = await fetch(path,{headers:{'Content-Type':'application/json'},credentials:'same-origin',...opts});
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||('HTTP '+res.status));
  return data;
}
function go(name){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-'+name)?.classList.add('active');
  document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===name));
  if(name==='dashboard') loadDashboard();
  if(name==='history') loadHistory();
  if(name==='downloads') loadFiles();
  if(name==='integrations') loadCreds();
  if(name==='profile') loadProfile();
  if(name==='help') loadHelp();
  window.location.hash = name;
}
document.querySelectorAll('[data-nav]').forEach(a=>a.onclick=()=>go(a.dataset.nav));
document.getElementById('mobileNav').innerHTML = ['dashboard','new','maps','scraping','history','downloads','integrations','profile','help'].map(n=>`<button class="btn-o" onclick="go('${n}')">${n}</button>`).join('');

async function boot(){
  try{ const me = await api('/api/auth/me'); document.getElementById('loginView').style.display='none';document.getElementById('loginView').classList.remove('hidden');document.getElementById('loginView').classList.add('hidden');
    document.getElementById('appView').classList.remove('hidden');
    document.getElementById('userEmail').textContent = me.user.email;
    document.getElementById('s_fields').innerHTML = FIELDS.map(f=>`<label class="card px-3 py-1"><input type="checkbox" checked onchange="toggleField('${f}',this.checked)"/> ${f}</label>`).join('');
    go(window.location.hash.slice(1) || 'dashboard');
  }catch{ document.getElementById('loginView').style.display='flex';document.getElementById('loginView').classList.remove('hidden'); }
}
function toggleField(f,on){ on?enabledFields.add(f):enabledFields.delete(f); }
async function doLogin(){ try{ await api('/api/auth/login',{method:'POST',body:JSON.stringify({email:loginEmail.value,password:loginPass.value})}); location.reload(); }catch(e){ const el=document.getElementById('loginErr'); el.textContent=e.message; el.classList.remove('hidden'); } }
async function doRegister(){ try{ await api('/api/auth/register',{method:'POST',body:JSON.stringify({email:loginEmail.value,password:loginPass.value})}); location.reload(); }catch(e){ const el=document.getElementById('loginErr'); el.textContent=e.message; el.classList.remove('hidden'); } }
async function doLogout(){ await api('/api/auth/logout',{method:'POST'}); location.reload(); }

async function loadDashboard(){
  try{
    const d = await api('/api/stats');
    const s = d.stats;
    document.getElementById('statCards').innerHTML = [
      ['Total leads',s.totalLeads],['Total jobs',s.totalJobs],['Completed',s.completed],['Failed',s.failed],['Today',s.today]
    ].map(([k,v])=>`<div class="card p-4"><div class="text-xs font-bold text-slate-400 uppercase">${k}</div><div class="text-2xl font-extrabold">${v}</div></div>`).join('');
    document.getElementById('recentJobs').innerHTML = d.recentJobs.length? d.recentJobs.map(j=>jobRow(j)).join('') : `<div class="empty">No jobs yet. Start your first collection.</div>`;
    document.getElementById('recentFiles').innerHTML = d.recentFiles.length? d.recentFiles.map(f=>`<div class="flex justify-between text-sm py-1"><span class="truncate">${f.filename}</span><a class="font-bold" href="/api/files/${f.id}/download">Download</a></div>`).join('') : `<div class="empty">No Excel files yet.</div>`;
    document.getElementById('apiStatus').innerHTML = d.providers.map(p=>`<div class="flex justify-between py-1"><span class="font-bold">${p.provider}</span><span>${p.configured?(p.enabled?'✅ configured':'⏸ disabled'):'⚪ not set'}</span></div>`).join('');
    const g = d.providers.find(p=>p.provider==='google-places');
    document.getElementById('mapsProvNote').innerHTML = g?.configured? `<span class="badge bg-green-100 text-green-800">Google Places ready</span>` : `<span class="badge bg-amber-100 text-amber-800">Google key not set — configure in API & Integrations</span>`;
  }catch(e){ toast(e.message); }
}
function jobRow(j){
  const pct = j.progress?.requested? Math.min(100,Math.round(100*(j.progress.processed||0)/j.progress.requested)) : (j.status==='completed'?100:0);
  return `<div class="border rounded-xl p-3 mb-2 cursor-pointer hover:border-slate-900" onclick="openJob('${j.id}')"><div class="flex justify-between text-sm"><b class="truncate">${j.title}</b><span class="badge ${j.status==='completed'?'bg-green-100 text-green-800':j.status==='failed'?'bg-red-100 text-red-700':'bg-slate-100'}">${j.status}</span></div><div class="progress mt-2"><div style="width:${pct}%"></div></div><div class="text-xs text-slate-500 mt-1">${j.type} · ${j.provider||''} · unique ${j.progress?.unique||0}/${j.progress?.requested||0}</div></div>`;
}
async function startMaps(){
  const body = { keyword:m_keyword.value, location:m_location.value, businessType:m_businessType.value, leadCount:Number(m_leadCount.value), radiusMeters:m_radius.value?Number(m_radius.value):null, language:m_lang.value, minRating:m_minRating.value?Number(m_minRating.value):null, category:m_category.value, onlyWebsite:m_onlyWebsite.checked, onlyPhone:m_onlyPhone.checked, dedupe:m_dedupe.checked, includeStatus:m_includeStatus.checked, budgetLimit:m_budget.value?Number(m_budget.value):null, provider:m_provider.value };
  try{ const r = await api('/api/jobs/maps',{method:'POST',body:JSON.stringify(body)}); if(r.confirmSpend && !confirm(r.confirmSpend+' Start anyway?')) return; toast('Collection started'); openJob(r.job.id); }catch(e){ toast(e.message); }
}
async function startScrape(){
  const body = { startUrl:s_url.value.trim(), mode:s_mode.value, maxPages:Number(s_maxPages.value), maxDepth:Number(s_maxDepth.value), allowPaths:s_allow.value.split(',').map(s=>s.trim()).filter(Boolean), denyPatterns:s_deny.value.split(',').map(s=>s.trim()).filter(Boolean), fields:[...enabledFields], customFields:s_custom.value.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{const i=l.indexOf(':');return{name:l.slice(0,i>0?i:l.length).trim(),instruction:l.slice(i+1).trim()};}).filter(c=>c.name), provider:s_provider.value, concurrency:Number(s_conc.value), urls:s_urls.value.split('\n').map(s=>s.trim()).filter(Boolean) };
  try{ const r = await api('/api/jobs/scrape',{method:'POST',body:JSON.stringify(body)}); toast('Scraping started'); openJob(r.job.id); }catch(e){ toast(e.message); }
}
async function openJob(id){
  curJob=id; curPage=1; selectedIds=new Set(); go('job');
  if(evtSource) evtSource.close();
  evtSource = new EventSource('/api/jobs/'+id+'/events');
  evtSource.onmessage = ev=>{ const d=JSON.parse(ev.data); renderJobProgress(d); if(['completed','partial','failed','cancelled'].includes(d.status)) loadRecords(1); };
  await refreshJob();
}
async function refreshJob(){
  const d = await api('/api/jobs/'+curJob);
  document.getElementById('jobTitle').textContent = d.job.title;
  renderJobProgress(d.job);
  document.getElementById('jobLogs').textContent = d.logs.map(l=>`[${l.at}] ${l.level}: ${l.message}`).join('\n')||'No logs yet';
  await loadRecords(1);
}
function renderJobProgress(j){
  const p=j.progress||{}; const pct=p.requested?Math.min(100,Math.round(100*(p.processed||0)/p.requested)):0;
  document.getElementById('jobBar').style.width=pct+'%';
  document.getElementById('jobStats').innerHTML=`Status <b>${j.status}</b> · requested ${p.requested||0} · discovered ${p.discovered||0} · processed ${p.processed||0} · unique <b>${p.unique||0}</b> · dupes ${p.duplicates||0} · failed ${p.failed||0}${j.error?`<br/><span class="text-amber-700">Note: ${j.error}</span>`:''}`;
  document.getElementById('jobDownloadBtn').style.display=j.fileId?'':'none';
}
async function loadRecords(page){
  curPage=Math.max(1,page); const q=document.getElementById('recSearch').value;
  const d=await api(`/api/jobs/${curJob}/records?page=${curPage}&pageSize=20&q=${encodeURIComponent(q)}`);
  curTotal=d.total; document.getElementById('recPage').textContent=`Page ${d.page} of ${Math.max(1,Math.ceil(d.total/d.pageSize))} · ${d.total} records`;
  const keys=[...new Set(d.items.flatMap(r=>Object.keys(r).filter(k=>k!=='id'&&k!=='jobId')))].slice(0,12);
  document.getElementById('recHead').innerHTML='<th>✓</th>'+keys.map(k=>`<th>${k}</th>`).join('');
  document.getElementById('recBody').innerHTML=d.items.map(r=>`<tr>${`<td><input type="checkbox" ${selectedIds.has(r.id)?'checked':''} onchange="toggleSel('${r.id}',this.checked)"/></td>`}${keys.map(k=>`<td title="${String(r[k]??'').slice(0,300)}">${r[k]==null||r[k]==='' ?'<span class="text-slate-300">—</span>':String(Array.isArray(r[k])?r[k].join(', '):typeof r[k]==='object'?JSON.stringify(r[k]).slice(0,120):r[k]).slice(0,120)}</td>`).join('')}</tr>`).join('')||`<tr><td class="p-6 text-slate-400">No records yet — job may still be running.</td></tr>`;
}
function toggleSel(id,on){on?selectedIds.add(id):selectedIds.delete(id);}
async function cancelJob(){ await api(`/api/jobs/${curJob}/cancel`,{method:'POST'}); toast('Cancel requested'); refreshJob(); }
async function retryJob(){ try{await api(`/api/jobs/${curJob}/retry`,{method:'POST'}); toast('Job re-queued'); openJob(curJob);}catch(e){toast(e.message);} }
async function downloadJobFile(){ const j=await api('/api/jobs/'+curJob); if(!j.job.fileId) return toast('File not ready yet'); location.href='/api/files/'+j.job.fileId+'/download'; }
async function exportSelected(){ if(!selectedIds.size) return toast('Select rows first'); const res=await fetch(`/api/jobs/${curJob}/export-selected`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[...selectedIds]})}); if(!res.ok) return toast('Export failed'); const blob=await res.blob(); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='selected.xlsx'; a.click(); }
async function loadHistory(){ const d=await api('/api/jobs'); document.getElementById('historyList').innerHTML=d.jobs.length?d.jobs.map(j=>`<div class="card p-4 flex items-center gap-3 flex-wrap"><div class="flex-1 min-w-[200px] cursor-pointer" onclick="openJob('${j.id}')"><b>${j.title}</b><div class="text-xs text-slate-500">${j.type} · ${j.provider||''} · ${new Date(j.createdAt).toLocaleString()} · unique ${j.progress?.unique||0}/${j.progress?.requested||0}</div></div><span class="badge bg-slate-100">${j.status}</span><button class="btn-o" onclick="openJob('${j.id}')">Open</button>${j.fileId?`<a class="btn-o" href="/api/files/${j.fileId}/download">Excel</a>`:''}<button class="btn-o" onclick="delJob('${j.id}')">Delete</button></div>`).join(''):`<div class="empty">No jobs yet.</div>`; }
async function delJob(id){ if(!confirm('Delete job and its data?'))return; await api('/api/jobs/'+id,{method:'DELETE'}); loadHistory(); }
async function loadFiles(){ const d=await api('/api/files'); document.getElementById('filesList').innerHTML=d.files.length?d.files.map(f=>`<div class="card p-4 flex items-center gap-3"><div class="flex-1"><b>${f.filename}</b><div class="text-xs text-slate-500">${(f.size/1024).toFixed(1)} KB · ${(f.sheets||[]).join(', ')} · ${new Date(f.createdAt).toLocaleString()}</div></div><a class="btn-p" href="/api/files/${f.id}/download">Download</a><button class="btn-o" onclick="delFile('${f.id}')">Delete</button></div>`).join(''):`<div class="empty">No exports yet.</div>`; }
async function delFile(id){ if(!confirm('Delete export?'))return; await api('/api/files/'+id,{method:'DELETE'}); loadFiles(); }
const PROVIDERS=[{id:'google-places',name:'Google Maps Platform',hint:'Required for Maps leads. Places API (New) + billing. Server-tested.'},{id:'firecrawl',name:'Firecrawl (optional)',hint:'Optional JS-render scraping fallback.'},{id:'apify',name:'Apify (optional)',hint:'Optional actor-based providers.'},{id:'openai',name:'OpenAI (optional)',hint:'Optional AI-assisted extraction. Basic scraping works without it.'}];
async function loadCreds(){ const d=await api('/api/settings/credentials'); document.getElementById('credList').innerHTML=PROVIDERS.map(p=>{const c=d.credentials[p.id];return `<div class="card p-5"><div class="flex justify-between flex-wrap gap-2"><div><b>${p.name}</b><div class="text-xs text-slate-500">${p.hint}</div><div class="text-sm mt-1">${c.configured?`Stored: <code>${c.masked}</code> ${c.enabled?'(enabled)':'(disabled)'}${c.lastTest?` · last test ${c.lastTest}`:''}`:'<span class="text-slate-400">No key saved</span>'}</div></div><span class="badge ${c.configured&&c.enabled?'bg-green-100 text-green-800':'bg-slate-100'}">${c.configured?(c.enabled?'configured':'disabled'):'not set'}</span></div><div class="grid md:grid-cols-[1fr_auto] gap-2 mt-3"><input id="key_${p.id}" type="password" class="inp" placeholder="${c.configured?'Leave empty to keep stored key / enter new to replace':'Enter API key'}"/><div class="flex gap-2"><button class="btn-p" onclick="saveKey('${p.id}')">Save</button><button class="btn-o" onclick="testKey('${p.id}')">Test</button><button class="btn-o" onclick="delKey('${p.id}')">Delete</button></div></div></div>`;}).join(''); }
async function saveKey(p){ const v=document.getElementById('key_'+p).value; await api('/api/settings/credentials/'+p,{method:'PUT',body:JSON.stringify({apiKey:v,enabled:true})}); toast('Saved'); loadCreds(); }
async function testKey(p){ try{ const r=await api('/api/settings/credentials/'+p+'/test',{method:'POST'}); toast('Connected ✓'); }catch(e){ toast('Test failed: '+e.message); } loadCreds(); }
async function delKey(p){ if(!confirm('Delete stored key?'))return; await api('/api/settings/credentials/'+p,{method:'DELETE'}); loadCreds(); }
async function loadProfile(){ const me=await api('/api/auth/me'); const a=await api('/api/audits'); document.getElementById('profileInfo').innerHTML=`<b>${me.user.email}</b> · role ${me.user.role}`; document.getElementById('auditList').innerHTML=a.audits.map(x=>`<div class="border-b py-1">${x.at} — <b>${x.action}</b> ${x.detail||''}</div>`).join('')||'No events'; }
function loadHelp(){ document.getElementById('helpBody').innerHTML=`<b>1. Configure keys:</b> API & Integrations → paste Google Maps key → Save → Test. Cheerio scraping needs no key.<br/><b>2. Maps:</b> enter niche + location + count → Start → watch live progress → Download Excel.<br/><b>3. Scraping:</b> single page / crawl / selected URLs; scope paths keep crawls on-topic; blocked private IPs & metadata endpoints are rejected (SSRF guard).<br/><b>4. Files:</b> every finished job writes a genuine .xlsx (Data + Job Summary + Errors sheets).<br/><b>5. Limits:</b> env MAX_LEADS_PER_JOB (500), MAX_PAGES_PER_JOB (200), concurrency ≤5. Google never returns emails — that column stays blank unless enriched.<br/><b>6. Troubleshooting:</b> 401 Google → enable Places API (New) + billing; no scrape results → site may need JS (use Firecrawl); file missing → check data/exports volume.`; }
boot();
