const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path');const {spawn,spawnSync,execFileSync}=require('node:child_process');
const {Updater,manifestOf,diff,hashFile,UPDATE_FILE}=require('../updates.cjs');const {buildUpdater,UPDATER_EXE}=require('../scripts/build-updater.cjs');
const windows=process.platform==='win32',scratch=path.resolve(__dirname,'../../../work/native-updater-tests');fs.mkdirSync(scratch,{recursive:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const write=(root,relative,text)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
async function fixture(from='1.0.0',to='1.1.0'){
  const root=fs.mkdtempSync(path.join(scratch,'更新 空格-')),old=path.join(root,'old'),next=path.join(root,'next'),temp=path.join(root,'temp'),stage=path.join(temp,'claude-desk-update-native');
  for(const [dir,version]of [[old,from],[next,to]]){write(dir,'ClaudeDesk.exe','exe');write(dir,'claude-desk-version.json',JSON.stringify({app:'ClaudeDesk',version}));write(dir,'resources/app.asar',version);write(dir,'resources/blocked.dll',version);fs.copyFileSync(buildUpdater(),path.join(dir,UPDATER_EXE));}
  write(old,'resources/obsolete.dll','old');write(next,'resources/aa-added.dll','new');
  const before=await manifestOf(old,from),after=await manifestOf(next,to),changes=diff(before,after);
  for(const rel of changes.changed)write(stage,rel,fs.readFileSync(path.join(next,rel)));
  const info={app:'ClaudeDesk',from,to,files:Object.fromEntries(changes.changed.map(rel=>[rel,after.files[rel]])),removed:changes.removed};write(stage,UPDATE_FILE,JSON.stringify(info));
  const updater=new Updater({installDir:old,version:from,tempRoot:temp});updater.staged={dir:stage,from,to};
  return{root,old,next,temp,stage,info,before,after,updater};
}
async function finished(f,child){for(let i=0;i<200;i++){try{const result=JSON.parse(fs.readFileSync(path.join(f.stage,'install-result.json'),'utf8'));if(!child||child.exitCode!==null)return result;}catch{}await pause(50);}throw Error('Updater did not finish');}
const apply=(f,extra={})=>f.updater.apply({pid:0,exe:path.join(f.old,'ClaudeDesk.exe'),restart:false,retryMs:200,...extra});
test('native updater installs and removes files, and keeps the application version consistent',{skip:!windows},async()=>{
  const f=await fixture(),child=await apply(f);assert.equal((await finished(f,child)).status,'ok');assert.deepEqual((await manifestOf(f.old,'x')).files,f.after.files);assert.equal(f.updater.cleanup(),'');assert.equal(fs.existsSync(f.stage),false);
});

test('native installer upgrades stable to preview, preview to preview, and preview to stable',{skip:!windows},async()=>{
  for(const [from,to] of [['0.29.5','0.30.0-beta.1'],['0.30.0-beta.2','0.30.0-beta.10'],['0.30.0-beta.10','0.30.0-rc.1'],['0.30.0-rc.1','0.30.0']]){
    const f=await fixture(from,to),child=await apply(f);assert.equal((await finished(f,child)).status,'ok',from+' -> '+to);assert.deepEqual((await manifestOf(f.old,'x')).files,f.after.files);f.updater.cleanup();
  }
  for(const [from,to] of [['0.30.0','0.30.0-rc.1'],['0.30.0-beta.10','0.30.0-beta.2'],['0.30.0-beta.2','0.30.0-beta.2'],['0.30.0-beta.2','0.30.0-beta.01']]){
    const f=await fixture(from,to);await assert.rejects(()=>apply(f),/newer|Invalid update version/);assert.deepEqual((await manifestOf(f.old,'x')).files,f.before.files);f.updater.cleanup();
  }
});
test('the installed updater can be replaced because a separate copy is executing',{skip:!windows},async()=>{
  const f=await fixture(),replacement=Buffer.concat([fs.readFileSync(buildUpdater()),Buffer.from('self-update-fixture')]);write(f.stage,UPDATER_EXE,replacement);f.info.files[UPDATER_EXE]=await hashFile(path.join(f.stage,UPDATER_EXE));write(f.stage,UPDATE_FILE,JSON.stringify(f.info));
  const child=await apply(f);assert.equal((await finished(f,child)).status,'ok');assert.deepEqual(fs.readFileSync(path.join(f.old,UPDATER_EXE)),replacement);assert.notEqual(child.spawnfile,path.join(f.old,UPDATER_EXE));
});
test('a checksum failure before readiness leaves the current application untouched',{skip:!windows},async()=>{
  const f=await fixture();write(f.stage,'resources/app.asar','tampered');await assert.rejects(()=>apply(f),/damaged or missing/);assert.deepEqual((await manifestOf(f.old,'x')).files,f.before.files);
});
test('version verification failure restores changed/deleted files and removes newly added files',{skip:!windows},async()=>{
  const f=await fixture();write(f.stage,'claude-desk-version.json',JSON.stringify({app:'ClaudeDesk',version:'9.9.9'}));f.info.files['claude-desk-version.json']=await hashFile(path.join(f.stage,'claude-desk-version.json'));write(f.stage,UPDATE_FILE,JSON.stringify(f.info));
  const child=await apply(f),result=await finished(f,child);assert.equal(result.status,'failed');assert.equal(result.rollbackComplete,true);assert.deepEqual((await manifestOf(f.old,'x')).files,f.before.files);assert.equal(fs.existsSync(path.join(f.old,'resources/aa-added.dll')),false);
});
test('a Windows file lock during replacement rolls back earlier replacements',{skip:!windows},async()=>{
  const f=await fixture(),ready=path.join(f.root,'locked.ready'),release=path.join(f.root,'release'),script=path.join(f.root,'lock.ps1');
  fs.writeFileSync(script,"param($File,$Ready,$Release)\n$stream=[IO.File]::Open($File,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)\ntry { [IO.File]::WriteAllText($Ready,'ready'); while(-not [IO.File]::Exists($Release)){Start-Sleep -Milliseconds 30} } finally {$stream.Dispose()}");
  const holder=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',script,path.join(f.old,'resources/blocked.dll'),ready,release],{windowsHide:true,stdio:'ignore'});
  try{for(let i=0;i<100&&!fs.existsSync(ready);i++)await pause(50);assert.ok(fs.existsSync(ready));const child=await apply(f),result=await finished(f,child);assert.equal(result.status,'failed');assert.equal(result.rollbackComplete,true);assert.deepEqual((await manifestOf(f.old,'x')).files,f.before.files);}
  finally{fs.writeFileSync(release,'release');for(let i=0;i<50&&holder.exitCode===null;i++)await pause(20);holder.kill();}
});
test('active staging survives cleanup and files change only after the parent process exits',{skip:!windows},async()=>{
  const f=await fixture(),script=path.join(f.root,'parent.cjs');fs.writeFileSync(script,'setInterval(()=>{},1000);');const parent=spawn(process.execPath,[script],{windowsHide:true,stdio:'ignore'});
  try{const child=await apply(f,{pid:parent.pid,waitExe:process.execPath});assert.equal(f.updater.cleanup(),'');assert.ok(fs.existsSync(f.stage));assert.deepEqual((await manifestOf(f.old,'x')).files,f.before.files);parent.kill();assert.equal((await finished(f,child)).status,'ok');}
  finally{parent.kill();}
});
test('parent timeout never kills the running app or modifies its files',{skip:!windows},async()=>{
  const f=await fixture(),script=path.join(f.root,'parent.cjs');fs.writeFileSync(script,'setInterval(()=>{},1000);');const parent=spawn(process.execPath,[script],{windowsHide:true,stdio:'ignore'});
  try{const child=await apply(f,{pid:parent.pid,waitExe:process.execPath,waitMs:150});const result=await finished(f,child);assert.equal(result.status,'failed');assert.equal(parent.exitCode,null);assert.deepEqual((await manifestOf(f.old,'x')).files,f.before.files);}
  finally{parent.kill();}
});
test('native installer rejects traversal and linked destination paths before readiness',{skip:!windows},async()=>{
  const f=await fixture();f.info.files['../outside.txt']='a'.repeat(64);write(f.stage,UPDATE_FILE,JSON.stringify(f.info));await assert.rejects(()=>apply(f),/Unsafe update path/);assert.equal(fs.existsSync(path.join(f.old,'../outside.txt')),false);
  const linked=await fixture(),outside=path.join(linked.root,'outside');fs.renameSync(path.join(linked.old,'resources'),outside);fs.symlinkSync(outside,path.join(linked.old,'resources'),'junction');await assert.rejects(()=>apply(linked),/Linked update path/);assert.equal(fs.readFileSync(path.join(outside,'app.asar'),'utf8'),'1.0.0');
});
test('interrupted or incomplete rollback backups survive startup cleanup',()=>{
  const root=fs.mkdtempSync(path.join(scratch,'recovery-')),stage=path.join(root,'claude-desk-update-test');write(stage,'backup-index.json','[]');write(stage,'backup/important.dll','old');write(stage,'install.log','installing 1.0.0 -> 1.1.0');
  const updater=new Updater({installDir:root,version:'1.0.0',tempRoot:root});assert.match(updater.cleanup(),/恢复备份已保留/);assert.ok(fs.existsSync(path.join(stage,'backup/important.dll')));write(stage,'install-result.json',JSON.stringify({status:'failed',rollbackComplete:false}));assert.match(updater.cleanup(),/恢复备份已保留/);assert.ok(fs.existsSync(stage));
});
test('the detached native installer survives the process that launched it',{skip:!windows},async()=>{
  const f=await fixture(),script=path.join(f.root,'launch.cjs');fs.writeFileSync(script,`const {Updater}=require(${JSON.stringify(path.resolve(__dirname,'../updates.cjs'))});const updater=new Updater(${JSON.stringify({installDir:f.old,version:'1.0.0',tempRoot:f.temp})});updater.staged={dir:${JSON.stringify(f.stage)}};updater.apply({pid:process.pid,waitExe:process.execPath,exe:${JSON.stringify(path.join(f.old,'ClaudeDesk.exe'))},restart:false}).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});`);
  const parent=spawnSync(process.execPath,[script],{windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(parent.status,0,parent.stderr);assert.equal((await finished(f)).status,'ok');assert.deepEqual((await manifestOf(f.old,'x')).files,f.after.files);
});
