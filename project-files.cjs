const fs=require('./disk-fs.cjs');const path=require('node:path');
const archivePath=file=>String(file).split(/[\\/]/).some(part=>/\.asar$/i.test(part));
function within(root,relative){
  if(typeof relative!=='string'||!relative||relative.length>2000||relative.includes('\0'))throw Error('文件路径无效');
  const target=path.resolve(root,relative),realRoot=fs.realpathSync(root),rel=path.relative(realRoot,target);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('文件不在项目内');
  if(fs.existsSync(target)){const real=fs.realpathSync(target),checked=path.relative(realRoot,real);if(checked.startsWith('..')||path.isAbsolute(checked))throw Error('链接指向项目外');}
  return target;
}
async function listProjectFiles(root,git){
  try{return [...new Set((await git(root,['ls-files','-z','--cached','--others','--exclude-standard'])).split('\0').filter(file=>file&&!archivePath(file)))].sort().slice(0,2500);}catch{}
  const files=[];
  function walk(dir,depth=0){
    if(depth>8||files.length>=2500)return;
    for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
      if(['.git','node_modules','.next','dist','.venv'].includes(ent.name)||/\.asar$/i.test(ent.name)||ent.isSymbolicLink())continue;
      const full=path.join(dir,ent.name);if(ent.isDirectory())walk(full,depth+1);else files.push(path.relative(root,full));
      if(files.length>=2500)break;
    }
  }
  walk(root);return files;
}
function readProjectFile(target){
  if(archivePath(target))return'二进制归档，请在外部应用中查看。';
  if(!fs.existsSync(target)||!fs.statSync(target).isFile())return'';
  if(fs.statSync(target).size>1024*1024)return'文件超过 1 MB，请在编辑器中查看。';
  const text=fs.readFileSync(target,'utf8');return text.includes('\0')?'二进制文件，请在外部应用中查看。':text;
}
module.exports={within,listProjectFiles,readProjectFile,archivePath};
