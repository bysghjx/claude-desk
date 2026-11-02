// The storage page: how much disk each kind of app data takes, and cleanup of
// what nothing uses any more. Only leftovers are removed: images no message
// shows, file snapshots and chat folders of deleted conversations, and worktrees
// of deleted or archived conversations that hold no uncommitted changes.
const fs=require('node:fs');const path=require('node:path');

async function sizeOf(target){
  let size=0,count=0;
  async function walk(file){
    let stat;try{stat=await fs.promises.lstat(file);}catch{return;}
    if(stat.isSymbolicLink())return;
    if(!stat.isDirectory()){size+=stat.size;count++;return;}
    let entries=[];try{entries=await fs.promises.readdir(file);}catch{return;}
    for(const entry of entries)await walk(path.join(file,entry));
  }
  await walk(target);return{size,count};
}
const children=dir=>{try{return fs.readdirSync(dir,{withFileTypes:true}).map(entry=>({name:entry.name,full:path.join(dir,entry.name),dir:entry.isDirectory()}));}catch{return[];}};
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();

class StorageUsage{
  // checkpointKey maps a folder to its snapshot store name (Checkpoints#key);
  // removeWorktree(thread) removes a thread's worktree the same way the 改动 panel does.
  constructor({dataRoot,state,checkpointKey,removeWorktree,worktreeStatus}){Object.assign(this,{dataRoot,state,checkpointKey,removeWorktree,worktreeStatus});}
  dir(name){return path.join(this.dataRoot,name);}
  threads(){return this.state().threads||[];}
  // Leftovers per kind, as [{full, label, thread?}].
  async leftovers(){
    const threads=this.threads(),images=new Set();
    for(const t of threads)for(const turn of t.turns||[])for(const image of turn.images||[])if(image?.path)images.add(path.resolve(image.path).toLowerCase());
    const attachments=children(this.dir('attachments')).filter(x=>!x.dir&&!images.has(path.resolve(x.full).toLowerCase())).map(x=>({full:x.full,label:x.name}));
    const keys=new Set(threads.map(t=>t.cwd).filter(Boolean).map(cwd=>this.checkpointKey(cwd)+'.git'));
    const checkpoints=children(this.dir('checkpoints')).filter(x=>x.dir&&!keys.has(x.name)).map(x=>({full:x.full,label:x.name}));
    const chats=children(this.dir('chats')).filter(x=>x.dir&&!threads.some(t=>t.cwd&&same(t.cwd,x.full))).map(x=>({full:x.full,label:x.name}));
    const worktrees=[];
    for(const x of children(this.dir('worktrees')).filter(x=>x.dir)){
      const owner=threads.find(t=>t.worktree&&!t.worktree.removed&&same(t.worktree.path,x.full));
      if(owner&&!owner.archived)continue;
      // A worktree goes only when it is clean; uncommitted work stays.
      const status=await this.worktreeStatus(owner?owner.worktree:{path:x.full,repo:x.full,baseCommit:'HEAD',branch:'HEAD'}).catch(()=>null);if(status?.exists&&status.dirty)continue;
      worktrees.push({full:x.full,label:owner?owner.title:x.name,thread:owner});
    }
    return{attachments,checkpoints,chats,worktrees};
  }
  async scan(){
    const left=await this.leftovers(),groups=[];
    const add=async(key,label,note,targets,leftover=[])=>{
      let size=0,count=0;for(const target of targets){const s=await sizeOf(target);size+=s.size;count+=s.count;}
      let cleanSize=0;for(const item of leftover)cleanSize+=(await sizeOf(item.full)).size;
      groups.push({key,label,note,size,count,clean:{count:leftover.length,size:cleanSize,items:leftover.slice(0,8).map(x=>x.label)}});
    };
    const db=children(this.dataRoot).filter(x=>!x.dir&&/^workspace\.sqlite/.test(x.name)).map(x=>x.full);
    await add('database','会话数据','所有对话、草稿和用量记录',[...db,this.dir('sessions')]);
    await add('attachments','图片附件','发送给 Claude 的图片；可清理的是已删除消息留下的图片',[this.dir('attachments')],left.attachments);
    await add('checkpoints','文件快照','「回退到这里」用的项目文件记录；可清理的是已删除对话的项目快照',[this.dir('checkpoints')],left.checkpoints);
    await add('worktrees','独立工作树','每个独立工作树是一份项目副本；可清理的是已归档或已删除对话的、没有未提交改动的工作树',[this.dir('worktrees')],left.worktrees);
    await add('chats','对话文件夹','不属于项目的对话各自的空文件夹',[this.dir('chats')],left.chats);
    const backups=children(this.dataRoot).filter(x=>!x.dir&&/^(bootstrap|migration-backup).*\.json$/.test(x.name)).map(x=>x.full);
    await add('backups','迁移备份','旧版本数据迁移前的快照',backups);
    let disk=null;try{const s=fs.statfsSync(this.dataRoot);disk={free:s.bavail*s.bsize,total:s.blocks*s.bsize};}catch{}
    return{root:this.dataRoot,groups,disk,total:groups.reduce((n,g)=>n+g.size,0)};
  }
  async clean(key){
    const left=await this.leftovers(),items=left[key];if(!items)throw Error('这一项没有可清理的内容');
    let removed=0;const failed=[];
    for(const item of items){
      try{
        if(key==='worktrees'&&item.thread)await this.removeWorktree(item.thread);
        else fs.rmSync(item.full,{recursive:true,force:true,maxRetries:4,retryDelay:250});
        removed++;
      }catch(e){failed.push(item.label+'：'+e.message);}
    }
    return{removed,failed};
  }
}
module.exports={StorageUsage,sizeOf};
