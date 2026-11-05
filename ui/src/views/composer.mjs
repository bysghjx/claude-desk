// The input box: text, references, images, model / effort / permission pickers,
// slash commands and @ mentions. Sending goes through actions.
import { $, escape } from '../core/dom.mjs';
import { guarded } from '../core/ui.mjs';

export const levels=['low','medium','high','xhigh','max'];
export const levelNames=['低','中','高','很高','最高'];
export const descriptions=['快速响应，适合简单问题和小改动','兼顾响应速度与推理深度','深入推理，适合复杂代码任务','投入更多推理，适合困难问题','使用最高思考强度，可能等待更久'];
export const modes=[
  {id:'default',name:'手动批准',description:'读取项目内容；修改文件、执行命令等操作按规则请求批准',icon:'<path d="M8 2 3 4v4c0 3 5 6 5 6s5-3 5-6V4Z"/>',tag:'默认'},
  {id:'acceptEdits',name:'允许编辑',description:'自动允许项目内编辑和常见文件操作，其他操作仍按规则审批',icon:'<path d="m10.5 2.5 3 3M3 10l7.5-7.5a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L6 13l-4 1Z"/>'},
  {id:'plan',name:'仅做计划',description:'只读探索与规划，不修改项目源文件',icon:'<rect x="3" y="2.5" width="10" height="12" rx="1.5"/><path d="M6 6h4M6 9h4M6 12h2"/>'},
  {id:'auto',name:'自动审批',description:'由 CLI 分类器审核操作；需要 CLI、模型和服务商支持',icon:'<path d="M8 1.5 2.5 4v4c0 3 5.5 6.5 5.5 6.5s5.5-3.5 5.5-6.5V4Z"/><path d="m5.5 8 1.8 1.8 3.3-3.6"/>',tag:'需支持'},
  {id:'dontAsk',name:'未授权即拒绝',description:'已允许的操作继续执行，其他需要批准的操作直接拒绝',icon:'<circle cx="8" cy="8" r="5.5"/><path d="m4.1 11.9 7.8-7.8"/>'},
  {id:'bypassPermissions',name:'完全访问',description:'跳过常规权限提示，可直接修改文件和运行命令；适合隔离环境',icon:'<path d="m9.5 1.5-7 8H8l-1.5 5 7-8H8Z"/>',tag:'高级',advanced:true}
];

export function modeListHtml(current){
  return modes.map(mode=>`<button type="button" class="mode-choice ${mode.id===current?'selected':''} ${mode.advanced?'advanced':''}" data-mode="${mode.id}" role="option" aria-selected="${mode.id===current}"><svg class="mode-choice-icon" viewBox="0 0 16 16" aria-hidden="true">${mode.icon}</svg><span class="mode-choice-copy"><strong>${mode.name}${mode.tag?`<small class="mode-tag">${mode.tag}</small>`:''}</strong><span>${mode.description}</span></span>${mode.id===current?'<span class="mode-choice-check">✓</span>':''}</button>`).join('');
}

export function createComposer({ store, api, toast, actions }) {
  let references=[],images=[],saveTimer,ready=false,menuItems=[],menuIndex=0,menuToken=null,menuGeneration=0,historyIndex=-1,historyDraft=null,filesCache=null,modelsLoading=false;
  const commands=[
    {name:'new',description:'返回主页，选择项目开始新任务',action:()=>actions().showHome()},
    {name:'model',description:'选择本次任务使用的 Claude 模型',action:()=>openPicker('model')},
    {name:'effort',description:'用滑块调整思考强度',action:()=>openPicker('effort')},
    {name:'plan',description:'切换到仅做计划模式',action:()=>{$('#mode').value='plan';optionChanged();toast('已切换为仅做计划');}},
    {name:'review',description:'检查项目中的问题，先不修改文件',prompt:'请审查当前项目，按严重程度列出具体问题、位置和改进建议。先不要修改文件。'},
    {name:'stop',description:'停止当前会话正在执行的任务',action:()=>actions().stop()},
    {name:'help',description:'查看输入框快捷用法',action:()=>toast('/ 选择命令 · @ 引用文件 · @@ 引用会话 · ↑ ↓ 召回历史消息 · Shift+Enter 换行')}
  ];
  function modelName(id) {
    const m=/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(.*)$/.exec(id);
    if(!m)return id;
    return `Claude ${m[1][0].toUpperCase()+m[1].slice(1)} ${m[2]}${m[3]?'.'+m[3]:''}${m[4]?' '+m[4].replace(/^-/, ''):''}`;
  }
  function options(){return{model:$('#model').value,effort:$('#effort').value,mode:$('#mode').value};}
  function capture(){return{text:$('#prompt').value,references:structuredClone(references),images:images.slice(),options:options()};}
  function payload(){store.drafts.set(store.selected||'new',capture());return{selectedThread:store.selected,projectId:store.projectId,drafts:Object.fromEntries([...store.drafts].map(([id,draft])=>[id,draft&&typeof draft==='object'?{...draft,images:undefined}:draft])),panelTab:store.panelTab,panelHidden:$('#inspector').hidden,showAllThreads:true};}
  // A draft save normally takes a few milliseconds; "正在保存" only shows when one is slow.
  async function persist(){if(!ready)return;const slow=setTimeout(()=>{$('#save-indicator').textContent='正在保存…';},600);try{await api('ui:save',payload());$('#save-indicator').textContent='已自动保存';$('#save-indicator').classList.remove('error');}catch(e){$('#save-indicator').textContent='保存失败';$('#save-indicator').classList.add('error');toast('本地保存失败：'+e.message);}finally{clearTimeout(slow);}}
  function save(){if(!ready)return;store.emit('composer');clearTimeout(saveTimer);saveTimer=setTimeout(persist,220);}
  function syncPickers(){
    $('#model-label').textContent=modelName($('#model').value);$('#picker-model-label').textContent=modelName($('#model').value);$('#model-toggle').title=$('#model').value;
    const index=Math.max(0,levels.indexOf($('#effort').value));
    $('#effort-label').textContent=levelNames[index];$('#effort-value').textContent=levelNames[index];$('#effort-description').textContent=descriptions[index];$('#effort-slider').value=index;$('#effort-slider').setAttribute('aria-valuetext',levelNames[index]);$('.effort-track').style.setProperty('--effort-fill',`${index*25}%`);$('#model-picker').title=descriptions[index];renderUsage();
    document.querySelectorAll('[data-effort]').forEach(b=>{b.classList.toggle('selected',b.dataset.effort===levels[index]);b.setAttribute('aria-pressed',String(b.dataset.effort===levels[index]));});
    const mode=modes.find(m=>m.id===$('#mode').value)||modes[0];$('#mode-label').textContent=mode.name;$('#mode-icon').innerHTML=mode.icon;$('#mode-icon').dataset.mode=mode.id;$('#mode-toggle').classList.toggle('advanced-mode',Boolean(mode.advanced));$('#mode-toggle').title=mode.description;renderModes();
  }
  function setEffort(index){$('#effort').value=levels[Math.max(0,Math.min(4,index))];syncPickers();optionChanged();}
  function optionChanged(){store.state.settings={...store.state.settings,...options()};syncPickers();save();api('settings',store.state.settings).catch(e=>toast(e.message));}
  function renderReferences(){
    $('#reference-chips').hidden=!references.length;
    $('#reference-chips').innerHTML=references.map((r,i)=>`<span class="reference-chip"><span class="reference-symbol">${r.kind==='file'?'@':'@@'}</span><span title="${escape(r.label||r.path)}">${escape(r.label||r.path)}</span><button type="button" data-remove-reference="${i}" aria-label="移除引用 ${escape(r.label||r.path)}">×</button></span>`).join('');
  }
  function closePickers(){
    for(const name of ['model','mode']){$('#'+name+'-picker').hidden=true;$('#'+name+'-toggle').setAttribute('aria-expanded','false');}
    $('#model-list-picker').hidden=true;$('#model-list-toggle').setAttribute('aria-expanded','false');
    $('#usage-picker').hidden=true;$('#context-usage').setAttribute('aria-expanded','false');
  }
  function renderUsage(){
    const t=store.current(),usage=t?.contextUsage;
    const used=Number.isFinite(usage?.usedTokens)?usage.usedTokens:null;
    const limit=Number.isFinite(usage?.contextWindow)&&usage.contextWindow>0?usage.contextWindow:null;
    const percent=used!==null&&limit!==null?Math.min(100,Math.max(0,Math.round(used/limit*100))):null;
    const label=percent===null?'—':`${percent}%`;
    $('#context-percent').textContent=percent===null?'':label;$('#usage-percent-detail').textContent=percent===null?'暂无统计':label;$('#context-usage').classList.toggle('usage-unknown',percent===null);
    $('#usage-ring').setAttribute('stroke-dashoffset',String(100-(percent||0)));
    $('#context-usage').classList.toggle('usage-high',percent!==null&&percent>=80);
    const number=value=>Number.isFinite(value)?value.toLocaleString():'未返回';
    const last=t?.turns.at(-1)?.usage;
    const summary=percent===null?'上下文用量：等待 CLI 返回完整统计':`上下文已用 ${label}，约 ${number(used)} / ${number(limit)} tokens`;
    $('#context-usage').title=summary;$('#context-usage').setAttribute('aria-label',summary);
    const rows=[['最近上下文',used===null?'暂无统计':`${number(used)} tokens`],['上下文上限',limit===null?'CLI 尚未返回':`${number(limit)} tokens`],['剩余空间',used!==null&&limit!==null?`${number(Math.max(0,limit-used))} tokens`:'暂无统计'],['统计模型',usage?.model||'发送后更新'],['本轮输入 / 输出',last?`${number(last.input)} / ${number(last.output)} tokens`:'暂无统计']];
    $('#usage-details').innerHTML=rows.map(([name,value])=>`<div class="usage-detail-row"><span>${escape(name)}</span><strong>${escape(value)}</strong></div>`).join('');
  }
  function openModelList(){
    closeAll();syncPickers();$('#model-list-picker').hidden=false;$('#model-toggle').setAttribute('aria-expanded','true');$('#model-list-toggle').setAttribute('aria-expanded','true');
    $('#model-search').value='';renderModels();$('#model-search').focus();
    if(!store.state.availableModels?.length)refreshModels().catch(()=>{});
  }
  function renderModes(){
    $('#mode-list').innerHTML=modeListHtml($('#mode').value);
  }
  function hidePromptMenu(){menuGeneration++;$('#prompt-menu').hidden=true;$('#prompt').removeAttribute('aria-activedescendant');menuItems=[];menuToken=null;}
  function closeAll(){closePickers();hidePromptMenu();}
  function renderModels(){
    const query=$('#model-search').value.trim().toLowerCase(),chosen=$('#model').value;
    const models=[...new Set([...(store.state.availableModels||[]),...[...$('#model').options].map(x=>x.value)])];
    const filtered=models.filter(id=>!query||`${id} ${modelName(id)}`.toLowerCase().includes(query));
    $('#model-provider').textContent=store.state.provider?.host||'';
    $('#model-list').innerHTML=filtered.map(id=>`<button class="model-choice ${id===chosen?'selected':''}" data-model="${escape(id)}" role="option" aria-selected="${id===chosen}"><span class="choice-icon">✳</span><span class="choice-copy"><strong>${escape(modelName(id))}</strong><small>${escape(id)}</small></span>${id===chosen?'<span class="choice-check">✓</span>':''}</button>`).join('');
    if(!filtered.length){$('#model-list').innerHTML=/^[\w.:/\-\[\]]{1,150}$/.test(query)?`<button class="model-choice" data-model="${escape($('#model-search').value.trim())}"><span class="choice-icon">＋</span><span class="choice-copy"><strong>使用这个模型 ID</strong><small>${escape($('#model-search').value.trim())}</small></span></button>`:'<div class="prompt-empty">没有匹配的模型</div>';}
  }
  async function refreshModels(){
    if(modelsLoading)return store.state.availableModels||[];modelsLoading=true;$('#model-refresh').disabled=true;$('#model-status').textContent='正在读取服务商的模型列表…';
    try{const models=await api('models');store.state.availableModels=models;for(const m of models)if(![...$('#model').options].some(x=>x.value===m))$('#model').add(new Option(m,m));renderModels();$('#model-status').textContent=`${models.length} 个服务商模型 · 点击即可选择`;return models;}
    catch(e){$('#model-status').textContent='未能刷新：'+e.message;throw e;}
    finally{modelsLoading=false;$('#model-refresh').disabled=false;}
  }
  function openPicker(name){
    if(name==='effort')name='model';
    const wasOpen=!$('#'+name+'-picker').hidden||name==='model'&&!$('#model-list-picker').hidden;
    closeAll();if(wasOpen)return;
    syncPickers();$('#'+name+'-picker').hidden=false;$('#'+name+'-toggle').setAttribute('aria-expanded','true');
    if(name==='model')$('#effort-slider').focus();else $('#mode-list .selected')?.focus();
  }
  function tokenAtCursor(){
    const prompt=$('#prompt'),before=prompt.value.slice(0,prompt.selectionStart);
    const command=/^\/(\S*)$/.exec(before);if(command)return{kind:'command',query:command[1],start:0,end:prompt.selectionStart};
    const m=/(?:^|\s)(@@?)([^@\s]*)$/.exec(before);if(!m)return null;
    return{kind:m[1]==='@@'?'thread':'file',query:m[2],start:prompt.selectionStart-m[1].length-m[2].length,end:prompt.selectionStart};
  }
  function renderPromptMenu(){
    const titles={command:'快捷命令',file:'引用当前项目文件',thread:'引用已有会话'};
    $('#prompt-menu-title').textContent=titles[menuToken?.kind]||'';
    $('#prompt-menu-list').innerHTML=menuItems.length?menuItems.map((item,i)=>`<button class="prompt-option ${i===menuIndex?'selected':''}" id="prompt-option-${i}" data-menu-index="${i}" type="button" role="option" aria-selected="${i===menuIndex}"><span class="prompt-icon">${item.icon}</span>${item.command?`<code>/${escape(item.command.name)}</code>`:''}<span><strong>${escape(item.label)}</strong><small>${escape(item.description||'')}</small></span><span class="option-hint">↵</span></button>`).join(''):'<div class="prompt-empty">没有匹配的内容</div>';
    if(menuItems.length){$('#prompt').setAttribute('aria-activedescendant','prompt-option-'+menuIndex);$('#prompt-option-'+menuIndex)?.scrollIntoView({block:'nearest'});}
  }
  async function updatePromptMenu(){
    const token=tokenAtCursor();if(!token){hidePromptMenu();return;}
    closePickers();const generation=++menuGeneration;menuToken=token;menuIndex=0;
    const query=token.query.toLowerCase();let items=[];
    if(token.kind==='command')items=commands.filter(c=>c.name.includes(query)||c.description.includes(query)).map(c=>({command:c,label:c.description,description:'Claude Desk 本地命令',icon:'/'}));
    if(token.kind==='thread')items=store.state.threads.filter(t=>t.id!==store.selected&&t.turns.length&&`${t.title} ${t.turns.map(x=>x.user).join(' ')}`.toLowerCase().includes(query)).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,12).map(t=>({reference:{kind:'thread',id:t.id,label:t.title},label:t.title,description:`${store.state.projects.find(p=>p.id===t.projectId)?.name||'项目'} · ${t.turns.length} 轮对话`,icon:'@@'}));
    if(token.kind==='file'){
      const p=store.workspace();if(!p){hidePromptMenu();toast('请先选择一个项目文件夹');return;}
      if(!filesCache||filesCache.projectId!==p.id){const files=await api('project:files',p.id);if(generation!==menuGeneration)return;filesCache={projectId:p.id,files};}
      items=filesCache.files.filter(file=>file.toLowerCase().includes(query)).slice(0,14).map(file=>({reference:{kind:'file',path:file,label:file},label:file.split(/[\\/]/).at(-1),description:file,icon:'@'}));
    }
    if(generation!==menuGeneration)return;menuItems=items;$('#prompt-menu').hidden=false;renderPromptMenu();
  }
  async function chooseMenu(index){
    const item=menuItems[index],token=menuToken;if(!item||!token)return;
    const prompt=$('#prompt');prompt.value=prompt.value.slice(0,token.start)+prompt.value.slice(token.end);prompt.selectionStart=prompt.selectionEnd=token.start;
    hidePromptMenu();
    if(item.reference){addReference(item.reference);prompt.focus();}
    else if(item.command.prompt){prompt.value=item.command.prompt;prompt.focus();}
    else if(item.command.action)await item.command.action();
    save();
  }
  function input(){historyIndex=-1;historyDraft=null;save();updatePromptMenu().catch(e=>{hidePromptMenu();toast(e.message);});}
  function keydown(event){
    if(event.isComposing)return false;
    if(!$('#prompt-menu').hidden){
      if(['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();if(menuItems.length){menuIndex=(menuIndex+(event.key==='ArrowDown'?1:-1)+menuItems.length)%menuItems.length;renderPromptMenu();}return true;}
      if((event.key==='Enter'&&!event.shiftKey)||event.key==='Tab'){event.preventDefault();if(menuItems.length)chooseMenu(menuIndex).catch(e=>toast(e.message));return true;}
      if(event.key==='Escape'){event.preventDefault();hidePromptMenu();return true;}
    }
    if(!['ArrowUp','ArrowDown'].includes(event.key)||event.shiftKey||event.ctrlKey||event.altKey)return false;
    const prompt=$('#prompt'),cursor=prompt.selectionStart;if(prompt.selectionStart!==prompt.selectionEnd)return false;
    const atTop=!prompt.value.slice(0,cursor).includes('\n'),atBottom=!prompt.value.slice(cursor).includes('\n');
    if((event.key==='ArrowUp'&&!atTop)||(event.key==='ArrowDown'&&!atBottom))return false;
    const history=store.current()?.turns||[];if(!history.length)return false;
    if(event.key==='ArrowUp'){
      if(historyIndex===-1)historyDraft=capture();historyIndex=Math.min(history.length-1,historyIndex+1);
    }else{if(historyIndex===-1)return false;historyIndex--;}
    event.preventDefault();const turn=history[history.length-1-historyIndex];const draft=historyIndex===-1?historyDraft:{text:turn.user,references:turn.references||[],options:options()};prompt.value=draft?.text||'';references=structuredClone(draft?.references||[]);renderReferences();prompt.selectionStart=prompt.selectionEnd=prompt.value.length;save();return true;
  }
  // Restores a draft; `defaults` supplies model, effort and mode when the draft has none.
  function restore(draft,defaults){$('#prompt').value=typeof draft==='string'?draft:draft?.text||'';const chosen=draft?.options?.model?draft.options:defaults;if(chosen){ensureModel(chosen.model);$('#effort').value=chosen.effort||'high';$('#mode').value=chosen.mode||'default';}
    references=structuredClone(draft?.references||[]);renderReferences();images=Array.isArray(draft?.images)?draft.images.slice():[];renderImages();syncPickers();closeAll();historyIndex=-1;historyDraft=null;autosize();}
  function addReference(reference){if(references.length>=8)return toast('一条消息最多引用 8 项');const key=r=>r.kind==='file'?'file:'+r.path:'thread:'+r.id;if(!references.some(r=>key(r)===key(reference)))references.push(reference);renderReferences();save();}
  function clear(){$('#prompt').value='';references=[];renderReferences();images=[];renderImages();closeAll();historyIndex=-1;historyDraft=null;$('#prompt').style.height='auto';}
  $('#model-toggle').onclick=()=>openPicker('model');$('#mode-toggle').onclick=()=>openPicker('mode');
  $('#model-list-toggle').onclick=openModelList;
  $('#context-usage').onclick=()=>{const wasOpen=!$('#usage-picker').hidden;closeAll();if(wasOpen)return;renderUsage();$('#usage-picker').hidden=false;$('#context-usage').setAttribute('aria-expanded','true');};
  $('#model-search').oninput=renderModels;
  $('#model-search').onkeydown=event=>{if(event.key==='ArrowDown'){event.preventDefault();$('#model-list .model-choice')?.focus();}if(event.key==='Enter'){event.preventDefault();$('#model-list .model-choice')?.click();}};
  $('#model-list').onkeydown=event=>{if(!['ArrowDown','ArrowUp'].includes(event.key))return;event.preventDefault();const choices=[...$('#model-list').querySelectorAll('.model-choice')],at=choices.indexOf(document.activeElement);choices[(at+(event.key==='ArrowDown'?1:-1)+choices.length)%choices.length]?.focus();};
  $('#model-list').onclick=event=>{const button=event.target.closest('[data-model]');if(!button)return;ensureModel(button.dataset.model);optionChanged();renderModels();closePickers();$('#model-picker').hidden=false;$('#model-toggle').setAttribute('aria-expanded','true');$('#model-list-toggle').focus();};
  $('#mode-list').onclick=event=>{const button=event.target.closest('[data-mode]');if(!button)return;$('#mode').value=button.dataset.mode;optionChanged();closePickers();$('#prompt').focus();};
  $('#mode-list').onkeydown=event=>{if(!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const items=[...$('#mode-list').querySelectorAll('[data-mode]')],at=items.indexOf(document.activeElement);items[(at+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();};
  $('#model-refresh').onclick=()=>refreshModels().catch(e=>toast(e.message));
  $('#effort-slider').oninput=()=>setEffort(Number($('#effort-slider').value));
  document.querySelectorAll('[data-effort]').forEach(button=>button.onclick=()=>setEffort(levels.indexOf(button.dataset.effort)));
  $('#mode').onchange=optionChanged;
  $('#reference-chips').onclick=event=>{const b=event.target.closest('[data-remove-reference]');if(b){references.splice(Number(b.dataset.removeReference),1);renderReferences();save();}};
  $('#add-context').onclick=()=>{const p=$('#prompt');p.value+=(p.value&&!/\s$/.test(p.value)?' ':'')+'@';p.focus();p.selectionStart=p.selectionEnd=p.value.length;input();};
  $('#prompt-menu-list').onmousedown=event=>event.preventDefault();
  $('#prompt-menu-list').onclick=event=>{const b=event.target.closest('[data-menu-index]');if(b)chooseMenu(Number(b.dataset.menuIndex)).catch(e=>toast(e.message));};
  document.addEventListener('pointerdown',event=>{
    if(!event.target.closest('.composer-popover,.picker-toggle'))closePickers();
    if(!event.target.closest('#prompt-menu,#prompt,#add-context'))hidePromptMenu();
  },true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){
    if(!$('#model-list-picker').hidden){closePickers();$('#model-picker').hidden=false;$('#model-toggle').setAttribute('aria-expanded','true');$('#model-list-toggle').focus();return;}
    const trigger=!$('#model-picker').hidden?$('#model-toggle'):!$('#mode-picker').hidden?$('#mode-toggle'):!$('#usage-picker').hidden?$('#context-usage'):null;closeAll();trigger?.focus();
  }});
  window.addEventListener('beforeunload',()=>{if(ready){clearTimeout(saveTimer);window.desk.persistUi(payload());}});
  window.addEventListener('blur',()=>{closeAll();if(ready){clearTimeout(saveTimer);persist();}});
  // Images are read in the renderer (paste, drop or file picker); the main process saves the original on send.
  const IMAGE_TYPES=['image/png','image/jpeg','image/gif','image/webp'];
  function renderImages(){
    $('#image-chips').hidden=!images.length;
    $('#image-chips').innerHTML=images.map((image,i)=>`<span class="image-chip" title="${escape(image.name)}"><img src="${escape(image.thumb)}" alt="${escape(image.name)}"><button type="button" data-remove-image="${i}" aria-label="移除图片 ${escape(image.name)}">×</button></span>`).join('');
  }
  function readAsDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('无法读取图片'));reader.readAsDataURL(file);});}
  function thumbnail(url){return new Promise(resolve=>{const img=new Image();img.onload=()=>{const scale=Math.min(1,240/Math.max(img.width,img.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);resolve(canvas.toDataURL('image/jpeg',0.82));};img.onerror=()=>resolve('');img.src=url;});}
  async function addImages(files){
    for(const file of [...files]){
      if(!IMAGE_TYPES.includes(file.type)){toast('只支持 PNG、JPEG、GIF、WebP 图片');continue;}
      if(file.size>5*1024*1024){toast(`${file.name||'图片'} 超过 5 MB`);continue;}
      if(images.length>=6){toast('一条消息最多附带 6 张图片');break;}
      const url=await readAsDataUrl(file),thumb=await thumbnail(url);
      if(!thumb){toast('无法识别这张图片');continue;}
      images.push({name:file.name||'粘贴的图片.'+file.type.split('/')[1],mediaType:file.type,data:String(url).split(',')[1],thumb});
    }
    renderImages();store.emit('composer');$('#prompt').focus();
  }
  $('#image-chips').onclick=event=>{const b=event.target.closest('[data-remove-image]');if(b){images.splice(Number(b.dataset.removeImage),1);renderImages();store.emit('composer');}};
  $('#add-image').onclick=()=>$('#image-input').click();
  $('#image-input').onchange=()=>{addImages($('#image-input').files).catch(e=>toast(e.message)).finally(()=>{$('#image-input').value='';});};
  $('#prompt').addEventListener('paste',event=>{const files=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(files.length){event.preventDefault();addImages(files).catch(e=>toast(e.message));}});
  $('#composer').addEventListener('dragover',event=>{if([...(event.dataTransfer?.items||[])].some(item=>item.kind==='file')){event.preventDefault();$('#composer').classList.add('dropping');}});
  $('#composer').addEventListener('dragleave',()=>$('#composer').classList.remove('dropping'));
  $('#composer').addEventListener('drop',event=>{$('#composer').classList.remove('dropping');const files=[...(event.dataTransfer?.files||[])];if(files.length){event.preventDefault();addImages(files).catch(e=>toast(e.message));}});
  function ensureModel(model){if(!model)return;if(![...$('#model').options].some(x=>x.value===model))$('#model').add(new Option(model,model));$('#model').value=model;syncPickers();}
  // Grows with the text; an empty box keeps its default height (placeholder text does not count).
  function autosize(){const prompt=$('#prompt');prompt.style.height='auto';prompt.style.height=prompt.value?Math.min(200,Math.max(52,prompt.scrollHeight))+'px':'';}
  function setText(text){$('#prompt').value=text;autosize();store.emit('composer');}
  const isEmpty=()=>!$('#prompt').value.trim()&&!images.length;
  // Enter sends (or queues while running); with an empty box the send button stops the run.
  $('#composer').addEventListener('submit',event=>event.preventDefault());
  $('#composer').addEventListener('submit',guarded(toast,async event=>{event.preventDefault();if(store.running()&&isEmpty())await actions().stop();else await actions().sendMessage();}));
  $('#prompt').addEventListener('keydown',guarded(toast,async event=>{if(keydown(event))return;if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();await actions().sendMessage();}}));
  $('#prompt').addEventListener('input',()=>{autosize();input();store.emit('composer');});
  function setMode(mode){if(modes.some(m=>m.id===mode)&&$('#mode').value!==mode){$('#mode').value=mode;optionChanged();}}
  return{capture,restore,clear,save,syncPickers,renderUsage,refreshModels,options,ensureModel,setText,isEmpty,setMode,addReference,
    focus:()=>$('#prompt').focus(),focusProject:()=>$('#home-project')?.focus(),
    initialize(){ready=true;syncPickers();renderModels();save();}};
}
