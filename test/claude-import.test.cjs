const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {ClaudeImporter,parseTranscript,promptText}=require('../claude-import.cjs');const {DatabaseStore}=require('../database.cjs');
const scratch=path.resolve(__dirname,'../../../work/claude-import-tests');fs.mkdirSync(scratch,{recursive:true});
const SESSION='11111111-2222-4333-8444-555555555555';
// Builds a transcript shaped like Claude Code's: one record per content block, chained by parentUuid.
function transcript(){
  let last=null,n=0;const rows=[];const add=(row)=>{const uuid='u'+(++n);rows.push({parentUuid:last,isSidechain:false,uuid,timestamp:new Date(Date.UTC(2026,9,30,1,0,n)).toISOString(),sessionId:SESSION,cwd:'C:\\work\\demo',...row});last=uuid;return uuid;};
  const user=(content,extra={})=>add({type:'user',message:{role:'user',content},...extra});
  const assistant=(id,block)=>add({type:'assistant',message:{id,role:'assistant',model:'claude-test',content:[block]}});
  return{rows,add,user,assistant,at:uuid=>{last=uuid;}};
}
function setup(build){const dir=fs.mkdtempSync(path.join(scratch,'import-')),home=path.join(dir,'claude'),project=path.join(home,'projects','C--work-demo');fs.mkdirSync(project,{recursive:true});const t=transcript();build(t);const file=path.join(project,SESSION+'.jsonl');fs.writeFileSync(file,t.rows.map(r=>JSON.stringify(r)).join('\n')+'\n');return{dir,home,file};}
function basic(t){
  t.user('Actual question<system-reminder>HARNESS NOTE</system-reminder>');
  t.assistant('m1',{type:'thinking',thinking:'Visible reasoning',signature:'SIG'});
  t.assistant('m1',{type:'thinking',thinking:'',signature:'ENCRYPTED'});
  const first=t.assistant('m1',{type:'tool_use',id:'tool-a',name:'Read',input:{file_path:'a.txt'}});
  // A parallel call and the reply text hang beside the first result, not after it.
  const second=t.assistant('m1',{type:'tool_use',id:'tool-b',name:'Bash',input:{command:'ls'}});
  t.at(first);t.user([{type:'tool_result',tool_use_id:'tool-a',content:'file a'}]);
  t.at(second);t.user([{type:'tool_result',tool_use_id:'tool-b',content:[{type:'text',text:'listing'},{type:'image',source:{}}],is_error:true}]);
  t.assistant('m2',{type:'text',text:'​​'});
  t.assistant('m2',{type:'text',text:'Final answer'});
  t.user('<task-notification>background done</task-notification>',{origin:{kind:'task-notification'}});
  t.assistant('m3',{type:'text',text:'Noted the background task'});
  t.user('<command-name>/model</command-name><command-args>opus</command-args>');
  t.user('<local-command-stdout>Set model</local-command-stdout>');
  t.add({type:'custom-title',customTitle:'Saved title'});
}
test('Claude Code parser keeps prompts, replies, thinking and every tool call without harness messages',async()=>{
  const {file}=setup(basic),parsed=await parseTranscript(file);
  assert.equal(parsed.turns.length,1);const [t]=parsed.turns;
  assert.equal(t.user,'Actual question');assert.equal(t.thinking,'Visible reasoning');assert.equal(t.answer,'Final answer\n\nNoted the background task');
  assert.deepEqual(t.tools.map(x=>[x.id,x.status,x.output]),[['tool-a','done','file a'],['tool-b','error','listing\n[图片输出未导入]']]);
  assert.equal(t.status,'done');assert.equal(parsed.model,'claude-test');assert.equal(parsed.meta.title,'Saved title');assert.equal(parsed.meta.cwd,'C:\\work\\demo');
  assert.doesNotMatch(JSON.stringify(parsed.turns),/HARNESS NOTE|ENCRYPTED|Set model|\/model/);
});
test('Claude Code parser follows the newest branch after a rewind and reads each resumed record once',async()=>{
  const {file}=setup(t=>{
    t.user('First question');const answer=t.assistant('a1',{type:'text',text:'First answer'});
    t.user('Abandoned question');t.assistant('a2',{type:'text',text:'Abandoned answer'});
    t.at(answer);t.user('Edited question');t.assistant('a3',{type:'text',text:'Edited answer'});
    // A resumed session can write earlier records again with the same uuid.
    t.rows.push(...t.rows.slice(0,2).map(r=>({...r})));
  });
  const parsed=await parseTranscript(file);
  assert.deepEqual(parsed.turns.map(t=>t.user),['First question','Edited question']);assert.doesNotMatch(JSON.stringify(parsed.turns),/Abandoned/);
});
test('Claude Code parser continues through compaction and marks interrupted turns',async()=>{
  const {file}=setup(t=>{
    t.user('Before compaction');const before=t.assistant('b1',{type:'text',text:'Earlier answer'});
    t.at(null);t.add({type:'system',subtype:'compact_boundary',logicalParentUuid:before});
    t.user('Summary of the earlier conversation',{isCompactSummary:true});
    t.user([{type:'text',text:'After compaction'},{type:'image',source:{}}]);t.assistant('b2',{type:'tool_use',id:'tool-c',name:'Bash',input:{}});
    t.user([{type:'text',text:'[Request interrupted by user for tool use]'}]);
  });
  const parsed=await parseTranscript(file);
  assert.deepEqual(parsed.turns.map(t=>t.user),['Before compaction','After compaction\n\n[原对话包含图片，图片文件未导入]']);
  assert.equal(parsed.turns[1].status,'interrupted');assert.equal(parsed.turns[1].tools[0].status,'interrupted');
  assert.equal(promptText({type:'user',isMeta:true,message:{content:'meta'}}),null);
});
test('Claude Code list, preview and import keep the title, skip duplicates and leave the source file untouched',async()=>{
  const {dir,home,file}=setup(basic),original=fs.readFileSync(file,'utf8'),store=new DatabaseStore(path.join(dir,'data')),importer=new ClaudeImporter(store,home);
  fs.writeFileSync(path.join(path.dirname(file),'notes.jsonl'),'{}\n');
  const list=await importer.list();assert.equal(list.items.length,1);assert.equal(list.items[0].title,'Saved title');assert.equal(list.items[0].cwd,'C:\\work\\demo');
  await assert.rejects(()=>importer.preview(['arbitrary-path']),/列表已变化/);
  const preview=await importer.preview([list.items[0].id]);assert.equal(preview.items[0].turns,1);assert.equal(preview.items[0].tools,2);assert.equal(store.state.threads.length,0);
  assert.equal(importer.commit(preview.token).imported,1);const thread=store.state.threads[0];
  assert.equal(thread.title,'Saved title');assert.equal(thread.importedFrom.type,'claude');assert.equal(thread.turns[0].source,'claude');assert.equal((store.state.usageLog||[]).length,0);
  assert.equal((await importer.list()).items[0].imported,true);
  const again=await importer.preview([list.items[0].id]);assert.equal(importer.commit(again.token).skipped,1);assert.equal(store.state.threads.length,1);
  assert.equal(fs.readFileSync(file,'utf8'),original);store.close();
  const reopened=new DatabaseStore(path.join(dir,'data'));assert.equal(reopened.state.threads[0].turns[0].answer,'Final answer\n\nNoted the background task');reopened.close();
});
test('Claude Code list hides sessions with no reply and lists a copied session once',async()=>{
  const {dir,home,file}=setup(basic),importer=new ClaudeImporter({state:{threads:[]}},home);
  const copy=path.join(home,'projects','F--elsewhere');fs.mkdirSync(copy);fs.copyFileSync(file,path.join(copy,SESSION+'.jsonl'));
  const empty=transcript();empty.user('Only a question');fs.writeFileSync(path.join(home,'projects','C--work-demo','22222222-2222-4333-8444-555555555555.jsonl'),empty.rows.map(r=>JSON.stringify(r)).join('\n'));
  const list=await importer.list();assert.deepEqual(list.items.map(x=>x.sourceId),[SESSION]);
  fs.writeFileSync(file,empty.rows.map(r=>JSON.stringify(r)).join('\n'));fs.rmSync(copy,{recursive:true});await assert.rejects(()=>importer.preview([list.items[0].id]),/会话列表已变化|没有可导入的问答/);
  fs.rmSync(dir,{recursive:true,force:true});
});
