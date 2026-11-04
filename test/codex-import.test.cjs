const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {CodexImporter,parseRollout}=require('../codex-import.cjs');const {DatabaseStore}=require('../database.cjs');
const scratch=path.resolve(__dirname,'../../../work/codex-import-tests');fs.mkdirSync(scratch,{recursive:true});
function setup(){const dir=fs.mkdtempSync(path.join(scratch,'import-')),home=path.join(dir,'codex');fs.mkdirSync(path.join(home,'sessions'),{recursive:true});const file=path.join(home,'sessions','rollout-test.jsonl');const rows=[
  {type:'session_meta',payload:{id:'original',cwd:dir,timestamp:'2026-10-30T01:00:00Z'}},
  {type:'turn_context',payload:{turn_id:'turn-1',model:'original-model'}},
  {type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'SECRET SYSTEM CONFIG'}]}},
  {type:'response_item',payload:{type:'message',role:'user',internal_chat_message_metadata_passthrough:{turn_id:'turn-1',content_item_kinds:['environments.environment_context']},content:[{type:'input_text',text:'ENVIRONMENT CONTEXT'}]}},
  {type:'response_item',payload:{id:'user-1',type:'message',role:'user',internal_chat_message_metadata_passthrough:{turn_id:'turn-1',content_item_kinds:['user.text']},content:[{type:'input_text',text:'Actual user question'}]}},
  {type:'response_item',payload:{id:'reason-1',type:'reasoning',summary:[{type:'summary_text',text:'Public summary'}],encrypted_content:'ENCRYPTED SECRET'}},
  {type:'response_item',payload:{id:'call-1',type:'function_call',call_id:'tool-1',name:'read_file',arguments:'{"path":"sample.txt"}'}},
  {type:'response_item',payload:{type:'function_call_output',call_id:'tool-1',output:'file result'}},
  {type:'event_msg',payload:{type:'agent_message',message:'Duplicate event answer'}},
  {type:'response_item',payload:{id:'assistant-1',type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Canonical answer'}]}}
];fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');fs.writeFileSync(path.join(home,'session_index.jsonl'),JSON.stringify({id:'original',thread_name:'Original title'})+'\n');return{dir,home,file,rows};}
test('Codex parser imports canonical user/assistant text, public summaries and tools without runtime instructions or encrypted content',async()=>{const {file,rows}=setup();fs.appendFileSync(file,JSON.stringify(rows.at(-1))+'\n{truncated');const parsed=await parseRollout(file);assert.equal(parsed.turns.length,1);assert.equal(parsed.turns[0].user,'Actual user question');assert.equal(parsed.turns[0].answer,'Canonical answer');assert.equal(parsed.turns[0].thinking,'Public summary');assert.equal(parsed.turns[0].tools[0].output,'file result');assert.equal(parsed.warnings,1);assert.doesNotMatch(JSON.stringify(parsed.turns),/SECRET|ENVIRONMENT|Duplicate/);});
test('Codex preview and import preserve title, deduplicate and persist without writing source files or Claude usage',async()=>{const {dir,home,file}=setup(),original=fs.readFileSync(file,'utf8'),store=new DatabaseStore(path.join(dir,'data')),importer=new CodexImporter(store,home);const list=await importer.list();assert.equal(list.items[0].title,'Original title');await assert.rejects(()=>importer.preview(['arbitrary-path']),/列表已变化/);const preview=await importer.preview([list.items[0].id]);assert.equal(preview.items[0].turns,1);assert.equal(store.state.threads.length,0);assert.equal(importer.commit(preview.token).imported,1);assert.equal(store.state.threads[0].title,'Original title');assert.equal((store.state.usageLog||[]).length,0);const again=await importer.preview([list.items[0].id]);assert.equal(importer.commit(again.token).skipped,1);assert.equal(store.state.threads.length,1);assert.equal(fs.readFileSync(file,'utf8'),original);store.close();const reopened=new DatabaseStore(path.join(dir,'data'));assert.equal(reopened.state.threads[0].turns[0].answer,'Canonical answer');reopened.close();});
test('Codex legacy event fallback and unfinished turns are retained accurately',async()=>{const {file}=setup();fs.writeFileSync(file,[{type:'session_meta',payload:{id:'legacy'}},{type:'event_msg',payload:{type:'user_message',message:'Hello'}},{type:'event_msg',payload:{type:'agent_message',message:'World'}}].map(r=>JSON.stringify(r)).join('\n'));const legacy=await parseRollout(file);assert.equal(legacy.turns[0].answer,'World');fs.writeFileSync(file,[{type:'session_meta',payload:{id:'pending'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Unfinished'}]}}].map(r=>JSON.stringify(r)).join('\n'));assert.equal((await parseRollout(file)).turns[0].status,'interrupted');});


test('Codex list excludes internal guardian review sessions',async()=>{const {home}=setup();fs.writeFileSync(path.join(home,'sessions','rollout-guardian.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'internal',thread_source:'guardian_review',source:{subagent:{other:'guardian'}}}})+'\n');const importer=new CodexImporter({state:{threads:[]}},home);assert.equal((await importer.list()).items.length,1);});

test('Codex paginated history follows base logs only up to the recorded rollback boundary',async()=>{
  const {dir}=setup(),base=path.join(dir,'base.jsonl'),tail=path.join(dir,'tail.jsonl');
  const message=(role,text,id)=>({type:'response_item',payload:{type:'message',role,content:[{type:'input_text',text}],internal_chat_message_metadata_passthrough:{turn_id:id,...(role==='user'?{content_item_kinds:['user.text']}:{})}}});
  const prefix=[{type:'session_meta',payload:{id:'original'}},message('user','Earlier question','one'),message('assistant','Earlier answer','one')].map(x=>JSON.stringify(x)).join('\n')+'\n';
  fs.writeFileSync(base,prefix+JSON.stringify(message('user','Rolled back question','discarded'))+'\n');
  fs.writeFileSync(tail,[{type:'session_meta',payload:{id:'original',history_base:{thread_id:'base',end_byte_offset:Buffer.byteLength(prefix)}}},message('user','Newest question','two'),message('assistant','Newest answer','two')].map(x=>JSON.stringify(x)).join('\n'));
  const data=await parseRollout(tail,id=>id==='base'?base:undefined);assert.equal(data.turns.length,2);assert.equal(data.turns[0].answer,'Earlier answer');assert.equal(data.turns[1].answer,'Newest answer');assert.doesNotMatch(JSON.stringify(data.turns),/Rolled back/);await assert.rejects(()=>parseRollout(tail),/基础日志/);
});

test('Codex compressed base pages are listed, resolved by byte offset and hidden behind the newest tail page',async()=>{
  const {home}=setup(),zlib=require('node:zlib'),dir=path.join(home,'sessions','2026');fs.mkdirSync(dir,{recursive:true});
  const thread='01a00000-0000-7000-8000-000000000001',page='01a00000-0000-7000-8000-000000000002';
  const message=(role,text,id)=>({type:'response_item',payload:{type:'message',role,content:[{type:'input_text',text}],internal_chat_message_metadata_passthrough:{turn_id:id,...(role==='user'?{content_item_kinds:['user.text']}:{})}}});
  const prefix=[{type:'session_meta',payload:{id:thread,history_mode:'paginated'}},message('user','Archived question','one'),message('assistant','Archived answer','one')].map(x=>JSON.stringify(x)).join('\n')+'\n';
  const basePath=path.join(dir,`rollout-2026-01-01T00-00-00-${thread}.jsonl.zst`);fs.writeFileSync(basePath,zlib.zstdCompressSync(Buffer.from(prefix+JSON.stringify(message('user','Rolled back','gone'))+'\n')));
  fs.writeFileSync(path.join(dir,`rollout-2026-01-02T00-00-00-${thread}_${page}.jsonl`),[{type:'session_meta',payload:{id:thread,history_base:{thread_id:thread,end_byte_offset:Buffer.byteLength(prefix)}}},message('user','Live question','two'),message('assistant','Live answer','two')].map(x=>JSON.stringify(x)).join('\n'));
  // The compressed page is touched last, as Codex does when it archives old pages.
  const later=new Date(Date.now()+60000);fs.utimesSync(basePath,later,later);
  const importer=new CodexImporter({state:{threads:[]}},home),list=await importer.list(),item=list.items.find(x=>x.sourceId===thread);
  assert.equal(list.items.filter(x=>x.sourceId===thread).length,1);assert.match(importer.files.get(item.id),/_01a00000-0000-7000-8000-000000000002\.jsonl$/);
  const preview=await importer.preview([item.id]),[parsed]=importer.previews.get(preview.token);
  assert.deepEqual(parsed.turns.map(t=>[t.user,t.answer]),[['Archived question','Archived answer'],['Live question','Live answer']]);
});
test('Codex output tagged with per-request ids stays in its turn, and automatic turns, questions and image results import readably',async()=>{
  const {file}=setup(),tagged=(payload,turn)=>({type:'response_item',payload:{...payload,internal_chat_message_metadata_passthrough:{turn_id:turn}}});
  fs.writeFileSync(file,[
    {type:'session_meta',payload:{id:'tags'}},{type:'event_msg',payload:{type:'task_started',turn_id:'turn-1'}},{type:'turn_context',payload:{turn_id:'turn-1'}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Run the batch'}],internal_chat_message_metadata_passthrough:{turn_id:'turn-1',content_item_kinds:['user.text']}}},
    tagged({type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Starting'}]},'request-a'),
    tagged({type:'custom_tool_call',call_id:'c1',name:'exec',input:'shot'},'request-a'),
    {type:'response_item',payload:{type:'custom_tool_call_output',call_id:'c1',output:[{type:'input_text',text:'Script completed'},{type:'input_image',image_url:'data:image/png;base64,AAAA'}]}},
    tagged({type:'function_call',call_id:'q1',name:'request_user_input_async',arguments:JSON.stringify({questions:[{title:'Which domain?',options:['a.example','b.example']}]})},'request-b'),
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<send_user_message_question_reply>\n'+JSON.stringify([{question:'Which domain?',answer:'a.example'}])+'\n</send_user_message_question_reply>'}],internal_chat_message_metadata_passthrough:{turn_id:'turn-1',content_item_kinds:['user.text']}}},
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<turn_aborted>\nThe user interrupted'}]}},
    tagged({type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Batch finished'}]},'request-c'),
    {type:'event_msg',payload:{type:'task_complete',turn_id:'turn-1'}},
    {type:'event_msg',payload:{type:'task_started',turn_id:'turn-2'}},
    tagged({type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Goal continued on its own'}]},'request-d')
  ].map(r=>JSON.stringify(r)).join('\n'));
  const {turns}=await parseRollout(file);assert.equal(turns.length,1);const [turn]=turns;
  assert.equal(turn.answer,'Starting\n\nWhich domain?\n- a.example\n- b.example\n\nBatch finished\n\nGoal continued on its own');
  assert.equal(turn.user,'Run the batch\n\n> Which domain?\n\na.example');assert.equal(turn.status,'done');
  assert.equal(turn.tools[0].output,'Script completed\n[图片输出未导入]');assert.deepEqual(turn.items.map(i=>i.type==='tool'?'tool:'+i.id:'text:'+i.text.split('\n')[0]),['text:Starting','tool:c1','tool:q1','text:Which domain?','text:Batch finished','text:Goal continued on its own']);assert.doesNotMatch(JSON.stringify(turns),/base64|turn_aborted/);
});
test('Codex compressed pages are read as a stream: offsets inside later chunks, ranges past the end and damaged files',async()=>{
  const {dir}=setup(),zlib=require('node:zlib'),base=path.join(dir,'base.jsonl.zst'),tail=path.join(dir,'tail.jsonl');
  const message=(role,text,id)=>({type:'response_item',payload:{type:'message',role,content:[{type:'input_text',text}],internal_chat_message_metadata_passthrough:{turn_id:id,...(role==='user'?{content_item_kinds:['user.text']}:{})}}});
  // Far more than one decompressed chunk, so the cut lands in a later one.
  const rows=[{type:'session_meta',payload:{id:'big'}}];for(let i=0;i<400;i++)rows.push(message('user','Q'+i+' '+'x'.repeat(2000),'t'+i),message('assistant','A'+i,'t'+i));
  const prefix=rows.map(x=>JSON.stringify(x)).join('\n')+'\n';fs.writeFileSync(base,zlib.zstdCompressSync(Buffer.from(prefix+JSON.stringify(message('user','Rolled back','gone'))+'\n')));
  const writeTail=offset=>fs.writeFileSync(tail,[{type:'session_meta',payload:{id:'big',history_base:{thread_id:'base',end_byte_offset:offset}}},message('user','Live','live'),message('assistant','Live answer','live')].map(x=>JSON.stringify(x)).join('\n'));
  writeTail(Buffer.byteLength(prefix));const data=await parseRollout(tail,()=>base);
  assert.equal(data.turns.length,401);assert.equal(data.turns[399].answer,'A399');assert.equal(data.turns[400].answer,'Live answer');assert.doesNotMatch(JSON.stringify(data.turns),/Rolled back/);
  writeTail(10*1024*1024);await assert.rejects(()=>parseRollout(tail,()=>base),/范围无效/);
  fs.writeFileSync(base,Buffer.from('not zstd at all'));writeTail(5);await assert.rejects(()=>parseRollout(tail,()=>base),/无法解压 Codex 历史日志：base\.jsonl\.zst/);
});
test('an import too large to save is rolled back with a clear message',async()=>{
  const {dir,home}=setup(),store=new DatabaseStore(path.join(dir,'data')),importer=new CodexImporter(store,home);
  const list=await importer.list(),preview=await importer.preview([list.items[0].id]);store.save=()=>{throw new RangeError('Invalid string length');};
  assert.throws(()=>importer.commit(preview.token),/会话太大：导入后单条会话超过约 512 MB/);assert.equal(store.state.threads.length,0);store.close();
});
