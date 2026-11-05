const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const UPDATER_EXE='ClaudeDesk.Updater.exe';
function buildUpdater(){
  if(process.platform!=='win32')throw Error('独立 Windows 更新器需要在 Windows 上构建');
  const source=path.join(__dirname,'updater/Updater.cs'),icon=path.resolve(__dirname,'../ui/icon.ico');
  const hash=createHash('sha256').update('framework4-winexe-utf8-v1').update(fs.readFileSync(source)).update(fs.readFileSync(icon)).digest('hex').slice(0,20);
  const root=path.resolve(__dirname,'../../../work/updater',hash),exe=path.join(root,UPDATER_EXE);if(fs.existsSync(exe))return exe;
  fs.mkdirSync(root,{recursive:true});const temp=fs.mkdtempSync(path.join(root,'compile-'));
  if(path.dirname(temp)!==root)throw Error('Invalid updater build directory');
  try{
    const windows=process.env.SystemRoot||'C:/Windows',framework=path.join(windows,'Microsoft.NET/Framework64/v4.0.30319');
    execFileSync(path.join(framework,'csc.exe'),['/nologo','/target:winexe','/optimize+','/platform:anycpu','/codepage:65001','/out:'+path.join(temp,UPDATER_EXE),'/win32icon:'+icon,'/reference:System.Web.Extensions.dll','/reference:System.Windows.Forms.dll',source],{windowsHide:true,stdio:'pipe'});
    try{fs.linkSync(path.join(temp,UPDATER_EXE),exe);}catch(e){if(e.code!=='EEXIST')throw e;}
    return exe;
  }catch(e){throw Error('独立更新器构建失败：'+String(e.stdout||e.stderr||e.message));}
  finally{fs.rmSync(temp,{recursive:true,force:true});}
}
if(require.main===module){if(process.platform==='win32'){const file=buildUpdater();console.log(file+' ('+fs.statSync(file).size+' bytes)');}else console.log('Windows updater build skipped on this platform');}
module.exports={buildUpdater,UPDATER_EXE};
