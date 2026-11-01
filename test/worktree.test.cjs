const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {Worktrees}=require('../worktree.cjs');

const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'desk-worktree-'));
function repo(){
  const dir=tmp(),git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
  git(dir,'init','-q','-b','main');git(dir,'config','user.email','t@t');git(dir,'config','user.name','t');git(dir,'config','core.autocrlf','false');
  fs.mkdirSync(path.join(dir,'app'));fs.writeFileSync(path.join(dir,'app/a.txt'),'one\n');git(dir,'add','.');git(dir,'commit','-qm','init');
  return{dir,git};
}

test('a worktree branches off, merges back with --no-ff and is removed with its branch', async()=>{
  const {dir,git}=repo(),trees=new Worktrees(tmp());
  fs.writeFileSync(path.join(dir,'app/a.txt'),'local edit\n');
  const wt=await trees.create(path.join(dir,'app'));
  assert.match(wt.branch,/^claude-desk\/[0-9a-f]{6}$/);
  assert.equal(wt.base,'main');
  assert.equal(wt.cwd,path.join(wt.path,'app'),'a project opened at a subfolder keeps working there');
  assert.equal(fs.readFileSync(path.join(wt.cwd,'a.txt'),'utf8'),'one\n','uncommitted edits stay in the main checkout');
  fs.writeFileSync(path.join(wt.cwd,'b.txt'),'new\n');
  assert.equal((await trees.status(wt)).dirty,1);
  await assert.rejects(()=>trees.merge(wt),/未提交/);
  git(wt.path,'add','.');git(wt.path,'commit','-qm','add b');
  const state=await trees.status(wt);
  assert.deepEqual([state.dirty,state.ahead,state.merged,state.target],[0,1,false,'main']);
  git(dir,'checkout','--','app/a.txt');
  const merged=await trees.merge(wt);
  assert.deepEqual(merged,{target:'main',commits:1});
  assert.equal(fs.readFileSync(path.join(dir,'app/b.txt'),'utf8'),'new\n');
  assert.equal((await trees.status(wt)).merged,true);
  const removed=await trees.remove(wt);
  assert.equal(removed.branchKept,false);
  assert.equal(fs.existsSync(wt.path),false);
  assert.equal(git(dir,'branch','--list',wt.branch),'');
});

test('conflicts abort the merge and unmerged branches are kept on removal', async()=>{
  const {dir,git}=repo(),trees=new Worktrees(tmp());
  const wt=await trees.create(dir);
  fs.writeFileSync(path.join(wt.path,'app/a.txt'),'theirs\n');git(wt.path,'commit','-qam','theirs');
  fs.writeFileSync(path.join(dir,'app/a.txt'),'ours\n');git(dir,'commit','-qam','ours');
  await assert.rejects(()=>trees.merge(wt),/冲突，已取消合并[\s\S]*app\/a.txt/);
  assert.equal(git(dir,'status','--porcelain'),'','main checkout left clean');
  assert.equal(fs.readFileSync(path.join(dir,'app/a.txt'),'utf8'),'ours\n');
  const removed=await trees.remove(wt);
  assert.equal(removed.branchKept,true,'unmerged work is not lost');
  assert.notEqual(git(dir,'branch','--list',wt.branch),'');
});

test('folders that are not repositories, or have no commits, are refused', async()=>{
  const trees=new Worktrees(tmp());
  await assert.rejects(()=>trees.create(tmp()),/不是 Git 仓库/);
  const empty=tmp();execFileSync('git',['-C',empty,'init','-q']);
  await assert.rejects(()=>trees.create(empty),/还没有任何提交/);
});

test('a folder git already unregistered (half-finished removal on Windows) is cleaned up', async()=>{
  const {dir,git}=repo(),trees=new Worktrees(tmp());
  const wt=await trees.create(dir);
  fs.rmSync(path.join(dir,'.git/worktrees',path.basename(wt.path)),{recursive:true,force:true});
  assert.ok(fs.existsSync(wt.path));
  assert.deepEqual(await trees.status(wt),{exists:false});
  const removed=await trees.remove(wt);
  assert.equal(fs.existsSync(wt.path),false);
  assert.equal(removed.branchKept,false);
  assert.equal(git(dir,'branch','--list',wt.branch),'');
});
