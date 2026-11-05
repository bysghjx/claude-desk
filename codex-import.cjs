const fs=require('node:fs');const path=require('node:path');const readline=require('node:readline');const {Transform}=require('node:stream');const os=require('node:os');const zlib=require('node:zlib');const {createHash,randomUUID}=require('node:crypto');
const hash=text=>createHash('sha256').update(text).digest('hex');
const time=value=>typeof value==='number'?(value<1e12?value*1000:value):Date.parse(value)||0;
function textContent(content){return(content||[]).filter(x=>['input_text','output_text','text','summary_text'].includes(x.type)).map(x=>x.text||'').join('\n');}
function userText(item){
  const kinds=item.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if(kinds?.length&&!kinds.some(kind=>kind.startsWith('user.')))return'';
  const content=Array.isArray(item.content)?item.content:[];
  let text=textContent(kinds?.length===content.length?content.filter((_x,i)=>kinds[i].startsWith('user.')):content);
  if(!kinds&&/^\s*(?:<environment_context>|<external_codex_apps_open_page>|# AGENTS\.md instructions|<user_instructions>|<turn_aborted>|<subagent_notification>|<recommended_plugins>)/.test(text))return'';
  if(!text&&content.some(x=>/image/.test(x.type)))text='[原对话包含图片，图片文件未导入]';
  const reply=text.match(/^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/);if(reply)try{text=JSON.parse(reply[1]).map(x=>'> '+String(x.question||'').replace(/\n/g,'\n> ')+'\n\n'+(Array.isArray(x.answer)?x.answer.join('、'):x.answer??'')).join('\n\n');}catch{}
  return text;
}
const questionText=input=>(Array.isArray(input?.questions)?input.questions:[]).map(q=>[q.title||q.question||'',...(Array.isArray(q.options)?q.options:[]).map(o=>'- '+(typeof o==='string'?o:o?.label||''))].join('\n')).join('\n\n');
// Tool results may be content-item arrays whose screenshots are inlined as base64;
// keep the text and drop the images like other imported attachments.
function toolOutput(output){
  if(typeof output==='string')return output;if(typeof output?.content==='string')return output.content;
  if(Array.isArray(output))return output.map(x=>typeof x==='string'?x:/image/.test(x?.type)?'[图片输出未导入]':x?.text??JSON.stringify(x)).join('\n');
  return JSON.stringify(output??'');
}
// Codex compresses older pages of paginated threads to rollout-*.jsonl.zst;
// history_base byte offsets refer to the decompressed text.
const ROLLOUT=/^rollout-.*\.jsonl(?:\.zst)?$/,packed=file=>file.endsWith('.zst');
// The lines of one log, decompressed while reading so its size does not matter;
// limit keeps only the first bytes, for a page that a later page builds on.
function logLines(file,limit){
  const input=fs.createReadStream(file,limit===undefined||packed(file)?{}:{end:limit-1});let stream=input;
  if(packed(file)){
    let seen=0;const unzip=zlib.createZstdDecompress();
    const cut=new Transform({transform(chunk,_encoding,done){const keep=limit===undefined?chunk:chunk.subarray(0,Math.max(0,limit-seen));seen+=chunk.length;done(null,keep.length?keep:undefined);},flush(done){done(limit!==undefined&&seen<limit?Error('Codex 基础历史范围无效'):null);}});
    input.on('error',e=>cut.destroy(e));unzip.on('error',()=>cut.destroy(Error('无法解压 Codex 历史日志：'+path.basename(file))));
    stream=input.pipe(unzip).pipe(cut);
  }
  return readline.createInterface({input:stream,crlfDelay:Infinity});
}
async function readMeta(file){
  const input=fs.createReadStream(file),stream=packed(file)?input.pipe(zlib.createZstdDecompress()):input,chunks=[];let size=0;
  try{for await(const chunk of stream){const i=chunk.indexOf(10);chunks.push(i<0?chunk:chunk.subarray(0,i));size+=chunk.length;if(i>=0||size>8*1024*1024)break;}}catch{}finally{input.destroy();stream.destroy();}
  try{const row=JSON.parse(Buffer.concat(chunks).toString('utf8'));return row.type==='session_meta'?row.payload||{}:{};}catch{return{};}
}
async function* rolloutLines(file,resolveBase,limit,visited=new Set()){
  const real=fs.realpathSync(file);if(visited.has(real)||visited.size>=40)throw Error('Codex 基础历史存在循环或层级过深');visited.add(real);
  // A compressed page's size is only known once read, so logLines checks its range.
  if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<0||!packed(real)&&limit>fs.statSync(real).size))throw Error('Codex 基础历史范围无效');
  const meta=await readMeta(real);
  if(meta.history_base){const base=meta.history_base,target=resolveBase?.(base.thread_id);if(!target)throw Error('找不到 Codex 引用的基础日志，无法完整导入：'+base.thread_id);if(!Number.isSafeInteger(base.end_byte_offset))throw Error('Codex 基础历史缺少字节范围，暂不支持此格式');yield* rolloutLines(target,resolveBase,base.end_byte_offset,visited);}
  if(limit!==0)for await(const line of logLines(real,limit))yield line;
  visited.delete(real);
}
async function parseRollout(file,resolveBase){
  const lines=rolloutLines(file,resolveBase);
  let meta={},model='',activeId='',current=null,warnings=0;const turns=[],byId=new Map(),known=new Set(),seen=new Set(),calls=new Map(),fallback=[];
  const ensure=(id,stamp)=>{if(id&&byId.has(id)){current=byId.get(id);return current;}current={id:id||'turn-'+turns.length,user:'',answer:'',thinking:'',items:[],tools:[],status:'interrupted',startedAt:time(stamp),finishedAt:time(stamp)};turns.push(current);if(id)byId.set(id,current);return current;};
  for await(const line of lines){
    if(!line.trim())continue;let record;try{record=JSON.parse(line);}catch{warnings++;continue;}
    const p=record.payload||{},stamp=record.timestamp;
    if(record.type==='session_meta'){meta=p;continue;}
    if(record.type==='turn_context'){if(p.turn_id)known.add(p.turn_id);activeId=p.turn_id||activeId;model=p.model||model;continue;}
    if(record.type==='event_msg'){
      if(p.type==='task_started'&&p.turn_id){known.add(p.turn_id);activeId=p.turn_id;}
      if(['user_message','agent_message'].includes(p.type))fallback.push({type:p.type,text:p.message||p.text||'',stamp});
      if(p.type==='task_complete'&&byId.has(p.turn_id)){const t=byId.get(p.turn_id);t.finishedAt=time(stamp);t.status='done';}
      continue;
    }
    if(record.type!=='response_item')continue;
    // Newer Codex tags model output with the id of each sampling request rather
    // than the turn, so only trust tags that name a real turn.
    const tag=p.internal_chat_message_metadata_passthrough?.turn_id,id=tag&&(p.role==='user'||known.has(tag)||byId.has(tag))?tag:activeId||tag;
    if(p.id){if(seen.has(p.id))continue;seen.add(p.id);}
    if(p.type==='message'&&p.role==='user'){
      const text=userText(p);if(!text)continue;
      const t=id?ensure(id,stamp):ensure('',stamp);if(t.user!==text)t.user+=(t.user?'\n\n':'')+text;continue;
    }
    if(p.type==='message'&&p.role==='assistant'){
      const text=textContent(Array.isArray(p.content)?p.content:[]);if(!text)continue;const t=id?ensure(id,stamp):current;if(!t)continue;t.answer+=(t.answer?'\n\n':'')+text;t.items.push({type:'text',text});t.finishedAt=time(stamp);if(p.phase!=='commentary')t.status='done';continue;
    }
    if(['function_call','custom_tool_call'].includes(p.type)){
      const t=id?ensure(id,stamp):current;if(!t)continue;let input=p.arguments??p.input??'';if(typeof input==='string')try{input=JSON.parse(input);}catch{input={text:input};}
      const tool={id:p.call_id||p.id||'tool-'+t.tools.length,name:p.name||'Codex tool',input,status:'interrupted',output:''};t.tools.push(tool);t.items.push({type:'tool',id:tool.id});calls.set(tool.id,tool);
      if(/^request_user_input/.test(tool.name)){const question=questionText(input);if(question){t.answer+=(t.answer?'\n\n':'')+question;t.items.push({type:'text',text:question});}}continue;
    }
    if(['function_call_output','custom_tool_call_output'].includes(p.type)){
      const tool=calls.get(p.call_id);if(tool){tool.status=p.is_error?'error':'done';tool.output=toolOutput(p.output);}continue;
    }
    if(p.type==='web_search_call'){const t=id?ensure(id,stamp):current;if(t){const tool={id:p.id||'tool-'+t.tools.length,name:'web_search',input:p.action||{},status:p.status==='completed'?'done':'interrupted',output:''};t.tools.push(tool);t.items.push({type:'tool',id:tool.id});}continue;}
    if(p.type==='reasoning'&&current){const summary=textContent(Array.isArray(p.summary)?p.summary:[]);if(summary){current.thinking+=(current.thinking?'\n\n':'')+summary;current.items.push({type:'thinking',text:summary});}}
  }
  // Turns Codex started on its own (goal continuation, agent callbacks) have no
  // user prompt; keep their output with the preceding turn instead of dropping it.
  let result=[];for(const t of turns){const prev=result.at(-1);if(t.user||!prev){result.push(t);continue;}if(t.answer)prev.answer+=(prev.answer?'\n\n':'')+t.answer;if(t.thinking)prev.thinking+=(prev.thinking?'\n\n':'')+t.thinking;prev.tools.push(...t.tools);prev.items.push(...t.items);prev.finishedAt=Math.max(prev.finishedAt,t.finishedAt);if(t.status==='done')prev.status='done';}
  if(!result.some(t=>t.user))result=[];else if(!result[0].user)result[0].user='[Codex 自动开始的任务]';
  if(!result.length){for(const event of fallback){if(event.type==='user_message'){current={id:'fallback-'+result.length,user:event.text,answer:'',tools:[],status:'done',startedAt:time(event.stamp)};result.push(current);}else if(current)current.answer+=(current.answer?'\n\n':'')+event.text;}}
  return{meta,model,turns:result,warnings};
}
class CodexImporter{
  constructor(store,home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')){this.store=store;this.home=path.resolve(home);this.files=new Map();this.rollouts=new Map();this.previews=new Map();}
  async list(){
    const titles=new Map(),index=path.join(this.home,'session_index.jsonl');if(fs.existsSync(index))for(const line of fs.readFileSync(index,'utf8').split('\n'))try{const item=JSON.parse(line);titles.set(item.id,item.thread_name);}catch{}
    this.titles=titles;this.files.clear();this.rollouts.clear();const list=[],found=[],bases=new Set(),walk=(root)=>{if(!fs.existsSync(root))return;for(const entry of fs.readdirSync(root,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const full=path.join(root,entry.name);if(entry.isDirectory())walk(full);else if(ROLLOUT.test(entry.name))found.push(full);}};
    walk(path.join(this.home,'sessions'));walk(path.join(this.home,'archived_sessions'));
    // A page that is still being compressed can exist as both .jsonl and .jsonl.zst; read the plain copy.
    found.sort((a,b)=>packed(b)-packed(a));for(const full of found){
      const page=path.basename(full).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i)?.[1];if(page)this.rollouts.set(page,full);
      const meta=await readMeta(full);if(meta.history_base?.thread_id)bases.add(meta.history_base.thread_id);if(!meta.id&&!meta.session_id)continue;if(meta.thread_source==='guardian_review'||(typeof meta.source==='object'&&meta.source?.subagent))continue;const sourceId=meta.id||meta.session_id,id=hash(full),stat=fs.statSync(full);this.files.set(id,full);list.push({id,sourceId,page,title:titles.get(sourceId)||path.basename(meta.cwd||'Codex 对话'),cwd:meta.cwd||'',updatedAt:stat.mtimeMs,archived:full.includes(path.sep+'archived_sessions'+path.sep),imported:this.store.state.threads.some(t=>t.importedFrom?.type==='codex'&&t.importedFrom.id===sourceId)});
    }
    // Paginated threads span several pages; only a page no other page builds on
    // holds the full history. Rollback/fork variants can still share a
    // conversation ID, so present the newest tail once instead of combining branches.
    list.sort((a,b)=>(bases.has(a.page)-bases.has(b.page))||b.updatedAt-a.updatedAt);const seen=new Set();return{home:this.home,items:list.filter(item=>{if(seen.has(item.sourceId))return false;seen.add(item.sourceId);return true;}).map(({page,...item})=>item).sort((a,b)=>b.updatedAt-a.updatedAt)};
  }
  async preview(ids){
    if(!Array.isArray(ids)||!ids.length||ids.length>20)throw Error('每次请选择 1–20 条会话');
    const parsed=[];for(const id of [...new Set(ids)]){
      const file=this.files.get(id);if(!file)throw Error('会话列表已变化，请重新扫描');const real=fs.realpathSync(file),relative=path.relative(this.home,real);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('会话文件不在所选 Codex 目录内');
      const data=await parseRollout(real,id=>this.rollouts.get(id));if(!data.turns.length)throw Error('此会话没有可导入的用户问答，可能使用了不支持的存储格式');parsed.push({file:real,...data});
    }
    const token=randomUUID();this.previews.clear();this.previews.set(token,parsed);return{token,items:parsed.map(p=>({id:p.meta.id||p.meta.session_id,cwd:p.meta.cwd||'',turns:p.turns.length,tools:p.turns.reduce((n,t)=>n+t.tools.length,0),model:p.model,warnings:p.warnings,first:p.turns[0].user.slice(0,250),last:p.turns.at(-1).answer.slice(0,250)}))};
  }
  commit(token){
    const parsed=this.previews.get(token);if(!parsed)throw Error('预览已过期，请重新预览');let imported=0,skipped=0;
    const before=structuredClone(this.store.state);
    try{for(const p of parsed){const sourceId=p.meta.id||p.meta.session_id;if(this.store.state.threads.some(t=>t.importedFrom?.type==='codex'&&t.importedFrom.id===sourceId)){skipped++;continue;}
      const cwd=p.meta.cwd||this.home;let project=this.store.state.projects.find(item=>item.path.toLowerCase()===cwd.toLowerCase());if(!project){project={id:randomUUID(),path:cwd,name:path.basename(cwd)};this.store.state.projects.push(project);}
      const id='codex-'+sourceId,startedAt=time(p.meta.timestamp)||Date.now();this.store.state.threads.push({id,projectId:project.id,cwd,title:this.titles?.get(sourceId)||p.turns[0].user.replace(/\s+/g,' ').slice(0,50),createdAt:startedAt,updatedAt:p.turns.at(-1).finishedAt||startedAt,status:p.turns.at(-1).status,...this.store.state.settings,turns:p.turns.map(t=>({...t,id:'codex-'+sourceId+'-'+t.id,source:'codex',originalModel:p.model})),importedFrom:{type:'codex',id:sourceId,file:p.file,model:p.model,importedAt:Date.now()}});imported++;
    }this.store.save();}catch(e){this.store.state=before;if(e instanceof RangeError)throw Error('导入会话超出运行时处理能力，已撤销本次导入：'+e.message,{cause:e});throw e;}
    this.previews.delete(token);return{imported,skipped};
  }
}
module.exports={CodexImporter,parseRollout,userText};
