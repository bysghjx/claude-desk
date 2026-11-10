const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const zlib=require('node:zlib');const {createHash}=require('node:crypto');
const {ClaudeCli,INSTALL_COMMANDS,BUNDLE,BUNDLE_INFO}=require('../cli-setup.cjs');
const scratch=path.resolve(__dirname,'../../../work/cli-tests');fs.mkdirSync(scratch,{recursive:true});
const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
const sha=data=>createHash('sha256').update(data).digest('hex');
// A home folder, ~/.claude-desk and a packed copy of a pretend claude.exe.
function setup({packed=true}={}){
  const root=fs.mkdtempSync(path.join(scratch,'测试 ')),home=path.join(root,'home'),desk=path.join(home,'.claude-desk'),bundleDir=path.join(root,'app/resources/claude-code');
  const exe=Buffer.from('MZ pretend claude '+'x'.repeat(5000));
  if(packed){write(path.join(bundleDir,BUNDLE),zlib.zstdCompressSync(exe));write(path.join(bundleDir,BUNDLE_INFO),JSON.stringify({version:'2.1.312',sha256:sha(exe),size:exe.length}));}
  const env={PATH:'',LOCALAPPDATA:path.join(home,'AppData/Local'),APPDATA:path.join(home,'AppData/Roaming')};
  const calls=[];const runner=async(file,args)=>{calls.push([file,...args]);if(file==='reg.exe')return null;if(args[0]==='--version')return file==='git'?'git version 2.47.1.windows.1':file==='gh'?null:'2.1.400 (Claude Code)';return null;};
  return{root,home,desk,bundleDir,exe,env,calls,cli:new ClaudeCli({home,root:desk,bundleDir,env,runner})};
}
test('the official install is preferred; the built-in copy is used only once unpacked',()=>{
  const {cli,home,desk,env}=setup();
  assert.equal(cli.find(),null,'a packed copy alone does not count');
  write(path.join(desk,'cli/claude.exe'),'own');assert.equal(cli.find().source,'bundled');
  write(path.join(env.LOCALAPPDATA,'Microsoft/WinGet/Links/claude.exe'),'w');assert.equal(cli.find().source,'winget');
  write(path.join(home,'.local/bin/claude.exe'),'n');assert.deepEqual(cli.find(),{file:path.join(home,'.local/bin/claude.exe'),source:'native'});
});
test('an install added to PATH after Claude Desk started is found from the registry',async()=>{
  const {cli,root}=setup();const dir=path.join(root,'Program Files/Claude');write(path.join(dir,'claude.exe'),'c');
  cli.env.TOOLS=path.join(root,'Program Files');
  cli.runner=async(file,args)=>file==='reg.exe'&&args[1]==='HKCU\\Environment'?`\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\nowhere;%TOOLS%\\Claude\r\n`:null;
  await cli.refreshPath();assert.deepEqual(cli.find(),{file:path.join(dir,'claude.exe'),source:'path'});
});
test('unpacking checks the hash, puts claude.exe in ~/.claude-desk/cli and deletes the packed file',async()=>{
  const {cli,desk,bundleDir,exe}=setup();
  assert.deepEqual(cli.bundle(),{available:true,file:path.join(bundleDir,BUNDLE),version:'2.1.312',size:exe.length,unpacked:''});
  assert.deepEqual(await cli.extract(),{file:path.join(desk,'cli/claude.exe'),version:'2.1.312',removed:true});
  assert.deepEqual(fs.readFileSync(path.join(desk,'cli/claude.exe')),exe);assert.equal(fs.existsSync(path.join(bundleDir,BUNDLE)),false);
  assert.deepEqual(cli.bundle(),{available:false,file:'',version:'2.1.312',size:0,unpacked:'2.1.312'});
  await assert.rejects(()=>cli.extract(),/已经解压过了（2\.1\.312）/);
});
test('a damaged packed file is rejected and leaves nothing half written',async()=>{
  const {cli,desk,bundleDir}=setup();write(path.join(bundleDir,BUNDLE),zlib.zstdCompressSync(Buffer.from('tampered')));
  await assert.rejects(()=>cli.extract(),/校验不通过/);
  assert.deepEqual(fs.readdirSync(path.join(desk,'cli')),[]);assert.ok(fs.existsSync(path.join(bundleDir,BUNDLE)),'the packed file is kept to try again');
  await assert.rejects(()=>setup({packed:false}).cli.extract(),/没有内置版/);
});
test('while developing, the uncompressed SDK copy is copied and kept',async()=>{
  const {root,home,desk,env}=setup({packed:false});const dev=path.join(root,'sdk/claude.exe');write(dev,'dev exe');
  const cli=new ClaudeCli({home,root:desk,devExe:dev,env});assert.equal(cli.bundle().available,true);
  assert.equal((await cli.extract()).removed,false);assert.equal(fs.readFileSync(path.join(desk,'cli/claude.exe'),'utf8'),'dev exe');assert.ok(fs.existsSync(dev));
});
test('an update with a newer packed copy replaces one already unpacked, and nothing else',async()=>{
  const {cli,bundleDir,desk}=setup();
  assert.equal(await cli.refreshBundled(),null,'not unpacked yet: stays packed');
  await cli.extract();
  const newer=Buffer.from('MZ newer claude');write(path.join(bundleDir,BUNDLE),zlib.zstdCompressSync(newer));write(path.join(bundleDir,BUNDLE_INFO),JSON.stringify({version:'2.2.0',sha256:sha(newer),size:newer.length}));
  assert.equal((await cli.refreshBundled()).version,'2.2.0');assert.deepEqual(fs.readFileSync(path.join(desk,'cli/claude.exe')),newer);
  assert.equal(await cli.refreshBundled(),null);
});
test('login is found from a key, a provider, settings or a saved account',()=>{
  const {cli,home}=setup();
  assert.deepEqual(cli.login(),{ok:false,how:''});
  write(path.join(home,'.claude/.credentials.json'),'{}');assert.deepEqual(cli.login(),{ok:true,how:'Claude 账号'});
  fs.rmSync(path.join(home,'.claude/.credentials.json'));write(path.join(home,'.claude/settings.json'),JSON.stringify({env:{ANTHROPIC_AUTH_TOKEN:'t'}}));assert.equal(cli.login().how,'API Key 或第三方服务商');
  write(path.join(home,'.claude/settings.json'),'{}');cli.env.CLAUDE_CODE_USE_BEDROCK='1';assert.equal(cli.login().ok,true);
});
test('the check reports Claude Code with its version, login, Git and GitHub CLI; the quick one runs nothing',async()=>{
  const {cli,home,calls}=setup();
  let r=await cli.check({quick:true});assert.equal(r.cli,null);assert.equal(r.commands,INSTALL_COMMANDS);assert.ok(!('git' in r));assert.ok(calls.every(c=>c[0]==='reg.exe'));
  write(path.join(home,'.local/bin/claude.exe'),'n');r=await cli.check();
  assert.deepEqual(r.cli,{file:path.join(home,'.local/bin/claude.exe'),source:'native',version:'2.1.400',broken:false});assert.equal(r.git,'2.47.1');assert.equal(r.gh,'');
  cli.runner=async()=>null;assert.equal((await cli.check()).cli.broken,true);
  assert.equal(INSTALL_COMMANDS.find(c=>c.id==='powershell').command,'irm https://claude.ai/install.ps1 | iex');
});

test('version checks compare the actual selected CLI with the official public version and report network failures',async()=>{
  const {cli,home,calls}=setup();write(path.join(home,'.local/bin/claude.exe'),'n');let online='2.1.401';
  cli.fetch=async(url,options)=>{assert.equal(url,'https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest');assert.ok(options.signal);return{ok:true,json:async()=>({version:online})};};
  let result=await cli.checkVersion();assert.equal(result.cli.version,'2.1.400');assert.equal(result.cli.file,cli.find().file);assert.equal(result.status,'available');
  online='2.1.400';assert.equal((await cli.checkVersion()).status,'current');
  online='2.1.399';assert.equal((await cli.checkVersion()).status,'ahead');
  cli.fetch=async()=>{throw Error('offline');};result=await cli.checkVersion();assert.equal(result.status,'unknown');assert.equal(result.latest,'');assert.match(result.error,/无法读取/);assert.equal(result.cli.version,'2.1.400');
  assert.ok(calls.every(c=>c[0]==='reg.exe'||c[1]==='--version'));
  const {versionCheckText}=await import('../ui/src/lib/env.mjs');assert.match(versionCheckText(result),/2\.1\.400.*无法读取/);
  const missing=setup({packed:false}).cli;missing.fetch=async()=>({ok:true,json:async()=>({version:'2.1.401'})});assert.equal((await missing.checkVersion()).cli,null);
});
test('the environment window lists install commands, the built-in option and each check',async()=>{
  const {commandsHtml,bundleState,checksHtml}=await import('../ui/src/lib/env.mjs');
  const html=commandsHtml(INSTALL_COMMANDS);assert.match(html,/irm https:\/\/claude\.ai\/install\.ps1 \| iex/);assert.match(html,/class="primary" data-env-run="powershell"/);assert.match(html,/data-env-copy="winget"/);assert.match(html,/&amp;&amp; install\.cmd/);
  assert.equal(bundleState({available:true,version:'2.1.312',size:298690208,unpacked:''}).enabled,true);assert.match(bundleState({available:true,version:'2.1.312',size:298690208}).text,/2\.1\.312.*约 285 MB.*删除自带的压缩文件/);
  assert.deepEqual(bundleState({available:false,unpacked:'2.1.312'}),{enabled:false,text:'内置版已经解压过（2.1.312），压缩文件已删除。',label:'已解压'});assert.equal(bundleState({available:false,unpacked:''}).label,'不可用');
  let list=checksHtml({cli:null,login:{ok:false},bundle:{}});assert.match(list,/没有找到。安装官方版或使用内置版/);assert.doesNotMatch(list,/data-env-login/);assert.doesNotMatch(list,/Git/);
  list=checksHtml({cli:{file:'C:/u/.local/bin/claude.exe',source:'native',version:'2.1.400'},login:{ok:false},git:'',gh:'2.60.0'});
  assert.match(list,/2\.1\.400，官方原生版。C:\/u\/\.local\/bin\/claude\.exe/);assert.match(list,/data-env-login/);assert.match(list,/没有安装（建议装）/);assert.match(list,/2\.60\.0/);
  assert.match(checksHtml({cli:{file:'x',source:'bundled',version:'2.1.312'},login:{ok:true,how:'Claude 账号'}}),/内置版，不会自动更新.*已配置：Claude 账号/s);
});
