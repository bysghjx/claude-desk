const fs=require('node:fs');const path=require('node:path');const {createHash}=require('node:crypto');
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
(async()=>{
  const {packager}=await import('@electron/packager');
  const source=path.resolve(__dirname,'..');
  const staging=path.resolve(source,'../../work/desktop-package');
  const target=path.resolve(source,'../ClaudeDesk-Windows/ClaudeDesk-win32-x64');
  // The bundled Claude Code CLI has to sit outside app.asar to run, like node-pty's native files.
  const results=await packager({dir:source,name:'ClaudeDesk',platform:'win32',arch:'x64',out:staging,overwrite:true,icon:path.join(source,'ui/icon.ico'),asar:{unpack:'**/node_modules/{node-pty,@anthropic-ai/claude-agent-sdk-win32-x64}/**'},ignore:/^\/(?:test|scripts)(?:\/|$)/});
  if(process.argv.includes('--stage-only')){console.log('Staged application:',results[0]);return;}
  fs.mkdirSync(target,{recursive:true});
  for(const entry of fs.readdirSync(results[0]))fs.cpSync(path.join(results[0],entry),path.join(target,entry),{recursive:true,force:true});
  console.log(keepExe(source,target));
  console.log('Updated fixed application entry:',path.join(target,'ClaudeDesk.exe'));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
