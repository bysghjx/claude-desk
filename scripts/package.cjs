const fs=require('node:fs');const path=require('node:path');const {createHash}=require('node:crypto');const zlib=require('node:zlib');const {execFileSync}=require('node:child_process');
// The packager writes the app version and a hash of app.asar into ClaudeDesk.exe, so every release
// would change the 250 MB exe and put it into every update package. Electron only checks that hash
// when the EnableEmbeddedAsarIntegrityValidation fuse is on, so while it is off the hash is removed and
// the exe's version resource is fixed (app.getVersion() still reads package.json in app.asar): the exe
// then depends only on the Electron version and the icon, and is the same in every build, here or on
// GitHub Actions. (The packager's appVersion option can't do this: it also rewrites package.json.)
const FUSE_SENTINEL='dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX',INTEGRITY_FUSE=4,EXE_VERSION=[1,0,0,0];
const {buildUpdater,UPDATER_EXE}=require('./build-updater.cjs');
function integrityChecked(buf){const i=buf.indexOf(FUSE_SENTINEL);return i<0||buf[i+FUSE_SENTINEL.length+2+INTEGRITY_FUSE]!==0x30;}
async function fixExe(dir){
  const file=path.join(dir,'ClaudeDesk.exe'),buf=fs.readFileSync(file);
  if(integrityChecked(buf))throw Error('ClaudeDesk.exe 会校验 app.asar，不能去掉其中的哈希');
  const {NtExecutable,NtExecutableResource,Resource}=await import('resedit');
  const exe=NtExecutable.from(buf),res=NtExecutableResource.from(exe);
  res.entries=res.entries.filter(e=>e.type!=='INTEGRITY');
  const [info]=Resource.VersionInfo.fromEntries(res.entries),text=EXE_VERSION.join('.');
  info.setFileVersion(...EXE_VERSION);info.setProductVersion(...EXE_VERSION);
  for(const lang of info.getAllLanguagesForStringValues())info.setStringValues(lang,{FileVersion:text,ProductVersion:text});
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);fs.writeFileSync(file,Buffer.from(exe.generate()));
}
// The Claude Code CLI from the Agent SDK ships compressed (zstd, about a third of its size) in
// resources/claude-code and is unpacked only if someone chooses to use it. Compressing takes a couple
// of minutes, so the result is kept in work/claude-code and redone only when the CLI changes.
function packCli(source){
  const exe=path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/package.json',{paths:[source]})),'claude.exe');
  const dir=path.resolve(source,'../../work/claude-code'),infoFile=path.join(dir,'claude-code.json'),zst=path.join(dir,'claude.exe.zst');
  const sha256=createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  let info=null;try{info=JSON.parse(fs.readFileSync(infoFile,'utf8'));}catch{}
  if(info?.sha256===sha256&&fs.existsSync(zst))return{dir,note:`内置 Claude Code ${info.version}（沿用已压缩的文件）`};
  const version=execFileSync(exe,['--version'],{encoding:'utf8',windowsHide:true}).trim().replace(/\s*\(Claude Code\)\s*$/,'');
  fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
  const packed=zlib.zstdCompressSync(fs.readFileSync(exe),{params:{[zlib.constants.ZSTD_c_compressionLevel]:19}});
  fs.writeFileSync(zst,packed);fs.writeFileSync(infoFile,JSON.stringify({version,sha256,size:fs.statSync(exe).size},null,1));
  return{dir,note:`内置 Claude Code ${version}：${(packed.length/2**20).toFixed(1)} MB`};
}
if(require.main===module)(async()=>{
  const {packager}=await import('@electron/packager');
  const source=path.resolve(__dirname,'..');
  // DESK_BUILD_DIR builds somewhere else, e.g. while the usual folders are open in a running Claude Desk.
  const build=process.env.DESK_BUILD_DIR&&path.resolve(process.env.DESK_BUILD_DIR);
  const staging=build?path.join(build,'stage'):path.resolve(source,'../../work/desktop-package');
  const target=build?path.join(build,'ClaudeDesk-win32-x64'):path.resolve(source,'../ClaudeDesk-Windows/ClaudeDesk-win32-x64');
  const cli=packCli(source);console.log(cli.note);
  const updater=buildUpdater();
  // node-pty's native files have to sit outside app.asar to load; the CLI goes in resources/claude-code instead of the asar.
  const results=await packager({dir:source,name:'ClaudeDesk',platform:'win32',arch:'x64',out:staging,overwrite:true,icon:path.join(source,'ui/icon.ico'),asar:{unpack:'**/node_modules/node-pty/**'},extraResource:[cli.dir],ignore:/^\/(?:test|scripts|node_modules\/@anthropic-ai\/claude-agent-sdk-win32-x64)(?:\/|$)/});
  await fixExe(results[0]);
  fs.copyFileSync(updater,path.join(results[0],UPDATER_EXE));
  fs.writeFileSync(path.join(results[0],'claude-desk-version.json'),JSON.stringify({app:'ClaudeDesk',version:require('../package.json').version}));
  if(process.argv.includes('--stage-only')){console.log('Staged application:',results[0]);return;}
  fs.mkdirSync(target,{recursive:true});
  // Don't delete the installed resources before copying: Windows may reject the
  // running exe, and a failed build must not leave that installation incomplete.
  for(const entry of fs.readdirSync(results[0]))fs.cpSync(path.join(results[0],entry),path.join(target,entry),{recursive:true,force:true});
  const prune=(from,dir)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.resolve(dir,entry.name),rel=path.relative(target,file);if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('构建清理路径不在程序目录内');
    const original=path.join(from,entry.name);if(!fs.existsSync(original))fs.rmSync(file,{recursive:true,force:true});else if(entry.isDirectory())prune(original,file);
  }};
  for(const dir of ['resources/app.asar.unpacked','resources/claude-code'])if(fs.existsSync(path.join(target,dir)))prune(path.join(results[0],dir),path.join(target,dir));
  console.log('Updated fixed application entry:',path.join(target,'ClaudeDesk.exe'));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={fixExe};
