const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const {GitHubUpdates,releaseInfo}=require('../github-updates.cjs');
const {Updater,manifestOf,verifyUpdate,UPDATE_FILE}=require('../updates.cjs');
const {createZip}=require('../scripts/zip.cjs');
const sha=b=>createHash('sha256').update(b).digest('hex');
const asset=(name,id,bytes=Buffer.from('zip'))=>({name,id,size:bytes.length,state:'uploaded',digest:'sha256:'+sha(bytes),browser_download_url:'https://github.com/bysghjx/claude-desk/releases/download/v1.1.0/'+name});
const release=assets=>({tag_name:'v1.1.0',draft:false,prerelease:false,assets});

test('a stable release replaces its Beta on either channel, with automatic full-package fallback when needed',async()=>{
  const full=asset('ClaudeDesk-1.1.0-win-x64.zip',11),manifest=asset('1.1.0.json',12);
  for(const updatePrerelease of [false,true]){
    const service=new GitHubUpdates({version:'1.1.0-beta',network:{updatePrerelease},fetch:async url=>Response.json(url.includes('/latest')?release([full,manifest]):[release([full,manifest])])});
    const result=await service.check();assert.equal(result.status,'available');assert.equal(result.update.to,'1.1.0');assert.equal(result.update.full,true);assert.equal(result.update.from,'1.1.0-beta');
  }
  const delta=asset('ClaudeDesk-1.1.0-beta-to-1.1.0-update.zip',13);
  const preview={tag_name:'v1.2.0-beta',draft:false,prerelease:true,assets:[]};
  const channel=new GitHubUpdates({version:'1.1.0-beta',network:{updatePrerelease:true},fetch:async()=>Response.json([preview,release([full,manifest])])});
  assert.equal((await channel.check()).version,'1.1.0','an installed Beta graduates to stable before the next development Beta');
  channel.version='1.1.0';assert.equal((await channel.check(true)).version,'1.2.0-beta','stable users can still opt into the next preview');
  assert.equal(releaseInfo(release([full,manifest,delta]),'1.1.0-beta').update.file,'github:13');
  assert.equal(releaseInfo(release([full,manifest]),'1.1.1-beta').status,'current','never downgrade a newer Beta');
  for(const broken of [{digest:null},{size:0},{browser_download_url:'https://other.example/zip'}])assert.equal(releaseInfo(release([{...full,...broken},manifest]),'1.1.0-beta').status,'manual');
});

test('downloaded full-package manifests must match the GitHub digest, size and target version',async()=>{
  const valid=Buffer.from(JSON.stringify({app:'ClaudeDesk',version:'1.1.0',files:{'ClaudeDesk.exe':'a'.repeat(64)}}));
  const update=releaseInfo(release([asset('ClaudeDesk-1.1.0-win-x64.zip',11),asset('1.1.0.json',12,valid)]),'1.1.0-beta').update;
  const service=new GitHubUpdates({version:'1.1.0-beta',fetch:async()=>new Response(valid)});
  assert.equal((await service.fullManifest(update)).version,'1.1.0');
  service.fetch=async()=>new Response(Buffer.alloc(valid.length));await assert.rejects(()=>service.fullManifest(update),/校验失败/);
  service.fetch=async()=>new Response(valid.subarray(1));await assert.rejects(()=>service.fullManifest(update),/校验失败/);
  const wrong=Buffer.from(JSON.stringify({app:'ClaudeDesk',version:'1.0.0',files:{x:'a'.repeat(64)}}));
  service.fetch=async()=>new Response(wrong);await assert.rejects(()=>service.fullManifest({...update,manifest:{size:wrong.length,sha256:sha(wrong),url:'https://github.com/manifest'}}),/内容无效/);
});

test('Beta full-package downloads stage as an exact-from update and reject tampered files',{skip:process.platform!=='win32'},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'desk-beta-full-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:250}));
  const full=path.join(root,'source/ClaudeDesk');fs.mkdirSync(path.join(full,'resources'),{recursive:true});
  for(const [rel,value]of Object.entries({'ClaudeDesk.exe':'test executable','ClaudeDesk.Updater.exe':'test updater','resources/app.asar':'test app','claude-desk-version.json':JSON.stringify({app:'ClaudeDesk',version:'1.1.0'})}))fs.writeFileSync(path.join(full,rel),value);
  fs.copyFileSync(require('../scripts/build-updater.cjs').buildUpdater(),path.join(full,'ClaudeDesk.Updater.exe'));
  const manifest=await manifestOf(full,'1.1.0'),manifestBytes=Buffer.from(JSON.stringify(manifest));
  const zip=path.join(root,'full.zip');createZip(path.dirname(full),zip);const bytes=fs.readFileSync(zip);
  const update=releaseInfo(release([asset('ClaudeDesk-1.1.0-win-x64.zip',11,bytes),asset('1.1.0.json',12,manifestBytes)]),'1.1.0-beta').update;
  const service=new GitHubUpdates({version:'1.1.0-beta',downloadDir:path.join(root,'downloads'),fetch:async url=>new Response(url.endsWith('.json')?manifestBytes:bytes)});
  const downloaded=await service.download(update),verifiedManifest=await service.fullManifest(update);
  const installed=path.join(root,'installed');fs.mkdirSync(installed);fs.writeFileSync(path.join(installed,'ClaudeDesk.exe'),'old test executable');fs.writeFileSync(path.join(installed,'claude-desk-version.json'),JSON.stringify({app:'ClaudeDesk',version:'1.1.0-beta'}));fs.copyFileSync(require('../scripts/build-updater.cjs').buildUpdater(),path.join(installed,'ClaudeDesk.Updater.exe'));fs.writeFileSync(path.join(installed,'my-settings.txt'),'preserve this');
  const updater=new Updater({installDir:installed,version:'1.1.0-beta',tempRoot:path.join(root,'stage')});
  const staged=await updater.stage(downloaded,{fullManifest:verifiedManifest});assert.equal(staged.to,'1.1.0');assert.equal(staged.from,'1.1.0-beta');assert.equal(staged.removed,0);
  assert.equal((await verifyUpdate(staged.dir,'1.1.0-beta')).files,4);assert.equal(JSON.parse(fs.readFileSync(path.join(staged.dir,UPDATE_FILE))).from,'1.1.0-beta');
  assert.equal(fs.readFileSync(path.join(staged.dir,'resources/app.asar'),'utf8'),'test app');
  const child=await updater.apply({pid:0,exe:path.join(installed,'ClaudeDesk.exe'),restart:false});
  for(let i=0;i<100&&child.exitCode===null;i++)await new Promise(r=>setTimeout(r,50));
  assert.match(fs.readFileSync(path.join(staged.dir,'install.log'),'utf8'),/ok 1\.1\.0-beta -> 1\.1\.0/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(installed,'claude-desk-version.json'))).version,'1.1.0');assert.equal(fs.readFileSync(path.join(installed,'my-settings.txt'),'utf8'),'preserve this');
  assert.equal(updater.cleanup(),'');assert.equal(updater.installed,'1.1.0-beta -> 1.1.0');assert.equal(updater.installedZip,downloaded);
  const bad={...verifiedManifest,files:{...verifiedManifest.files,'resources/app.asar':'b'.repeat(64)}};
  await assert.rejects(()=>updater.stage(downloaded,{fullManifest:bad}),/校验失败/);assert.equal(updater.staged,null);assert.deepEqual(fs.readdirSync(updater.tempRoot),[]);
  await assert.rejects(()=>new Updater({installDir:root,version:'1.2.0-beta',tempRoot:path.join(root,'newer')}).stage(downloaded,{fullManifest:verifiedManifest}),/目标版本无效/);
});
