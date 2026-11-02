const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {Engine,JsonStore,InputQueue}=require('../engine.cjs');const {WRAP_UP,wrapUpOf,deskServerFactory}=require('../desk-tools.cjs');const {KeepAwake}=require('../awake.cjs');
const worklog=()=>import('../ui/src/lib/worklog.mjs');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const scratch=path.resolve(__dirname,'../../../work/unit-tests');fs.mkdirSync(scratch,{recursive:true});
function setup(deskServer){
  const outputs=new InputQueue(),contexts=[];
  const query=({prompt,options})=>{contexts.push(options);(async()=>{for await(const _ of prompt)outputs.push({type:'system',subtype:'init',session_id:'cli'});})();return{[Symbol.asyncIterator]:()=>outputs,close:()=>outputs.close()};};
  const dir=fs.mkdtempSync(path.join(scratch,'desk-')),engine=new Engine({query,store:new JsonStore(path.join(dir,'state.json')),cliPath:'fake-cli',deskServer}),t=engine.create(engine.addProject(dir).id);
  return{engine,t,outputs,contexts};
}
test('wrap-up input is trimmed, needs a recap, and keeps at most two buttons only with a question',()=>{
  assert.equal(wrapUpOf({recap:'  '}),null);
  assert.deepEqual(wrapUpOf({recap:' Done.\n Tests pass. ',actions:['Commit']}),{recap:'Done. Tests pass.'});
  assert.deepEqual(wrapUpOf({recap:'Done',ask:'Commit now?',actions:['Commit',{label:'Not yet'},'Third']}),{recap:'Done',ask:'Commit now?',actions:['Commit','Not yet']});
  assert.equal(wrapUpOf({recap:'x'.repeat(900)}).recap.length,600);
});
test('desk server factory builds one wrap_up tool per call',()=>{
  const made=[];const factory=deskServerFactory({createSdkMcpServer:o=>{made.push(o);return{type:'sdk',name:o.name};},tool:(name,description,schema,handler)=>({name,description,schema,handler}),z:{string:()=>({optional:()=>'opt'}),array:()=>({max:()=>({optional:()=>'arr'})})}});
  factory();factory();assert.equal(made.length,2);assert.equal(made[0].name,'desk');assert.deepEqual(made[0].tools.map(t=>t.name),['wrap_up']);assert.equal('mcp__'+made[0].name+'__'+made[0].tools[0].name,WRAP_UP);
});
test('engine gives Claude the desk tools, records the wrap-up box and never asks to approve it',async()=>{
  const{engine,t,outputs,contexts}=setup(()=>({type:'sdk',name:'desk'}));
  await engine.send(t.id,'fix it');await tick();
  const options=contexts[0];assert.equal(options.mcpServers.desk.name,'desk');assert.deepEqual(options.allowedTools,[WRAP_UP]);assert.match(options.systemPrompt.append,/wrap_up/);
  assert.deepEqual(await options.canUseTool(WRAP_UP,{recap:'r'},{toolUseID:'w1'}),{behavior:'allow',updatedInput:{recap:'r'}});
  outputs.push({type:'assistant',uuid:'a1',message:{content:[{type:'tool_use',id:'w1',name:WRAP_UP,input:{recap:'Fixed the bug.',ask:'Commit?',actions:['Commit','Wait']}}]}});
  outputs.push({type:'result',subtype:'success',is_error:false,result:'Done',usage:{output_tokens:1},total_cost_usd:0});await tick();
  assert.deepEqual(engine.thread(t.id).turns[0].wrapUp,{recap:'Fixed the bug.',ask:'Commit?',actions:['Commit','Wait']});
  await engine.shutdown();
});
test('without a desk server the CLI options are unchanged',async()=>{
  const{engine,t,contexts}=setup(null);await engine.send(t.id,'hello');await tick();
  assert.equal(contexts[0].mcpServers,undefined);assert.equal(contexts[0].allowedTools,undefined);assert.doesNotMatch(contexts[0].systemPrompt.append,/wrap_up/);await engine.shutdown();
});
test('keep-awake holds one blocker while busy and releases it when idle',()=>{
  const calls=[];let next=7;const live=new Set();
  const blocker={start:type=>{calls.push('start:'+type);live.add(next);return next++;},stop:id=>{calls.push('stop:'+id);live.delete(id);},isStarted:id=>live.has(id)};
  const awake=new KeepAwake(blocker);
  assert.equal(awake.update(true),true);awake.update(true);assert.equal(awake.update(false),false);awake.update(false);
  assert.deepEqual(calls,['start:prevent-app-suspension','stop:7']);
});
test('task list follows TodoWrite and TaskCreate / TaskUpdate and shows only when the latest turn touched it',async()=>{
  const {taskList,taskListHtml}=await worklog();
  const todo={name:'TodoWrite',input:{todos:[{content:'Read code',status:'completed'},{content:'Fix bug',status:'in_progress'}]}};
  assert.deepEqual(taskList([{tools:[todo]}]),[{text:'Read code',status:'done'},{text:'Fix bug',status:'active'}]);
  const turns=[{tools:[{name:'TaskCreate',input:{subject:'Plan'},output:'Task #1 created successfully: Plan'},{name:'TaskCreate',input:{subject:'Build'},output:'[{"type":"text","text":"Task #2 created successfully: Build"}]'},{name:'TaskCreate',input:{subject:'Drop me'},output:'Task #3 created successfully'}]},
    {tools:[{name:'TaskUpdate',input:{taskId:'1',status:'completed'}},{name:'TaskUpdate',input:{taskId:'2',status:'in_progress',subject:'Build it'}},{name:'TaskUpdate',input:{taskId:'3',status:'deleted'}}]}];
  assert.deepEqual(taskList(turns),[{text:'Plan',status:'done'},{text:'Build it',status:'active'}]);
  const html=taskListHtml(turns,escape);assert.match(html,/1\/2/);assert.match(html,/task-active/);
  assert.equal(taskListHtml([...turns,{tools:[{name:'Bash',input:{}}]}],escape),'');
  assert.equal(taskListHtml([{tools:[{name:'TodoWrite',input:{todos:[{content:'<b>',status:'pending'}]}}]}],escape).includes('&lt;b&gt;'),true);
});
test('wrap-up box hides its tool row, waits for the turn to finish and only offers buttons on the latest idle turn',async()=>{
  const {splitTurn,wrapUpHtml}=await worklog();
  const turn={status:'done',tools:[{id:'b',name:'Bash',input:{command:'ls'}},{id:'w',name:WRAP_UP,input:{}}],items:[{type:'tool',id:'b'},{type:'tool',id:'w'},{type:'text',text:'Final reply'}],wrapUp:{recap:'Done <now>',ask:'Ship it?',actions:['Ship','Wait']}};
  const split=splitTurn(turn);assert.deepEqual(split.work.map(i=>i.id),['b']);assert.equal(split.final,'Final reply');
  const html=wrapUpHtml(turn,{escape,latest:true,threadActive:false});assert.match(html,/Done &lt;now&gt;/);assert.match(html,/data-wrap-reply="Ship"/);assert.match(html,/class="primary"/);
  assert.doesNotMatch(wrapUpHtml(turn,{escape,latest:false,threadActive:false}),/data-wrap-reply/);
  assert.doesNotMatch(wrapUpHtml(turn,{escape,latest:true,threadActive:true}),/data-wrap-reply/);
  assert.equal(wrapUpHtml({...turn,status:'running'},{escape,latest:true,threadActive:true}),'');
});
