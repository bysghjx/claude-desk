const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {listProjectFiles,within,readProjectFile}=require('../project-files.cjs');
test('project listings omit archives in git and fallback scans but keep unpacked source',async()=>{
  const scratch=path.resolve(__dirname,'../../../work/asar-tests');fs.mkdirSync(scratch,{recursive:true});const root=fs.mkdtempSync(path.join(scratch,'files-'));
  fs.mkdirSync(path.join(root,'app.asar'));fs.writeFileSync(path.join(root,'app.asar','hidden.txt'),'x');fs.mkdirSync(path.join(root,'app.asar.unpacked'));fs.writeFileSync(path.join(root,'app.asar.unpacked','source.js'),'source');fs.writeFileSync(path.join(root,'README.md'),'readme');
  assert.deepEqual((await listProjectFiles(root,async()=>{throw Error('not git');})).sort(),[path.join('app.asar.unpacked','source.js'),'README.md'].sort());
  assert.deepEqual(await listProjectFiles(root,async()=>['README.md','app.asar/hidden.txt','APP.ASAR','app.asar.unpacked/source.js'].join('\0')),['README.md','app.asar.unpacked/source.js']);
  assert.throws(()=>within(root,'../outside'),/不在项目/);assert.match(readProjectFile(within(root,'app.asar')),/二进制归档/);assert.equal(readProjectFile(within(root,'README.md')),'readme');
});
