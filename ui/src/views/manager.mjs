// Workspace manager window: MCP servers, plugins, skills, usage, and Codex / Claude Code imports.
import { $, escape } from '../core/dom.mjs';

export function createManager({ store, api, toast, confirm }) {
  let page='plugins',lastImport='import',catalog=null,mcpRows=null,summary=null,query='',pluginFilter='installed',limit=50,scope='user',period='30d',busy=false,generation=0,editor=null;
  // Each import source is its own tab with its own list, selection and preview.
  const IMPORTS={
    import:{source:'codex',name:'Codex',note:'从本机 Codex 的 sessions / archived_sessions 读取历史。每次最多选择 20 条，先预览再导入；原文件保持不变。重复会话会跳过，导入的旧用量不计入 Claude 累计统计。',after:'导入后继续聊天使用当前 Claude 模型；Codex 原始模型、后台进程、加密思考和图片附件不会迁移。分支或回退版本使用最新日志，预览可核对轮次。'},
    'claude-import':{source:'claude',name:'Claude Code',note:'从本机 Claude Code 的 projects 目录读取历史，包括终端里的 claude 和 Claude 桌面版 Code 标签的会话。每次最多选择 20 条，先预览再导入；原文件保持不变。重复会话会跳过，导入的旧用量不计入累计统计。',after:'导入后继续聊天使用当前选择的模型，原来的问答作为上下文带上。子代理记录、图片附件和后台任务不会迁移；回退过的会话只导入最新的分支。'}
  };
  const imports=Object.fromEntries(Object.keys(IMPORTS).map(key=>[key,{list:null,preview:null,selected:new Set()}]));
  const isImport=name=>name in IMPORTS,current=()=>imports[page];
  const dialog=$('#manager-dialog'),content=$('#manager-content'),controls=$('#manager-controls');
  const project=()=>$('#manager-project').value||'';
  const format=value=>Number(value||0).toLocaleString();
  const currency=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:4}).format(value||0);
  function status(message,error=false){$('#manager-status').textContent=message;$('#manager-status').classList.toggle('error',error);}
  function tabs(){document.querySelectorAll('[data-manager-tab]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.managerTab===page)));}
  const scopeLabel=value=>({user:'用户范围',project:'当前项目',local:'项目本地'}[value]||value);
  function renderMcp(){
    content.innerHTML='<p class="manager-note">沿用 Claude CLI 的用户、项目和本地 MCP 配置。列表不会连接服务器；点击“检查连接”才进行健康检查。新增或移除从下次发送生效。</p>'+(mcpRows.length?mcpRows.map(row=>`<article class="manager-card"><div class="manager-card-copy"><h3>${escape(row.name)}<span class="manager-tag">${escape(row.type)}</span></h3><p>${escape(row.shadowed?'被更高优先级配置覆盖':row.status)}</p><small>${scopeLabel(row.scope)}</small></div><div class="manager-actions"><button class="destructive" data-mcp-remove="${escape(row.name)}" data-mcp-scope="${escape(row.scope)}">移除</button></div></article>`).join(''):'<div class="manager-empty">尚未发现 MCP 配置，点击“添加服务器”开始配置。</div>')+'<p class="manager-note">此列表显示原生 MCP 配置；插件携带的 MCP 由对应插件管理。项目服务器的批准和 OAuth 登录仍需在官方 Claude CLI 中完成。连接检查反映本次 CLI 检测结果。</p>';
  }
  function renderImport(){
    const info=IMPORTS[page],{list:importList,preview:importPreview,selected:importSelected}=current(),search=query.trim().toLowerCase(),items=(importList?.items||[]).filter(item=>`${item.title} ${item.cwd}`.toLowerCase().includes(search));
    content.innerHTML=`<p class="manager-note">${info.note}</p>`+(importPreview?`<div class="import-preview"><h3>导入预览</h3>${importPreview.items.map(item=>`<article><strong>${item.turns} 轮问答 · ${item.tools} 条工具记录</strong><small>${escape(item.cwd)} · ${escape(item.model||'未记录模型')}</small><p>${escape(item.first)}</p><p class="muted">最后回复：${escape(item.last||'无文本回复')}</p>${item.warnings?'<p class="error">存在 '+item.warnings+' 条无法解析的日志行，未导入这些行。</p>':''}</article>`).join('')}<button id="import-commit" class="manager-primary">确认导入 ${importPreview.items.length} 条会话</button></div>`:'')+(items.length?items.map(item=>`<article class="manager-card"><label class="skill-selection"><input type="checkbox" data-import-id="${escape(item.id)}" aria-label="选择 ${escape(item.title)}" ${importSelected.has(item.id)?'checked':''} ${item.imported?'disabled':''}></label><div class="manager-card-copy"><h3>${escape(item.title)}${item.imported?'<span class="manager-tag">已导入</span>':''}${item.archived?'<span class="manager-tag">已归档</span>':''}</h3><p>${escape(item.cwd)}</p><small>${new Date(item.updatedAt).toLocaleString()}</small></div></article>`).join(''):`<div class="manager-empty">没有找到匹配的 ${info.name} 对话。</div>`)+`<p class="manager-note">${info.after}</p>`;
    $('#import-commit')?.addEventListener('click',async()=>{const state=current(),token=state.preview.token;if(busy)return;busy=true;disabled();try{const result=await api(info.source+':import',token);const fresh=await api('state');store.load(fresh);state.selected.clear();state.preview=null;await load();status(`已导入 ${result.imported} 条，跳过 ${result.skipped} 条重复会话`);}catch(e){status(e.message,true);}finally{busy=false;disabled();}});
  }
  function tools(){
    $('#manager-project').closest('.manager-scope').hidden=isImport(page);
    if(isImport(page))controls.innerHTML=`<input id="extension-search" aria-label="搜索 ${IMPORTS[page].name} 对话" placeholder="搜索标题或项目路径" value="${escape(query)}"><button id="import-scan">重新扫描</button><button id="import-preview">预览所选（${current().selected.size}）</button>`;

    if(page==='mcp')controls.innerHTML='<button id="mcp-check">检查连接</button><button id="mcp-create" class="manager-primary">添加服务器</button>';

    if(page==='plugins')controls.innerHTML=`<input id="extension-search" aria-label="搜索插件" placeholder="搜索插件，或输入 plugin@marketplace" value="${escape(query)}"><select id="plugin-filter" aria-label="插件列表"><option value="installed" ${pluginFilter==='installed'?'selected':''}>已安装</option><option value="available" ${pluginFilter==='available'?'selected':''}>浏览市场</option></select><select id="plugin-scope" aria-label="插件安装范围"><option value="user">用户范围</option>${project()?'<option value="project">当前项目</option><option value="local">项目本地</option>':''}</select><button id="plugin-install-id">按名称安装</button><button id="marketplace-open">添加市场</button>`;
    if(page==='skills')controls.innerHTML=`<input id="extension-search" aria-label="搜索技能" placeholder="搜索技能名称、说明或来源" value="${escape(query)}"><select id="skill-mode" aria-label="技能加载方式"><option value="all">默认全部技能</option><option value="selected">只加载所选技能</option></select><button id="skill-import">导入文件夹</button><button id="skill-create" class="manager-primary">新建技能</button>`;
    if(page==='usage')controls.innerHTML=`<select id="usage-period" aria-label="统计时间范围"><option value="today">今天</option><option value="7d">近 7 天</option><option value="30d">近 30 天</option><option value="all">全部时间</option></select><button id="usage-export">导出 CSV</button>`;
    if($('#extension-search'))$('#extension-search').oninput=()=>{query=$('#extension-search').value;limit=50;render();};
    if(isImport(page)){const state=current();$('#import-scan').onclick=()=>{state.preview=null;load(true);};$('#import-preview').onclick=async()=>{if(busy)return;busy=true;disabled();status('正在读取所选会话…');try{state.preview=await api(IMPORTS[page].source+':preview',[...state.selected]);render();content.scrollTop=0;status('请核对预览，确认后导入');}catch(e){status(e.message,true);}finally{busy=false;disabled();}};}
    if(page==='plugins'){
      $('#plugin-filter').onchange=()=>{pluginFilter=$('#plugin-filter').value;limit=50;render();};
      $('#plugin-scope').value=project()?scope:'user';$('#plugin-scope').onchange=()=>{scope=$('#plugin-scope').value;render();};
      $('#plugin-install-id').onclick=()=>pluginAction('install',query.trim(),$('#plugin-scope').value);
      $('#marketplace-open').onclick=()=>{
        if($('#marketplace-form'))return;
        const form=document.createElement('form');form.id='marketplace-form';form.className='marketplace-form';form.innerHTML='<input id="marketplace-source" aria-label="市场地址" placeholder="GitHub owner/repo 或 HTTPS 市场地址" required><button type="submit">添加</button>';
        controls.append(form);form.onsubmit=event=>{event.preventDefault();perform(()=>api('extensions:marketplace',$('#marketplace-source').value.trim(),project()),'正在添加市场…','市场已添加');};$('#marketplace-source').focus();
      };
    }
    if(page==='skills'){
      $('#skill-mode').value=catalog?.selection?.skillMode||'all';
      $('#skill-mode').onchange=()=>perform(()=>api('skills:selection',$('#skill-mode').value,catalog?.selection?.selectedSkills||[]),'正在保存技能选择…','技能选择已保存，下次发送生效');
      $('#skill-create').onclick=()=>openEditor();
      $('#skill-import').onclick=()=>perform(()=>api('skills:import'),'正在导入技能…','技能列表已更新');
    }
    if(page==='usage'){$('#usage-period').value=period;$('#usage-period').onchange=()=>{period=$('#usage-period').value;load();};$('#usage-export').onclick=()=>api('usage:export',{period,projectId:project()}).catch(e=>status(e.message,true));}
    if(page==='mcp'){
      $('#mcp-create').onclick=()=>{$('#mcp-name').value='';$('#mcp-json').value='';$('#mcp-error').textContent='';$('#mcp-scope').value=project()?'local':'user';[...$('#mcp-scope').options].forEach(option=>option.disabled=option.value!=='user'&&!project());$('#mcp-dialog').showModal();$('#mcp-name').focus();};
      $('#mcp-check').onclick=async()=>{if(busy)return;busy=true;disabled();status('正在检查连接，可能需要一分钟…');const token=++generation;try{const rows=await api('mcp:check',project());if(token===generation){mcpRows=rows;render();status('连接检查完成');}}catch(e){if(token===generation)status(e.message,true);}finally{busy=false;disabled();}};
    }
    disabled();
  }
  function disabled(){document.querySelectorAll('#manager-content button,#manager-controls button,#manager-controls select,#manager-content input,#manager-project,#manager-refresh,[data-manager-tab],#manager-close').forEach(el=>el.disabled=busy||(el.matches?.('[data-import-id]')&&Boolean(current()?.list?.items.find(item=>item.id===el.dataset.importId)?.imported)));}
  function renderPlugins(){
    const list=pluginFilter==='installed'?catalog.installed:catalog.available.map(item=>catalog.installed.find(p=>p.id===item.id)||item);
    const search=query.trim().toLowerCase(),filtered=list.filter(item=>`${item.name} ${item.id} ${item.description} ${item.marketplace}`.toLowerCase().includes(search));
    content.innerHTML='<p class="manager-note">插件沿用 Claude CLI 的安装与启用配置。安装、更新后的能力在下次连接时加载；当前任务不重启。</p>'+(filtered.length?filtered.slice(0,limit).map(item=>`<article class="manager-card"><div class="manager-card-copy"><h3>${escape(item.name)}${item.installed?`<span class="manager-tag ${item.enabled?'enabled':''}">${item.enabled?'已启用':'已停用'}</span>`:''}</h3><p>${escape(item.description||'此插件没有提供描述')}</p><small>${escape(item.id)}${item.version?' · v'+escape(item.version):''}${item.installed?' · '+escape(item.scope):''}</small></div><div class="manager-actions">${item.installed?`<button data-plugin-action="${item.enabled?'disable':'enable'}" data-plugin-id="${escape(item.id)}" data-plugin-scope="${escape(project()?scope:item.scope)}">${item.enabled?'停用':'启用'}</button><button data-plugin-action="update" data-plugin-id="${escape(item.id)}" data-plugin-scope="${escape(item.scope)}">更新</button><button class="destructive" data-plugin-action="uninstall" data-plugin-id="${escape(item.id)}" data-plugin-scope="${escape(item.scope)}">卸载</button>`:`<button data-plugin-action="install" data-plugin-id="${escape(item.id)}">安装</button>`}</div></article>`).join(''):'<div class="manager-empty">'+(pluginFilter==='installed'?'尚未安装插件。切换到“浏览市场”，或输入插件名称安装。':'没有匹配的插件，可刷新列表或添加市场。')+'</div>')+(filtered.length>limit?`<button id="manager-more" class="manager-more">加载更多 · 已显示 ${limit} / ${filtered.length}</button>`:'');
    $('#manager-more')?.addEventListener('click',()=>{limit+=50;render();});
  }
  function renderSkills(){
    const search=query.trim().toLowerCase(),skills=catalog.skills.filter(skill=>`${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(search));
    const all=catalog.selection.skillMode!=='selected',selected=new Set(catalog.selection.selectedSkills||[]);
    content.innerHTML='<p class="manager-note">用户、项目和已启用插件的技能会显示在这里。本应用创建或导入的技能保存在独立技能库；技能选择从下次发送生效。</p>'+(skills.length?skills.map(skill=>`<article class="manager-card"><label class="skill-selection" title="是否加载到模型上下文"><input type="checkbox" data-skill-name="${escape(skill.name)}" ${all||selected.has(skill.name)?'checked':''} aria-label="加载 ${escape(skill.name)}"></label><div class="manager-card-copy"><h3>${escape(skill.name)}<span class="manager-tag">${escape(skill.source)}</span></h3><p>${escape(skill.description||'没有提供描述')}</p><small>${escape(skill.path)}</small></div><div class="manager-actions"><button data-skill-read="${escape(skill.id)}">${skill.owned?'编辑':'查看'}</button><button data-skill-open="${escape(skill.id)}">目录</button>${skill.owned?`<button class="destructive" data-skill-remove="${escape(skill.id)}">移除</button>`:''}</div></article>`).join(''):'<div class="manager-empty">没有发现技能。可创建新技能，或导入包含 SKILL.md 的文件夹。</div>')+'<p class="manager-note">“只加载所选技能”控制技能列表与 Skill 工具的可见性，不构成文件访问隔离。外部技能在此只读，原文件保持不变。</p>';
  }
  function renderUsage(){
    const s=summary;
    const values=[['累计 tokens',format(s.tokens),'输入、输出、缓存读取及写入'],['估算费用',currency(s.cost),'CLI 估算 · 非服务商账单'],['已记录轮次',format(s.turns),s.recordedSince?'开始记录：'+new Date(s.recordedSince).toLocaleDateString():'还没有使用记录'],['缓存读取 / 写入',format(s.cacheRead)+' / '+format(s.cacheWrite),'缓存也会计入累计 tokens']];
    const daily=s.daily||[],tokens=row=>row.input+row.output+row.cacheRead+row.cacheWrite,max=Math.max(1,...daily.map(tokens));
    content.innerHTML=`<div class="usage-kpis">${values.map(([label,value,note])=>`<div class="usage-kpi"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('')}</div><h3 class="usage-section-title">最近日期趋势 · tokens</h3><div class="usage-chart">${daily.length?`<svg viewBox="0 0 720 110" role="img" aria-label="每日 token 用量">${daily.map((day,i)=>{const width=720/daily.length,height=tokens(day)/max*100,bar=Math.min(36,Math.max(2,width-5));return`<rect x="${i*width+(width-bar)/2}" y="${105-height}" width="${bar}" height="${height}" rx="2"><title>${escape(day.date)} · ${format(tokens(day))} tokens</title></rect>`;}).join('')}</svg><div class="usage-chart-labels"><span>${daily[0].date}</span><span>${daily.at(-1).date}</span></div>`:'<p class="context-empty">此时间范围暂无用量记录</p>'}</div><h3 class="usage-section-title">按模型汇总</h3><div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存读取</th><th>缓存写入</th><th>估算费用</th></tr></thead><tbody>${s.models.length?s.models.map(m=>`<tr><td title="${escape(m.model)}">${escape(m.model)}</td><td>${format(m.input)}</td><td>${format(m.output)}</td><td>${format(m.cacheRead)}</td><td>${format(m.cacheWrite)}</td><td>${currency(m.cost)}</td></tr>`).join(''):'<tr><td colspan="6">暂无记录</td></tr>'}</tbody></table></div><p class="manager-note">统计来自本应用保存的 CLI 用量。模型累计返回值按增量计算，避免多轮重复累加；包含 CLI 报告的主任务与子任务调用。删除会话后，用量计数仍保留，不保留聊天正文。${s.partial?`其中 ${s.partial} 轮来自旧版或仅主任务统计，明细可能不完整。`:''}服务商账户额度未在此推算。</p>`;
  }
  function render(){if(isImport(page)){if(current().list)renderImport();}else if(page==='mcp'){if(mcpRows)renderMcp();}else if(page==='usage'){if(summary)renderUsage();}else if(catalog){page==='plugins'?renderPlugins():renderSkills();}disabled();}
  async function load(refresh=false){
    const token=++generation;status('正在读取…');$('#manager-refresh').disabled=true;
    try{
      const requestedPage=page;const data=isImport(requestedPage)?await api(IMPORTS[requestedPage].source+':list'):requestedPage==='mcp'?await api('mcp:list',project()):requestedPage==='usage'?await api('usage:summary',{period,projectId:project()}):await api('extensions:list',project(),refresh);
      if(token!==generation)return;if(isImport(requestedPage))imports[requestedPage].list=data;else if(requestedPage==='mcp')mcpRows=data;else if(requestedPage==='usage')summary=data;else catalog=data;tools();render();
      status(isImport(page)?`${current().list.items.length} 条可见历史 · ${current().list.home}`:page==='mcp'?`${mcpRows.length} 个 MCP 配置 · 列表不展示凭据`:page==='usage'?'本地累计统计 · 按所选项目及时间筛选':catalog.warning||`${catalog.installed.length} 个已安装插件 · ${catalog.skills.length} 个技能 · ${catalog.available.length} 个市场条目`,Boolean(catalog?.warning&&!['usage','mcp'].includes(page)&&!isImport(page)));
    }catch(e){if(token===generation){content.innerHTML='<div class="manager-empty">读取失败，请刷新重试。</div>';status(e.message,true);}}
    finally{if(token===generation)disabled();}
  }
  async function perform(action,pending,done){
    if(busy)return;busy=true;disabled();status(pending);
    try{await action();await load(true);status(done);}catch(e){status(e.message,true);}finally{busy=false;render();disabled();}
  }
  async function pluginAction(action,id,actionScope){
    if(!id)return status('请先输入插件名称或 plugin@marketplace',true);
    if(['install','uninstall','update'].includes(action)){
      const labels={install:'安装插件',uninstall:'卸载插件',update:'更新插件'};const scopeLabel={user:'用户范围',project:'当前项目',local:'项目本地'}[actionScope||scope]||actionScope||scope;
      const ok=await confirm({title:labels[action]+'？',description:action==='uninstall'?'从所选范围卸载插件，保留插件持久数据目录。':`将${action==='install'?'安装':'更新'}此插件及其声明的组件，下次连接时加载。`,preview:id+' · '+scopeLabel,label:labels[action],kind:action==='uninstall'?'danger':'neutral'});if(!ok)return;
    }
    await perform(()=>api('extensions:plugin',action,id,actionScope||scope,project()),'正在执行插件操作…','插件配置已更新，下次连接时生效');
  }
  async function openEditor(id){
    try{
      editor=id?await api('skills:read',id,project()):null;
      $('#skill-editor-title').textContent=editor?(editor.owned?'编辑技能':'查看技能'):'新建技能';$('#skill-create-fields').hidden=Boolean(editor);$('#skill-raw-wrap').hidden=!editor;
      $('#skill-name').value='';$('#skill-description').value='';$('#skill-body').value='';$('#skill-raw').value=editor?.text||'';$('#skill-raw').readOnly=Boolean(editor&&!editor.owned);$('#skill-save').hidden=Boolean(editor&&!editor.owned);$('#skill-editor-error').textContent='';$('#skill-dialog').showModal();(editor?$('#skill-raw'):$('#skill-name')).focus();
    }catch(e){status(e.message,true);}
  }
  content.onclick=event=>{
    const mcp=event.target.closest('[data-mcp-remove]');if(mcp)return(async()=>{const name=mcp.dataset.mcpRemove,scope=mcp.dataset.mcpScope;if(await confirm({title:'移除 MCP 服务器？',description:'移除此范围内的连接配置，不卸载服务器程序，也不删除会话。',preview:name+' · '+scopeLabel(scope),label:'移除服务器'}))await perform(()=>api('mcp:action','remove',name,scope,project()),'正在移除 MCP…','MCP 配置已移除，下次发送生效');})();

    const plugin=event.target.closest('[data-plugin-action]');if(plugin)return pluginAction(plugin.dataset.pluginAction,plugin.dataset.pluginId,plugin.dataset.pluginScope||$('#plugin-scope').value);
    const read=event.target.closest('[data-skill-read]');if(read)return openEditor(read.dataset.skillRead);
    const open=event.target.closest('[data-skill-open]');if(open)return api('skills:open',open.dataset.skillOpen,project()).catch(e=>status(e.message,true));
    const remove=event.target.closest('[data-skill-remove]');if(remove)(async()=>{if(await confirm({title:'移除技能？',description:'移除本应用技能库中的副本，不影响导入来源目录。',preview:remove.dataset.skillRemove.slice(6),label:'移除技能'}))await perform(()=>api('skills:remove',remove.dataset.skillRemove),'正在移除技能…','技能已移除');})();
  };
  content.onchange=event=>{
    const pick=event.target.closest('[data-import-id]');if(pick){const state=current();pick.checked?state.selected.add(pick.dataset.importId):state.selected.delete(pick.dataset.importId);state.preview=null;tools();render();return;}

    const checkbox=event.target.closest('[data-skill-name]');if(!checkbox)return;
    const names=new Set(catalog.selection.skillMode==='selected'?catalog.selection.selectedSkills:catalog.skills.map(skill=>skill.name));checkbox.checked?names.add(checkbox.dataset.skillName):names.delete(checkbox.dataset.skillName);
    perform(()=>api('skills:selection','selected',[...names]),'正在保存技能选择…','技能选择已保存，下次发送生效');
  };
  $('#mcp-close').onclick=$('#mcp-cancel').onclick=()=>{$('#mcp-dialog').close();$('#mcp-json').value='';};
  $('#mcp-dialog').addEventListener('close',()=>{$('#mcp-json').value='';});
  $('#mcp-form').onsubmit=async event=>{
    event.preventDefault();$('#mcp-save').disabled=true;$('#mcp-error').textContent='';
    try{await api('mcp:action','add',$('#mcp-name').value.trim(),$('#mcp-scope').value,project(),$('#mcp-json').value);$('#mcp-dialog').close();await load();status('MCP 配置已添加，下次发送生效');}catch(e){$('#mcp-error').textContent=e.message;}finally{$('#mcp-save').disabled=false;}
  };
  $('#skill-form').onsubmit=async event=>{
    event.preventDefault();$('#skill-save').disabled=true;$('#skill-editor-error').textContent='';
    try{await api('skills:save',editor?{id:editor.id,name:editor.folder,raw:$('#skill-raw').value}:{name:$('#skill-name').value.trim(),description:$('#skill-description').value,body:$('#skill-body').value});$('#skill-dialog').close();await load(true);status('技能已保存，下次发送生效');}
    catch(e){$('#skill-editor-error').textContent=e.message;}finally{$('#skill-save').disabled=false;}
  };
  $('#skill-close').onclick=$('#skill-editor-cancel').onclick=()=>$('#skill-dialog').close();
  // 'last-import' (the rail button) reopens whichever import tab was used last.
  async function open(pageName){
    page=pageName==='last-import'?lastImport:pageName;if(isImport(page))lastImport=page;$('#manager-title').textContent='工作空间';query='';limit=50;tabs();$('#manager-project').innerHTML='<option value="">全部项目 / 用户范围</option>'+store.state.projects.map(p=>`<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');$('#manager-project').value=store.currentProject()?.id||'';scope=project()?'project':'user';
    if(!dialog.open)dialog.showModal();content.innerHTML='<div class="manager-empty">正在读取…</div>';tools();await load();
  }
  document.querySelectorAll('[data-manager-tab]').forEach(button=>button.onclick=()=>{if(busy)return;page=button.dataset.managerTab;if(isImport(page))lastImport=page;query='';limit=50;tabs();tools();content.innerHTML='<div class="manager-empty">正在读取…</div>';load();});
  $('#manager-close').onclick=()=>dialog.close();$('#manager-project').onchange=()=>{query='';limit=50;scope=project()?'project':'user';load();};$('#manager-refresh').onclick=()=>load(true);
  return { open };
}
