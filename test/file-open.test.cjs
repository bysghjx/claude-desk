const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveRef,clickAction,openRef}=require('../file-open.cjs');

function folders(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'desk-open-')),project=path.join(root,'project'),outside=path.join(root,'outside');
  fs.mkdirSync(path.join(project,'src'),{recursive:true});fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project,'src','app.js'),'let a=1\n');fs.writeFileSync(path.join(project,'report.html'),'<p>hi</p>');
  fs.writeFileSync(path.join(project,'logo.png'),Buffer.from([137,80,78,71,0,0,0,13]));fs.writeFileSync(path.join(project,'run.bat'),'echo hi');fs.writeFileSync(path.join(project,'tool.exe'),Buffer.from([77,90,0,0]));
  fs.writeFileSync(path.join(outside,'notes.md'),'# notes');
  return{root,project,outside};
}
const fakeShell=()=>{const calls=[];return{calls,shell:{openPath:async p=>{calls.push(['open',p]);return'';},showItemInFolder:p=>calls.push(['reveal',p])},clipboard:{writeText:t=>calls.push(['copy',t])}};};

test('a file in a reply is found relative to the conversation folder, by absolute path or by file: URL',()=>{
  const {project,outside}=folders();
  assert.equal(resolveRef(project,'src/app.js'),path.join(project,'src','app.js'));
  assert.equal(resolveRef(project,path.join(outside,'notes.md')),path.join(outside,'notes.md'));
  assert.equal(resolveRef(project,require('node:url').pathToFileURL(path.join(outside,'notes.md')).href),path.join(outside,'notes.md'));
  assert.throws(()=>resolveRef(project,'missing.txt'),/找不到文件/);
});

test('a click views project text in the split view and opens pages, binaries and outside files in their own app; programs are only shown',()=>{
  const {project,outside}=folders();
  assert.equal(clickAction(project,path.join(project,'src','app.js')),'view');
  assert.equal(clickAction(project,path.join(project,'report.html')),'open');
  assert.equal(clickAction(project,path.join(project,'logo.png')),'open');
  assert.equal(clickAction(project,path.join(outside,'notes.md')),'open');
  assert.equal(clickAction(project,path.join(project,'src')),'open');
  // A script is still text to read; a program, or a script outside the folder, is only shown in the file manager.
  assert.equal(clickAction(project,path.join(project,'run.bat')),'view');
  assert.equal(clickAction(project,path.join(project,'tool.exe')),'reveal');
  fs.writeFileSync(path.join(outside,'x.cmd'),'echo');assert.equal(clickAction(project,path.join(outside,'x.cmd')),'reveal');
});

test('opening carries out the choice and never runs a program',async()=>{
  const {project,outside}=folders(),{calls,shell,clipboard}=fakeShell();
  assert.deepEqual(await openRef({shell,clipboard},project,'src/app.js'),{view:{path:'src/app.js',text:'let a=1\n'}});
  await openRef({shell,clipboard},project,'report.html');
  await openRef({shell,clipboard},project,'run.bat','open');
  await openRef({shell,clipboard},project,'logo.png','reveal');
  await openRef({shell,clipboard},project,'src/app.js','copy');
  assert.deepEqual(calls,[['open',path.join(project,'report.html')],['reveal',path.join(project,'run.bat')],['reveal',path.join(project,'logo.png')],['copy',path.join(project,'src','app.js')]]);
  await assert.rejects(openRef({shell,clipboard},project,path.join(outside,'notes.md'),'view'),/只能在分栏里查看/);
});

test('reply links keep web addresses and file paths but not scripts',async()=>{
  const {LINK_URI}=await import('../ui/src/core/dom.mjs');
  for(const ok of ['https://a.com','mailto:a@b.c','F:/out/report.html','C:\\x\\y.docx','file:///F:/a.txt','outputs/a.md','./a.md','#top'])assert.match(ok,LINK_URI,ok);
  for(const bad of ['javascript:alert(1)','vbscript:x','data:text/html,x'])assert.doesNotMatch(bad,LINK_URI,bad);
});
