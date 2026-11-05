const fs=require('./disk-fs.cjs');const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const {JsonStore}=require('./engine.cjs');const {readState,mergeLegacy,atomicWrite}=require('./storage.cjs');
const {legacyUsage}=require('./usage.cjs');const {recordChunks,readRecord,writeJson}=require('./json-stream.cjs');
const fingerprint=value=>{const hash=createHash('sha256');for(const chunk of recordChunks(value))hash.update(chunk);return hash.digest('hex');};
const TABLES=`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,body TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,time INTEGER NOT NULL,action TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT);`;
const RECORDS=`CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,owner TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,part INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,owner,id,part));
  CREATE INDEX IF NOT EXISTS record_order ON records(kind,owner,position,part);`;
// SQLite is authoritative. JSON mirrors are streamed recovery copies, never merged
// back automatically. Version 2 separates turns and bounds every database value.
class DatabaseStore{
  constructor(root,candidates=[]){
    fs.mkdirSync(root,{recursive:true});Object.assign(this,{root,file:path.join(root,'workspace.sqlite'),recovered:false,recoveredCount:0,warning:'',prior:new Map(),usagePrior:new Map()});
    this.db=new DatabaseSync(this.file);
    try{
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if(this.db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('数据库完整性检查失败');
      const version=this.db.prepare('PRAGMA user_version').get().user_version;if(version>2)throw Error('此数据由更新版本创建，请使用新版软件');
      this.db.exec(TABLES);
      const row=this.db.prepare("SELECT value FROM meta WHERE key='state'").get();
      if(row){
        this.revision=Number(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value);
        this.datasetId=this.db.prepare("SELECT value FROM meta WHERE key='dataset'").get().value;
        if(version<2){
          this.state=JSON.parse(row.value);this.state.threads=[];this.state.usageLog=[];
          for(const item of this.db.prepare('SELECT body FROM threads').iterate())this.state.threads.push(JSON.parse(item.body));
          for(const item of this.db.prepare('SELECT body FROM usage').iterate())this.state.usageLog.push(JSON.parse(item.body));
          // VACUUM INTO includes committed WAL content in a standalone v1 backup.
          this.migrationBackup=path.join(root,'migration-v1-backup-'+Date.now()+'-'+randomUUID().slice(0,8)+'.sqlite');
          this.db.prepare('VACUUM INTO ?').run(this.migrationBackup);
          const backup=new DatabaseSync(this.migrationBackup,{readOnly:true});try{if(backup.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('迁移备份校验失败');}finally{backup.close();}
          this.save(true);
        }else{
          this.state=this.read('state','','state');this.state.threads=[];this.state.usageLog=[];
          for(const item of this.db.prepare("SELECT threads.id FROM threads LEFT JOIN records r ON r.kind='thread' AND r.owner='' AND r.id=threads.id AND r.part=0 ORDER BY r.position").all()){
            const thread=this.read('thread','',item.id);thread.turns=[];
            for(const turn of this.db.prepare("SELECT id FROM records WHERE kind='turn' AND owner=? GROUP BY id ORDER BY min(position)").all(item.id))thread.turns.push(this.read('turn',item.id,turn.id));
            this.state.threads.push(thread);
          }
          for(const item of this.db.prepare("SELECT id FROM records WHERE kind='usage' GROUP BY id ORDER BY min(position)").all())this.state.usageLog.push(this.read('usage','',item.id));
          this.remember();
        }
        this.normalize();
      }else{
        this.db.exec(RECORDS+'PRAGMA user_version=2;');
        const states=[];
        for(const file of [...new Set(candidates)]){
          let found=false;const valid=[];
          for(const source of [file,file+'.tmp',file+'.bak'])if(fs.existsSync(source)){found=true;try{const state=readState(source);valid.push({file:source,state,time:state.savedAt||fs.statSync(source).mtimeMs});}catch{}}
          if(found&&!valid.length)throw Error('旧会话文件无法读取，已保留原件：'+file);
          valid.sort((a,b)=>b.time-a.time);if(valid.length){states.push(valid[0]);if(valid[0].file!==file)this.recovered=true;}
        }
        states.sort((a,b)=>b.time-a.time);
        if(states.length){
          this.state=structuredClone(states[0].state);this.recoveredCount=mergeLegacy(this.state,states.slice(1).map(s=>s.file));
          this.state.usageLog||=[];const ids=new Set(this.state.usageLog.map(row=>row.id));
          for(const source of states.slice(1))for(const row of source.state.usageLog||[])if(!ids.has(row.id)){this.state.usageLog.push(row);ids.add(row.id);}
          if(this.recoveredCount)delete this.state.usageAccountingVersion;
          this.state.migrations={...this.state.migrations,unifiedDataV2:true};legacyUsage(this.state);
        }else this.state={projects:[],threads:[]};
        const backup=path.join(root,'migration-backup.json');if(!fs.existsSync(backup))atomicWrite(backup,this.state);
        this.revision=0;this.datasetId=randomUUID();this.normalize();this.save();
      }
      this.mirror(new Set(this.state.threads.map(t=>t.id)));
    }catch(e){this.db.close();throw Error('会话数据库未能打开，原文件已保留：'+e.message,{cause:e});}
  }
  read(kind,owner,id){
    const rows=this.db.prepare('SELECT part,body FROM records WHERE kind=? AND owner=? AND id=? ORDER BY part').iterate(kind,owner,id);
    function* parts(){let expected=0;for(const row of rows){if(row.part!==expected++)throw Error('会话记录缺少分块');yield row.body;}}
    return readRecord(parts());
  }
  normalize(){const normal=Object.create(JsonStore.prototype);normal.state=this.state;JsonStore.normalize(normal);this.state=normal.state;}
  describe(thread,position){const {turns,...meta}=thread;return{hash:fingerprint(meta),position,turns:new Map(turns.map((turn,index)=>[turn.id,{hash:fingerprint(turn),position:index}]))};}
  remember(){this.prior=new Map(this.state.threads.map((t,i)=>[t.id,this.describe(t,i)]));this.usagePrior=new Map((this.state.usageLog||[]).map((row,i)=>[row.id,{hash:fingerprint(row),position:i}]));}
  // A light save (`durable:false`, while Claude streams) only looks at the threads in
  // `touched`, commits without waiting for the disk (WAL with synchronous=NORMAL: an
  // app crash loses nothing, a power cut at most the last moments) and leaves the JSON
  // copies to the next full save. Every other save checks every thread and turn.
  save(migration=false,{durable=true,touched=null}={}){
    const metadata={...this.state,savedAt:Date.now()};delete metadata.threads;delete metadata.usageLog;
    const next=new Map(),usage=new Map(),dirty=new Set(),light=!durable&&touched instanceof Set;
    if(light)this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const revision=Number(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get()?.value||0);
      if(revision!==this.revision)throw Error('另一进程已更新会话数据；请重新打开软件，避免用旧记录覆盖新内容');
      if(migration)this.db.exec(RECORDS);
      const erase=this.db.prepare('DELETE FROM records WHERE kind=? AND owner=? AND id=?');
      const insert=this.db.prepare('INSERT INTO records(kind,owner,id,position,part,body) VALUES(?,?,?,?,?,?)');
      const move=this.db.prepare('UPDATE records SET position=? WHERE kind=? AND owner=? AND id=?');
      const write=(kind,owner,id,position,value,prior)=>{
        const hash=fingerprint(value),record={hash,position};
        if(hash!==prior?.hash){erase.run(kind,owner,id);let part=0;for(const body of recordChunks(value))insert.run(kind,owner,id,position,part++,body);}
        else if(position!==prior.position)move.run(position,kind,owner,id);
        return record;
      };
      const audit=this.db.prepare('INSERT INTO audit(time,action,thread_id,turn_id) VALUES(?,?,?,?)');
      for(let i=0;i<this.state.threads.length;i++){
        const thread=this.state.threads[i],prior=this.prior.get(thread.id),{turns,...meta}=thread;
        if(next.has(thread.id))throw Error('会话 ID 重复');
        if(light&&prior&&!touched.has(thread.id)&&prior.turns.size===turns.length){
          if(prior.position!==i)move.run(i,'thread','',thread.id);
          next.set(thread.id,{...prior,position:i});continue;
        }
        const record=write('thread','',thread.id,i,meta,prior);record.turns=new Map();
        if(!prior||record.hash!==prior.hash){this.db.prepare('INSERT INTO threads(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(thread.id,'{}');dirty.add(thread.id);}
        for(let j=0;j<turns.length;j++){
          const turn=turns[j];if(typeof turn.id!=='string'||!turn.id||record.turns.has(turn.id))throw Error('问答 ID 无效或重复');
          const saved=write('turn',thread.id,turn.id,j,turn,prior?.turns.get(turn.id));record.turns.set(turn.id,saved);
          const old=prior?.turns.get(turn.id);if(!old||saved.hash!==old.hash||saved.position!==old.position)dirty.add(thread.id);
        }
        if(prior)for(const id of prior.turns.keys())if(!record.turns.has(id)){erase.run('turn',thread.id,id);audit.run(Date.now(),'delete_turn',thread.id,id);dirty.add(thread.id);}
        next.set(thread.id,record);
      }
      for(const id of this.prior.keys())if(!next.has(id)){this.db.prepare('DELETE FROM threads WHERE id=?').run(id);erase.run('thread','',id);this.db.prepare("DELETE FROM records WHERE kind='turn' AND owner=?").run(id);audit.run(Date.now(),'delete_thread',id,null);}
      for(let i=0;i<(this.state.usageLog||[]).length;i++){const row=this.state.usageLog[i];usage.set(row.id,write('usage','',row.id,i,row,this.usagePrior.get(row.id)));}
      for(const id of this.usagePrior.keys())if(!usage.has(id))erase.run('usage','',id);
      write('state','','state',0,metadata);
      const set=this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      set.run('state','{}');set.run('revision',String(revision+1));set.run('dataset',this.datasetId);
      if(migration)this.db.exec("DELETE FROM usage; UPDATE threads SET body='{}'; PRAGMA user_version=2;");
      this.db.exec('COMMIT');this.revision=revision+1;this.state.savedAt=metadata.savedAt;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    finally{if(light)this.db.exec('PRAGMA synchronous=FULL');}
    this.prior=next;this.usagePrior=usage;
    if(light)for(const id of dirty)(this.mirrorDirty||=new Set()).add(id);else this.mirror(dirty);
  }
  // Settings, projects and drafts only, e.g. while typing. save() hashes every turn,
  // which grows with the history; changed threads are left to the next save().
  // Without the fsync (synchronous=NORMAL) a power cut can lose the last few drafts, never the database.
  saveState(){
    const metadata={...this.state,savedAt:Date.now()};delete metadata.threads;delete metadata.usageLog;
    this.db.exec('PRAGMA synchronous=NORMAL');
    try{
      this.db.exec('BEGIN IMMEDIATE');
      try{
        const revision=Number(this.db.prepare("SELECT value FROM meta WHERE key='revision'").get()?.value||0);
        if(revision!==this.revision)throw Error('另一进程已更新会话数据；请重新打开软件，避免用旧记录覆盖新内容');
        this.db.prepare("DELETE FROM records WHERE kind='state' AND owner='' AND id='state'").run();
        const insert=this.db.prepare("INSERT INTO records(kind,owner,id,position,part,body) VALUES('state','','state',0,?,?)");let part=0;
        for(const body of recordChunks(metadata))insert.run(part++,body);
        this.db.prepare("UPDATE meta SET value=? WHERE key='revision'").run(String(revision+1));
        this.db.exec('COMMIT');this.revision=revision+1;this.state.savedAt=metadata.savedAt;
      }catch(e){this.db.exec('ROLLBACK');throw e;}
    }finally{this.db.exec('PRAGMA synchronous=FULL');}
  }
  mirror(dirty=new Set()){
    const pending=this.mirrorDirty||=new Set();for(const id of dirty)pending.add(id);
    try{
      const folder=path.join(this.root,'sessions');fs.mkdirSync(folder,{recursive:true});const keep=new Set();
      for(const thread of this.state.threads){const name=createHash('sha256').update(thread.id).digest('hex')+'.json';keep.add(name);const file=path.join(folder,name);if(pending.has(thread.id)||!fs.existsSync(file)){writeJson(file,thread);pending.delete(thread.id);}}
      for(const name of fs.readdirSync(folder))if(/^[a-f0-9]{64}\.json(?:\.tmp)?$/.test(name)&&!keep.has(name))fs.unlinkSync(path.join(folder,name));
      this.warning='';
    }catch{this.warning='数据库已保存，但独立会话副本写入失败，请检查磁盘空间。';}
  }
  export(file){writeJson(file,this.state);}
  info(){return{database:this.file,datasetId:this.datasetId,revision:this.revision,storageVersion:2,migrationBackup:this.migrationBackup,threads:this.state.threads.length,turns:this.state.threads.reduce((n,t)=>n+t.turns.length,0),warning:this.warning};}
  close(){if(this.mirrorDirty?.size)this.mirror();this.db.close();}
}
module.exports={DatabaseStore};
