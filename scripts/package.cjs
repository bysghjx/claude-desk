const fs=require('node:fs');const path=require('node:path');
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
  console.log('Updated fixed application entry:',path.join(target,'ClaudeDesk.exe'));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
