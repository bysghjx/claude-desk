const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');const {AgentWindows}=require('../agent-windows.cjs');
class FakeWindow extends EventEmitter{
  constructor(options){super();this.options=options;this.events=[];this.webContents=new EventEmitter();this.webContents.mainFrame={};this.webContents.session={setPermissionRequestHandler(){}};this.webContents.setWindowOpenHandler=fn=>this.openHandler=fn;this.webContents.send=(name,data)=>this.events.push({name,data});this.webContents.getURL=()=>'';this.destroyed=false;}
  loadFile(file){this.file=file;}isDestroyed(){return this.destroyed;}isMinimized(){return false;}show(){this.shown=true;}focus(){this.focused=true;}close(){this.destroyed=true;this.emit('closed');}
}
function setup(){const handlers={};const engine={store:{state:{threads:[{id:'t',title:'Parent',cwd:'C:/demo',turns:[{user:'Main question',subagents:[{id:'a',name:'Worker',status:'tool',answer:'',tools:[{id:'read',name:'Read',status:'running'}]},{id:'b',name:'Other',status:'done',answer:'PRIVATE OTHER OUTPUT',tools:[]}]}]}]}}};const main=new FakeWindow({});const clipboard={writeText(text){this.text=text;}};const manager=new AgentWindows({BrowserWindow:FakeWindow,ipcMain:{handle(name,fn){handlers[name]=fn;}},engine,mainWindow:()=>main,clipboard});return{manager,handlers,engine,main,clipboard};}
test('agent windows deduplicate, isolate IPC, and closing the viewer never stops a task',async()=>{
  const {manager,handlers,engine}=setup();manager.open('t','a');const entry=[...manager.windows.values()][0],window=entry.window;manager.open('t','a');assert.equal(manager.windows.size,1);assert.equal(window.focused,true);assert.equal(window.options.webPreferences.nodeIntegration,false);assert.equal(window.options.webPreferences.sandbox,true);assert.deepEqual(window.openHandler(),{action:'deny'});
  const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};const state=handlers['agent:view'](event,'state');assert.equal(state.agent.id,'a');assert.doesNotMatch(JSON.stringify(state),/PRIVATE OTHER OUTPUT/);assert.throws(()=>handlers['agent:view']({sender:{},senderFrame:{}},'state'),/无效/);assert.throws(()=>handlers['agent:view']({...event,senderFrame:{}},'state'),/无效/);
  window.close();assert.equal(manager.windows.size,0);assert.equal(engine.store.state.threads[0].turns[0].subagents[0].status,'tool');
});
test('agent windows follow live events and aliases, navigate to main, and clear deleted records',()=>{
  const {manager,handlers,engine,main,clipboard}=setup();manager.open('t','a');const window=[...manager.windows.values()][0].window,event={sender:window.webContents,senderFrame:window.webContents.mainFrame};const a=engine.store.state.threads[0].turns[0].subagents[0];Object.assign(a,{id:'canonical',aliases:['a'],answer:'Final worker output',status:'done'});manager.refresh('t');assert.equal(window.events.at(-1).data.agent.answer,'Final worker output');handlers['agent:view'](event,'copy');assert.equal(clipboard.text,'Final worker output');handlers['agent:view'](event,'main');assert.deepEqual(main.events.at(-1),{name:'thread:navigate',data:'t'});
  engine.store.state.threads=[];manager.refresh('t');assert.equal(window.events.at(-1).data.available,false);assert.throws(()=>manager.open('t','a'),/不存在/);manager.close();assert.equal(window.destroyed,true);
});
test('the split view page renders a sub-agent without the window preload',()=>{
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
  const nodes=new Map();
  const node=()=>{const n={hidden:false,disabled:false,textContent:'',innerHTML:'',checked:true,scrollTop:0,scrollHeight:0,dataset:{},classList:{toggle(){},add(){},remove(){}},addEventListener(){},setAttribute(){}};return n;};
  const document={title:'',body:node(),documentElement:node(),querySelector:s=>{if(!nodes.has(s))nodes.set(s,node());return nodes.get(s);},querySelectorAll:()=>[]};
  const listeners=[],posted=[],parent={postMessage:m=>posted.push(m)};
  const window={parent,location:{search:'?embedded=1'},addEventListener:(type,fn)=>listeners.push(fn)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui/agent.js'),'utf8'),{window,document,location:window.location,URLSearchParams,setInterval(){},setTimeout(){},DOMPurify:{sanitize:x=>x},marked:{parse:x=>x}});
  assert.deepEqual(JSON.parse(JSON.stringify(posted)),[{type:'agent:action',action:'state'}]);
  const agent={name:'看看仓库',status:'done',description:'读 README',answer:'仓库很小',tools:[{id:'r',name:'Read',input:{file_path:'README.md'},status:'done',output:'# hi'}]};
  for(const fn of listeners)fn({source:parent,data:{type:'agent:data',data:{available:true,threadTitle:'演示',agent}}});
  return new Promise(resolve=>setImmediate(resolve)).then(()=>{
    assert.equal(document.querySelector('#name').textContent,'看看仓库');assert.equal(document.querySelector('#description').textContent,'读 README');
    assert.match(document.querySelector('#tools').innerHTML,/Read/);
  });
});
