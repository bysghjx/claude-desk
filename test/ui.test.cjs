const {test}=require('node:test');const assert=require('node:assert/strict');
const modules=async()=>({...await import('../ui/src/core/store.mjs'),...await import('../ui/src/features/actions.mjs')});

function fakeComposer(){
  return{text:'',capture(){return{text:this.text,references:[],images:[],options:{model:'claude-opus-5-5',effort:'high',mode:'default'}};},
    options:()=>({model:'claude-opus-5-5',effort:'high',mode:'default'}),restore(draft){this.text=draft?.text||'';},clear(){this.text='';},save(){},focus(){},isEmpty(){return!this.text.trim();}};
}
async function setup({confirmAnswer=true}={}){
  const {createStore,createActions}=await modules();
  const store=createStore(),composer=fakeComposer(),calls=[],toasts=[];let hold=null,created=0;
  store.load({projects:[{id:'p1',name:'demo',path:'C:/demo'}],threads:[],settings:{model:'claude-opus-5-5',effort:'high',mode:'default'},ui:{}});
  const thread=(id,extra={})=>({id,projectId:'p1',cwd:'C:/demo',title:'新对话',status:'idle',turns:[],...extra});
  const api=async(name,...args)=>{
    calls.push({name,args});
    if(name==='thread:create'){if(hold)await hold;created++;return thread('t'+created);}
    if(name==='thread:send')return thread(args[0],{status:'starting',turns:[{id:'u1',rev:1,user:args[1],status:'running'}]});
    if(name==='thread:steer')return{steered:args[1]!=='cannot',thread:thread(args[0],{status:'tool',turns:store.thread(args[0]).turns.map(t=>({id:t.id,rev:t.rev,same:true}))})};
    if(name==='thread:queue')return thread(args[0],{status:'tool',queue:[{id:'q1',text:args[1]}],turns:store.thread(args[0]).turns.map(t=>({id:t.id,rev:t.rev,same:true}))});
    if(name==='thread:get')return thread(args[0],{turns:[{id:'x',rev:9,user:'full',status:'done'}]});
    return true;
  };
  const actions=createActions({store,api,composer,toast:t=>toasts.push(t),confirm:async()=>confirmAnswer});
  actions.selectThread(null);
  return{store,actions,composer,calls,toasts,hold:value=>{hold=value;}};
}

test('new chat, project selection, typing and empty submit never create a conversation',async()=>{
  const r=await setup();
  r.actions.showHome();r.actions.selectProject('p1');r.composer.text='draft only';
  assert.equal(r.calls.filter(c=>c.name==='thread:create').length,0);assert.equal(r.store.state.threads.length,0);
  r.composer.text='   ';await r.actions.sendMessage();
  assert.equal(r.calls.filter(c=>c.name==='thread:create').length,0);
});
test('the first send creates one conversation and rapid repeated sends cannot create duplicates',async()=>{
  const r=await setup();r.actions.selectProject('p1');r.composer.text='first message';
  let release;r.hold(new Promise(resolve=>{release=resolve;}));
  const sending=r.actions.sendMessage();await r.actions.sendMessage();
  release();await sending;
  assert.equal(r.calls.filter(c=>c.name==='thread:create').length,1);
  const sends=r.calls.filter(c=>c.name==='thread:send');
  assert.equal(sends.length,1);assert.equal(sends[0].args[1],'first message');
  assert.equal(r.store.state.threads.length,1);assert.equal(r.store.selected,'t1');assert.equal(r.composer.text,'');
});
test('a message sent while the conversation runs is 插话; Tab queues it instead',async()=>{
  const r=await setup();r.actions.selectProject('p1');r.composer.text='first';await r.actions.sendMessage();
  r.composer.text='steer this';await r.actions.sendMessage();
  assert.equal(r.calls.filter(c=>c.name==='thread:steer').length,1);assert.match(r.toasts.at(-1),/已插话/);
  r.composer.text='later';await r.actions.sendMessage(undefined,{queue:true});
  assert.equal(r.calls.filter(c=>c.name==='thread:queue').length,1);assert.equal(r.calls.filter(c=>c.name==='thread:send').length,1);
  assert.deepEqual(r.store.current().queue.map(q=>q.text),['later']);assert.equal(r.store.current().turns[0].user,'first');
  assert.match(r.toasts.at(-1),/队列/);
});
test('deleting a conversation waits for confirmation and returns home',async()=>{
  for(const answer of [false,true]){
    const r=await setup({confirmAnswer:answer});r.actions.selectProject('p1');r.composer.text='hello';await r.actions.sendMessage();
    const deleted=await r.actions.deleteThread('t1');
    assert.equal(deleted,answer);assert.equal(r.calls.filter(c=>c.name==='thread:delete').length,answer?1:0);
    assert.equal(r.store.state.threads.length,answer?0:1);assert.equal(r.store.selected,answer?null:'t1');
  }
});
test('thread updates reuse unchanged turns and fetch the full thread when a reused turn is unknown',async()=>{
  const r=await setup();
  r.store.mergeThread({id:'a',turns:[{id:'x',rev:1,user:'one'},{id:'y',rev:2,user:'two'}]});
  const first=r.store.thread('a').turns[0];
  assert.equal(r.store.mergeThread({id:'a',turns:[{id:'x',rev:1,same:true},{id:'y',rev:3,user:'two!'}]}),true);
  assert.equal(r.store.thread('a').turns[0],first);assert.equal(r.store.thread('a').turns[1].user,'two!');
  await r.actions.apply({id:'b',turns:[{id:'x',rev:5,same:true}]});
  assert.equal(r.calls.at(-1).name,'thread:get');assert.equal(r.store.thread('b').turns[0].user,'full');
});
test('home shows active sub-agents across conversations with visible progress outside collapsed details',async()=>{
  const {createStore}=await modules();const {collectAgents,agentCardsHtml}=await import('../ui/src/views/inspector.mjs');
  const store=createStore();store.load({projects:[],threads:[{id:'owner',title:'Owner conversation',turns:[{subagents:[
    {id:'active',name:'Active worker',status:'tool',startedAt:Date.now()-2000,summary:'Inspecting the parser',tools:[{id:'read',name:'Read',status:'running',input:{file_path:'src/parser.js'}}]},
    {id:'done',name:'Completed worker',status:'done',startedAt:Date.now()-5000,finishedAt:Date.now(),tools:[]}]}]}]});
  const html=agentCardsHtml(collectAgents(store),{home:true});
  const summary=html.slice(html.indexOf('<summary'),html.indexOf('</summary>'));
  assert.match(summary,/Inspecting the parser/);assert.match(summary,/Read · src\/parser.js/);
  assert.match(html,/data-agent-owner="owner"/);assert.doesNotMatch(html,/Completed worker/);
});
test('finished sub-agents fold into one 已结束 row with a compact list',async()=>{
  const {agentCardsHtml}=await import('../ui/src/views/inspector.mjs');
  const now=Date.now(),agent=(id,status)=>({id,name:'Worker '+id,status,ownerId:'t',startedAt:now-3000,finishedAt:status==='tool'?null:now,tools:[]});
  const html=agentCardsHtml([agent('a','tool'),agent('b','done'),agent('c','error')],{home:false,now});
  assert.equal((html.match(/<details class="agent-card/g)||[]).length,1);
  assert.match(html,/<details class="agent-history" data-agent-detail="history"><summary><span>已结束 2 个<\/span>/);
  assert.equal((html.match(/class="agent-row"/g)||[]).length,2);
  assert.match(html,/data-agent-window="c" data-agent-thread="t"[^>]*><span class="dot error">/);
  assert.doesNotMatch(agentCardsHtml([agent('a','tool')],{home:false,now}),/agent-history/);
});
test('all six permission modes share their menu icon with the toolbar',async()=>{
  const {modes,modeListHtml}=await import('../ui/src/views/composer.mjs');
  assert.equal(new Set(modes.map(m=>m.icon)).size,6);
  for(const mode of modes){
    const row=modeListHtml(mode.id).split('<button ').find(r=>r.includes(`data-mode="${mode.id}"`));
    assert.ok(row.includes(`aria-hidden="true">${mode.icon}</svg>`));assert.ok(row.includes('aria-selected="true"'));
  }
});
test('dock tab keys survive HTML attributes and closing the last tab removes its view and panel',async()=>{
  const {createDock}=await import('../ui/src/views/dock.mjs');const {createStore}=await modules();
  const elements=new Map();const $=id=>{if(!elements.has(id))elements.set(id,{hidden:false,innerHTML:'',classList:{toggle(){},add(){},remove(){}},append(frame){this.frames||=[];this.frames.push(frame);},style:{},setPointerCapture(){},releasePointerCapture(){}});return elements.get(id);};
  const store=createStore();store.load({projects:[],threads:[{id:'thread',title:'Parent',turns:[{subagents:[{id:'agent',name:'Worker "quoted"'}]}]}]});
  const document={body:{classList:{toggle(){}}},createElement(){return{hidden:false,contentWindow:{postMessage(){}},remove(){this.removed=true;}};},querySelector(){},documentElement:{style:{setProperty(){}}}};
  const dock=createDock({$,store,api:async()=>true,toast(){},onSelectThread(){},document,window:{addEventListener(){}}});
  dock.open('thread','agent');const tabs=$('#agent-dock-tabs'),panel=$('#agent-dock'),frame=$('#agent-dock-views').frames[0];
  assert.equal(panel.hidden,false);assert.match(tabs.innerHTML,/Worker &quot;quoted&quot;/);
  const key=/data-dock-close="([^"]*)"/.exec(tabs.innerHTML)[1];tabs.onclick({target:{closest(selector){return selector==='[data-dock-close]'?{dataset:{dockClose:key}}:null;}}});
  assert.equal(frame.removed,true);assert.equal(panel.hidden,true);assert.equal(tabs.innerHTML,'');dock.refresh('thread');assert.equal(panel.hidden,true);
  dock.open('thread','agent');assert.equal(panel.hidden,false);assert.equal($('#agent-dock-views').frames.length,2);
});

test('sidebar dots: only running, waiting, or something new to read', async()=>{
  const {threadDot,isUnread}=await import('../ui/src/core/format.mjs');
  const t=(status,extra={})=>({status,turns:[],...extra});
  assert.equal(threadDot(t('done',{seenAt:200,finishedAt:100})),'','read conversations have no dot');
  assert.equal(threadDot(t('done',{seenAt:100,finishedAt:200})),'unread');
  assert.equal(threadDot(t('error',{seenAt:100,finishedAt:200})),'error');
  assert.equal(threadDot(t('error',{seenAt:300,finishedAt:200})),'','a failure you have seen is not flagged again');
  assert.equal(threadDot(t('idle',{seenAt:100})),'');
  assert.equal(threadDot(t('done',{finishedAt:200})),'','conversations from before tracking count as read');
  assert.equal(threadDot(t('thinking',{seenAt:100,finishedAt:200})),'active');
  assert.equal(threadDot(t('approval')),'approval');
  assert.equal(isUnread(t('stopped',{seenAt:1,finishedAt:2})),false,'stopping it yourself is not news');
  assert.equal(isUnread(null),false);
});

test('sending from home without a project starts a chat; worktree only applies to projects',async()=>{
  const r=await setup();r.store.state.settings.location='worktree';
  r.actions.showHome();r.composer.text='just a question';await r.actions.sendMessage();
  const create=r.calls.find(c=>c.name==='thread:create');
  assert.deepEqual(create.args,[null,{worktree:false}]);
  assert.equal(r.toasts.some(t=>/选择一个工作项目/.test(t)),false);
  r.actions.selectProject('p1');r.composer.text='in the project';await r.actions.sendMessage();
  assert.deepEqual(r.calls.filter(c=>c.name==='thread:create')[1].args,['p1',{worktree:true}]);
});
