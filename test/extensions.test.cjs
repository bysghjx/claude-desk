const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {ExtensionsManager,metadata}=require('../extensions.cjs');
const scratch=path.resolve(__dirname,'../../../work/extension-tests');fs.mkdirSync(scratch,{recursive:true});
function setup(execute=async()=>({stdout:'{"installed":[],"available":[]}'})){
  const root=fs.mkdtempSync(path.join(scratch,'test-'));const home=path.join(root,'home');fs.mkdirSync(home);const store={state:{},save(){}};
  return{root,home,store,manager:new ExtensionsManager({cliPath:'fake-cli',dataRoot:path.join(root,'data'),home,store,execute})};
}
test('skill metadata supports quoted and folded descriptions',()=>{
  const a=metadata('---\nname: sample\ndescription: >\n  A useful skill\n  over two lines\n---\nBody');assert.equal(a.name,'sample');assert.equal(a.description,'A useful skill over two lines');assert.equal(a.body,'Body');
  assert.equal(metadata('---\nname: "sample"\ndescription: "Line \\"one\\""\n---\n').name,'sample');
});
test('owned skills preserve support files, native skills stay read-only, and selection maps to SDK options',()=>{
  const {manager,root,home}=setup();const source=path.join(root,'source');fs.mkdirSync(path.join(source,'scripts'),{recursive:true});fs.writeFileSync(path.join(source,'SKILL.md'),'---\nname: example\ndescription: Example skill\n---\nInstructions');fs.writeFileSync(path.join(source,'scripts','helper.txt'),'helper');
  manager.importSkill(source);assert.equal(fs.readFileSync(path.join(manager.skillsRoot,'example','scripts','helper.txt'),'utf8'),'helper');
  fs.mkdirSync(path.join(home,'.claude','skills','native'),{recursive:true});fs.writeFileSync(path.join(home,'.claude','skills','native','SKILL.md'),'---\nname: native\ndescription: Native\n---\nBody');
  const skills=manager.scanSkills();assert.equal(skills.length,2);assert.equal(skills.find(s=>s.name==='native').owned,false);
  manager.selection('selected',['desk-user-skills:example']);const options=manager.sessionOptions();assert.deepEqual(options.skills,['desk-user-skills:example']);assert.equal(options.plugins[0].type,'local');
  assert.throws(()=>manager.removeSkill('用户:anything'),/只能移除/);manager.removeSkill('owned:example');assert.ok(fs.existsSync(path.join(source,'SKILL.md')));assert.ok(fs.existsSync(path.join(home,'.claude','skills','native','SKILL.md')));
});
test('skill edits preserve raw metadata and reject traversal and duplicate imports',()=>{
  const {manager}=setup();manager.saveSkill({name:'review',description:'Review',body:'Instructions'});
  assert.throws(()=>manager.saveSkill({name:'../escape',description:'Bad',body:'Bad'}),/名称/);
  assert.throws(()=>manager.saveSkill({name:'con',description:'Bad',body:'Bad'}),/名称/);
  assert.throws(()=>manager.saveSkill({name:'review',description:'Review',body:'Duplicate'}),/已存在/);
  manager.saveSkill({id:'owned:review',name:'review',raw:'---\nname: review\ndescription: Changed\nallowed-tools: Read\n---\nNew body'});
  assert.match(fs.readFileSync(path.join(manager.skillsRoot,'review','SKILL.md'),'utf8'),/allowed-tools: Read/);
  assert.throws(()=>manager.saveSkill({id:'owned:review',name:'review',raw:'---\nname: renamed\ndescription: Changed\n---\nBody'}),/保留原/);
});
test('plugin commands are argument arrays, never approve declared shell commands automatically, and retain uninstall data',async()=>{
  const calls=[];const {manager}=setup(async(file,args,options)=>{calls.push({file,args,options});return{stdout:'{"success":true}'};});
  await manager.pluginAction('install','example@official','user');await manager.pluginAction('uninstall','example@official','user');
  assert.ok(calls.every(call=>!call.args.includes('--yes')&&!call.args.includes('-y')&&!call.options.shell));assert.ok(calls[1].args.includes('--keep-data'));
  await assert.rejects(()=>manager.pluginAction('install','bad;echo injected','user'),/无效/);
  await assert.rejects(()=>manager.pluginAction('install','example','project'),/选择项目/);
  await assert.rejects(()=>manager.addMarketplace('https://user:secret@example.com/repo'),/不带凭据/);
});
test('catalog sanitizes fields and caches reads while preserving plugin state',async()=>{
  let count=0;const {manager}=setup(async()=>{count++;return{stdout:JSON.stringify({installed:[{id:'test@market',name:'test',enabled:false,scope:'project',credential:'SECRET'}],available:[{pluginId:'next@market',name:'next',description:'Next'}]})};});
  const a=await manager.catalog();await manager.catalog();assert.equal(count,1);assert.equal(a.installed[0].enabled,false);assert.equal(a.available[0].id,'next@market');assert.doesNotMatch(JSON.stringify(a),/SECRET/);
});
