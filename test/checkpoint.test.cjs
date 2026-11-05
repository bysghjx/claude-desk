const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {Checkpoints,MAX_FILE}=require('../checkpoint.cjs');

const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'desk-checkpoint-'));
const write=(dir,rel,text)=>{fs.mkdirSync(path.dirname(path.join(dir,rel)),{recursive:true});fs.writeFileSync(path.join(dir,rel),text);};
const read=(dir,rel)=>fs.readFileSync(path.join(dir,rel),'utf8');

test('restores changed, deleted and created files to the checkpoint', async()=>{
  const project=tmp(),store=new Checkpoints(tmp());
  write(project,'a.txt','one');write(project,'src/b.js','b1');write(project,'keep/c.md','c');
  const tree=await store.snapshot(project);
  write(project,'a.txt','two');fs.rmSync(path.join(project,'keep/c.md'));write(project,'new/deep/d.txt','d');
  const {files}=await store.changes(project,tree);
  assert.deepEqual(files.map(f=>f.status+' '+f.path).sort(),['A new/deep/d.txt','D keep/c.md','M a.txt']);
  const result=await store.restore(project,tree);
  assert.equal(result.files.length,3);
  assert.equal(read(project,'a.txt'),'one');
  assert.equal(read(project,'keep/c.md'),'c');
  assert.equal(read(project,'src/b.js'),'b1');
  assert.equal(fs.existsSync(path.join(project,'new')),false,'emptied folders are removed too');
  assert.deepEqual((await store.changes(project,tree)).files,[]);
});

test('leaves the project repository alone and honours .gitignore', async()=>{
  const project=tmp(),store=new Checkpoints(tmp());
  const git=(...args)=>execFileSync('git',['-C',project,...args],{encoding:'utf8'});
  git('init','-q');git('config','user.email','t@t');git('config','user.name','t');
  write(project,'.gitignore','secret.env\n');write(project,'app.js','v1');write(project,'secret.env','KEY=1');
  git('add','.');git('commit','-qm','init');
  write(project,'app.js','v2');git('add','app.js');
  const before=git('status','--porcelain'),head=git('rev-parse','HEAD');
  const tree=await store.snapshot(project);
  assert.equal(git('status','--porcelain'),before,'project index and status unchanged');
  assert.equal(git('rev-parse','HEAD'),head);
  assert.equal(git('branch','--list').trim(),'* '+git('branch','--show-current').trim(),'no extra branches');
  write(project,'app.js','v3');write(project,'secret.env','KEY=2');
  const {files}=await store.changes(project,tree);
  assert.deepEqual(files.map(f=>f.path),['app.js'],'ignored files are not tracked');
  await store.restore(project,tree);
  assert.equal(read(project,'app.js'),'v2');
  assert.equal(read(project,'secret.env'),'KEY=2');
});

test('skips files above the size limit instead of copying them', async()=>{
  const project=tmp(),store=new Checkpoints(tmp());
  write(project,'small.txt','s');fs.writeFileSync(path.join(project,'big.bin'),Buffer.alloc(MAX_FILE+1));
  const tree=await store.snapshot(project);
  fs.rmSync(path.join(project,'big.bin'));write(project,'small.txt','t');
  const {files}=await store.changes(project,tree);
  assert.deepEqual(files.map(f=>f.path),['small.txt']);
});

test('restores only the listed files and can put them back again', async()=>{
  const project=tmp(),store=new Checkpoints(tmp());
  write(project,'a.txt','one');write(project,'b.txt','b1');
  const tree=await store.snapshot(project);
  write(project,'a.txt','two');write(project,'b.txt','b2');write(project,'src/new.js','n');write(project,'other.txt','o');
  const undo=await store.restore(project,tree,['a.txt',String.raw`SRC\new.js`]);
  assert.deepEqual(undo.files.map(f=>f.path).sort(),['a.txt','src/new.js']);
  assert.equal(read(project,'a.txt'),'one');assert.equal(fs.existsSync(path.join(project,'src')),false);
  assert.equal(read(project,'b.txt'),'b2','files not listed stay as they are');assert.equal(read(project,'other.txt'),'o');
  assert.equal((await store.restore(project,tree,[])).files.length,0,'an empty list restores nothing');
  const redo=await store.restore(project,undo.before,undo.files.map(f=>f.path));
  assert.equal(redo.files.length,2);assert.equal(read(project,'a.txt'),'two');assert.equal(read(project,'src/new.js'),'n');
});
