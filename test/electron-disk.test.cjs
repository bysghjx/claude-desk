const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
test('Electron project browsing and update validation leave real ASAR files deletable while the app is alive',{skip:process.platform!=='win32',timeout:60000},async()=>{
  const asar=await import('@electron/asar');const scratch=path.resolve(__dirname,'../../../work/asar-tests');fs.mkdirSync(scratch,{recursive:true});const root=fs.mkdtempSync(path.join(scratch,'electron-'));
  const source=path.join(root,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'hello.txt'),'hello');const template=path.join(root,'own.asar');await asar.createPackage(source,template);
  for(const rel of ['project/work/desktop-package/ClaudeDesk-win32-x64/resources/app.asar','project/work/release/full/ClaudeDesk/resources/app.asar','project/work/APP.ASAR','package/resources/app.asar']){const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(template,file);}
  fs.writeFileSync(path.join(root,'project/README.md'),'project');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=spawnSync(require('electron'),['--no-sandbox','--disable-gpu',path.join(__dirname,'fixtures/electron-disk.cjs'),root],{env,windowsHide:true,encoding:'utf8',timeout:55000});
  const error=path.join(root,'error.txt');assert.equal(result.status,0,(fs.existsSync(error)?fs.readFileSync(error,'utf8'):'')+result.stderr+result.stdout+String(result.error||''));
  const proof=JSON.parse(fs.readFileSync(path.join(root,'result.json'),'utf8'));assert.equal(proof.deleted.length,3);assert.ok(proof.updateStageDeleted&&proof.originalErrorPreserved&&proof.asarSupport);
});
