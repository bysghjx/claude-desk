// Pure helpers that turn a recorded turn into Codex-style rows: commands, reads,
// edits with line diffs, plans. No DOM access, so they run in Node tests as well.
const slash=value=>String(value||'').replace(/\\/g,'/');
const baseName=value=>slash(value).split('/').filter(Boolean).pop()||slash(value);
const lines=text=>{const value=String(text??'');return value===''?[]:value.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n');};
export function lineDiff(before,after){
  const x=lines(before),y=lines(after);let start=0,end=0;
  while(start<x.length&&start<y.length&&x[start]===y[start])start++;
  while(end<x.length-start&&end<y.length-start&&x[x.length-1-end]===y[y.length-1-end])end++;
  const a=x.slice(start,x.length-end),b=y.slice(start,y.length-end),out=x.slice(0,start).map(text=>({type:' ',text}));
  if(a.length*b.length<=250000){
    const n=a.length,m=b.length,dp=Array.from({length:n+1},()=>new Uint32Array(m+1));
    for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
    let i=0,j=0;while(i<n&&j<m){if(a[i]===b[j]){out.push({type:' ',text:a[i]});i++;j++;}else if(dp[i+1][j]>=dp[i][j+1])out.push({type:'-',text:a[i++]});else out.push({type:'+',text:b[j++]});}
    while(i<n)out.push({type:'-',text:a[i++]});while(j<m)out.push({type:'+',text:b[j++]});
  }else{for(const text of a)out.push({type:'-',text});for(const text of b)out.push({type:'+',text});}
  out.push(...x.slice(x.length-end).map(text=>({type:' ',text})));
  return{lines:out,added:out.filter(l=>l.type==='+').length,removed:out.filter(l=>l.type==='-').length};
}
// Keep changed lines with three lines of context; long unchanged runs collapse to a marker.
export function compact(diff,context=3){
  const keep=new Set();diff.forEach((l,i)=>{if(l.type==='+'||l.type==='-'||l.type==='@')for(let k=i-context;k<=i+context;k++)keep.add(k);});
  const out=[];let skipped=false;diff.forEach((l,i)=>{if(keep.has(i)){out.push(l);skipped=false;}else if(!skipped){out.push({type:'…',text:''});skipped=true;}});
  return out;
}
export function parsePatch(text){
  const files=[];let file=null;
  for(const line of String(text||'').replace(/\r\n/g,'\n').split('\n')){
    const head=line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);if(head){file={path:head[2].trim(),kind:head[1],lines:[],added:0,removed:0};files.push(file);continue;}
    const move=line.match(/^\*\*\* Move to: (.+)$/);if(move&&file){file.path=move[1].trim();continue;}
    if(!file||line.startsWith('*** '))continue;
    if(line.startsWith('+')){file.added++;file.lines.push({type:'+',text:line.slice(1)});}
    else if(line.startsWith('-')){file.removed++;file.lines.push({type:'-',text:line.slice(1)});}
    else if(line.startsWith('@@'))file.lines.push({type:'@',text:line});
    else file.lines.push({type:' ',text:line.replace(/^ /,'')});
  }
  return files;
}
const firstLine=text=>String(text||'').trim().split('\n')[0];
function codexCommand(input){
  const text=String(input?.text??input?.code??'');
  const match=text.match(/exec_command\(\{\s*cmd:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`)/);
  if(match){try{return JSON.parse(match[1][0]==='"'?match[1]:'"'+match[1].slice(1,-1).replace(/"/g,'\\"')+'"');}catch{return match[1].slice(1,-1);}}
  return'';
}
const todoList=items=>(Array.isArray(items)?items:[]).map(x=>({text:String(x.content||x.step||x.activeForm||''),status:x.status==='completed'?'done':x.status==='in_progress'?'active':'pending'}));
// Claude Code and imported Codex tools map to one short verb + target row.
export function toolView(tool){
  const name=String(tool?.name||''),input=tool?.input&&typeof tool.input==='object'?tool.input:{};
  const view=(kind,verb,target='',extra={})=>({kind,verb,target:String(target||''),files:[],...extra});
  const fileDiff=(path,before,after)=>({path,...lineDiff(before,after)});
  const mcp=name.match(/^mcp__(.+?)__(.+)$/);if(mcp)return view('other','调用 '+mcp[1],mcp[2]);
  switch(name){
    case'Bash':return view('command','运行',input.command);
    case'BashOutput':return view('command','查看后台命令',input.bash_id);
    case'KillShell':case'KillBash':return view('command','停止后台命令',input.shell_id||input.bash_id);
    case'Read':return view('read','读取',input.file_path);
    case'Edit':return view('edit','编辑',input.file_path,{files:[fileDiff(input.file_path,input.old_string,input.new_string)]});
    case'MultiEdit':{const diffs=(input.edits||[]).map(e=>lineDiff(e.old_string,e.new_string));return view('edit','编辑',input.file_path,{files:[{path:input.file_path,lines:diffs.flatMap((d,i)=>i?[{type:'@',text:'@@'},...d.lines]:d.lines),added:diffs.reduce((n,d)=>n+d.added,0),removed:diffs.reduce((n,d)=>n+d.removed,0)}]});}
    case'Write':return view('edit','写入',input.file_path,{files:[fileDiff(input.file_path,'',input.content)]});
    case'NotebookEdit':return view('edit','编辑',input.notebook_path,{files:[fileDiff(input.notebook_path,'',input.new_source)]});
    case'Grep':return view('search','搜索',input.pattern+(input.path?' · '+baseName(input.path):''));
    case'Glob':return view('search','查找文件',input.pattern);
    case'LS':return view('read','列出目录',input.path);
    case'WebSearch':case'web_search':return view('web','搜索网页',input.query||input.queries?.[0]);
    case'WebFetch':return view('web','打开网页',input.url);
    case'TodoWrite':return view('plan','更新计划','',{todos:todoList(input.todos)});
    case'update_plan':return view('plan','更新计划','',{todos:todoList(input.plan)});
    case'Task':case'Agent':return view('agent','委派子智能体',input.description||input.subagent_type);
    case'spawn_agent':return view('agent','启动子智能体',input.task_name);
    case'ExitPlanMode':return view('plan','提交计划','',{plan:input.plan});
    case'AskUserQuestion':case'request_user_input':case'request_user_input_async':return view('question','提问',firstLine(input.questions?.[0]?.question||input.questions?.[0]?.title));
    case'Skill':return view('other','使用技能',input.skill||input.command);
    case'exec_command':case'shell':case'shell_command':case'local_shell':return view('command','运行',Array.isArray(input.command)?input.command.join(' '):input.cmd||input.command);
    case'write_stdin':return view('command','向终端输入',input.chars||'');
    case'wait':case'sleep':case'wait_agent':return view('other','等待',input.duration_ms?Math.round(input.duration_ms/1000)+'s':'');
    case'apply_patch':{const files=parsePatch(input.text??input.input??input.patch);return view('edit','编辑',files.map(f=>baseName(f.path)).join(', '),{files});}
    case'exec':{
      const source=String(input.text??input.code??'');
      if(source.includes('*** Begin Patch')){const files=parsePatch(source);return view('edit','编辑',files.map(f=>baseName(f.path)).join(', '),{files});}
      const command=codexCommand(input);return command?view('command','运行',command):view('command','运行脚本',input.title||firstLine(source));
    }
    case'js':return view('command','运行脚本',input.title||firstLine(input.code));
    case'view_image':return view('read','查看图片',input.path);
    default:return view('other',name||'工具',input.command||input.file_path||input.path||input.pattern||input.query||input.url||input.description||input.title||'');
  }
}
export function relativePath(file,cwd){
  const target=slash(file),rootPath=slash(cwd).replace(/\/+$/,'');
  if(rootPath&&target.toLowerCase().startsWith(rootPath.toLowerCase()+'/'))return target.slice(rootPath.length+1);
  return target;
}
export function fileChanges(turn,cwd){
  const map=new Map();
  for(const tool of turn?.tools||[]){
    if(tool.status==='error')continue;
    for(const file of toolView(tool).files){
      if(!file.path)continue;const key=relativePath(file.path,cwd),entry=map.get(key.toLowerCase())||{path:key,added:0,removed:0};
      entry.added+=file.added||0;entry.removed+=file.removed||0;map.set(key.toLowerCase(),entry);
    }
  }
  return[...map.values()];
}
// Claude Desk's own tools draw cards under the turn, not step rows.
export const WRAP_UP='mcp__desk__wrap_up',PROPOSE='mcp__desk__propose_session';
const CARD_TOOLS=new Set([WRAP_UP,PROPOSE]);
// A turn cut where Claude read 插话: each part is the work up to the next 插话, which shows in the
// conversation like a message of its own, followed by what Claude wrote back before its next step
// (reply); the last part ends with the final answer. 插话 not read yet comes back separately.
export function turnParts(turn){
  const tools=new Map((turn?.tools||[]).filter(t=>!CARD_TOOLS.has(t.name)).map(t=>[t.id,t])),steers=new Map((turn?.steers||[]).map(s=>[s.id,s]));
  const items=Array.isArray(turn?.items)&&turn.items.length?turn.items:[...(turn?.thinking?[{type:'thinking',text:turn.thinking}]:[]),...(turn?.tools||[]).map(t=>({type:'tool',id:t.id})),...(turn?.answer?[{type:'text',text:turn.answer}]:[])];
  const parts=[{steer:null,items:[]}],placed=new Set();
  for(const item of items){
    if(item.type==='steer'){if(steers.has(item.id)&&!placed.has(item.id)){placed.add(item.id);parts.push({steer:steers.get(item.id),items:[]});}}
    else if(item.type==='tool'?tools.has(item.id):String(item.text||'').trim())parts.at(-1).items.push(item.type==='tool'?{...item,tool:tools.get(item.id)}:item);
  }
  for(const p of parts.slice(1)){const first=p.items.findIndex(i=>i.type==='tool');if(first<0)continue;p.reply=p.items.slice(0,first).filter(i=>i.type==='text').map(i=>i.text).join('\n\n');p.items=p.items.filter((i,n)=>n>first||i.type!=='text');}
  const last=parts.at(-1).items;let at=-1;last.forEach((item,i)=>{if(item.type==='tool')at=i;});
  const rest=last.slice(at+1);parts.at(-1).items=[...last.slice(0,at+1),...rest.filter(i=>i.type==='thinking'||i.type==='narration')];
  return{parts:parts.map(p=>({steer:p.steer,reply:p.reply||'',work:p.items})),final:rest.filter(i=>i.type==='text').map(i=>i.text).join('\n\n'),pending:(turn?.steers||[]).filter(s=>s.status==='pending'&&!placed.has(s.id))};
}
// Every step in order, 插话 in its place, and the final answer.
export function splitTurn(turn){
  const {parts,final}=turnParts(turn);
  return{work:parts.flatMap(p=>p.steer?[{type:'steer',id:p.steer.id,steer:p.steer},...(p.reply?[{type:'text',text:p.reply}]:[]),...p.work]:p.work),final};
}
const STATE_LABELS={running:'运行中',error:'失败',interrupted:'已中断',approval:'等待批准'};
const STEP_ICONS={
  command:'<rect x="2" y="2.5" width="14" height="13" rx="3"/><path d="m5 6 2.5 2.5L5 11m5 0h3"/>',
  read:'<path d="M4 2.5h6l4 4v9H4Z"/><path d="M10 2.5v4h4M6.5 9h5M6.5 12h5"/>',
  image:'<rect x="2" y="4" width="11" height="11" rx="2"/><path d="M6 4V2h10v10h-3M3 12l3-3 3 3 2-2 2 2"/><circle cx="6" cy="7" r=".8"/>',
  edit:'<path d="m4 11 8-8 3 3-8 8-4 1ZM10 5l3 3M3 16h12"/>',
  search:'<circle cx="7.5" cy="7.5" r="5"/><path d="m11.5 11.5 4 4"/>',
  web:'<circle cx="9" cy="9" r="7"/><ellipse cx="9" cy="9" rx="3" ry="7"/><path d="M2 9h14"/>',
  plan:'<path d="m2 5 1.5 1.5L6 4M8 5h8M2 10h3M8 10h8M2 15h3M8 15h8"/>',
  agent:'<circle cx="6" cy="6" r="3"/><path d="M1.5 15v-1a4.5 4.5 0 0 1 9 0v1M12 3a3 3 0 0 1 0 6m1 2a4 4 0 0 1 3.5 4"/>',
  question:'<path d="M3 3h12v9H8l-4 3v-3H3Z"/><path d="M7 6a2 2 0 1 1 3 1.7L9 8.5M9 10h.01"/>',
  other:'<rect x="3" y="3" width="12" height="12" rx="3"/><path d="M6 9h.01M9 9h.01M12 9h.01"/>'
};
function stepLabel(tool,view){
  const done=!['running','error','interrupted','approval'].includes(tool.status);
  if(tool.name==='view_image')return done?'已查看 1 张图像':'查看图像';
  const labels={command:['运行了命令','运行命令'],read:['读取了文件','读取文件'],edit:[view.files.length>1?`编辑了 ${view.files.length} 个文件`:'编辑了文件','编辑文件'],search:[view.verb==='查找文件'?'查找了文件':'搜索了内容','搜索内容'],web:[view.verb==='打开网页'?'打开了网页':'搜索了网页',view.verb],plan:[view.plan?'提交了计划':'更新了计划',view.verb],agent:['启动了子智能体','启动子智能体'],question:['提出了问题','提问'],other:[view.verb==='等待'?'已等待':view.verb==='使用技能'?'使用了技能':'调用了工具',view.verb]};
  const label=(labels[view.kind]||labels.other)[done?0:1];
  return tool.status==='running'?'正在'+label:label;
}
export const deltaHtml=(added,removed)=>added||removed?`<span class="step-delta"><span class="plus">+${added}</span><span class="minus">−${removed}</span></span>`:'';
function diffHtml(diff,escape,limit=400){
  const shown=compact(diff.lines||[]),cut=shown.slice(0,limit);
  return `<pre class="step-diff">${cut.map(l=>l.type==='…'?'<span class="diff-gap">⋯</span>\n':`<span class="${l.type==='+'?'diff-add':l.type==='-'?'diff-remove':l.type==='@'?'diff-hunk':''}">${l.type==='@'?escape(l.text):escape((l.type===' '?' ':l.type)+' '+l.text)}\n</span>`).join('')}${shown.length>limit?`<span class="diff-gap">… 另有 ${shown.length-limit} 行未显示</span>`:''}</pre>`;
}
// One tool call as {className, summary, body}; the caller keeps the <details>
// element so its open state survives updates.
export function stepParts(tool,{escape,cwd}){
  const view=toolView(tool),added=view.files.reduce((n,f)=>n+(f.added||0),0),removed=view.files.reduce((n,f)=>n+(f.removed||0),0);
  const target=view.kind==='edit'||view.kind==='read'?view.files.length>1?view.target:relativePath(view.target,cwd):view.target;
  const output=tool.output?`<pre class="step-output">${escape(String(tool.output).slice(-20000))}</pre>`:'';
  let body='';
  if(view.kind==='command')body=`<pre class="step-command">$ ${escape(view.target)}</pre>${output}`;
  else if(view.kind==='edit')body=view.files.map(f=>`<div class="step-file"><span>${escape(relativePath(f.path,cwd))}</span>${deltaHtml(f.added,f.removed)}</div>${diffHtml(f,escape)}`).join('')+(tool.status==='error'?output:'');
  else if(view.todos)body=`<ul class="step-todos">${view.todos.map(t=>`<li class="${t.status}">${escape(t.text)}</li>`).join('')}</ul>`;
  else body=`${Object.keys(tool.input||{}).length?`<pre class="step-input">${escape(JSON.stringify(tool.input,null,2))}</pre>`:''}${view.plan?`<pre class="step-output">${escape(view.plan)}</pre>`:''}${output}`;
  const state=STATE_LABELS[tool.status]||'';
  const icon=STEP_ICONS[tool.name==='view_image'?'image':view.kind]||STEP_ICONS.other;
  const detailHead=`<div class="step-detail-head"><span>${escape(view.verb)}</span>${target&&view.kind!=='command'?`<code>${escape(target)}</code>`:''}${deltaHtml(added,removed)}</div>`;
  return{
    className:`step step-${view.kind} ${tool.status||''}`,
    summary:`<span class="step-icon" aria-hidden="true"><svg viewBox="0 0 18 18">${icon}</svg></span><span class="step-label">${escape(stepLabel(tool,view))}</span>${state?`<span class="step-state">${state}</span>`:''}`,
    body:detailHead+(body||'<p class="step-empty">没有更多信息</p>')
  };
}
// The sub-agent an Agent / Task step started, when Claude Desk recorded one.
export function agentOf(turn,tool){
  const id=tool?.id;if(!id)return null;
  return(turn?.subagents||[]).find(a=>a.toolUseId===id||a.id===id||a.aliases?.includes(id))||null;
}
// The Agent tool hands back the sub-agent's report inside a frame (notes, an indented
// report, agentId and usage lines); keep the report.
export function agentReport(output){
  let text=String(output||'');
  if(/^\s*\[/.test(text))try{const blocks=JSON.parse(text);if(Array.isArray(blocks))text=blocks.map(b=>typeof b==='string'?b:b?.text||'').join('\n');}catch{}
  const start=text.indexOf('The report follows:');if(start>=0)text=text.slice(text.indexOf('\n',start)+1);
  text=text.replace(/<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>/g,'').replace(/\n[ \t]*agentId: [\s\S]*$/,'').replace(/<usage>[\s\S]*?<\/usage>/g,'');
  const rows=text.replace(/\r\n/g,'\n').split('\n');
  if(rows.some(l=>l.trim())&&rows.every(l=>!l.trim()||l.startsWith('  ')))text=rows.map(l=>l.slice(2)).join('\n');
  return text.trim();
}
const AGENT_LIVE=new Set(['running','waiting','thinking','generating','tool','approval','paused']);
const AGENT_STATES={running:'运行中',waiting:'等待中',thinking:'思考中',generating:'生成中',tool:'执行工具',approval:'等待批准',paused:'已暂停',error:'失败',stopped:'已停止',interrupted:'已中断',ended:'已结束'};
// A sub-agent's steps in the order they came (thinking, notes, tool calls) and its conclusion:
// the report the Agent tool returned, the summary of a finished background agent, or while
// it runs the text after its last step.
export function agentWork(agent,tool){
  const tools=new Map((agent?.tools||[]).map(t=>[t.id,t]));
  const items=agent?.items?.length?agent.items:[...(agent?.thinking?[{type:'thinking',text:agent.thinking}]:[]),...(agent?.tools||[]).map(t=>({type:'tool',id:t.id})),...(agent?.answer?[{type:'text',text:agent.answer}]:[])];
  const work=[];
  for(const item of items)if(item.type==='tool'){if(tools.has(item.id))work.push({...item,tool:tools.get(item.id)});}else if(String(item.text||'').trim())work.push(item);
  let at=-1;work.forEach((item,i)=>{if(item.type==='tool')at=i;});
  const tail=work.slice(at+1),text=tail.filter(i=>i.type==='text').map(i=>i.text).join('\n\n').trim();
  const background=agent?.background||tool?.input?.run_in_background;
  const report=!background&&tool&&['done','error'].includes(tool.status)?agentReport(tool.output):'';
  const finished=agent&&!AGENT_LIVE.has(agent.status);
  const final=report||(finished&&agent.summary?String(agent.summary).trim():'')||text;
  // Notes after the last step stay steps unless they are the conclusion itself.
  const notes=tail.filter(i=>i.type==='thinking'||i.type==='narration'||(i.type==='text'&&final!==text&&i.text.trim()!==final));
  return{work:[...work.slice(0,at+1),...notes],final,live:Boolean(agent&&AGENT_LIVE.has(agent.status))};
}
// The Agent step's row and the parts of its body above the sub-agent's own steps.
export function agentParts(tool,agent,{escape}){
  const view=toolView(tool),input=tool?.input&&typeof tool.input==='object'?tool.input:{};
  const {work,final,live}=agentWork(agent,tool),steps=work.filter(i=>i.type==='tool').length;
  const status=agent?AGENT_STATES[agent.status]||'':STATE_LABELS[tool.status]||'';
  const running=live||['running','approval'].includes(tool.status);
  const label=running?(steps?`子智能体正在工作 · 已 ${steps} 步`:'正在启动子智能体'):steps?`子智能体完成了 ${steps} 个步骤`:'启动了子智能体';
  const icon=STEP_ICONS.agent;
  const meta=[agent?.type||input.subagent_type,agent?.background||input.run_in_background?'后台':'',agent?.usage?.totalTokens?`${Number(agent.usage.totalTokens).toLocaleString()} tokens`:''].filter(Boolean);
  return{
    className:`step step-agent ${running?'running':tool.status||''}${agent?.status==='error'?' error':''}`,
    summary:`<span class="step-icon" aria-hidden="true"><svg viewBox="0 0 18 18">${icon}</svg></span><span class="step-label">${escape(label)}</span>${view.target?`<span class="step-target">${escape(view.target)}</span>`:''}${status&&status!=='已完成'?`<span class="step-state">${escape(status)}</span>`:''}`,
    head:`<div class="step-detail-head"><span>${escape(view.verb)}</span>${view.target?`<code>${escape(view.target)}</code>`:''}${meta.map(m=>`<span class="agent-step-meta">${escape(m)}</span>`).join('')}</div>`,
    prompt:String(input.prompt||agent?.description||''),
    work,final,
    empty:work.length?'':running?'已启动，等待子智能体的第一步':'没有记录到子智能体的步骤'
  };
}
// The card under a finished turn: the files it edited, 撤销 / 重做 for them (`undo`
// is 'ready' with a snapshot from before the turn, 'undone' after an undo) and
// 查看变更. Three rows show; the rest fold under 再显示.
const CHANGES_ICON='<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="3.5"/><path d="M10 6v5M7.5 8.5h5M7.5 13.5h5"/></svg>';
const UNDO_ICON='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6.5h6a3.5 3.5 0 0 1 0 7H7M3.5 6.5 6 4M3.5 6.5 6 9"/></svg>';
// Consecutive steps of one kind fold into one row such as 运行了 4 个命令; thinking
// between them stays inside, thinking after the last one stays outside. Returns
// {index} for a single work item or {kind, indices, count, running} for a group.
const GROUPED={command:(n,f)=>`运行了 ${n} 个命令`,read:(n,f)=>`读取了 ${f} 个文件`,edit:(n,f)=>`编辑了 ${f} 个文件`,search:(n,f)=>`搜索了 ${n} 次`,web:(n,f)=>`访问了 ${n} 次网页`};
const RUNNING_GROUP={command:'正在运行命令',read:'正在读取文件',edit:'正在编辑文件',search:'正在搜索',web:'正在访问网页'};
export function groupSteps(work){
  const out=[];let run=null;
  const flush=()=>{
    if(!run)return;
    const tail=[];while(work[run.indices.at(-1)].type==='thinking')tail.unshift(run.indices.pop());
    if(run.count>=2)out.push(run);else out.push(...run.indices.map(index=>({index})));
    out.push(...tail.map(index=>({index})));run=null;
  };
  work.forEach((item,index)=>{
    const view=item.type==='tool'&&item.tool?toolView(item.tool):null,kind=view&&GROUPED[view.kind]?view.kind:null;
    if(kind){
      if(run&&run.kind!==kind)flush();
      run||={kind,indices:[],count:0,running:false,files:new Set()};
      run.indices.push(index);run.count++;
      if(['running','approval'].includes(item.tool.status))run.running=true;
      for(const file of view.files.length?view.files.map(f=>f.path):[view.target])if(file)run.files.add(String(file).toLowerCase());
    }else if(item.type==='thinking'&&run)run.indices.push(index);
    else{flush();out.push({index});}
  });
  flush();return out;
}
export function groupSummaryHtml(group){
  const label=group.running?`${RUNNING_GROUP[group.kind]} · 已 ${group.count} 步`:GROUPED[group.kind](group.count,group.files.size||group.count);
  return `<span class="step-icon" aria-hidden="true"><svg viewBox="0 0 18 18">${STEP_ICONS[group.kind]||STEP_ICONS.other}</svg></span><span class="step-label">${label}</span><svg class="step-group-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 3 3 3-3 3"/></svg>`;
}
export function changesHtml(changes,escape,{turnId='',undo='',disabled=false}={}){
  if(!changes.length)return'';
  const added=changes.reduce((n,f)=>n+f.added,0),removed=changes.reduce((n,f)=>n+f.removed,0),undone=undo==='undone';
  const row=f=>`<button type="button" class="turn-change-row" data-review-file="${escape(f.path)}" title="${escape(f.path)}"><span class="change-path"><span class="change-dir">${escape(f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')+1):'')}</span><span class="change-name">${escape(baseName(f.path))}</span></span>${deltaHtml(f.added,f.removed)}</button>`;
  const action=undo&&turnId?`<button type="button" class="changes-undo" data-undo-turn="${escape(turnId)}"${undone?' data-redo="1"':''}${disabled?' disabled title="运行结束后可用"':''}>${undone?'重做':'撤销'}${UNDO_ICON}</button>`:'';
  const more=changes.length>3?`<details class="changes-more"><summary><span class="more-closed">再显示 ${changes.length-3} 个文件</span><span class="more-open">收起</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg></summary>${changes.slice(3).map(row).join('')}</details>`:'';
  return `<div class="turn-changes${undone?' undone':''}"><div class="turn-changes-head"><span class="changes-icon">${CHANGES_ICON}</span><div class="changes-title"><strong>${undone?`已撤销 ${changes.length} 个文件的改动`:`已编辑 ${changes.length} 个文件`}</strong>${deltaHtml(added,removed)}</div><div class="changes-actions">${action}<button type="button" class="changes-review" data-review-file="${escape(changes[0].path)}">查看变更</button></div></div>${changes.slice(0,3).map(row).join('')}${more}</div>`;
}

// The task list Claude keeps, as of the end of `turns`: TodoWrite replaces the
// whole list; TaskCreate / TaskUpdate add and change one task at a time.
const TASK_TOOLS=new Set(['TodoWrite','TaskCreate','TaskUpdate']);
const taskStatus=status=>status==='completed'?'done':status==='in_progress'?'active':'pending';
export function taskList(turns){
  let items=[];const byId=new Map();
  for(const turn of turns||[])for(const tool of turn?.tools||[]){
    const input=tool?.input&&typeof tool.input==='object'?tool.input:{};
    if(tool.name==='TodoWrite'){items=todoList(input.todos);byId.clear();}
    else if(tool.name==='TaskCreate'&&tool.status!=='error'){
      const output=String(tool.output||''),id=(output.match(/#(\d+)/)||output.match(/"id"\s*:\s*"?(\d+)/)||output.match(/(\d+)/))?.[1]||String(byId.size+1),item={text:String(input.subject||''),status:'pending'};
      byId.set(id,item);items.push(item);
    }
    else if(tool.name==='TaskUpdate'){
      const item=byId.get(String(input.taskId));if(!item)continue;
      if(input.status==='deleted'){items=items.filter(x=>x!==item);byId.delete(String(input.taskId));continue;}
      if(input.subject)item.text=String(input.subject);if(input.status)item.status=taskStatus(input.status);
    }
  }
  return items.filter(x=>x.text);
}
// Shown under the latest turn only, and only when that turn touched the list.
export function taskListHtml(turns,escape){
  const latest=turns?.at(-1);if(!(latest?.tools||[]).some(t=>TASK_TOOLS.has(t.name)))return'';
  const items=taskList(turns);if(!items.length)return'';
  const done=items.filter(x=>x.status==='done').length;
  return `<section class="task-list" aria-label="任务清单"><div class="task-list-head"><span>任务</span><span>${done}/${items.length}</span></div><ol>${items.map(x=>`<li class="task-${x.status}"><span class="task-mark" aria-hidden="true"></span><span>${escape(x.text)}</span></li>`).join('')}</ol></section>`;
}
// Buttons answer the question, so they only work on the newest turn of an idle conversation.
export function wrapUpHtml(turn,{escape,latest,threadActive}){
  const box=turn?.wrapUp;if(!box?.recap||turn.status==='running')return'';
  const live=latest&&!threadActive&&box.ask&&box.actions?.length;
  return `<section class="wrap-up" aria-label="本轮小结"><p class="wrap-recap">${escape(box.recap)}</p>${box.ask?`<p class="wrap-ask">${escape(box.ask)}</p>`:''}${live?`<div class="wrap-actions">${box.actions.map((label,i)=>`<button type="button" class="${i?'secondary':'primary'}" data-wrap-reply="${escape(label)}">${escape(label)}</button>`).join('')}</div>`:''}</section>`;
}
// Conversations Claude proposed with propose_session. A started one links to its conversation.
export function proposalsHtml(turn,{escape}){
  const list=(turn?.proposals||[]).filter(p=>p.status!=='dismissed');if(!list.length)return'';
  return list.map(p=>`<section class="proposal-card" aria-label="提议的新会话"><div class="proposal-head"><span class="proposal-kicker">提议新会话</span><strong>${escape(p.title)}</strong></div><details class="proposal-brief"><summary>任务说明</summary><div>${escape(p.prompt)}</div></details><div class="proposal-actions">${p.status==='started'?`<button type="button" class="secondary" data-open-thread="${escape(p.threadId)}">打开会话</button><span class="proposal-state">已开始</span>`:`<button type="button" class="primary" data-proposal-start="${escape(p.id)}">开始</button><button type="button" class="secondary" data-proposal-dismiss="${escape(p.id)}">不用了</button>`}</div></section>`).join('');
}
