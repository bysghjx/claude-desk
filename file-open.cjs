// Files named in a reply (inline code or a link): which file is meant, and how a click opens it.
// Text inside the conversation's folder shows in the split view; anything else opens in its own
// app, except programs and scripts, which are only shown in the file manager.
const fs=require('node:fs');
const path=require('node:path');
const {within,readProjectFile}=require('./project-files.cjs');

const RUNNABLE=new Set(['exe','com','bat','cmd','ps1','psm1','psd1','ps1xml','psc1','vbs','vbe','js','jse','mjs','cjs','wsf','wsh','msi','msp','mst','scr','hta','lnk','url','pif','reg','cpl','jar','application','appref-ms','scf','inf','sct','msc','gadget','vb','dll','sys','drv','ocx','appx','msix','appinstaller','settingcontent-ms','library-ms','search-ms','diagcab','xll','iqy','slk']);
// Opened in their own app even when they are text: a page in the browser, not its source.
const DOCUMENTS=new Set(['html','htm','svg','pdf']);
const ext=file=>path.extname(file).slice(1).toLowerCase();

const PATH_KEYS=['file_path','notebook_path','path','filePath','cwd','directory','workdir'];
const CD_RE=/(?:^|[;&|\n]\s*)(?:cd(?:\s+\/d)?|pushd|Set-Location)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|\r\n]+))/gi;
function pushHint(list,seen,value,base){
  if(typeof value!=='string')return;
  const trimmed=value.trim();if(!trimmed||trimmed.length>2000||trimmed.includes('\0'))return;
  const resolved=path.isAbsolute(trimmed)?trimmed:base?path.resolve(base,trimmed):'';
  if(!resolved)return;
  const key=resolved.toLowerCase();if(seen.has(key))return;seen.add(key);list.push(resolved);
}
function hintsFromTools(tools,base,list,seen){
  for(const tool of [...(tools||[])].reverse()){
    const input=tool?.input;if(!input||typeof input!=='object')continue;
    for(const key of PATH_KEYS)pushHint(list,seen,input[key],base);
    if(typeof input.command==='string')for(const m of input.command.matchAll(CD_RE))pushHint(list,seen,m[1]||m[2]||m[3],base);
  }
}
// Collects candidate file and working-directory paths from tool calls, clicked turn first.
function collectHints(thread,turnId){
  if(!thread)return[];
  const list=[],seen=new Set(),base=thread.cwd||'',turns=Array.isArray(thread.turns)?thread.turns:[];
  const picked=turnId&&turns.find(t=>t.id===turnId),ordered=picked?[picked]:[];
  for(let i=turns.length-1;i>=0;i--)if(turns[i]!==picked)ordered.push(turns[i]);
  for(const turn of ordered){
    hintsFromTools(turn.tools,base,list,seen);
    for(const agent of [...(turn.subagents||[])].reverse())hintsFromTools(agent?.tools,base,list,seen);
    for(const ref of turn.references||[])if(ref?.path)pushHint(list,seen,ref.path,base);
  }
  return list;
}
function matchHints(hints,text){
  if(!Array.isArray(hints)||!hints.length)return'';
  const tail=text.replace(/^\.[\\/]/,'').split(/[\\/]+/).filter(Boolean),wanted=tail.join('/').toLowerCase();
  if(!wanted||tail.includes('..'))return'';
  const dirs=[];
  for(const raw of hints){
    if(typeof raw!=='string'||!raw.trim())continue;
    const hint=raw.trim(),norm='/'+hint.replaceAll('\\','/').replace(/\/+$/,'').toLowerCase();
    if(norm.endsWith('/'+wanted)&&fs.existsSync(hint))return hint;
    dirs.push(hint);
  }
  for(const dir of dirs){
    try{if(!fs.existsSync(dir)||!fs.statSync(dir).isDirectory())continue;}catch{continue;}
    const candidate=path.resolve(dir,text);
    if(fs.existsSync(candidate))return candidate;
  }
  return'';
}

// `ref` is what the reply wrote: relative to the conversation's folder, absolute, or a file: URL.
function resolveRef(cwd,ref,extra){
  let text=String(ref||'').trim();
  if(!text||text.length>2000||text.includes('\0'))throw Error('文件路径无效');
  if(/^file:/i.test(text)){try{text=require('node:url').fileURLToPath(text);}catch{throw Error('文件路径无效');}}
  const hints=Array.isArray(extra)?extra:extra?.hints||[];
  const worktree=Array.isArray(extra)?null:extra?.worktree||null;
  if(path.isAbsolute(text)){if(fs.existsSync(text))return text;}
  else{
    const hinted=matchHints(hints,text);if(hinted)return hinted;
    const target=path.resolve(cwd||'.',text);if(fs.existsSync(target))return target;
    // Replies often give only a file's name or the end of its path (ClaudeDesk-0.29.7-win-x64.zip
    // for outputs/releases/…); look for it in the conversation's folder.
    const found=cwd&&findInFolder(cwd,text);if(found)return found;
  }
  const where=cwd?`在 ${cwd} 里找不到 ${text}`:`找不到文件 ${text}`;
  const note=worktree?.removed?`。这个会话的工作树已删除，只在分支 ${worktree.branch||'原分支'} 上的文件需要先合并或检出`:'';
  throw Error(where+note);
}
const SKIP=new Set(['.git','node_modules','__pycache__','bower_components','dist','build','.next','target']);
// Breadth first, so the shallowest match wins; stops after `maxEntries` entries or `maxMs` ms.
function findInFolder(root,ref,opts={}){
  const maxEntries=typeof opts==='number'?opts:(opts?.maxEntries??20000);
  const maxMs=typeof opts==='object'&&opts?.maxMs!=null?opts.maxMs:500;
  const tail=ref.replace(/^\.[\\/]/,'').split(/[\\/]+/).filter(Boolean),name=tail.at(-1)?.toLowerCase(),wanted=tail.join('/').toLowerCase();
  if(!name||tail.includes('..'))return'';
  const deadline=Date.now()+maxMs;
  let level=[root],seen=0;
  while(level.length&&seen<maxEntries&&Date.now()<deadline){
    const next=[];
    for(const dir of level){
      if(seen>=maxEntries||Date.now()>=deadline)break;
      let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{continue;}
      for(const entry of entries){
        if(++seen>maxEntries||((seen&255)===0&&Date.now()>=deadline))break;
        const full=path.join(dir,entry.name);
        if(entry.name.toLowerCase()===name&&('/'+path.relative(root,full).replaceAll('\\','/').toLowerCase()).endsWith('/'+wanted))return full;
        if(entry.isDirectory()&&!SKIP.has(entry.name))next.push(full);
      }
    }
    level=next;
  }
  return'';
}
function inside(cwd,target){try{within(cwd,path.relative(cwd,target)||'.');return true;}catch{return false;}}
// What a click does: 'view' (split view), 'open' (its own app) or 'reveal' (file manager).
function clickAction(cwd,target){
  const stat=fs.statSync(target),other=RUNNABLE.has(ext(target))?'reveal':'open';
  if(stat.isDirectory())return'open';
  if(DOCUMENTS.has(ext(target))||!cwd||!inside(cwd,target)||stat.size>1024*1024)return other;
  const head=Buffer.alloc(Math.min(stat.size,8000)),fd=fs.openSync(target,'r');
  try{fs.readSync(fd,head,0,head.length,0);}finally{fs.closeSync(fd);}
  return head.includes(0)?other:'view';
}
// Carries out a click or a menu choice; returns the file for the split view when that is the choice.
async function openRef({shell,clipboard},cwd,ref,how='click',extra){
  const target=resolveRef(cwd,ref,extra),action=how==='click'?clickAction(cwd,target):how;
  if(action==='view'){if(!inside(cwd,target))throw Error('只能在分栏里查看会话文件夹内的文件');return{view:{path:path.relative(cwd,target).replaceAll('\\','/'),text:readProjectFile(target)}};}
  if(action==='open'){
    if(RUNNABLE.has(ext(target))&&!fs.statSync(target).isDirectory()){shell.showItemInFolder(target);return{revealed:true};}
    const error=await shell.openPath(target);if(error)throw Error('无法打开：'+error);return{opened:true};
  }
  if(action==='reveal'){shell.showItemInFolder(target);return{revealed:true};}
  if(action==='copy'){clipboard.writeText(target);return{copied:true};}
  throw Error('不支持的操作');
}
module.exports={resolveRef,findInFolder,collectHints,clickAction,openRef,RUNNABLE};
