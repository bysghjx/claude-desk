const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {Updater,manifestOf,diff,verifyUpdate,safe,UPDATE_FILE}=require('../updates.cjs');
const scratch=path.resolve(__dirname,'../../../work/update-tests');fs.mkdirSync(scratch,{recursive:true});
const write=(dir,files)=>{for(const [rel,text] of Object.entries(files)){const file=path.join(dir,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}};
// Two versions of an app folder and the update package between them, built the way scripts/release.cjs does.
async function versions(){
  const root=fs.mkdtempSync(path.join(scratch,'测试 目录-')),old=path.join(root,'old'),next=path.join(root,'next'),pkg=path.join(root,'pkg');
  write(old,{'ClaudeDesk.exe':'exe','resources/app.asar':'app 1','resources/old-only.txt':'gone','使用说明.txt':'说明 1','debug.log':'noise'});
  write(next,{'ClaudeDesk.exe':'exe','resources/app.asar':'app 2','resources/new/extra.dll':'new','使用说明.txt':'说明 2'});
  const from=await manifestOf(old,'1.0.0'),to=await manifestOf(next,'1.1.0'),{changed,removed}=diff(from,to);
  for(const rel of changed){fs.mkdirSync(path.dirname(path.join(pkg,rel)),{recursive:true});fs.copyFileSync(path.join(next,rel),path.join(pkg,rel));}
  fs.writeFileSync(path.join(pkg,UPDATE_FILE),JSON.stringify({app:'ClaudeDesk',from:'1.0.0',to:'1.1.0',files:Object.fromEntries(changed.map(r=>[r,to.files[r]])),removed}));
  return{root,old,next,pkg,from,to,changed,removed};
}
test('manifests skip the crash log and the diff lists changed, added and removed files',async()=>{
  const {from,changed,removed}=await versions();
  assert.ok(!('debug.log' in from.files));assert.ok('使用说明.txt' in from.files);
  assert.deepEqual(changed.sort(),['resources/app.asar','resources/new/extra.dll','使用说明.txt']);assert.deepEqual(removed,['resources/old-only.txt']);
});
test('an update package must be for the running version, complete and untampered, with safe paths',async()=>{
  const {pkg}=await versions();
  assert.deepEqual(await verifyUpdate(pkg,'1.0.0'),{from:'1.0.0',to:'1.1.0',files:3,removed:1,size:fs.statSync(path.join(pkg,'resources/app.asar')).size+fs.statSync(path.join(pkg,'resources/new/extra.dll')).size+fs.statSync(path.join(pkg,'使用说明.txt')).size,notes:''});
  await assert.rejects(()=>verifyUpdate(pkg,'0.9.0'),/从 1\.0\.0 升级到 1\.1\.0 用的，当前是 0\.9\.0/);
  fs.writeFileSync(path.join(pkg,'resources/app.asar'),'tampered');await assert.rejects(()=>verifyUpdate(pkg,'1.0.0'),/已损坏：resources\/app\.asar/);
  await assert.rejects(()=>verifyUpdate(path.join(pkg,'resources'),'1.0.0'),/不是 Claude Desk 的更新包/);
  for(const bad of ['../evil.exe','C:/Windows/x','a\\..\\b'])assert.throws(()=>safe(bad),/不安全/);assert.equal(safe('resources/app.asar'),'resources/app.asar');
});
test('a real update zip is extracted, checked and installed over the old folder by the PowerShell script',{skip:process.platform!=='win32'},async()=>{
  const {root,old,next,pkg}=await versions();
  const zip=path.join(root,'update.zip');execFileSync('C:\\Windows\\System32\\tar.exe',['-a','-c','-f',zip,'-C',pkg,...fs.readdirSync(pkg)]);
  const updater=new Updater({installDir:old,version:'1.0.0',tempRoot:path.join(root,'temp')});
  const staged=await updater.stage(zip);assert.equal(staged.to,'1.1.0');
  updater.apply({pid:0,exe:'unused',restart:false});
  const log=path.join(staged.dir,'install.log');for(let i=0;i<60&&!fs.existsSync(log);i++)await new Promise(r=>setTimeout(r,500));
  assert.match(fs.readFileSync(path.join(staged.dir,'install.log'),'utf8'),/ok 1\.0\.0 -> 1\.1\.0/);
  assert.deepEqual((await manifestOf(old,'x')).files,(await manifestOf(next,'x')).files);
  assert.equal(updater.cleanup(),'');assert.equal(fs.readdirSync(path.join(root,'temp')).length,0);
  await assert.rejects(()=>new Updater({installDir:old,version:'1.1.0',tempRoot:path.join(root,'temp')}).stage(zip),/当前是 1\.1\.0/);
  assert.equal(fs.readdirSync(path.join(root,'temp')).length,0,'a rejected package leaves nothing behind');
});
test('cleanup reports a failed install from its log',()=>{
  const temp=fs.mkdtempSync(path.join(scratch,'t-'));write(temp,{'claude-desk-update-abc/install.log':'﻿failed: 文件被占用'});
  assert.equal(new Updater({installDir:temp,version:'1',tempRoot:temp}).cleanup(),'文件被占用');assert.equal(fs.existsSync(path.join(temp,'claude-desk-update-abc')),false);
});
