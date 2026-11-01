const fs=require('node:fs');const path=require('node:path');const {execFile}=require('node:child_process');
// Git review actions for the changes panel. Paths are repository-relative (as git
// status reports them) and are checked to stay inside the repository.
function run(cwd,args,{allowFail=false}={}){
  return new Promise((resolve,reject)=>execFile('git',['--no-optional-locks','-c','core.quotepath=off','-C',cwd,...args],{windowsHide:true,timeout:20000,maxBuffer:8*1024*1024},(error,stdout,stderr)=>{
    if(error&&!allowFail)return reject(Error((String(stderr||'').trim()||error.message).split('\n').slice(0,6).join('\n')));
    resolve({stdout:String(stdout),code:error?error.code??1:0});
  }));
}
async function repo(projectPath){
  const top=path.resolve((await run(projectPath,['rev-parse','--show-toplevel'])).stdout.trim());
  const hasHead=(await run(top,['rev-parse','--verify','--quiet','HEAD'],{allowFail:true})).code===0;
  return{top,hasHead,prefix:path.relative(top,path.resolve(projectPath)).replace(/\\/g,'/')};
}
function inside(top,relative){
  if(typeof relative!=='string'||!relative||relative.length>2000||relative.includes('\0'))throw Error('文件路径无效');
  const target=path.resolve(top,relative),rel=path.relative(top,target);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel)||rel.split(/[\\/]/)[0]==='.git')throw Error('文件不在仓库内');
  return target;
}
function textLines(file){
  try{const stat=fs.statSync(file);if(!stat.isFile()||stat.size>2*1024*1024)return null;const text=fs.readFileSync(file,'utf8');if(text.includes('\0'))return null;return text===''?0:text.replace(/\n$/,'').split('\n').length;}catch{return null;}
}
async function changes(projectPath){
  let info;try{info=await repo(projectPath);}catch{return{isGit:false,files:[],branch:''};}
  const {top,hasHead,prefix}=info;
  const status=(await run(top,['status','--porcelain=v1','-z','--untracked-files=all'])).stdout.split('\0');
  const files=[];
  for(let i=0;i<status.length;i++){
    const line=status[i];if(!line)continue;const x=line[0],y=line[1],file={path:line.slice(3),status:line.slice(0,2),index:x,worktree:y,untracked:x==='?',staged:x!==' '&&x!=='?',added:0,removed:0,binary:false};
    if(x==='R'||x==='C')file.from=status[++i];
    files.push(file);
  }
  const counts=new Map();
  const numstat=async args=>{for(const row of (await run(top,['diff','--numstat','-z',...args],{allowFail:true})).stdout.split('\0')){const m=row.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);if(!m||!m[3])continue;const c=counts.get(m[3])||{added:0,removed:0,binary:false};if(m[1]==='-')c.binary=true;else{c.added+=Number(m[1]);c.removed+=Number(m[2]);}counts.set(m[3],c);}};
  if(hasHead)await numstat(['HEAD']);else{await numstat(['--cached']);await numstat([]);}
  for(const file of files){
    const c=counts.get(file.path);
    if(c)Object.assign(file,c);
    else if(file.untracked||(!hasHead&&file.index==='A')){const n=textLines(path.join(top,file.path));if(n==null)file.binary=true;else file.added=n;}
  }
  let branch='';try{branch=(await run(top,['branch','--show-current'])).stdout.trim();}catch{}
  return{isGit:true,files,branch,prefix,hasHead,root:top};
}
async function diff(projectPath,relative){
  const {top,hasHead}=await repo(projectPath),target=inside(top,relative);
  const tracked=(await run(top,['ls-files','--error-unmatch','--',relative],{allowFail:true})).code===0;
  if(tracked){
    const text=hasHead?(await run(top,['diff','--no-ext-diff','--no-textconv','HEAD','--',relative],{allowFail:true})).stdout:(await run(top,['diff','--no-ext-diff','--cached','--',relative],{allowFail:true})).stdout+(await run(top,['diff','--no-ext-diff','--',relative],{allowFail:true})).stdout;
    if(text)return text.slice(0,400000);
  }
  if(!fs.existsSync(target))return'文件已删除。';
  if(fs.statSync(target).size>1024*1024)return'文件超过 1 MB，请在编辑器中查看。';
  const content=fs.readFileSync(target,'utf8');if(content.includes('\0'))return'二进制文件，请在外部应用中查看。';
  return`新文件 ${relative}\n@@ 新增 @@\n`+content.replace(/\n$/,'').split('\n').map(line=>'+'+line).join('\n');
}
async function stage(projectPath,paths,staged){
  const {top,hasHead}=await repo(projectPath);if(!Array.isArray(paths)||!paths.length||paths.length>500)throw Error('请选择文件');
  for(const p of paths)inside(top,p);
  if(staged)await run(top,['add','-A','--',...paths]);
  else if(hasHead)await run(top,['restore','--staged','--',...paths]);
  else await run(top,['rm','-r','--cached','--quiet','--',...paths]);
  return true;
}
// Discards one file's changes against HEAD. New files are deleted; this cannot be undone.
async function revert(projectPath,relative){
  const {top,hasHead}=await repo(projectPath),target=inside(top,relative);
  const row=(await changes(projectPath)).files.find(f=>f.path===relative);if(!row)throw Error('这个文件已没有改动');
  const inHead=hasHead&&(await run(top,['cat-file','-e','HEAD:'+relative],{allowFail:true})).code===0;
  if(row.from){inside(top,row.from);await run(top,['restore','--source=HEAD','--staged','--worktree','--',row.from]);}
  if(inHead){await run(top,['restore','--source=HEAD','--staged','--worktree','--',relative]);return true;}
  if(row.staged)await run(top,hasHead?['restore','--staged','--',relative]:['rm','--cached','--quiet','--',relative]);
  if(fs.existsSync(target)&&fs.lstatSync(target).isFile())fs.rmSync(target);
  return true;
}
async function commit(projectPath,message,all){
  const {top}=await repo(projectPath);message=String(message||'').trim();
  if(!message||message.length>5000)throw Error('请填写提交说明（最多 5000 字）');
  if(all)await run(top,['add','-A']);
  if((await run(top,['diff','--cached','--quiet'],{allowFail:true})).code===0)throw Error(all?'没有可以提交的改动':'还没有暂存任何文件');
  await run(top,['commit','-m',message]);
  const head=(await run(top,['log','-1','--format=%h%x00%s'])).stdout.trim().split('\0');
  return{hash:head[0],subject:head[1]};
}
module.exports={changes,diff,stage,revert,commit};
