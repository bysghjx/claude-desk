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
// Claude Desk's own wrap_up tool draws the box under the turn, not a step row.
export const WRAP_UP='mcp__desk__wrap_up';
export function splitTurn(turn){
  const tools=new Map((turn?.tools||[]).filter(t=>t.name!==WRAP_UP).map(t=>[t.id,t]));
  let items=Array.isArray(turn?.items)&&turn.items.length?turn.items:[...(turn?.thinking?[{type:'thinking',text:turn.thinking}]:[]),...(turn?.tools||[]).map(t=>({type:'tool',id:t.id})),...(turn?.answer?[{type:'text',text:turn.answer}]:[])];
  items=items.filter(item=>item.type==='tool'?tools.has(item.id):String(item.text||'').trim());
  let last=-1;items.forEach((item,i)=>{if(item.type==='tool')last=i;});
  const rest=items.slice(last+1);
  const work=[...items.slice(0,last+1),...rest.filter(i=>i.type==='thinking')].map(item=>item.type==='tool'?{...item,tool:tools.get(item.id)}:item);
  return{work,final:rest.filter(i=>i.type==='text').map(i=>i.text).join('\n\n')};
}
const STATE_LABELS={running:'运行中',error:'失败',interrupted:'已中断',approval:'等待批准'};
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
  return{
    className:`step step-${view.kind} ${tool.status||''}`,
    summary:`<span class="step-dot"></span><span class="step-verb">${escape(view.verb)}</span>${target?`<code class="step-target" title="${escape(target)}">${escape(firstLine(target).slice(0,240))}</code>`:''}${deltaHtml(added,removed)}${state?`<span class="step-state">${state}</span>`:''}`,
    body:body||'<p class="step-empty">没有更多信息</p>'
  };
}
export function changesHtml(changes,escape){
  if(!changes.length)return'';
  const added=changes.reduce((n,f)=>n+f.added,0),removed=changes.reduce((n,f)=>n+f.removed,0);
  return `<div class="turn-changes"><div class="turn-changes-head"><strong>${changes.length} 个文件已更改</strong>${deltaHtml(added,removed)}<button type="button" data-review-file="${escape(changes[0].path)}">审查改动</button></div>${changes.map(f=>`<button type="button" class="turn-change-row" data-review-file="${escape(f.path)}" title="${escape(f.path)}"><span class="change-name">${escape(baseName(f.path))}</span><span class="change-dir">${escape(f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')):'')}</span>${deltaHtml(f.added,f.removed)}</button>`).join('')}</div>`;
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
