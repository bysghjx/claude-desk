const {test}=require('node:test');const assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {BrowserPreview}=require('../preview.cjs');const {deskServerFactory,PREVIEW_TOOLS,DESK_TOOLS}=require('../desk-tools.cjs');
// A stand-in for a webview's WebContents.
function fakeContents({url='about:blank',script=async()=>({value:'ok'})}={}){
  const c=new EventEmitter();let current=url;
  Object.assign(c,{isDestroyed:()=>false,isLoading:()=>false,getURL:()=>current,getTitle:()=>'Title',loaded:[],scripts:[],
    loadURL:async next=>{c.loaded.push(next);current=next;},executeJavaScript:async code=>{c.scripts.push(code);return script(code);},
    capturePage:async()=>({isEmpty:()=>false,getSize:()=>({width:800}),toJPEG:()=>Buffer.from('jpeg')})});
  return c;
}
test('opening a page asks the renderer for it, waits for the page and loads the address',async()=>{
  const sent=[],preview=new BrowserPreview({send:event=>sent.push(event)}),contents=fakeContents();
  const opening=preview.open('t1','http://localhost:5173/');setTimeout(()=>preview.attach('t1',contents),10);
  assert.deepEqual(await opening,{url:'http://localhost:5173/',title:'Title'});
  assert.deepEqual(sent,[{type:'open',threadId:'t1',url:'http://localhost:5173/'}]);assert.deepEqual(contents.loaded,['http://localhost:5173/']);
  await preview.open('t1','http://localhost:5173/');assert.equal(contents.loaded.length,1);
  await assert.rejects(()=>preview.open('t1','file:///C:/secret.txt'),/http/);await assert.rejects(()=>preview.open('t1','javascript:alert(1)'),/http/);
});
test('page tools need an opened page; errors in the page come back with their message',async()=>{
  const preview=new BrowserPreview({send:()=>{}});
  await assert.rejects(()=>preview.screenshot('none'),/还没有打开/);assert.throws(()=>preview.console('none'),/还没有打开/);
  preview.attach('t1',fakeContents({script:async code=>code.includes('#missing')?{error:'找不到元素：#missing'}:{value:{n:1}}}));
  assert.equal(await preview.evaluate('t1','({n:1})'),'{\n "n": 1\n}');
  await assert.rejects(()=>preview.click('t1','#missing'),/找不到元素：#missing/);
  assert.equal(await preview.screenshot('t1'),Buffer.from('jpeg').toString('base64'));
});
test('console output is kept per page and filtered by level',()=>{
  const preview=new BrowserPreview({send:()=>{}}),contents=fakeContents();preview.attach('t1',contents);
  contents.emit('console-message',{level:'info',message:'ready',sourceId:'app.js',lineNumber:3});
  contents.emit('console-message',{level:'warning',message:'slow'});contents.emit('console-message',{level:'error',message:'boom',sourceId:'app.js',lineNumber:9});
  assert.match(preview.console('t1'),/\[info\] ready \(app\.js:3\)/);assert.doesNotMatch(preview.console('t1','warn'),/ready/);assert.equal(preview.console('t1','error'),'[error] boom (app.js:9)');
  contents.emit('destroyed');assert.throws(()=>preview.console('t1'),/还没有打开/);
});
test('the desk server adds the preview tools for its conversation only when a preview is given, and they need no approval',async()=>{
  const made=[];const z={string:()=>({optional:()=>'o'}),array:()=>({max:()=>({optional:()=>'a'})}),enum:()=>({optional:()=>'e'})};
  const tool=(name,description,schema,handler)=>({name,handler});const createSdkMcpServer=o=>{made.push(o);return o;};
  deskServerFactory({createSdkMcpServer,tool,z})('t1');assert.deepEqual(made[0].tools.map(t=>t.name),['wrap_up','propose_session']);
  const calls=[];const preview={open:async(id,url)=>{calls.push([id,url]);return{url,title:'T'};},click:async()=>{throw Error('找不到元素：#x');}};
  const server=deskServerFactory({createSdkMcpServer,tool,z,preview})('t9');
  assert.deepEqual(server.tools.map(t=>'mcp__desk__'+t.name).slice(2),PREVIEW_TOOLS);for(const name of PREVIEW_TOOLS)assert.ok(DESK_TOOLS.includes(name));
  const open=await server.tools.find(t=>t.name==='preview_open').handler({url:'http://localhost:3000'});assert.deepEqual(calls,[['t9','http://localhost:3000']]);assert.match(open.content[0].text,/已打开/);
  const failed=await server.tools.find(t=>t.name==='preview_click').handler({selector:'#x'});assert.equal(failed.isError,true);assert.match(failed.content[0].text,/找不到元素/);
});
