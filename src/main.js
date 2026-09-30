import './style.css';
import { parseXml } from './imports.js';
import { parseFilters, convertFilters } from './filters.js';
import { buildFolders } from './mailbox.js';
import { downloadText, gapsMarkdown, sendersCsv, foldersJson, migrationReadme } from './exports.js';
import { TARGETS, getTarget, defaultFolders, buildRecipe } from './targets.js';
import { t } from './i18n.js';

const state = { step: 0, lang: 'zh', targetId: 'generic', filters: [], labels: new Set(), senders: new Map(), seen: new Set(), sources: [], warnings: [], overrides: new Map(), special: {}, rows: [], errors: [], conversion: { sieve: '', results: [], gaps: [] }, busy: false, progress: null, status: '', reviewFilter: 'all' };
const imported = new Set();
const app = document.querySelector('#app');
let controller;
const tr = key => t(state.lang, key);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const target = () => getTarget(state.targetId);
const senders = () => [...state.senders].map(([email,count]) => ({email,count})).sort((a,b) => b.count-a.count || a.email.localeCompare(b.email));
const normalize = value => value.normalize('NFC').trim().toLowerCase();

function recompute() {
  const defaults = defaultFolders(target());
  const suggestions = buildFolders([...state.labels], { reserved: defaults.reserved });
  for (const rule of state.filters) if (rule.actions.label && !suggestions.some(row => row.label === rule.actions.label)) suggestions.push({label:rule.actions.label,folder:'',notes:['Rule destination needs an explicit user-folder mapping.']});
  state.rows = suggestions.map(row => ({ ...row, folder: state.overrides.get(row.label) ?? row.folder ?? '' }));
  state.errors = [];
  const used = new Map();
  for (const [index,row] of state.rows.entries()) {
    if (!row.folder.trim() || /[\x00-\x1f\x7f-\x9f]/.test(row.folder)) state.errors.push({ index, key:'invalidFolder' });
    const key = normalize(row.folder);
    if (defaults.reserved.some(name => normalize(name) === key)) state.errors.push({index,key:'reservedFolder'});
    if (used.has(key)) { state.errors.push({index,key:'collision'}, {index:used.get(key),key:'collision'}); }
    used.set(key,index);
  }
  const archive = state.special.archiveFolder ?? defaults.archiveFolder;
  const trash = state.special.trashFolder ?? defaults.trashFolder;
  for (const [name,value] of [['archiveFolder',archive],['trashFolder',trash]]) if (!value.trim() || /[\x00-\x1f\x7f-\x9f]/.test(value)) state.errors.push({index:name,key:'invalidFolder'});
  const folderMap = Object.fromEntries(state.rows.map(row => [row.label,row.folder]));
  state.conversion = convertFilters(state.filters,{target:state.targetId,folderMap,archiveFolder:archive,trashFolder:trash,includeApproximate:false});
}
function runWorker(operation,data,signal,onProgress=()=>{}) {
  return new Promise((resolve,reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const worker = new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
    const finish = (error,result) => { signal.removeEventListener('abort',abort); worker.terminate(); error ? reject(error) : resolve(result); };
    const abort = () => finish(signal.reason || new DOMException('Cancelled','AbortError'));
    signal.addEventListener('abort',abort,{once:true});
    worker.onmessage = ({data:message}) => message.progress ? onProgress(message.progress) : finish(message.error ? new Error(message.error) : null,message.result);
    worker.onerror = event => finish(new Error(event.message));
    worker.postMessage({operation,...data});
  });
}
function render(focus=false) {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'en';
  document.title = `GmailChanger · ${tr('steps')[state.step]}`;
  app.innerHTML = `<main class="shell"><header class="hero"><div><div class="brand">GMAILCHANGER</div><h1>${tr('title')}</h1><p>${tr('subtitle')}</p></div><div><span class="privacy">${tr('privacy')}</span><label class="language">${tr('language')}<select id="language" ${state.busy?'disabled':''}><option value="zh" ${state.lang==='zh'?'selected':''}>简体中文</option><option value="en" ${state.lang==='en'?'selected':''}>English</option></select></label></div></header>
  <nav aria-label="${tr('steps')[state.step]}"><ol class="steps">${tr('steps').map((label,i)=>`<li><button data-step="${i}" ${i===state.step?'aria-current="step"':''} ${state.busy || (i>1 && !state.sources.length)?'disabled':''}><span>${i+1}</span>${label}</button></li>`).join('')}</ol></nav>
  <div id="status" role="status" aria-live="polite" aria-atomic="true">${esc(state.status)}</div>
  <section class="card" aria-busy="${state.busy}">${[targetPanel,importPanel,reviewPanel,mappingPanel,exportPanel][state.step]()}</section>
  <div class="actions navigation"><button data-action="back" class="secondary" ${state.step===0 || state.busy?'disabled':''}>${tr('back')}</button><button data-action="next" ${state.step===4 || state.busy?'disabled':''}>${tr('next')}</button></div>
  <footer class="foot">${tr('footer')}</footer></main>`;
  if (focus) app.querySelector('#step-title')?.focus();
}
const heading = key => `<h2 id="step-title" tabindex="-1">${tr(key)}</h2>`;
function targetPanel() {
  return `${heading('target')}<p>${tr('targetHelp')}</p><fieldset><legend>${tr('target')}</legend><div class="target-grid">${TARGETS.map(item=>`<label class="target-card"><input type="radio" name="target" value="${item.id}" ${item.id===state.targetId?'checked':''}><span><strong>${esc(item.id==='generic' && state.lang==='en'?'Generic Sieve':item.id==='unknown' && state.lang==='en'?'Not decided':item.label)}</strong><small>${item.kind==='recipe'?tr('manual'):tr('unverified')}</small></span></label>`).join('')}</div></fieldset><details><summary>${tr('notes')}</summary><ul>${target().notes.map(note=>`<li>${esc(note)}</li>`).join('')}</ul></details>${target().docsUrl?`<a href="${esc(target().docsUrl)}" target="_blank" rel="noopener noreferrer">${tr('docs')}</a>`:''}`;
}
function importPanel() {
  return `${heading('importTitle')}<p>${tr('importHelp')}</p><div id="drop" class="drop"><div class="actions"><button data-action="files" ${state.busy?'disabled':''}>${tr('files')}</button><button data-action="folder" ${state.busy?'disabled':''}>${tr('folder')}</button></div><input id="files" type="file" accept=".xml,.mbox,.zip" multiple hidden><input id="folder" type="file" webkitdirectory multiple hidden><p class="small">${tr('limits')}</p></div>${state.busy?`<p>${tr('busy')}</p><progress aria-label="${tr('progress')}" max="100" ${state.progress===null?'':`value="${state.progress}"`}></progress><span id="progress-text"></span><button data-action="cancel">${tr('cancel')}</button>`:`<button class="secondary" data-action="reset">${tr('reset')}</button>`}<h3>${tr('sources')}</h3>${state.sources.length?`<ul>${state.sources.map(source=>`<li>${esc(source.name)} — ${(source.size/1048576).toFixed(2)} MiB · ${source.count} ${tr('records')}</li>`).join('')}</ul>`:`<p>${tr('noData')}</p>`}${warningsPanel()}`;
}
function warningsPanel() { return state.warnings.length?`<details open><summary>${tr('warnings')} (${state.warnings.length})</summary><ul>${state.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>`:''; }
function reviewPanel() {
  const results = state.conversion.results.filter(row=>state.reviewFilter==='all'||row.status===state.reviewFilter);
  return `${heading('reviewTitle')}<p>${tr('reviewHelp')}</p><p class="small">${tr('technical')}</p><label>${tr('filter')}<select id="review-filter">${['all','converted','approximate','skipped'].map(key=>`<option value="${key}" ${state.reviewFilter===key?'selected':''}>${tr(key)}</option>`).join('')}</select></label><div class="table-wrap"><table><caption>${tr('rules')} (${state.filters.length})</caption><thead><tr><th scope="col">${tr('rule')}</th><th scope="col">${tr('status')}</th><th scope="col">${tr('details')}</th></tr></thead><tbody>${results.map(row=>`<tr><td>${esc(row.id)}</td><td><span class="badge ${row.status}">${tr(row.status)}</span></td><td><details><summary>${tr('details')}</summary><pre>${esc(row.description)}</pre><ul>${row.issues.map(issue=>`<li>${esc(issue)}</li>`).join('')}</ul></details></td></tr>`).join('')}</tbody></table></div>${!state.filters.length?`<p>${tr('noneRules')}</p>`:''}<h3>${tr('senders')}</h3><p class="small">${tr('senderHelp')}</p>${senders().length?`<div class="table-wrap"><table><thead><tr><th>${tr('email')}</th><th>${tr('count')}</th></tr></thead><tbody>${senders().map(row=>`<tr><td>${esc(row.email)}</td><td>${row.count}</td></tr>`).join('')}</tbody></table></div>`:`<p>${tr('noneSenders')}</p>`}${warningsPanel()}`;
}
function mappingPanel() {
  const defaults = defaultFolders(target());
  const field = (id,value,label) => `<label>${esc(label)}<input data-map="${id}" value="${esc(value)}" aria-invalid="${state.errors.some(error=>String(error.index)===id)}" aria-describedby="map-errors"></label>`;
  return `${heading('mappingTitle')}<p>${tr('mappingHelp')}</p><div id="map-errors" ${state.errors.length?'role="alert"':''}>${state.errors.length?`<ul>${[...new Set(state.errors.map(e=>tr(e.key)))].map(error=>`<li>${error}</li>`).join('')}</ul>`:''}</div><div class="grid">${field('archiveFolder',state.special.archiveFolder??defaults.archiveFolder,tr('archive'))}${field('trashFolder',state.special.trashFolder??defaults.trashFolder,tr('trash'))}</div>${state.rows.length?`<div class="table-wrap"><table><thead><tr><th>${tr('original')}</th><th>${tr('destination')}</th><th>${tr('notesColumn')}</th></tr></thead><tbody>${state.rows.map((row,i)=>`<tr><td>${esc(row.label)}</td><td>${field(String(i),row.folder,`${tr('destination')}: ${row.label}`)}</td><td>${row.notes.map(esc).join('; ')}</td></tr>`).join('')}</tbody></table></div>`:`<p>${tr('emptyMapping')}</p>`}`;
}
function exportPanel() {
  const recipe = target().kind === 'recipe';
  const active = recipe?0:state.conversion.results.filter(row=>row.status==='converted').length;
  const blocked = state.errors.length || state.busy;
  const button = (type,label,enabled=true) => `<button data-export="${type}" ${blocked||!enabled?'disabled':''}>${tr(label)}</button>`;
  return `${heading('exportTitle')}<p>${tr('exportHelp')}</p><p>${tr('active')}: <strong>${active}</strong> · ${tr('disabled')}: <strong>${state.filters.length-active}</strong></p>${state.errors.length?`<p role="alert">${tr('mappingBlocked')}</p>`:''}${recipe?`<p>${tr('recipeHelp')}</p>`:!active?`<p class="notice">${tr('noActive')}</p>`:''}<div class="actions">${recipe?button('recipe','recipe',!!state.filters.length):button('sieve','sieve',!!state.filters.length)}${button('folders','folderDownload',!!state.rows.length)}${button('senders','senderDownload',!!senders().length)}${button('gaps','gaps',!!state.sources.length)}${button('guide','guide')}${!recipe?`<button data-action="copy" ${blocked||!state.filters.length?'disabled':''}>${tr('copy')}</button>`:''}</div>${warningsPanel()}`;
}
function navigate(step) {
  if (state.busy || step<0 || step>4) return;
  if (step>1 && !state.sources.length) { state.status=tr('noData'); render(); return; }
  if (step===4 && state.errors.length) { state.status=tr('mappingBlocked'); state.step=3; render(true); return; }
  state.step=step; state.status=''; render(true);
}
app.addEventListener('click',async event=>{
  const button=event.target.closest('button'); if (!button || button.disabled) return;
  if (button.dataset.step!==undefined) { navigate(Number(button.dataset.step)); return; }
  if (button.dataset.export) { exportFile(button.dataset.export); return; }
  switch(button.dataset.action) {
    case 'back': navigate(state.step-1); break;
    case 'next': navigate(state.step+1); break;
    case 'files': case 'folder': app.querySelector(`#${button.dataset.action}`).click(); break;
    case 'cancel': controller?.abort(); break;
    case 'reset': state.filters=[];state.labels.clear();state.senders.clear();state.seen.clear();state.sources=[];state.warnings=[];state.overrides.clear();state.special={};imported.clear();state.status='';recompute();render();break;
    case 'copy': try { await navigator.clipboard.writeText(state.conversion.sieve);state.status=tr('copied'); } catch {state.status=tr('copyFailed');} app.querySelector('#status').textContent=state.status;break;
  }
});
app.addEventListener('change',event=>{
  const input=event.target;
  if (input.id==='language') {state.lang=input.value;render();return;}
  if (input.name==='target') {state.targetId=input.value;recompute();render();return;}
  if (input.id==='files'||input.id==='folder') {void processFiles([...input.files]);return;}
  if (input.id==='review-filter') {state.reviewFilter=input.value;render();app.querySelector('#review-filter').focus();return;}
  if (input.dataset.map!==undefined) {
    const key=input.dataset.map;
    if (key==='archiveFolder'||key==='trashFolder') state.special[key]=input.value;
    else state.overrides.set(state.rows[Number(key)].label,input.value);
    recompute();render();app.querySelector(`[data-map="${key}"]`)?.focus();
  }
});
app.addEventListener('dragover',event=>{if(event.target.closest('#drop'))event.preventDefault();});
app.addEventListener('drop',event=>{if(event.target.closest('#drop')){event.preventDefault();void processFiles([...event.dataTransfer.files]);}});

async function processFiles(files) {
  if (state.busy||!files.length) return;
  const signal=(controller=new AbortController()).signal;
  state.busy=true;state.progress=null;state.status=tr('expanding');render();
  try {
    const expanded=await runWorker('expand',{files:files.map(file=>({file,path:file.webkitRelativePath||file.name}))},signal);
    state.warnings.push(...expanded.warnings);
    for(const [index,entry] of expanded.files.entries()) {
      if(signal.aborted)break;
      const file=entry.blob,name=entry.path.toLowerCase(),signature=`${entry.path}:${entry.size}:${entry.lastModified}`;
      if(imported.has(signature)){state.warnings.push(`${entry.name}: ${tr('duplicate')}`);continue;}
      try {
        let count=0;
        if(name.endsWith('.xml')) {
          if(file.size>10*1048576)throw new Error('XML > 10 MiB');
          const rules=parseFilters(parseXml(await file.text()));
          if(signal.aborted)break;
          for(const rule of rules){if(rule.actions.label)state.labels.add(rule.actions.label);rule.id=`${entry.path} / ${rule.id}`;}
          state.filters.push(...rules);count=rules.length;
        } else if(name.endsWith('.mbox')) {
          const sentHint=/^(sent|sent mail|已发送|已发送邮件|寄件備份|gesendet|envoyés)\.mbox$/i.test(name.split(/[/\\]/).pop());
          const result=await runWorker('analyze',{file,sentHint,seen:[...state.seen]},signal,info=>{
            state.progress=Math.round((index+info.bytesRead/Math.max(1,info.totalBytes))/expanded.files.length*100);
            const progress=app.querySelector('progress');if(progress)progress.value=state.progress;
            const text=app.querySelector('#progress-text');if(text)text.textContent=`${state.progress}% · ${info.messageCount}`;
          });
          if(signal.aborted)break;
          result.labels.forEach(label=>state.labels.add(label));
          for(const sender of result.senders)state.senders.set(sender.email,(state.senders.get(sender.email)||0)+sender.count);
          if(Array.isArray(result.seen))state.seen=new Set(result.seen);
          else state.warnings.push('This analyzer did not return a shared deduplication index; cross-file counts may repeat.');
          state.warnings.push(...result.warnings.map(w=>`${entry.name}: ${w}`));count=result.messageCount;
        }
        imported.add(signature);state.sources.push({name:entry.path,size:entry.size,count});
      }catch(error){if(signal.aborted)break;state.warnings.push(`${entry.name}: ${error.message}`);}
    }
    state.status=signal.aborted?tr('cancelled'):tr('importDone');
  }catch(error){state.status=signal.aborted?tr('cancelled'):`${tr('failed')}: ${error.message}`;}
  finally{state.busy=false;recompute();render();}
}
function guideText() {
  const files=[{name:target().kind==='recipe'?'migration-recipe.md':'rules.sieve',purpose:tr('rules')},{name:'folders.json',purpose:tr('folders')},{name:'senders.csv',purpose:tr('senders')},{name:'gaps.md',purpose:tr('warnings')}];
  return migrationReadme({target:state.targetId,files,results:state.conversion.results,folders:state.rows,senders:senders(),warnings:state.warnings,...state.special});
}
function exportFile(type) {
  if(state.busy||state.errors.length)return;
  const recipe=target().kind==='recipe';
  if(type==='sieve'&&!recipe)downloadText('rules.sieve',state.conversion.sieve,'application/sieve;charset=utf-8');
  if(type==='folders')downloadText('folders.json',foldersJson(state.rows,{target:state.targetId,...state.special}),'application/json;charset=utf-8');
  if(type==='senders')downloadText('senders.csv',sendersCsv(senders()),'text/csv;charset=utf-8');
  if(type==='gaps')downloadText('gaps.md',gapsMarkdown([...state.conversion.gaps,...state.warnings],state.conversion.results,{target:state.targetId}),'text/markdown;charset=utf-8');
  if(type==='recipe')downloadText('migration-recipe.md',buildRecipe(target(),state.conversion.results),'text/markdown;charset=utf-8');
  if(type==='guide')downloadText('README-migration.md',guideText(),'text/markdown;charset=utf-8');
}
recompute();render();
