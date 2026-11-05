// Runs in a real Electron main process: Node-only fs tests cannot catch ASAR locks.
const fs=require('original-fs'),path=require('node:path'),assert=require('node:assert/strict');
const {app}=require('electron');const {execFileSync}=require('node:child_process');
const root=process.argv.at(-1),source=path.resolve(__dirname,'../..');
(async()=>{
  const {within,listProjectFiles,readProjectFile}=require(path.join(source,'project-files.cjs'));
  const {sizeOf}=require(path.join(source,'storage-usage.cjs'));const review=require(path.join(source,'review.cjs'));
  const {manifestOf,verifyUpdate,Updater,UPDATE_FILE}=require(path.join(source,'updates.cjs'));
  const project=path.join(root,'project');
  const archives=['work/desktop-package/ClaudeDesk-win32-x64/resources/app.asar','work/release/full/ClaudeDesk/resources/app.asar','work/APP.ASAR'];
  const fallback=await listProjectFiles(project,async()=>{throw Error('not git');});assert.ok(fallback.some(x=>x.endsWith('README.md')));assert.ok(!fallback.some(x=>/\.asar(?:[\\/]|$)/i.test(x)));
  for(const rel of archives){const file=within(project,rel);assert.match(readProjectFile(file),/二进制归档/);}
  execFileSync('git',['init','--quiet',project],{windowsHide:true});
  const changed=await review.changes(project);assert.equal(changed.isGit,true);assert.ok(changed.files.some(x=>x.path.endsWith('app.asar')&&x.binary));
  assert.match(await review.diff(project,archives[0]),/二进制归档/);
  const actual=await listProjectFiles(project,async(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true}));assert.ok(!actual.some(x=>/\.asar(?:[\\/]|$)/i.test(x)));
  const measured=await sizeOf(project);assert.ok(measured.size>0);
  const manifest=await manifestOf(project,'test');for(const rel of archives)assert.ok(manifest.files[rel]);
  const deleted=[];for(const rel of archives){fs.unlinkSync(path.join(project,rel));deleted.push(rel);}
  const pkg=path.join(root,'package'),zip=path.join(root,'update.zip');
  const packageManifest=await manifestOf(pkg,'1.1.0');fs.writeFileSync(path.join(pkg,UPDATE_FILE),JSON.stringify({app:'ClaudeDesk',from:'1.0.0',to:'1.1.0',files:packageManifest.files,removed:[]}));
  await verifyUpdate(pkg,'1.0.0');
  execFileSync('C:/Windows/System32/tar.exe',['-a','-c','-f',zip,'-C',pkg,...fs.readdirSync(pkg)],{windowsHide:true});
  const updater=new Updater({installDir:path.join(root,'installed'),version:'1.0.0',tempRoot:path.join(root,'updates')});
  const stage=await updater.stage(zip);assert.equal(stage.to,'1.1.0');fs.unlinkSync(path.join(stage.dir,'resources/app.asar'));
  assert.equal(updater.cleanup(),'');assert.deepEqual(fs.readdirSync(path.join(root,'updates')),[]);
  const invalid=new Updater({installDir:root,version:'0.9.0',tempRoot:path.join(root,'updates')});await assert.rejects(()=>invalid.stage(zip),/当前是 0\.9\.0/);assert.deepEqual(fs.readdirSync(path.join(root,'updates')),[]);
  assert.notEqual(process.noAsar,true);
  // The app's own archive support still works; only external disk operations changed.
  assert.equal(require('node:fs').readFileSync(path.join(root,'own.asar','hello.txt'),'utf8'),'hello');
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify({pid:process.pid,deleted,updateStageDeleted:true,originalErrorPreserved:true,asarSupport:true}));
  app.exit(0);
})().catch(e=>{fs.writeFileSync(path.join(root,'error.txt'),e.stack);app.exit(1);});
