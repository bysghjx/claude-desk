const fs=require('node:fs');const path=require('node:path');const {createHash}=require('node:crypto');const zlib=require('node:zlib');const {execFileSync}=require('node:child_process');
// The packager also writes a hash of app.asar into ClaudeDesk.exe, so every code change would change
// the 250 MB exe and put it into every update package. Electron only checks that hash when the
// EnableEmbeddedAsarIntegrityValidation fuse is on, so while it is off the first exe built for an
// Electron version and icon is kept (outputs/releases/exe-cache) and reused.
const FUSE_SENTINEL='dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX',INTEGRITY_FUSE=4;
function integrityChecked(exe){const buf=fs.readFileSync(exe),i=buf.indexOf(FUSE_SENTINEL);return i<0||buf[i+FUSE_SENTINEL.length+2+INTEGRITY_FUSE]!==0x30;}
function keepExe(source,target){
  const exe=path.join(target,'ClaudeDesk.exe');
  if(integrityChecked(exe))return'ClaudeDesk.exe 会校验 app.asar，不能沿用旧的 exe';
  const icon=createHash('sha256').update(fs.readFileSync(path.join(source,'ui/icon.ico'))).digest('hex').slice(0,12);
  const cache=path.resolve(source,'../releases/exe-cache'),kept=path.join(cache,`electron-${require('electron/package.json').version}-icon-${icon}.exe`);
  if(fs.existsSync(kept)){fs.copyFileSync(kept,exe);return'沿用 '+path.basename(kept);}
  fs.mkdirSync(cache,{recursive:true});fs.copyFileSync(exe,kept);return'新的 exe 已保存为 '+path.basename(kept);
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
(async()=>{
  const {packager}=await import('@electron/packager');
  const source=path.resolve(__dirname,'..');
  const staging=path.resolve(source,'../../work/desktop-package');
  const target=path.resolve(source,'../ClaudeDesk-Windows/ClaudeDesk-win32-x64');
  const cli=packCli(source);console.log(cli.note);
  // node-pty's native files have to sit outside app.asar to load; the CLI goes in resources/claude-code instead of the asar.
  const results=await packager({dir:source,name:'ClaudeDesk',platform:'win32',arch:'x64',out:staging,overwrite:true,icon:path.join(source,'ui/icon.ico'),asar:{unpack:'**/node_modules/node-pty/**'},extraResource:[cli.dir],ignore:/^\/(?:test|scripts|node_modules\/@anthropic-ai\/claude-agent-sdk-win32-x64)(?:\/|$)/});
  if(process.argv.includes('--stage-only')){console.log('Staged application:',results[0]);return;}
  fs.mkdirSync(target,{recursive:true});
  // Folders whose contents can shrink are replaced, not merged, so nothing from an older build stays behind.
  for(const dir of ['resources/app.asar.unpacked','resources/claude-code'])fs.rmSync(path.join(target,dir),{recursive:true,force:true});
  for(const entry of fs.readdirSync(results[0]))fs.cpSync(path.join(results[0],entry),path.join(target,entry),{recursive:true,force:true});
  console.log(keepExe(source,target));
  console.log('Updated fixed application entry:',path.join(target,'ClaudeDesk.exe'));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
