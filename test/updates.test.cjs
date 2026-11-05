const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {Updater,manifestOf,diff,verifyUpdate,safe,packagesFor,UPDATE_FILE}=require('../updates.cjs');
const scratch=path.resolve(__dirname,'../../../work/update-tests');fs.mkdirSync(scratch,{recursive:true});
const write=(dir,files)=>{for(const [rel,text] of Object.entries(files)){const file=path.join(dir,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}};
// Two versions of an app folder and the update package between them, built the way scripts/release.cjs does.
async function versions(){
  const root=fs.mkdtempSync(path.join(scratch,'测试 目录-')),old=path.join(root,'old'),next=path.join(root,'next'),pkg=path.join(root,'pkg');
  write(old,{'ClaudeDesk.exe':'exe','resources/app.asar':'app 1','resources/old-only.txt':'gone','使用说明.txt':'说明 1','debug.log':'noise'});
  write(next,{'ClaudeDesk.exe':'exe','resources/app.asar':'app 2','resources/new/extra.dll':'new','使用说明.txt':'说明 2'});
  for(const [dir,version]of [[old,'1.0.0'],[next,'1.1.0']]){
    fs.writeFileSync(path.join(dir,'claude-desk-version.json'),JSON.stringify({app:'ClaudeDesk',version}));
    if(process.platform==='win32')fs.copyFileSync(require('../scripts/build-updater.cjs').buildUpdater(),path.join(dir,'ClaudeDesk.Updater.exe'));
  }
  const from=await manifestOf(old,'1.0.0'),to=await manifestOf(next,'1.1.0'),{changed,removed}=diff(from,to);
  for(const rel of changed){fs.mkdirSync(path.dirname(path.join(pkg,rel)),{recursive:true});fs.copyFileSync(path.join(next,rel),path.join(pkg,rel));}
  fs.writeFileSync(path.join(pkg,UPDATE_FILE),JSON.stringify({app:'ClaudeDesk',from:'1.0.0',to:'1.1.0',files:Object.fromEntries(changed.map(r=>[r,to.files[r]])),removed}));
  return{root,old,next,pkg,from,to,changed,removed};
}
test('manifests skip the crash log and the diff lists changed, added and removed files',async()=>{
  const {from,changed,removed}=await versions();
  assert.ok(!('debug.log' in from.files));assert.ok('使用说明.txt' in from.files);
  assert.deepEqual(changed.sort(),['claude-desk-version.json','resources/app.asar','resources/new/extra.dll','使用说明.txt']);assert.deepEqual(removed,['resources/old-only.txt']);
});
test('an update package must be for the running version, complete and untampered, with safe paths',async()=>{
  const {pkg}=await versions();
  assert.deepEqual(await verifyUpdate(pkg,'1.0.0'),{from:'1.0.0',to:'1.1.0',files:4,removed:1,size:['claude-desk-version.json','resources/app.asar','resources/new/extra.dll','使用说明.txt'].reduce((n,file)=>n+fs.statSync(path.join(pkg,file)).size,0),notes:''});
  await assert.rejects(()=>verifyUpdate(pkg,'0.9.0'),/从 1\.0\.0 升级到 1\.1\.0 用的，当前是 0\.9\.0/);
  fs.writeFileSync(path.join(pkg,'resources/app.asar'),'tampered');await assert.rejects(()=>verifyUpdate(pkg,'1.0.0'),/已损坏：resources\/app\.asar/);
  await assert.rejects(()=>verifyUpdate(path.join(pkg,'resources'),'1.0.0'),/不是 Claude Desk 的更新包/);
  for(const bad of ['../evil.exe','C:/Windows/x','a\\..\\b'])assert.throws(()=>safe(bad),/不安全/);assert.equal(safe('resources/app.asar'),'resources/app.asar');
});
test('a real update zip is extracted, checked and installed by the independent executable',{skip:process.platform!=='win32'},async()=>{
  const {root,old,next,pkg}=await versions();
  const zip=path.join(root,'update.zip');execFileSync('C:/Windows/System32/tar.exe',['-a','-c','-f',zip,'-C',pkg,...fs.readdirSync(pkg)]);
  const updater=new Updater({installDir:old,version:'1.0.0',tempRoot:path.join(root,'temp')});
  const staged=await updater.stage(zip);assert.equal(staged.to,'1.1.0');
  const child=await updater.apply({pid:0,exe:path.join(old,'ClaudeDesk.exe'),restart:false});
  const log=path.join(staged.dir,'install.log');for(let i=0;i<100&&child.exitCode===null;i++)await new Promise(r=>setTimeout(r,100));
  assert.match(fs.readFileSync(path.join(staged.dir,'install.log'),'utf8'),/ok 1\.0\.0 -> 1\.1\.0/);
  assert.deepEqual((await manifestOf(old,'x')).files,(await manifestOf(next,'x')).files);
  assert.equal(updater.cleanup(),'');assert.equal(updater.installedZip,zip);assert.equal(fs.readdirSync(path.join(root,'temp')).length,0);
  await assert.rejects(()=>new Updater({installDir:old,version:'1.1.0',tempRoot:path.join(root,'temp')}).stage(zip),/当前是 1\.1\.0/);
  assert.equal(fs.readdirSync(path.join(root,'temp')).length,0,'a rejected package leaves nothing behind');
});
test('cleanup reports a failed install from its log',()=>{
  const temp=fs.mkdtempSync(path.join(scratch,'t-'));write(temp,{'claude-desk-update-abc/install.log':'﻿failed: 文件被占用'});
  assert.equal(new Updater({installDir:temp,version:'1',tempRoot:temp}).cleanup(),'文件被占用');assert.equal(fs.existsSync(path.join(temp,'claude-desk-update-abc')),false);
});
test('update packages are found in the watched folders by what they contain, not their exact name',{skip:process.platform!=='win32'},async()=>{
  const {findUpdates,readZipEntry}=require('../updates.cjs');
  const {root,pkg}=await versions(),downloads=path.join(root,'下载'),desktop=path.join(root,'desktop');fs.mkdirSync(downloads);fs.mkdirSync(desktop);
  const tar=(out,dir)=>execFileSync('C:/Windows/System32/tar.exe',['-a','-c','-f',out,'-C',dir,...fs.readdirSync(dir)]);
  tar(path.join(downloads,'ClaudeDesk-1.0.0-to-1.1.0-update (1).zip'),pkg);
  tar(path.join(desktop,'ClaudeDesk-1.0.0-to-1.1.0-update.zip'),pkg); // the same package twice is listed once
  const later=path.join(root,'later');fs.cpSync(pkg,later,{recursive:true});fs.writeFileSync(path.join(later,UPDATE_FILE),JSON.stringify({app:'ClaudeDesk',from:'1.1.0',to:'1.2.0',files:{}}));tar(path.join(desktop,'claudedesk-1.1.0-to-1.2.0.zip'),later);
  tar(path.join(downloads,'photos.zip'),pkg);tar(path.join(downloads,'ClaudeDesk-1.1.0-win-x64.zip'),path.join(pkg,'resources'));fs.writeFileSync(path.join(downloads,'ClaudeDesk-broken.zip'),'not a zip');
  assert.equal(JSON.parse(readZipEntry(path.join(downloads,'ClaudeDesk-1.0.0-to-1.1.0-update (1).zip'),UPDATE_FILE)).to,'1.1.0');
  const found=findUpdates([downloads,desktop,path.join(root,'missing')],'1.0.0');
  assert.deepEqual(found.ready.map(u=>[u.name,u.dir,u.from,u.to,u.files]),[['ClaudeDesk-1.0.0-to-1.1.0-update (1).zip',downloads,'1.0.0','1.1.0',4]]);
  assert.deepEqual(found.other.map(u=>u.name),['claudedesk-1.1.0-to-1.2.0.zip']);
  assert.deepEqual(findUpdates([downloads,desktop],'1.1.0').ready.map(u=>u.to),['1.2.0']);
  assert.deepEqual(findUpdates([downloads,desktop],'1.2.0'),{ready:[],other:[]},'nothing older than the running version is offered');
});
test('a finished install is reported once on the next start',()=>{
  const temp=fs.mkdtempSync(path.join(scratch,'t-'));write(temp,{'claude-desk-update-ok/install.log':'﻿ok 1.0.0 -> 1.1.0'});
  const updater=new Updater({installDir:temp,version:'1.1.0',tempRoot:temp});assert.equal(updater.cleanup(),'');assert.equal(updater.installed,'1.0.0 -> 1.1.0');assert.equal(updater.installedZip,'');
});
test('packages for a finished install are found by their from and to versions',{skip:process.platform!=='win32'},()=>{
  const temp=fs.mkdtempSync(path.join(scratch,'t-')),zip=(name,info)=>{const dir=fs.mkdtempSync(path.join(scratch,'p-'));fs.writeFileSync(path.join(dir,UPDATE_FILE),JSON.stringify({app:'ClaudeDesk',files:{},...info}));execFileSync('C:/Windows/System32/tar.exe',['-a','-c','-f',path.join(temp,name),'-C',dir,UPDATE_FILE]);};
  zip('ClaudeDesk-1.0.0-to-1.1.0-update.zip',{from:'1.0.0',to:'1.1.0'});zip('ClaudeDesk-1.0.0-to-1.1.0-update (1).zip',{from:'1.0.0',to:'1.1.0'});zip('ClaudeDesk-1.1.0-to-1.2.0-update.zip',{from:'1.1.0',to:'1.2.0'});zip('other-1.0.0-to-1.1.0.zip',{from:'1.0.0',to:'1.1.0'});
  assert.deepEqual(packagesFor([temp,path.join(temp,'missing')],'1.0.0','1.1.0').map(f=>path.basename(f)).sort(),['ClaudeDesk-1.0.0-to-1.1.0-update (1).zip','ClaudeDesk-1.0.0-to-1.1.0-update.zip']);
});
test('the zip an install came from is reported for removal only if it is unchanged',()=>{
  const temp=fs.mkdtempSync(path.join(scratch,'t-')),zip=path.join(temp,'ClaudeDesk-1.0.0-to-1.1.0-update.zip');fs.writeFileSync(zip,'zip');const stat=fs.statSync(zip);
  const source=JSON.stringify({file:zip,size:stat.size,modified:stat.mtimeMs});
  write(temp,{'claude-desk-update-a/install.log':'ok 1.0.0 -> 1.1.0','claude-desk-update-a/source-zip.json':source});
  let updater=new Updater({installDir:temp,version:'1.1.0',tempRoot:temp});updater.cleanup();assert.equal(updater.installedZip,zip);
  write(temp,{'claude-desk-update-b/install.log':'failed: 文件被占用','claude-desk-update-b/source-zip.json':source});
  updater=new Updater({installDir:temp,version:'1.0.0',tempRoot:temp});updater.cleanup();assert.equal(updater.installedZip,'','a failed install keeps its package');
  write(temp,{'claude-desk-update-c/install.log':'ok 1.0.0 -> 1.1.0','claude-desk-update-c/source-zip.json':source});fs.writeFileSync(zip,'changed zip');
  updater=new Updater({installDir:temp,version:'1.1.0',tempRoot:temp});updater.cleanup();assert.equal(updater.installedZip,'','a replaced file is left alone');
});
test('failed staging preserves the validation error even when Windows denies temporary cleanup',{skip:process.platform!=='win32'},async()=>{
  const {root,pkg}=await versions(),zip=path.join(root,'update.zip'),temp=path.join(root,'temp');
  execFileSync('C:/Windows/System32/tar.exe',['-a','-c','-f',zip,'-C',pkg,...fs.readdirSync(pkg)],{windowsHide:true});
  const remove=fs.rmSync;fs.rmSync=(file,options)=>{if(path.dirname(file)===temp){const error=Error('locked fixture');error.code='EPERM';throw error;}return remove(file,options);};
  try{await assert.rejects(()=>new Updater({installDir:root,version:'0.9.0',tempRoot:temp}).stage(zip),e=>/当前是 0\.9\.0/.test(e.message)&&/暂存目录未能清理/.test(e.message)&&/locked fixture/.test(e.message));}
  finally{fs.rmSync=remove;}
  const updater=new Updater({installDir:root,version:'0.9.0',tempRoot:temp});fs.rmSync=(file,options)=>{if(path.dirname(file)===temp)throw Error('locked fixture');return remove(file,options);};
  try{assert.match(updater.cleanup(),/暂存目录未能清理/);}finally{fs.rmSync=remove;}
});
test('the About card and the notice say what was found and what happens next',async()=>{
  const {updateCardHtml,noticeOf}=await import('../ui/src/lib/updates.mjs');
  const update={file:'D:/dl/a.zip',name:'ClaudeDesk-1.0.0-to-1.1.0-update.zip',dir:'D:/dl',from:'1.0.0',to:'1.1.0',size:4.3*1048576,files:2};
  const scan={ready:[update],other:[],dirs:[{label:'下载',path:'D:/dl'},{label:'桌面',path:'D:/desk'}],version:'1.0.0',installable:true};
  let html=updateCardHtml(scan);assert.match(html,/可以升级到 1\.1\.0/);assert.match(html,/在「下载」找到 ClaudeDesk-1\.0\.0-to-1\.1\.0-update\.zip（4\.3 MB）/);assert.match(html,/data-update-action="install" class="primary"/);
  assert.doesNotMatch(updateCardHtml({...scan,installable:false}),/data-update-action="install"/);
  html=updateCardHtml({...scan,ready:[]});assert.match(html,/没有找到新的更新包/);assert.match(html,/放到「下载」、「桌面」/);assert.match(html,/data-update-action="scan"/);
  assert.match(updateCardHtml({...scan,ready:[],other:[{...update,from:'0.9.0'}]}),/是从 0\.9\.0 升级用的，当前是 1\.0\.0/);
  assert.match(updateCardHtml(null,{scanning:true}),/正在查找/);assert.match(updateCardHtml(scan,{installing:'正在检查'}),/正在检查/);
  assert.deepEqual(noticeOf(scan,update,{mode:'countdown',seconds:7}),{title:'Claude Desk 1.1.0 更新包',detail:'7 秒后自动关闭、更新并重新打开。会话记录不受影响。',primary:'立即安装',secondary:'取消'});
  assert.match(noticeOf(scan,update,{mode:'wait',running:2}).detail,/2 个任务在运行，全部结束后自动安装/);
  assert.equal(noticeOf(scan,update,{mode:'ask'}).primary,'安装并重启');assert.equal(noticeOf(scan,update,{installing:'x'}).primary,'');
});
