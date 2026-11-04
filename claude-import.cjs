// Imports Claude Code transcripts (CLI and the desktop app's Code tab) from
// <config>/projects/<project>/<session>.jsonl into Claude Desk threads.
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const readline=require('node:readline');const {createHash,randomUUID}=require('node:crypto');
const hash=text=>createHash('sha256').update(text).digest('hex');
const time=value=>Date.parse(value)||0;
const SESSION=/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const blocks=content=>typeof content==='string'?[{type:'text',text:content}]:Array.isArray(content)?content:[];
// Harness reminders are injected into user text; they are not what the user typed.
const clean=text=>String(text||'').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g,'').replace(/\r\n/g,'\n').trim();
const INTERRUPTED=/^\[Request interrupted by user/,visible=text=>/[^\s\u200b-\u200d\ufeff]/.test(text||'');
// The text of a prompt the user typed, or null for tool results, harness
// messages (task notifications, command output, compaction summaries) and
// subagent records.
function promptText(record){
  if(record.type!=='user'||record.isMeta||record.isCompactSummary||record.isSidechain)return null;
  if(record.origin?.kind&&record.origin.kind!=='human')return null;
  const items=blocks(record.message?.content);if(items.some(x=>x.type==='tool_result'))return null;
  let text=clean(items.filter(x=>x.type==='text').map(x=>x.text).join('\n'));
  if(INTERRUPTED.test(text)||/^<(?:local-command-|bash-stdout|bash-stderr|task-notification)/.test(text))return null;
  const command=text.match(/<command-name>\/?([^<]*)<\/command-name>/);if(command){const args=text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim();text='/'+command[1].trim()+(args?' '+args:'');}
  const bash=text.match(/^<bash-input>([\s\S]*?)<\/bash-input>$/);if(bash)text='! '+bash[1].trim();
  const images=items.filter(x=>x.type==='image').length;if(images)text+=(text?'\n\n':'')+(images>1?`[原对话包含 ${images} 张图片，图片文件未导入]`:'[原对话包含图片，图片文件未导入]');
  return text||null;
}
// Inline images are dropped on import anyway; dropping their data while reading keeps large transcripts in memory cheaply.
const noImage=x=>x?.type==='image'?{type:'image'}:x?.type==='tool_result'&&Array.isArray(x.content)?{...x,content:x.content.map(noImage)}:x;
const toolOutput=content=>typeof content==='string'?content:blocks(content).map(x=>x.type==='image'?'[图片输出未导入]':x.text??JSON.stringify(x)).join('\n');
async function* records(file){
  const lines=readline.createInterface({input:fs.createReadStream(file,{encoding:'utf8'}),crlfDelay:Infinity});
  for await(const line of lines){if(!line.trim())continue;try{yield JSON.parse(line);}catch{yield null;}}
}
async function parseTranscript(file){
  // Records form a tree through parentUuid: rewinds and edits leave abandoned
  // branches behind, and compaction links back through logicalParentUuid.
  const nodes=new Map(),kept=[],results=[];let leaf='',warnings=0,cwd='',title={},sessionId='';
  for await(const r of records(file)){
    if(!r){warnings++;continue;}
    if(r.type==='custom-title'&&r.customTitle)title.custom=r.customTitle;
    if(r.type==='ai-title'&&r.aiTitle)title.ai=r.aiTitle;
    if(r.type==='summary'&&r.summary)title.summary=r.summary;
    if(!r.uuid||r.isSidechain)continue;
    // Resumed sessions can write earlier records again with the same uuid; keep the first copy.
    if(nodes.has(r.uuid))continue;
    cwd||=r.cwd||'';sessionId||=r.sessionId||'';
    const keep=r.type==='user'||r.type==='assistant',record=keep?{type:r.type,uuid:r.uuid,timestamp:r.timestamp,isMeta:r.isMeta,isCompactSummary:r.isCompactSummary,origin:r.origin,message:Array.isArray(r.message?.content)?{...r.message,content:r.message.content.map(noImage)}:r.message}:null;
    nodes.set(r.uuid,{parent:r.parentUuid||r.logicalParentUuid||'',record});
    if(keep){leaf=r.uuid;kept.push(record);}
    // Parallel tool calls branch off the tool_use they answer, so results are matched by id, not by path.
    if(r.type==='user')for(const x of blocks(record.message?.content))if(x.type==='tool_result')results.push(x);
  }
  const active=new Set(),replies=new Set();for(let id=leaf;id&&!active.has(id);id=nodes.get(id)?.parent){const node=nodes.get(id);if(!node)break;active.add(id);if(node.record?.message?.id)replies.add(node.record.message.id);}
  // Each block of a reply is its own record, and blocks after a tool call hang
  // beside that call's result; a reply on the branch keeps all its blocks.
  const branch=kept.filter(r=>active.has(r.uuid)||(r.type==='assistant'&&replies.has(r.message?.id)));
  let model='',current=null;const turns=[],calls=new Map();
  const turn=(user,stamp)=>{current={id:'turn-'+turns.length,user,answer:'',thinking:'',items:[],tools:[],status:'done',startedAt:time(stamp),finishedAt:time(stamp)};turns.push(current);return current;};
  for(const r of branch){
    if(r.type==='user'){
      const text=promptText(r);if(text!==null){turn(text,r.timestamp);continue;}
      if(current&&blocks(r.message?.content).some(x=>x.type==='text'&&INTERRUPTED.test(x.text||'')))current.status='interrupted';
      continue;
    }
    if(r.message?.model&&r.message.model!=='<synthetic>')model=r.message.model;
    const t=current||turn('',r.timestamp);t.finishedAt=time(r.timestamp)||t.finishedAt;
    for(const x of blocks(r.message?.content)){
      if(x.type==='text'&&visible(x.text)){t.answer+=(t.answer?'\n\n':'')+x.text;t.items.push({type:'text',text:x.text});}
      else if(x.type==='thinking'&&x.thinking?.trim()){t.thinking+=(t.thinking?'\n\n':'')+x.thinking;t.items.push({type:'thinking',text:x.thinking});}
      else if(x.type==='tool_use'&&!calls.has(x.id)){const tool={id:x.id||'tool-'+t.tools.length,name:x.name||'tool',input:x.input||{},status:'interrupted',output:''};t.tools.push(tool);t.items.push({type:'tool',id:tool.id});calls.set(tool.id,tool);}
    }
  }
  for(const x of results){const tool=calls.get(x.tool_use_id);if(tool){tool.status=x.is_error?'error':'done';tool.output=toolOutput(x.content);}}
  // Slash commands such as /model or /compact leave a prompt with no reply.
  const result=turns.filter(t=>t.answer||t.tools.length||!t.user.startsWith('/'));
  for(const t of result){if(!t.answer&&!t.tools.length)t.status='interrupted';}
  if(result[0]&&!result[0].user)result[0].user='[Claude Code 自动开始的任务]';
  return{meta:{id:sessionId||path.basename(file,'.jsonl'),cwd,title:title.custom||title.ai||title.summary||''},model,turns:result.some(t=>t.answer||t.tools.length)?result:[],warnings};
}
// Lists sessions from the first and last bytes of each file so large transcripts stay cheap.
function slice(file,start,length){const fd=fs.openSync(file,'r');try{const buffer=Buffer.alloc(length);const read=fs.readSync(fd,buffer,0,length,start);return buffer.subarray(0,read).toString('utf8').split('\n');}finally{fs.closeSync(fd);}}
function summarize(file,size){
  const parse=lines=>lines.map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
  const head=parse(slice(file,0,Math.min(size,256*1024))),tail=size>256*1024?parse(slice(file,Math.max(0,size-1024*1024),Math.min(size,1024*1024))):[],all=[...head,...tail];
  const last=(type,key)=>all.findLast(r=>r.type===type&&r[key])?.[key];
  let saved='';try{saved=JSON.parse(fs.readFileSync(path.join(path.dirname(file),path.basename(file,'.jsonl'),'custom-title.json'),'utf8')).customTitle||'';}catch{}
  const first=head.map(promptText).find(text=>text&&!text.startsWith('/'))||'';
  // A file read whole that holds no reply has nothing to import; larger files are checked at preview.
  return{cwd:all.find(r=>r.cwd&&!r.isSidechain)?.cwd||'',title:saved||last('custom-title','customTitle')||last('ai-title','aiTitle')||last('summary','summary')||first.replace(/\s+/g,' ').slice(0,50),reply:size>256*1024||head.some(r=>r.type==='assistant'&&!r.isSidechain)};
}
class ClaudeImporter{
  constructor(store,home=process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude')){this.store=store;this.home=path.resolve(home);this.files=new Map();this.previews=new Map();}
  imported(id){return this.store.state.threads.some(t=>t.importedFrom?.type==='claude'&&t.importedFrom.id===id);}
  async list(){
    const root=path.join(this.home,'projects'),list=[];this.files.clear();
    if(fs.existsSync(root))for(const project of fs.readdirSync(root,{withFileTypes:true})){
      if(!project.isDirectory())continue;const dir=path.join(root,project.name);
      for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
        const sourceId=entry.isFile()&&entry.name.match(SESSION)?.[1];if(!sourceId)continue;
        const full=path.join(dir,entry.name),stat=fs.statSync(full);if(!stat.size)continue;
        const info=summarize(full,stat.size);if(!info.reply)continue;
        const id=hash(full);this.files.set(id,full);
        list.push({id,sourceId,title:info.title||'Claude Code 对话',cwd:info.cwd,updatedAt:stat.mtimeMs,archived:false,imported:this.imported(sourceId)});
      }
    }
    // A session copied into another project folder is the same conversation; list the newest copy once.
    const seen=new Set();return{home:this.home,items:list.sort((a,b)=>b.updatedAt-a.updatedAt).filter(item=>!seen.has(item.sourceId)&&seen.add(item.sourceId))};
  }
  async preview(ids){
    if(!Array.isArray(ids)||!ids.length||ids.length>20)throw Error('每次请选择 1–20 条会话');
    const parsed=[];for(const id of [...new Set(ids)]){
      const file=this.files.get(id);if(!file)throw Error('会话列表已变化，请重新扫描');const real=fs.realpathSync(file),relative=path.relative(this.home,real);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('会话文件不在所选 Claude 目录内');
      const data=await parseTranscript(real);if(!data.turns.length)throw Error('此会话没有可导入的问答，可能还没有收到过回复');parsed.push({file:real,...data});
    }
    const token=randomUUID();this.previews.clear();this.previews.set(token,parsed);return{token,items:parsed.map(p=>({id:p.meta.id,cwd:p.meta.cwd,turns:p.turns.length,tools:p.turns.reduce((n,t)=>n+t.tools.length,0),model:p.model,warnings:p.warnings,first:p.turns[0].user.slice(0,250),last:p.turns.at(-1).answer.slice(0,250)}))};
  }
  commit(token){
    const parsed=this.previews.get(token);if(!parsed)throw Error('预览已过期，请重新预览');let imported=0,skipped=0;
    const before=structuredClone(this.store.state);
    try{for(const p of parsed){const sourceId=p.meta.id;if(this.imported(sourceId)){skipped++;continue;}
      const cwd=p.meta.cwd||this.home;let project=this.store.state.projects.find(item=>item.path.toLowerCase()===cwd.toLowerCase());if(!project){project={id:randomUUID(),path:cwd,name:path.basename(cwd)};this.store.state.projects.push(project);}
      const id='claude-'+sourceId,startedAt=p.turns[0].startedAt||Date.now();this.store.state.threads.push({id,projectId:project.id,cwd,title:p.meta.title||p.turns[0].user.replace(/\s+/g,' ').slice(0,50),createdAt:startedAt,updatedAt:p.turns.at(-1).finishedAt||startedAt,status:p.turns.at(-1).status,...this.store.state.settings,turns:p.turns.map(t=>({...t,id:'claude-'+sourceId+'-'+t.id,source:'claude',originalModel:p.model})),importedFrom:{type:'claude',id:sourceId,file:p.file,model:p.model,importedAt:Date.now()}});imported++;
    }this.store.save();}catch(e){this.store.state=before;if(e instanceof RangeError)e=Error('会话太大：导入后单条会话超过约 512 MB（JavaScript 单个字符串的上限），无法保存');throw e;}
    this.previews.delete(token);return{imported,skipped};
  }
}
module.exports={ClaudeImporter,parseTranscript,promptText};
