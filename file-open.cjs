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

// `ref` is what the reply wrote: relative to the conversation's folder, absolute, or a file: URL.
function resolveRef(cwd,ref){
  let text=String(ref||'').trim();
  if(!text||text.length>2000||text.includes('\0'))throw Error('文件路径无效');
  if(/^file:/i.test(text)){try{text=require('node:url').fileURLToPath(text);}catch{throw Error('文件路径无效');}}
  const target=path.resolve(cwd||'.',text);
  if(fs.existsSync(target))return target;
  // Replies often give only a file's name or the end of its path (ClaudeDesk-0.29.7-win-x64.zip
  // for outputs/releases/…); look for it in the conversation's folder.
  const found=!path.isAbsolute(text)&&cwd&&findInFolder(cwd,text);
  if(found)return found;
  throw Error('找不到文件 '+text);
}
const SKIP=new Set(['node_modules','__pycache__','bower_components']);
// Breadth first, so the shallowest match wins; stops after `limit` folders.
function findInFolder(root,ref,limit=3000){
  const tail=ref.replace(/^\.[\\/]/,'').split(/[\\/]+/).filter(Boolean),name=tail.at(-1)?.toLowerCase(),wanted=tail.join('/').toLowerCase();
  if(!name||tail.includes('..'))return'';
  let level=[root],seen=0;
  while(level.length&&seen<limit){
    const next=[];
    for(const dir of level){
      if(++seen>limit)break;
      let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{continue;}
      for(const entry of entries){
        const full=path.join(dir,entry.name);
        if(entry.name.toLowerCase()===name&&('/'+path.relative(root,full).replaceAll('\\','/').toLowerCase()).endsWith('/'+wanted))return full;
        if(entry.isDirectory()&&!entry.name.startsWith('.')&&!SKIP.has(entry.name))next.push(full);
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
async function openRef({shell,clipboard},cwd,ref,how='click'){
  const target=resolveRef(cwd,ref),action=how==='click'?clickAction(cwd,target):how;
  if(action==='view'){if(!inside(cwd,target))throw Error('只能在分栏里查看会话文件夹内的文件');return{view:{path:path.relative(cwd,target).replaceAll('\\','/'),text:readProjectFile(target)}};}
  if(action==='open'){
    if(RUNNABLE.has(ext(target))&&!fs.statSync(target).isDirectory()){shell.showItemInFolder(target);return{revealed:true};}
    const error=await shell.openPath(target);if(error)throw Error('无法打开：'+error);return{opened:true};
  }
  if(action==='reveal'){shell.showItemInFolder(target);return{revealed:true};}
  if(action==='copy'){clipboard.writeText(target);return{copied:true};}
  throw Error('不支持的操作');
}
module.exports={resolveRef,findInFolder,clickAction,openRef,RUNNABLE};
