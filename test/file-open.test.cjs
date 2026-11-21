const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveRef,resolveRefAsync,findInFolder,findInFolderAsync,closeSearchWorker,collectHints,clickAction,openRef}=require('../file-open.cjs');

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
  assert.throws(()=>resolveRef(project,'missing.txt'),e=>{assert.match(e.message,/里找不到 missing\.txt/);assert.ok(e.message.includes(project));return true;});
  // Only a name, or the end of the path: the shallowest match in the folder.
  fs.mkdirSync(path.join(project,'outputs','releases'),{recursive:true});fs.mkdirSync(path.join(project,'work','a','releases'),{recursive:true});
  fs.writeFileSync(path.join(project,'outputs','releases','App-1.0.zip'),'x');fs.writeFileSync(path.join(project,'work','a','releases','App-1.0.zip'),'y');
  assert.equal(resolveRef(project,'App-1.0.zip'),path.join(project,'outputs','releases','App-1.0.zip'));
  assert.equal(resolveRef(project,'a/releases/App-1.0.zip'),path.join(project,'work','a','releases','App-1.0.zip'));
  assert.equal(resolveRef(project,'app.js'),path.join(project,'src','app.js'));
  assert.throws(()=>resolveRef(project,'../outside/notes.md/x'),/里找不到/);
});

test('tool hints locate files outside cwd, clicked turn wins, and removed worktrees explain why a file is missing',async()=>{
  const {root,project,outside}=folders();
  const docs=path.join(outside,'docs');fs.mkdirSync(docs,{recursive:true});
  const docFile=path.join(docs,'desktop-candidate2.md');fs.writeFileSync(docFile,'# candidate');
  const otherDir=path.join(root,'bash-work');fs.mkdirSync(path.join(otherDir,'sub'),{recursive:true});
  const bashFile=path.join(otherDir,'sub','out.md');fs.writeFileSync(bashFile,'hi');
  const olderFile=path.join(outside,'older','dup.md');fs.mkdirSync(path.dirname(olderFile),{recursive:true});fs.writeFileSync(olderFile,'old');
  const newerFile=path.join(outside,'newer','dup.md');fs.mkdirSync(path.dirname(newerFile),{recursive:true});fs.writeFileSync(newerFile,'new');
  // Direct hints array finds file outside cwd, and also searches near hinted tool directories.
  assert.equal(resolveRef(project,'docs/desktop-candidate2.md',[docFile]),docFile);
  const siblingSub=path.join(outside,'scripts','preview-manifests','0.29.11-beta.json');
  const scriptFile=path.join(outside,'scripts','github-release.cjs');
  fs.mkdirSync(path.dirname(siblingSub),{recursive:true});fs.writeFileSync(siblingSub,'{}');fs.writeFileSync(scriptFile,'');
  assert.equal(resolveRef(project,'0.29.11-beta.json',[scriptFile]),siblingSub);
  // collectHints reads file_path, notebook_path, path and Bash cd, preferring clicked turn.
  const thread={cwd:project,turns:[
    {id:'t1',tools:[{name:'Read',input:{file_path:olderFile}},{name:'Bash',input:{command:`cd "${otherDir}" && dir`}}]},
    {id:'t2',tools:[{name:'Write',input:{file_path:docFile}},{name:'Read',input:{file_path:newerFile}}]}
  ]};
  assert.equal(resolveRef(project,'dup.md',collectHints(thread,'t1')),olderFile);
  assert.equal(resolveRef(project,'dup.md',collectHints(thread,'t2')),newerFile);
  assert.equal(resolveRef(project,'sub/out.md',collectHints(thread,'t2')),bashFile);
  // Outside files found via hints open in their system app, not the split view.
  const {calls,shell,clipboard}=fakeShell();
  assert.deepEqual(await openRef({shell,clipboard},project,'docs/desktop-candidate2.md','click',{hints:collectHints(thread,'t2')}),{opened:true});
  assert.deepEqual(calls,[['open',docFile]]);
  // Removed worktree error mentions cwd and branch.
  assert.throws(()=>resolveRef(project,'docs/only-in-branch.md',{worktree:{removed:true,branch:'claude-desk/abc123'}}),e=>{
    assert.ok(e.message.includes(project));assert.match(e.message,/工作树已删除/);assert.match(e.message,/claude-desk\/abc123/);return true;
  });
});

test('folder search enters dot-folders except .git, skips build outputs, and scales past 3000 folders',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'desk-search-'));
  fs.mkdirSync(path.join(root,'.github','workflows'),{recursive:true});
  fs.mkdirSync(path.join(root,'.claude'),{recursive:true});
  fs.mkdirSync(path.join(root,'.git','hooks'),{recursive:true});
  fs.mkdirSync(path.join(root,'dist'),{recursive:true});
  const gh=path.join(root,'.github','workflows','ci.yml'),cl=path.join(root,'.claude','settings.json');
  fs.writeFileSync(gh,'name: ci');fs.writeFileSync(cl,'{}');
  fs.writeFileSync(path.join(root,'.git','hooks','secret.sample'),'x');
  fs.writeFileSync(path.join(root,'dist','bundle.js'),'x');
  assert.equal(resolveRef(root,'workflows/ci.yml'),gh);
  assert.equal(resolveRef(root,'settings.json'),cl);
  assert.throws(()=>resolveRef(root,'secret.sample'),/里找不到/);
  assert.throws(()=>resolveRef(root,'bundle.js'),/里找不到/);
  // More than the old 3000-folder cap, still within the new entry budget.
  const many=fs.mkdtempSync(path.join(os.tmpdir(),'desk-many-'));
  for(let i=0;i<3050;i++)fs.mkdirSync(path.join(many,'d'+String(i).padStart(4,'0')));
  const deep=path.join(many,'z-last','target-file.md');fs.mkdirSync(path.dirname(deep));fs.writeFileSync(deep,'ok');
  assert.equal(findInFolder(many,'target-file.md',{maxEntries:20000,maxMs:5000}),deep);
  fs.rmSync(root,{recursive:true,force:true});fs.rmSync(many,{recursive:true,force:true});
});

test('background worker thread prioritizes source folders over deferred work/build folders and still finds files in work',async t=>{
  t.after(()=>closeSearchWorker());
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'desk-worker-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'work','build-001','nested'),{recursive:true});
  fs.mkdirSync(path.join(root,'outputs','scripts','preview-manifests'),{recursive:true});
  const inWork=path.join(root,'work','build-001','only-in-work.md');
  const dupWork=path.join(root,'work','0.29.11-beta.json');
  const inOutputs=path.join(root,'outputs','scripts','preview-manifests','0.29.11-beta.json');
  fs.writeFileSync(inWork,'w');fs.writeFileSync(dupWork,'{}');fs.writeFileSync(inOutputs,'{}');
  // Normal folder wins over shallower deferred `work/` folder.
  assert.equal(await resolveRefAsync(root,'0.29.11-beta.json'),inOutputs);
  // Files that only live inside deferred `work/` are still found in pass 2.
  assert.equal(await findInFolderAsync(root,'only-in-work.md'),inWork);
  await assert.rejects(()=>resolveRefAsync(root,'definitely-missing.md'),e=>{assert.ok(e.message.includes(root));return true;});
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
