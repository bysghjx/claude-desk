const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {Engine,JsonStore,InputQueue}=require('../engine.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const scratch=path.resolve(__dirname,'../../../work/unit-tests');fs.mkdirSync(scratch,{recursive:true});
function setup(){
  const sessions=[];
  const query=({prompt,options})=>{const outputs=new InputQueue(),messages=[];sessions.push({options,outputs,messages});(async()=>{for await(const input of prompt){messages.push(input);outputs.push({type:'system',subtype:'init',session_id:'cli'});}})();return{[Symbol.asyncIterator]:()=>outputs,close:()=>outputs.close()};};
  const dir=fs.mkdtempSync(path.join(scratch,'instructions-')),store=new JsonStore(path.join(dir,'state.json')),engine=new Engine({query,store,cliPath:'fake-cli',chatRoot:path.join(dir,'chats')});
  const other=fs.mkdtempSync(path.join(scratch,'instructions-other-'));
  const project=engine.addProject(dir),second=engine.addProject(other);
  return{engine,store,project,second,t:engine.create(project.id),sessions};
}
async function finish(session){session.outputs.push({type:'assistant',uuid:String(Math.random()),message:{content:[{type:'text',text:'OK'}]}});session.outputs.push({type:'result',subtype:'success',is_error:false,result:'OK',usage:{output_tokens:1},total_cost_usd:0});await tick();}
const append=session=>session.options.systemPrompt.append;
test('global and project prompts are added to the system prompt, the project one only in its own project',async()=>{
  const{engine,store,project,second,t,sessions}=setup();
  assert.equal(engine.setInstructions('global',null,'  Answer briefly.\r\n  '),'Answer briefly.');
  engine.setInstructions('project',project.id,'Run npm test after edits.');
  assert.equal(store.state.settings.instructions,'Answer briefly.');assert.equal(project.instructions,'Run npm test after edits.');
  await engine.send(t.id,'first');await tick();
  assert.match(append(sessions[0]),/<global_instructions>[\s\S]*Answer briefly\.[\s\S]*<\/global_instructions>[\s\S]*<project_instructions>[\s\S]*Run npm test after edits\.[\s\S]*<\/project_instructions>/);
  const elsewhere=engine.create(second.id),chat=engine.create(null);
  await engine.send(elsewhere.id,'hi');await engine.send(chat.id,'hi');await tick();
  for(const s of sessions.slice(1)){assert.match(append(s),/Answer briefly/);assert.doesNotMatch(append(s),/project_instructions/);}
  await engine.shutdown();
});
test('changing a prompt restarts the CLI with the history from the next message; unchanged prompts keep it',async()=>{
  const{engine,project,t,sessions}=setup();
  await engine.send(t.id,'first');await tick();await finish(sessions[0]);
  await engine.send(t.id,'second');await tick();assert.equal(sessions.length,1);await finish(sessions[0]);
  engine.setInstructions('project',project.id,'Use English.');
  await engine.send(t.id,'third');await tick();
  assert.equal(sessions.length,2);assert.match(append(sessions[1]),/Use English\./);assert.match(JSON.stringify(sessions[1].messages[0]),/previous_conversation/);await finish(sessions[1]);
  engine.setInstructions('global',null,'Be brief.');await engine.send(t.id,'fourth');await tick();assert.equal(sessions.length,3);await finish(sessions[2]);
  engine.setInstructions('project',project.id,'');assert.equal('instructions' in project,false);
  await engine.send(t.id,'fifth');await tick();assert.equal(sessions.length,4);assert.doesNotMatch(append(sessions[3]),/project_instructions/);
  await engine.shutdown();
});
test('prompts have a length limit and need a known scope and project',()=>{
  const{engine}=setup();
  assert.throws(()=>engine.setInstructions('global',null,'x'.repeat(20001)),/最多/);
  assert.throws(()=>engine.setInstructions('project','missing','x'),/项目不存在/);assert.throws(()=>engine.setInstructions('thread',null,'x'),/范围/);
});
