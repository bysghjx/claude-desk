const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
const review=require('../review.cjs');
const scratch=path.resolve(__dirname,'../../../work/review-tests');fs.mkdirSync(scratch,{recursive:true});
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true});
function repo({commit=true}={}){
  const dir=fs.mkdtempSync(path.join(scratch,'repo-'));git(dir,'init','-q');git(dir,'config','user.name','Review Test');git(dir,'config','user.email','review@test.local');git(dir,'config','core.autocrlf','false');
  fs.mkdirSync(path.join(dir,'src'));fs.writeFileSync(path.join(dir,'src/a.js'),'one\ntwo\nthree\n');fs.writeFileSync(path.join(dir,'keep.txt'),'keep\n');
  if(commit){git(dir,'add','-A');git(dir,'commit','-q','-m','init');}
  return dir;
}
test('changes report per-file counts for modified, new and staged files',async()=>{
  const dir=repo();fs.writeFileSync(path.join(dir,'src/a.js'),'one\nTWO\nthree\nfour\n');fs.writeFileSync(path.join(dir,'new.md'),'a\nb\n');fs.writeFileSync(path.join(dir,'keep.txt'),'kept\n');git(dir,'add','keep.txt');
  const result=await review.changes(dir);const by=Object.fromEntries(result.files.map(f=>[f.path,f]));
  assert.equal(result.isGit,true);assert.equal(result.prefix,'');
  assert.deepEqual([by['src/a.js'].added,by['src/a.js'].removed,by['src/a.js'].staged],[2,1,false]);
  assert.deepEqual([by['new.md'].added,by['new.md'].untracked],[2,true]);
  assert.equal(by['keep.txt'].staged,true);
  assert.match(await review.diff(dir,'new.md'),/^\+a$/m);assert.match(await review.diff(dir,'src/a.js'),/^-two$/m);
  assert.deepEqual(await review.changes(scratch).then(r=>r.isGit),false);
});
test('stage, unstage, revert and commit act on single files inside the repository',async()=>{
  const dir=repo();fs.writeFileSync(path.join(dir,'src/a.js'),'changed\n');fs.writeFileSync(path.join(dir,'new.md'),'new\n');fs.writeFileSync(path.join(dir,'keep.txt'),'edited\n');
  await review.stage(dir,['keep.txt'],true);assert.equal((await review.changes(dir)).files.find(f=>f.path==='keep.txt').staged,true);
  await review.stage(dir,['keep.txt'],false);assert.equal((await review.changes(dir)).files.find(f=>f.path==='keep.txt').staged,false);
  await review.revert(dir,'src/a.js');assert.equal(fs.readFileSync(path.join(dir,'src/a.js'),'utf8'),'one\ntwo\nthree\n');
  await review.revert(dir,'new.md');assert.equal(fs.existsSync(path.join(dir,'new.md')),false);
  await assert.rejects(()=>review.commit(dir,'nothing staged',false),/还没有暂存/);
  await assert.rejects(()=>review.commit(dir,'  ',true),/提交说明/);
  const result=await review.commit(dir,'Update keep file',true);assert.equal(result.subject,'Update keep file');assert.match(result.hash,/^[0-9a-f]{6,}$/);
  assert.equal((await review.changes(dir)).files.length,0);
  for(const bad of ['../outside.txt','.git/config','',path.join(dir,'..','x')])await assert.rejects(()=>review.revert(dir,bad),/文件路径无效|文件不在仓库内/);
});
test('a project inside a repository subfolder and a repository without commits are both supported',async()=>{
  const dir=repo();fs.writeFileSync(path.join(dir,'src/a.js'),'x\n');
  const sub=await review.changes(path.join(dir,'src'));assert.equal(sub.prefix,'src');assert.equal(sub.files[0].path,'src/a.js');
  const fresh=repo({commit:false});const before=await review.changes(fresh);
  assert.equal(before.hasHead,false);assert.deepEqual(before.files.map(f=>[f.path,f.added]).sort(),[['keep.txt',1],['src/a.js',3]]);
  await review.stage(fresh,['keep.txt'],true);await review.stage(fresh,['keep.txt'],false);
  assert.equal((await review.changes(fresh)).files.find(f=>f.path==='keep.txt').staged,false);
  await review.commit(fresh,'First commit',true);assert.equal((await review.changes(fresh)).hasHead,true);
});
