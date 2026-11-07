// The input box: text, references, images, model / effort / permission pickers,
// slash commands and @ mentions. Sending goes through actions.
import { $, escape } from '../core/dom.mjs';
import { guarded, showImage } from '../core/ui.mjs';

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

// Models the provider names in its own way (a gateway's ocx-claude-claude--claude-opus-5-5,
// or anything not called claude-…) come first, Claude models among them first; the
// plain claude-… names follow, since a gateway may route those to another provider.
export function orderModels(ids){
  const plain=ids.filter(id=>/^claude-/.test(id)),own=ids.filter(id=>!/^claude-/.test(id));
  const claude=id=>/claude-(opus|sonnet|haiku|fable)-/.test(id);
  return{own:[...own.filter(claude),...own.filter(id=>!claude(id))],plain};
}
export function modeListHtml(current){
  return modes.map(mode=>`<button type="button" class="mode-choice ${mode.id===current?'selected':''} ${mode.advanced?'advanced':''}" data-mode="${mode.id}" role="option" aria-selected="${mode.id===current}"><svg class="mode-choice-icon" viewBox="0 0 16 16" aria-hidden="true">${mode.icon}</svg><span class="mode-choice-copy"><strong>${mode.name}${mode.tag?`<small class="mode-tag">${mode.tag}</small>`:''}</strong><span>${mode.description}</span></span>${mode.id===current?'<span class="mode-choice-check">✓</span>':''}</button>`).join('');
}

export function createComposer({ store, api, toast, actions }) {
  let references=[],images=[],saveTimer,ready=false,menuItems=[],menuIndex=0,menuToken=null,menuGeneration=0,historyIndex=-1,historyDraft=null,filesCache=null,modelsLoading=false;
  const commands=[
    {name:'new',description:'在当前项目里开始新任务',action:()=>actions().newTask()},
    {name:'model',description:'选择本次任务使用的 Claude 模型',action:()=>openPicker('model')},
    {name:'effort',description:'用滑块调整思考强度',action:()=>openPicker('effort')},
    {name:'plan',description:'切换到仅做计划模式',action:()=>{$('#mode').value='plan';optionChanged();toast('已切换为仅做计划');}},
    {name:'review',description:'检查项目中的问题，先不修改文件',prompt:'请审查当前项目，按严重程度列出具体问题、位置和改进建议。先不要修改文件。'},
    {name:'stop',description:'停止当前会话正在执行的任务',action:()=>actions().stop()},
    {name:'help',description:'查看输入框快捷用法',action:()=>toast('/ 选择命令 · @ 引用文件 · @@ 引用会话 · ↑ ↓ 召回历史消息 · Shift+Enter 换行')}
  ];
  // A gateway's prefixed ID (e.g. ocx-claude-claude--claude-opus-5-5) keeps its prefix
  // after the name, so it is not mistaken for the plain model.
  function modelName(id) {
    const m=/^(.*?)claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(.*)$/.exec(id);
    if(!m)return id;
    const prefix=m[1].replace(/[-_:/.]+$/,'');
    return `Claude ${m[2][0].toUpperCase()+m[2].slice(1)} ${m[3]}${m[4]?'.'+m[4]:''}${m[5]?' '+m[5].replace(/^-/, ''):''}${prefix?' · '+prefix:''}`;
  }
  function options(){return{model:$('#model').value,effort:$('#effort').value,mode:$('#mode').value};}
  function capture(){return{text:$('#prompt').value,references:structuredClone(references),images:images.filter(i=>i.data||i.path).map(({preview,ready,...image})=>image),options:options()};}
  function payload(){store.drafts.set(store.selected||'new',capture());return{selectedThread:store.selected,projectId:store.projectId,drafts:Object.fromEntries([...store.drafts].map(([id,draft])=>[id,draft&&typeof draft==='object'?{...draft,images:undefined}:draft])),panelTab:store.panelTab,panelHidden:$('#inspector').hidden,showAllThreads:true};}
  // Drafts save silently; the hint only shows while a save is slow or after one failed.
  async function persist(){if(!ready)return;const slow=setTimeout(()=>{$('#save-indicator').textContent='正在保存…';},600);try{await api('ui:save',payload());$('#save-indicator').textContent='';$('#save-indicator').classList.remove('error');}catch(e){$('#save-indicator').textContent='保存失败';$('#save-indicator').classList.add('error');toast('本地保存失败：'+e.message);}finally{clearTimeout(slow);}}
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
    $('#reference-chips').innerHTML=references.map((r,i)=>`<span class="reference-chip"><span class="reference-symbol">${r.kind==='file'?'@':r.kind==='upload'?'📎':'@@'}</span><span title="${escape(r.kind==='upload'?r.path:r.label||r.path)}">${escape(r.label||r.path)}</span><button type="button" data-remove-reference="${i}" aria-label="移除引用 ${escape(r.label||r.path)}">×</button></span>`).join('');
  }
  // The ＋ menu, like Codex's: attach or reference something, switch plan mode, run a skill.
  let addSkills=null,addIndex=0;
  const ICONS={image:'<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.2"/><path d="m3 12 3.5-3.5 2.5 2.5 1.5-1.5L13 12"/>',file:'<path d="M9.5 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7Z"/><path d="M9.5 2.5v3h3"/>',thread:'<path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h0a1.5 1.5 0 0 1-1-1.4Z"/>',plan:'<path d="M6.2 12.5h3.6M6.7 14.2h2.6M8 1.8a4.2 4.2 0 0 0-2.6 7.5c.5.4.8.9.8 1.5v.2h3.6v-.2c0-.6.3-1.1.8-1.5A4.2 4.2 0 0 0 8 1.8Z"/>',skill:'<path d="m8 1.5 1.9 4.3 4.6.5-3.5 3.1 1 4.6L8 11.6 4 14l1-4.6L1.5 6.3l4.6-.5Z"/>',manage:'<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>'};
  function addMenuItems(){
    const plan=$('#mode').value==='plan';
    return[
      {section:'添加'},
      {key:'image',icon:'image',label:'图片',hint:'从电脑选择，也可以直接粘贴或拖入'},
      {key:'upload',icon:'file',label:'文件',hint:'任意文件或文件夹，也可以拖入或粘贴；Claude 用文件工具读取'},
      {key:'file',icon:'file',label:'项目文件',hint:'用 @ 引用当前项目里的文件'},
      {key:'thread',icon:'thread',label:'其他会话',hint:'用 @@ 把另一个会话作为上下文'},
      {key:'plan',icon:'plan',label:'计划模式',hint:plan?'已开启 · 只读探索并给出计划':'只读探索并给出计划，确认后再执行',on:plan},
      ...(addSkills?.length?[{section:'技能'},...addSkills.slice(0,8).map(skill=>({key:'skill',icon:'skill',label:skill.name,hint:skill.description,skill:skill.name}))]:[]),
      {section:''},
      {key:'manage',icon:'manage',label:'管理插件和技能…',hint:''}
    ];
  }
  function renderAddMenu(){
    let index=-1;
    $('#add-menu').innerHTML=addMenuItems().map(item=>item.section!==undefined?(item.section?`<div class="add-menu-section">${escape(item.section)}</div>`:'<div class="add-menu-line"></div>'):`<button type="button" role="menuitem" class="add-menu-item${++index===addIndex?' active':''}" data-add="${item.key}"${item.skill?` data-skill="${escape(item.skill)}"`:''}><svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[item.icon]}</svg><strong>${escape(item.label)}</strong>${item.hint?`<span title="${escape(item.hint)}">${escape(item.hint)}</span>`:''}${item.on!==undefined?`<i class="add-menu-switch${item.on?' on':''}" aria-hidden="true"></i>`:''}</button>`).join('');
  }
  function openAddMenu(){
    const wasOpen=!$('#add-menu').hidden;closeAll();if(wasOpen)return;
    addIndex=0;renderAddMenu();$('#add-menu').hidden=false;$('#add-context').setAttribute('aria-expanded','true');
    $('#add-menu .add-menu-item')?.focus();
    // Skills of the current project, read once per opening (the main process caches the catalog).
    api('extensions:list',store.workspace()?.id||null,false).then(catalog=>{addSkills=catalog.skills||[];if(!$('#add-menu').hidden){renderAddMenu();$('#add-menu .add-menu-item.active')?.focus();}}).catch(()=>{});
  }
  function insertToken(token){const p=$('#prompt');p.value+=(p.value&&!/\s$/.test(p.value)?' ':'')+token;p.focus();p.selectionStart=p.selectionEnd=p.value.length;input();}
  let modeBeforePlan='default';
  function chooseAdd(button){
    const key=button.dataset.add;closePickers();
    if(key==='image')return $('#image-input').click();
    if(key==='upload')return api('files:pick').then(paths=>{for(const path of paths)addUpload(path);$('#prompt').focus();}).catch(e=>toast(e.message));
    if(key==='file')return insertToken('@');
    if(key==='thread')return insertToken('@@');
    if(key==='plan'){const plan=$('#mode').value==='plan';if(!plan)modeBeforePlan=$('#mode').value;$('#mode').value=plan?modeBeforePlan:'plan';optionChanged();toast(plan?'已关闭计划模式':'已开启计划模式，Claude 会先给出计划');return $('#prompt').focus();}
    if(key==='skill')return insertToken('/'+button.dataset.skill+' ');
    if(key==='manage')return $('#manage-skills').click();
  }
  function closePickers(){
    $('#add-menu').hidden=true;$('#add-context').setAttribute('aria-expanded','false');
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
  // 上下文明细: what fills the window, by category, as the CLI's /context counts it.
  const CONTEXT_PARTS={system_prompt:['系统提示词','#8b8fa3'],system_tools:['内置工具','#6f8fb8'],mcp_tools:['MCP 工具','#3fa7a0'],mcp_instructions:['MCP 说明','#5bb7a9'],custom_agents:['自定义子智能体','#b48ad6'],memory_files:['记忆文件（CLAUDE.md）','#d6a35a'],skills:['技能','#c97a9c'],messages:['对话消息','#7fb069'],autocompact_buffer:['自动压缩预留','#5c5c5c'],compact_buffer:['压缩预留','#5c5c5c'],free_space:['剩余空间','#343434']};
  let breakdownToken=0;
  function breakdownHtml(d){
    const total=d.maxTokens||1,pct=n=>`${Math.max(0,n/total*100).toFixed(1)}%`,k=n=>n>=1000?(n/1000).toFixed(n>=100000?0:1)+'k':String(n);
    const rows=d.categories.filter(c=>c.tokens>0).map(c=>{const [name,color]=CONTEXT_PARTS[c.id]||[c.name,'#777'];return{name,color,tokens:c.tokens,kind:c.kind};});
    const bar=rows.map(r=>`<i data-w="${pct(r.tokens)}" data-c="${r.color}" title="${escape(r.name)} · ${r.tokens.toLocaleString()} tokens"></i>`).join('');
    const list=rows.map(r=>`<div class="usage-part${r.kind==='free'?' free':''}"><span class="usage-dot" data-c="${r.color}"></span><span>${escape(r.name)}</span><strong>${k(r.tokens)}</strong><small>${pct(r.tokens)}</small></div>`).join('');
    const extra=(title,items)=>items.length?`<div class="usage-sub"><span>${title}</span>${items.map(x=>`<div><span title="${escape(x.label)}">${escape(x.label)}</span><strong>${k(x.tokens)}</strong></div>`).join('')}</div>`:'';
    return `<div class="usage-bar">${bar}</div>${list}${extra('记忆文件',d.memoryFiles.map(f=>({label:f.path.split(/[\\/]/).slice(-2).join('/'),tokens:f.tokens})))}${extra('MCP 服务器',d.mcpServers.map(s=>({label:s.name,tokens:s.tokens})))}${d.detail==='full'?'':'<p class="usage-estimate">按最近一次响应估算；「详细分析」逐项精确计数。</p>'}`;
  }
  async function loadBreakdown(detail='summary'){
    const id=store.selected,box=$('#usage-breakdown'),token=++breakdownToken;
    $('#usage-compact').disabled=true;$('#usage-analyze').disabled=true;
    if(!id){box.innerHTML='<p class="usage-estimate">进入会话后可以查看明细。</p>';return;}
    box.innerHTML=`<p class="usage-estimate">${detail==='full'?'正在逐项计数…':'正在读取明细…'}</p>`;
    try{
      const d=await api('context:details',id,detail);if(token!==breakdownToken)return;
      if(!d){box.innerHTML='<p class="usage-estimate">这个会话的 Claude 还没启动，发送一条消息后可以查看明细和压缩。重新打开的会话只带最近的历史，一般不需要压缩。</p>';return;}
      box.innerHTML=breakdownHtml(d);for(const el of box.querySelectorAll('[data-c]')){el.style.background=el.dataset.c;if(el.dataset.w)el.style.width=el.dataset.w;}$('#usage-analyze').disabled=false;$('#usage-compact').disabled=store.running();
      $('#usage-compact').title=store.running()?'运行结束后可以压缩':'让 Claude 把之前的对话总结成摘要，腾出上下文空间（/compact）';
      renderUsage();
    }catch(e){if(token===breakdownToken){box.innerHTML=`<p class="usage-estimate">${escape(e.message)}</p>`;$('#usage-analyze').disabled=false;}}
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
    const {own,plain}=orderModels(filtered),sections=own.length&&plain.length;
    const choice=id=>`<button class="model-choice ${id===chosen?'selected':''}" data-model="${escape(id)}" role="option" aria-selected="${id===chosen}"><span class="choice-icon">✳</span><span class="choice-copy"><strong>${escape(modelName(id))}</strong><small>${escape(id)}</small></span>${id===chosen?'<span class="choice-check">✓</span>':''}</button>`;
    $('#model-list').innerHTML=sections?`<div class="model-section">服务商提供的模型</div>${own.map(choice).join('')}<div class="model-section" title="网关可能把不带前缀的名称发给别的服务商">通用名称 · 可能被网关转到其他服务商</div>${plain.map(choice).join('')}`:[...own,...plain].map(choice).join('');
    if(!filtered.length){$('#model-list').innerHTML=/^[\w.:/\-\[\]]{1,150}$/.test(query)?`<button class="model-choice" data-model="${escape($('#model-search').value.trim())}"><span class="choice-icon">＋</span><span class="choice-copy"><strong>使用这个模型 ID</strong><small>${escape($('#model-search').value.trim())}</small></span></button>`:'<div class="prompt-empty">没有匹配的模型</div>';}
  }
  async function refreshModels(){
    if(modelsLoading)return store.state.availableModels||[];modelsLoading=true;$('#model-refresh').disabled=true;$('#model-status').textContent='正在读取服务商的模型列表…';
    try{const models=await api('models');store.state.availableModels=models;
      // Models added by an earlier fetch (another provider's) go, except the one still selected.
      for(const o of [...$('#model').options])if(o.dataset.fetched&&!models.includes(o.value)&&o.value!==$('#model').value)o.remove();
      for(const m of models)if(![...$('#model').options].some(x=>x.value===m)){const o=new Option(m,m);o.dataset.fetched='1';$('#model').add(o);}
      renderModels();$('#model-status').textContent=`${models.length} 个服务商模型 · 点击即可选择`;return models;}
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
    const prompt=$('#prompt');if(prompt.selectionStart!==prompt.selectionEnd)return false;
    // Earlier messages come back only into an empty box or while already going through them
    // (typing ends that), so a draft is never swapped out by moving the caret.
    if(historyIndex===-1&&(event.key==='ArrowDown'||prompt.value.trim()))return false;
    const edges=caretEdges(prompt);if((event.key==='ArrowUp'&&!edges.top)||(event.key==='ArrowDown'&&!edges.bottom))return false;
    const history=store.current()?.turns||[];if(!history.length)return false;
    if(event.key==='ArrowUp'){
      if(historyIndex===history.length-1)return false;if(historyIndex===-1)historyDraft=capture();historyIndex++;
    }else historyIndex--;
    event.preventDefault();const turn=history[history.length-1-historyIndex];const draft=historyIndex===-1?historyDraft:{text:turn.user,references:turn.references||[],options:options()};prompt.value=draft?.text||'';references=structuredClone(draft?.references||[]);renderReferences();autosize();
    // Going back puts the caret on the first line of a long message, so the next ↑ goes on back; otherwise at the end.
    prompt.selectionStart=prompt.selectionEnd=prompt.value.length;if(event.key==='ArrowUp'&&!caretEdges(prompt).top)prompt.selectionStart=prompt.selectionEnd=0;
    save();return true;
  }
  // Whether the caret is on the first / last line as shown, wrapped lines counted: a hidden
  // copy of the box, same width and font, with markers at the start, the caret and the end.
  function caretEdges(prompt){
    const style=getComputedStyle(prompt),copy=document.createElement('div'),at=prompt.selectionStart;
    for(const name of ['fontFamily','fontSize','fontWeight','fontStyle','letterSpacing','wordSpacing','lineHeight','tabSize','textIndent','textTransform','whiteSpace','wordBreak','overflowWrap','paddingLeft','paddingRight'])copy.style[name]=style[name];
    Object.assign(copy.style,{position:'fixed',left:'-10000px',top:'0',visibility:'hidden',boxSizing:'content-box',border:'0',width:Math.max(0,prompt.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight))+'px'});
    const mark=text=>{const span=document.createElement('span');span.textContent=text;return span;};
    const start=mark('​'),caret=mark(prompt.value.slice(at)||'​'),end=mark('​');
    copy.append(start,prompt.value.slice(0,at),caret,end);document.body.append(copy);
    const result={top:caret.offsetTop===start.offsetTop,bottom:caret.offsetTop===end.offsetTop};
    copy.remove();return result;
  }
  // Restores a draft; `defaults` supplies model, effort and mode when the draft has none.
  function restore(draft,defaults){$('#prompt').value=typeof draft==='string'?draft:draft?.text||'';const chosen=draft?.options?.model?draft.options:defaults;if(chosen){ensureModel(chosen.model);$('#effort').value=chosen.effort||'high';$('#mode').value=chosen.mode||'default';}
    references=structuredClone(draft?.references||[]);renderReferences();images=Array.isArray(draft?.images)?draft.images.slice():[];renderImages();syncPickers();closeAll();historyIndex=-1;historyDraft=null;autosize();}
  function addReference(reference){if(references.length>=8)return toast('一条消息最多引用 8 项');const key=r=>r.kind+':'+(r.path||r.id);if(!references.some(r=>key(r)===key(reference)))references.push(reference);renderReferences();save();}
  function clear(){$('#prompt').value='';references=[];renderReferences();images=[];renderImages();closeAll();historyIndex=-1;historyDraft=null;$('#prompt').style.height='auto';}
  $('#model-toggle').onclick=()=>openPicker('model');$('#mode-toggle').onclick=()=>openPicker('mode');
  $('#model-list-toggle').onclick=openModelList;
  $('#context-usage').onclick=()=>{const wasOpen=!$('#usage-picker').hidden;closeAll();if(wasOpen)return;renderUsage();$('#usage-picker').hidden=false;$('#context-usage').setAttribute('aria-expanded','true');loadBreakdown();};
  $('#usage-analyze').onclick=()=>loadBreakdown('full');
  $('#usage-compact').onclick=()=>{closePickers();toast('正在压缩上下文…');actions().sendMessage('/compact').catch(e=>toast(e.message));};
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
  $('#add-context').onclick=openAddMenu;
  $('#add-menu').onclick=event=>{const b=event.target.closest('[data-add]');if(b)chooseAdd(b);};
  $('#add-menu').onkeydown=event=>{
    const items=[...$('#add-menu').querySelectorAll('.add-menu-item')];
    if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();addIndex=(items.indexOf(document.activeElement)+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items.forEach((b,i)=>b.classList.toggle('active',i===addIndex));items[addIndex].focus();}
    if(event.key==='Escape'){event.preventDefault();closePickers();$('#add-context').focus();}
  };
  $('#prompt-menu-list').onmousedown=event=>event.preventDefault();
  $('#prompt-menu-list').onclick=event=>{const b=event.target.closest('[data-menu-index]');if(b)chooseMenu(Number(b.dataset.menuIndex)).catch(e=>toast(e.message));};
  document.addEventListener('pointerdown',event=>{
    if(!event.target.closest('.composer-popover,.picker-toggle,#add-context'))closePickers();
    if(!event.target.closest('#prompt-menu,#prompt,#add-menu'))hidePromptMenu();
  },true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){
    if(!$('#model-list-picker').hidden){closePickers();$('#model-picker').hidden=false;$('#model-toggle').setAttribute('aria-expanded','true');$('#model-list-toggle').focus();return;}
    const trigger=!$('#model-picker').hidden?$('#model-toggle'):!$('#mode-picker').hidden?$('#mode-toggle'):!$('#usage-picker').hidden?$('#context-usage'):null;closeAll();trigger?.focus();
  }});
  window.addEventListener('beforeunload',()=>{if(ready){clearTimeout(saveTimer);window.desk.persistUi(payload());}});
  window.addEventListener('blur',()=>{closeAll();if(ready){clearTimeout(saveTimer);persist();}});
  // Images are read in the renderer (paste, drop or file picker); the main process saves the original on send.
  // The chip shows the file at once; its bytes and the small thumbnail kept with the
  // message are read in the background (createImageBitmap decodes off the main thread).
  const IMAGE_TYPES=['image/png','image/jpeg','image/gif','image/webp'];
  function renderImages(){
    $('#image-chips').hidden=!images.length;
    $('#image-chips').innerHTML=images.map((image,i)=>`<span class="image-chip${image.ready&&!image.thumb?' loading':''}" data-view-image="${i}" title="${escape(image.name)} · 点击查看大图"><img src="${escape(image.thumb||image.preview||'')}" alt="${escape(image.name)}"><button type="button" data-remove-image="${i}" aria-label="移除图片 ${escape(image.name)}">×</button></span>`).join('');
  }
  function dropImage(image){const at=images.indexOf(image);if(at>=0)images.splice(at,1);if(image.preview)URL.revokeObjectURL(image.preview);}
  function readAsDataUrl(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('无法读取图片'));reader.readAsDataURL(file);});}
  async function thumbnail(file){
    try{const bitmap=await createImageBitmap(file),scale=Math.min(1,240/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();return canvas.toDataURL('image/jpeg',0.82);}
    catch{return'';}
  }
  // 上传文件: images go in the message itself; any other file (or folder) goes by its path on disk.
  function addUpload(path){if(path)addReference({kind:'upload',path,label:path.split(/[\\/]/).filter(Boolean).at(-1)||path});}
  function addFiles(files){
    const list=[...files],pictures=list.filter(file=>IMAGE_TYPES.includes(file.type));if(pictures.length)addImages(pictures);
    for(const file of list.filter(file=>!IMAGE_TYPES.includes(file.type))){const path=globalThis.desk?.pathForFile?.(file);if(path)addUpload(path);else toast(`读不到「${file.name}」在磁盘上的位置`);}
  }
  function addImages(files){
    for(const file of [...files]){
      if(!IMAGE_TYPES.includes(file.type)){toast('只支持 PNG、JPEG、GIF、WebP 图片');continue;}
      if(file.size>5*1024*1024){toast(`${file.name||'图片'} 超过 5 MB`);continue;}
      if(images.length>=6){toast('一条消息最多附带 6 张图片');break;}
      const image={name:file.name||'粘贴的图片.'+file.type.split('/')[1],mediaType:file.type,preview:URL.createObjectURL(file)};
      image.ready=Promise.all([readAsDataUrl(file),thumbnail(file)]).then(([url,thumb])=>{
        if(!thumb)throw Error('无法识别这张图片');
        image.data=String(url).split(',')[1];image.thumb=thumb;URL.revokeObjectURL(image.preview);delete image.preview;
      }).catch(e=>{dropImage(image);toast(e.message);}).finally(()=>{renderImages();store.emit('composer');});
      images.push(image);
    }
    renderImages();store.emit('composer');$('#prompt').focus();
  }
  // Sending waits for images still being read.
  const imagesReady=()=>Promise.all(images.map(image=>image.ready));
  $('#image-chips').onclick=event=>{
    const b=event.target.closest('[data-remove-image]');if(b){dropImage(images[Number(b.dataset.removeImage)]);renderImages();store.emit('composer');return;}
    const chip=event.target.closest('[data-view-image]'),image=chip&&images[Number(chip.dataset.viewImage)];if(image)showImage(image.data?`data:${image.mediaType};base64,${image.data}`:image.thumb,image.name);
  };
  $('#image-input').onchange=()=>{addImages($('#image-input').files);$('#image-input').value='';};
  $('#prompt').addEventListener('paste',event=>{const files=[...(event.clipboardData?.items||[])].filter(item=>item.kind==='file').map(item=>item.getAsFile()).filter(Boolean);if(files.length){event.preventDefault();addFiles(files);}});
  $('#composer').addEventListener('dragover',event=>{if([...(event.dataTransfer?.items||[])].some(item=>item.kind==='file')){event.preventDefault();$('#composer').classList.add('dropping');}});
  $('#composer').addEventListener('dragleave',()=>$('#composer').classList.remove('dropping'));
  $('#composer').addEventListener('drop',event=>{$('#composer').classList.remove('dropping');const files=[...(event.dataTransfer?.files||[])];if(files.length){event.preventDefault();addFiles(files);}});
  // Models a fetch added (a provider's own list), and dropping them when that provider is left.
  const fetchedModels=()=>[...$('#model').options].filter(o=>o.dataset.fetched).map(o=>o.value);
  function dropModels(ids){for(const o of [...$('#model').options])if(ids.includes(o.value))o.remove();syncPickers();}
  function ensureModel(model){if(!model)return;if(![...$('#model').options].some(x=>x.value===model))$('#model').add(new Option(model,model));$('#model').value=model;syncPickers();}
  // Grows with the text (CSS keeps it to a quarter of the window); an empty box keeps its default height (placeholder text does not count).
  function autosize(){const prompt=$('#prompt');prompt.style.height='auto';prompt.style.height=prompt.value?Math.min(200,Math.max(52,prompt.scrollHeight))+'px':'';}
  function setText(text){$('#prompt').value=text;autosize();store.emit('composer');}
  // 引用到输入框 from the right-click menu: the selection as a Markdown quote.
  function quote(text){const p=$('#prompt'),block=String(text).trim().split(/\r?\n/).map(line=>'> '+line).join('\n')+'\n\n';p.value=p.value.trim()?p.value.replace(/\s*$/,'\n\n')+block:block;autosize();p.focus();p.selectionStart=p.selectionEnd=p.value.length;input();store.emit('composer');}
  const isEmpty=()=>!$('#prompt').value.trim()&&!images.length;
  // Enter sends (or queues while running); with an empty box the send button stops the run.
  $('#composer').addEventListener('submit',event=>event.preventDefault());
  $('#composer').addEventListener('submit',guarded(toast,async event=>{event.preventDefault();if(store.running()&&isEmpty())await actions().stop();else await actions().sendMessage();}));
  $('#prompt').addEventListener('keydown',guarded(toast,async event=>{if(keydown(event))return;if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();await actions().sendMessage();}
    // While a task runs, Tab queues the message instead of 插话.
    else if(event.key==='Tab'&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&store.running()&&!isEmpty()){event.preventDefault();await actions().sendMessage(undefined,{queue:true});}}));
  $('#prompt').addEventListener('input',()=>{autosize();input();store.emit('composer');});
  // A narrower window or an opened side panel wraps the text onto more lines.
  let promptWidth=0;new ResizeObserver(([entry])=>{const width=Math.round(entry.contentRect.width);if(width!==promptWidth){promptWidth=width;if($('#prompt').value)autosize();}}).observe($('#prompt'));
  function setMode(mode){if(modes.some(m=>m.id===mode)&&$('#mode').value!==mode){$('#mode').value=mode;optionChanged();}}
  return{capture,imagesReady,quote,restore,clear,save,syncPickers,renderUsage,refreshModels,fetchedModels,dropModels,options,ensureModel,setText,isEmpty,setMode,addReference,
    focus:()=>$('#prompt').focus(),focusProject:()=>$('#home-project')?.focus(),
    initialize(){ready=true;syncPickers();renderModels();save();}};
}
