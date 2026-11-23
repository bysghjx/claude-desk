const fs=require('./disk-fs.cjs');const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const {JsonStore}=require('./engine.cjs');const {readState,mergeLegacy,atomicWrite}=require('./storage.cjs');
const {legacyUsage}=require('./usage.cjs');const {recordChunks,readRecord,writeJson,jsonChunks}=require('./json-stream.cjs');
const fingerprint=value=>{const hash=createHash('sha256');for(const chunk of recordChunks(value))hash.update(chunk);return hash.digest('hex');};
// A trace lists a record's structure and leaf values. Strings are immutable, so a value
// that still matches its trace serializes exactly as before: comparing it costs one step
// per node and never reads string contents. Values with toJSON never match.
const OBJECT=Symbol('object'),ARRAY=Symbol('array');
function trace(value,out=[]){
  if(value===null||typeof value!=='object')out.push(value);
  else if(Array.isArray(value)){out.push(ARRAY,value.length);for(let i=0;i<value.length;i++)trace(value[i],out);}
  else{const keys=Object.keys(value);out.push(OBJECT,keys.length);for(const key of keys){out.push(key);trace(value[key],out);}}
  return out;
}
function traced(value,list){
  let at=0;
  const same=item=>{
    if(item===null||typeof item!=='object')return at<list.length&&list[at++]===item;
    if(typeof item.toJSON==='function')return false;
    if(Array.isArray(item)){if(list[at++]!==ARRAY||list[at++]!==item.length)return false;for(let i=0;i<item.length;i++)if(!same(item[i]))return false;return true;}
    const keys=Object.keys(item);if(list[at++]!==OBJECT||list[at++]!==keys.length)return false;
    for(const key of keys)if(list[at++]!==key||!same(item[key]))return false;
    return true;
  };
  return same(value)&&at===list.length;
}
// Hashing first also rejects circular values before they are traced.
const entry=(value,position)=>{const hash=fingerprint(value);return{hash,position,trace:trace(value)};};
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
      this.mirror(this.staleMirrors());
    }catch(e){this.db.close();throw Error('会话数据库未能打开，原文件已保留：'+e.message,{cause:e});}
  }
  read(kind,owner,id){
    const rows=this.db.prepare('SELECT part,body FROM records WHERE kind=? AND owner=? AND id=? ORDER BY part').iterate(kind,owner,id);
    function* parts(){let expected=0;for(const row of rows){if(row.part!==expected++)throw Error('会话记录缺少分块');yield row.body;}}
    return readRecord(parts());
  }
  normalize(){const normal=Object.create(JsonStore.prototype);normal.state=this.state;JsonStore.normalize(normal);this.state=normal.state;}
  describe(thread,position){const {turns,...meta}=thread;return{...entry(meta,position),turns:new Map(turns.map((turn,index)=>[turn.id,entry(turn,index)]))};}
  remember(){this.prior=new Map(this.state.threads.map((t,i)=>[t.id,this.describe(t,i)]));this.usagePrior=new Map((this.state.usageLog||[]).map((row,i)=>[row.id,entry(row,i)]));}
  // A light save (`durable:false`, while Claude streams) only looks at the threads in
  // `touched`, commits without waiting for the disk (WAL with synchronous=NORMAL: an
  // app crash loses nothing, a power cut at most the last moments) and leaves the JSON
  // copies to the next full save. Every other save checks every thread and turn: a record
  // that still matches the trace saved with it keeps its hash, the rest are hashed again.
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
        if(prior?.trace&&traced(value,prior.trace)){if(position!==prior.position)move.run(position,kind,owner,id);return{...prior,position};}
        const record=entry(value,position);
        if(record.hash!==prior?.hash){erase.run(kind,owner,id);let part=0;for(const body of recordChunks(value))insert.run(kind,owner,id,position,part++,body);}
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
  // Settings, projects and drafts only, e.g. while typing. save() walks every turn and
  // waits for the disk; changed threads are left to the next save().
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
  // The sessions folder holds one JSON copy per thread. sessions-index.json records,
  // per copy, a digest of the saved records it was written from and the file's size and
  // mtime, so a restart rewrites only copies that are missing, edited or behind the
  // database (e.g. after a crash lost the copies a light save had deferred).
  mirrorDigest(id){const record=this.prior.get(id);if(!record)return'';const hash=createHash('sha256').update(record.hash);for(const [turn,{hash:value}] of record.turns)hash.update('\n'+turn+':'+value);return hash.digest('hex');}
  mirrorName(id){return createHash('sha256').update(id).digest('hex')+'.json';}
  loadMirrorIndex(){
    if(this.mirrorIndex)return this.mirrorIndex;
    try{const index=JSON.parse(fs.readFileSync(path.join(this.root,'sessions-index.json'),'utf8'));if(index.version===1&&index.dataset===this.datasetId&&index.files&&typeof index.files==='object')return this.mirrorIndex=index;}catch{}
    return this.mirrorIndex={version:1,dataset:this.datasetId,files:{}};
  }
  staleMirrors(){
    const index=this.loadMirrorIndex(),folder=path.join(this.root,'sessions'),stale=new Set();
    for(const thread of this.state.threads){
      const name=this.mirrorName(thread.id),entry=index.files[name];let stat;try{stat=fs.statSync(path.join(folder,name));}catch{}
      if(!entry||!stat||entry.digest!==this.mirrorDigest(thread.id)||entry.size!==stat.size||entry.mtimeMs!==stat.mtimeMs)stale.add(thread.id);
    }
    return stale;
  }
  // Copies are written in the background, one at a time: each thread is serialized in a
  // single tick (a consistent snapshot), then written and fsynced off the main thread.
  // A light save only queues its threads; the next full save, mirror() or close() writes them.
  mirror(dirty=new Set()){
    const pending=this.mirrorDirty||=new Set();for(const id of dirty)pending.add(id);
    if(this.closed)return Promise.resolve();this.mirrorRequested=true;
    return this.mirroring||=this.mirrorRun().finally(()=>{this.mirroring=null;if(this.mirrorRequested&&!this.closed)this.mirror();});
  }
  async mirrorRun(){
    const pending=this.mirrorDirty,folder=path.join(this.root,'sessions');
    try{
      while(this.mirrorRequested&&!this.closed){
        this.mirrorRequested=false;await fs.promises.mkdir(folder,{recursive:true});
        for(const thread of [...this.state.threads]){
          if(this.closed)return;
          const name=this.mirrorName(thread.id),file=path.join(folder,name);
          if(!this.state.threads.includes(thread)||(!pending.has(thread.id)&&fs.existsSync(file)))continue;
          pending.delete(thread.id);this.mirrorActive=thread.id;
          try{await this.mirrorWrite(file,name,thread);}catch(e){pending.add(thread.id);throw e;}finally{this.mirrorActive=null;}
        }
        this.mirrorPrune(true);await this.mirrorSaveIndex();
      }
      if(!this.closed)this.warning='';
    }catch{this.warning='数据库已保存，但独立会话副本写入失败，请检查磁盘空间。';}
  }
  async mirrorWrite(file,name,thread){
    const digest=this.mirrorDigest(thread.id),chunks=[...jsonChunks(thread)],temp=file+'.'+randomUUID().slice(0,8)+'.tmp';
    try{
      const handle=await fs.promises.open(temp,'w');
      try{for(const chunk of chunks)await handle.write(chunk);await handle.sync();}finally{await handle.close();}
      await fs.promises.rename(temp,file);
    }catch(e){await fs.promises.rm(temp,{force:true}).catch(()=>{});throw e;}
    this.mirrorRecord(name,digest,await fs.promises.stat(file));
  }
  mirrorRecord(name,digest,stat){const files=this.loadMirrorIndex().files;if(digest)files[name]={digest,size:stat.size,mtimeMs:stat.mtimeMs};else delete files[name];}
  // Removes copies of deleted threads; temp files only when no write of ours is in flight.
  mirrorPrune(temps){
    const folder=path.join(this.root,'sessions'),keep=new Set(this.state.threads.map(t=>this.mirrorName(t.id))),files=this.loadMirrorIndex().files,ids=new Set(this.state.threads.map(t=>t.id));
    for(const id of this.mirrorDirty||[])if(!ids.has(id))this.mirrorDirty.delete(id);
    for(const name of Object.keys(files))if(!keep.has(name))delete files[name];
    let names=[];try{names=fs.readdirSync(folder);}catch{}
    for(const name of names){const match=/^([a-f0-9]{64}\.json)(\.(?:[a-f0-9]{8}\.)?tmp)?$/.exec(name);if(match&&(match[2]?temps:!keep.has(match[1])))fs.rmSync(path.join(folder,name),{force:true});}
  }
  async mirrorSaveIndex(){const file=path.join(this.root,'sessions-index.json'),temp=file+'.'+randomUUID().slice(0,8)+'.tmp';await fs.promises.writeFile(temp,JSON.stringify(this.loadMirrorIndex()));await fs.promises.rename(temp,file);}
  // Waits for the background copies, e.g. before quitting.
  async flush(){while(this.mirroring)await this.mirroring;}
  export(file){writeJson(file,this.state);}
  info(){return{database:this.file,datasetId:this.datasetId,revision:this.revision,storageVersion:2,migrationBackup:this.migrationBackup,threads:this.state.threads.length,turns:this.state.threads.reduce((n,t)=>n+t.turns.length,0),warning:this.warning};}
  // Writes what is still queued synchronously; a copy being written in the background
  // finishes on its own (or is redone on the next start).
  close(){
    this.closed=true;
    try{
      if(this.mirrorDirty?.size){
        const folder=path.join(this.root,'sessions');
        for(const thread of this.state.threads)if(this.mirrorDirty.has(thread.id)&&thread.id!==this.mirrorActive){const name=this.mirrorName(thread.id),file=path.join(folder,name);writeJson(file,thread);this.mirrorDirty.delete(thread.id);this.mirrorRecord(name,this.mirrorDigest(thread.id),fs.statSync(file));}
        this.mirrorPrune(!this.mirrorActive);const index=path.join(this.root,'sessions-index.json');fs.writeFileSync(index+'.tmp',JSON.stringify(this.loadMirrorIndex()));fs.renameSync(index+'.tmp',index);
      }
    }catch{this.warning='数据库已保存，但独立会话副本写入失败，请检查磁盘空间。';}
    this.db.close();
  }
}
module.exports={DatabaseStore};
