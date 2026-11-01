const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {JsonStore}=require('./engine.cjs');
const {readState,mergeLegacy,atomicWrite}=require('./storage.cjs');
const {legacyUsage}=require('./usage.cjs');

// SQLite is authoritative. Per-chat snapshots are inspectable recovery copies,
// not inputs for automatic merging (which would resurrect intentional deletions).
class DatabaseStore{
  constructor(root,candidates=[]){
    fs.mkdirSync(root,{recursive:true});this.root=root;this.file=path.join(root,'workspace.sqlite');this.recovered=false;this.recoveredCount=0;this.warning='';
    this.db=new DatabaseSync(this.file);
    try{
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if(this.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('数据库完整性检查失败');
      const version=this.db.prepare('PRAGMA user_version').get().user_version;
      if(version>1)throw Error('此数据由更新版本创建，请使用新版软件');
      this.db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,time INTEGER NOT NULL,action TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT);
        PRAGMA user_version=1;`);
      const row=this.db.prepare("SELECT value FROM meta WHERE key='state'").get();
      if(row){
        this.state=JSON.parse(row.value);this.state.threads=this.db.prepare('SELECT body FROM threads').all().map(row=>JSON.parse(row.body));this.state.usageLog=this.db.prepare('SELECT body FROM usage').all().map(row=>JSON.parse(row.body));
        this.revision=Number(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value);
        this.datasetId=this.db.prepare("SELECT value FROM meta WHERE key='dataset'").get().value;
        this.prior=new Map(this.state.threads.map(t=>[t.id,JSON.stringify(t)]));this.usagePrior=new Map(this.state.usageLog.map(t=>[t.id,JSON.stringify(t)]));
        // Reuse restart normalization without writing the legacy source.
        this.normalize();
      }else{
        const states=[];
        for(const file of [...new Set(candidates)]){
          let found=false;const valid=[];
          for(const source of [file,file+'.tmp',file+'.bak'])if(fs.existsSync(source)){
            found=true;try{const state=readState(source);valid.push({file:source,state,time:state.savedAt||fs.statSync(source).mtimeMs});}catch{}
          }
          if(found&&!valid.length)throw Error('旧会话文件无法读取，已保留原件：'+file);
          valid.sort((a,b)=>b.time-a.time);if(valid.length){states.push(valid[0]);if(valid[0].file!==file)this.recovered=true;}
        }
        states.sort((a,b)=>b.time-a.time);
        if(states.length){
          this.state=structuredClone(states[0].state);
          this.recoveredCount=mergeLegacy(this.state,states.slice(1).map(s=>s.file));
          this.state.usageLog||=[];const usageIds=new Set(this.state.usageLog.map(row=>row.id));
          for(const source of states.slice(1))for(const row of source.state.usageLog||[])if(!usageIds.has(row.id)){this.state.usageLog.push(row);usageIds.add(row.id);}
          if(this.recoveredCount)delete this.state.usageAccountingVersion;
          this.state.migrations={...this.state.migrations,unifiedDataV2:true};legacyUsage(this.state);
        }else this.state={projects:[],threads:[]};
        // An immutable pre-migration copy contains all original records, drafts,
        // options and counters before restart status normalization.
        const backup=path.join(root,'migration-backup.json');if(!fs.existsSync(backup))atomicWrite(backup,this.state);
        this.revision=0;this.datasetId=randomUUID();this.prior=new Map();this.usagePrior=new Map();this.normalize();this.save();
      }
      this.mirror();
    }catch(e){this.db.close();throw Error('会话数据库未能打开，原文件已保留：'+e.message);}
  }
  normalize(){
    const normal=Object.create(JsonStore.prototype); // Constructor's normalization is shared below.
    normal.state=this.state;JsonStore.normalize(normal);
    this.state=normal.state;
  }
  save(){
    const metadata={...this.state,savedAt:Date.now()};delete metadata.threads;delete metadata.usageLog;
    const next=new Map(this.state.threads.map(t=>[t.id,JSON.stringify(t)])),usage=new Map((this.state.usageLog||[]).map(row=>[row.id,JSON.stringify(row)]));
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const revision=Number(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get()?.value||0);
      if(revision!==this.revision)throw Error('另一进程已更新会话数据；请重新打开软件，避免用旧记录覆盖新内容');
      const upsert=this.db.prepare('INSERT INTO threads(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body');
      const audit=this.db.prepare('INSERT INTO audit(time,action,thread_id,turn_id) VALUES(?,?,?,?)');
      for(const [id,body]of next)if(body!==this.prior.get(id)){
        upsert.run(id,body);
        if(this.prior.has(id)){const ids=new Set(JSON.parse(body).turns.map(t=>t.id));for(const turn of JSON.parse(this.prior.get(id)).turns)if(!ids.has(turn.id))audit.run(Date.now(),'delete_turn',id,turn.id);}
      }
      for(const id of this.prior.keys())if(!next.has(id)){this.db.prepare('DELETE FROM threads WHERE id=?').run(id);audit.run(Date.now(),'delete_thread',id,null);}
      const addUsage=this.db.prepare('INSERT INTO usage(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body');
      for(const [id,body]of usage)if(body!==this.usagePrior.get(id))addUsage.run(id,body);
      for(const id of this.usagePrior.keys())if(!usage.has(id))this.db.prepare('DELETE FROM usage WHERE id=?').run(id);
      const set=this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      set.run('state',JSON.stringify(metadata));set.run('revision',String(revision+1));set.run('dataset',this.datasetId);
      this.db.exec('COMMIT');this.revision=revision+1;this.state.savedAt=metadata.savedAt;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    this.prior=next;this.usagePrior=usage;this.mirror();
  }
  mirror(){
    try{
      const folder=path.join(this.root,'sessions');fs.mkdirSync(folder,{recursive:true});const keep=new Set();
      for(const [id,body]of this.prior){const name=createHash('sha256').update(id).digest('hex')+'.json';keep.add(name);const file=path.join(folder,name);if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==body){const fd=fs.openSync(file+'.tmp','w');try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(file+'.tmp',file);}}
      for(const name of fs.readdirSync(folder))if(/^[a-f0-9]{64}\.json(?:\.tmp)?$/.test(name)&&!keep.has(name))fs.unlinkSync(path.join(folder,name));
      this.warning='';
    }catch{this.warning='数据库已保存，但独立会话副本写入失败，请检查磁盘空间。';}
  }
  info(){return{database:this.file,datasetId:this.datasetId,revision:this.revision,threads:this.state.threads.length,turns:this.state.threads.reduce((n,t)=>n+t.turns.length,0),warning:this.warning};}
  close(){this.db.close();}
}
module.exports={DatabaseStore};
