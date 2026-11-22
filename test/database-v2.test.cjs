const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {DatabaseStore}=require('../database.cjs');
const scratch=path.resolve(__dirname,'../../../work/database-tests');fs.mkdirSync(scratch,{recursive:true});
const fixture=()=>fs.mkdtempSync(path.join(scratch,'v2-'));
function legacy(root,{fail=false}={}){
  const db=new DatabaseSync(path.join(root,'workspace.sqlite'));
  db.exec("PRAGMA journal_mode=WAL;CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE threads(id TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE usage(id TEXT PRIMARY KEY,body TEXT NOT NULL);PRAGMA user_version=1;");
  const meta={projects:[{id:'p',path:root}],settings:{model:'test'},ui:{drafts:{a:{text:'draft'}}}};
  for(const [key,value]of Object.entries({state:JSON.stringify(meta),dataset:'dataset-1',revision:'7'}))db.prepare('INSERT INTO meta VALUES(?,?)').run(key,value);
  const thread={id:'a',title:'旧会话',projectId:'p',turns:[{id:'t1',user:'hello',answer:'中😀',tools:[]},{id:'t2',user:'next',answer:'done',tools:[]}]};
  db.prepare('INSERT INTO threads VALUES(?,?)').run('a',JSON.stringify(thread));db.prepare('INSERT INTO usage VALUES(?,?)').run('usage-1',JSON.stringify({id:'usage-1',cost:3}));
  if(fail)db.exec("CREATE TRIGGER fail_migration BEFORE UPDATE ON threads BEGIN SELECT RAISE(ABORT,'migration failed'); END;");
  return{db,thread};
}
test('v1 migration backs up committed WAL, retains identities and drafts, and runs only once',()=>{
  const root=fixture(),old=legacy(root);const store=new DatabaseStore(root);old.db.close();
  assert.equal(store.datasetId,'dataset-1');assert.deepEqual(store.state.threads[0].turns,old.thread.turns);assert.equal(store.state.ui.drafts.a.text,'draft');assert.equal(store.state.usageLog[0].cost,3);
  const backup=new DatabaseSync(store.migrationBackup,{readOnly:true});assert.equal(backup.prepare('PRAGMA user_version').get().user_version,1);assert.deepEqual(JSON.parse(backup.prepare('SELECT body FROM threads').get().body),old.thread);backup.close();
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,2);store.close();
  const again=new DatabaseStore(root);assert.equal(again.datasetId,'dataset-1');assert.equal(fs.readdirSync(root).filter(x=>x.startsWith('migration-v1-backup')).length,1);again.close();
});
test('failed migration rolls back schema and old records and retains a readable backup',()=>{
  const root=fixture(),old=legacy(root,{fail:true});old.db.close();assert.throws(()=>new DatabaseStore(root),/migration failed/);
  const db=new DatabaseSync(path.join(root,'workspace.sqlite'));assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);assert.deepEqual(JSON.parse(db.prepare('SELECT body FROM threads').get().body),old.thread);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='records'").get().n,0);db.close();assert.ok(fs.readdirSync(root).some(x=>x.startsWith('migration-v1-backup')));
});
test('large turns use bounded rows, changed turns alone are rewritten, and export/mirrors remain ordinary JSON',async()=>{
  const root=fixture(),store=new DatabaseStore(root),text='中😀\\\n'.repeat(100000);
  store.state.threads.push({id:'a',title:'large',turns:[{id:'one',user:'question',answer:text,items:[{type:'text',text}],tools:[]},{id:'two',user:'other',answer:'same',tools:[]}]});store.save();
  assert.ok(store.db.prepare("SELECT count(*) n FROM records WHERE kind='turn' AND id='one'").get().n>1);
  assert.ok(store.db.prepare('SELECT max(length(CAST(body AS BLOB))) n FROM records').get().n<1024*1024);
  store.db.exec("CREATE TRIGGER unchanged_turn BEFORE DELETE ON records WHEN OLD.kind='turn' AND OLD.id='two' BEGIN SELECT RAISE(ABORT,'unchanged record rewritten'); END;");
  store.state.threads[0].turns[0].answer+='changed';store.save();
  await store.flush();const out=path.join(root,'export.json');store.export(out);assert.deepEqual(JSON.parse(fs.readFileSync(out,'utf8')),store.state);
  const mirror=path.join(root,'sessions',fs.readdirSync(path.join(root,'sessions'))[0]);assert.deepEqual(JSON.parse(fs.readFileSync(mirror,'utf8')),store.state.threads[0]);
  store.close();const reopened=new DatabaseStore(root);assert.equal(reopened.state.threads[0].turns[0].answer,text+'changed');assert.equal(reopened.state.threads[0].turns[1].id,'two');reopened.close();
});
test('missing record chunks fail closed and stale mirrors are repaired on restart',async()=>{
  const root=fixture(),store=new DatabaseStore(root);store.state.threads.push({id:'a',turns:[{id:'one',answer:'x'.repeat(400000)}]});store.save();await store.flush();
  const mirror=path.join(root,'sessions',fs.readdirSync(path.join(root,'sessions'))[0]);fs.writeFileSync(mirror,'stale');store.close();
  const reopened=new DatabaseStore(root);await reopened.flush();assert.equal(JSON.parse(fs.readFileSync(mirror,'utf8')).turns[0].answer.length,400000);
  reopened.db.exec("DELETE FROM records WHERE kind='turn' AND part=0");reopened.close();assert.throws(()=>new DatabaseStore(root),/缺少分块/);
});
test('saveState writes drafts without touching turns, and unsaved turn changes still reach the next save',()=>{
  const root=fixture(),store=new DatabaseStore(root);store.state.projects.push({id:'p',path:root});store.state.threads.push({id:'a',projectId:'p',turns:[{id:'t1',user:'hi',answer:'old',tools:[]}]});store.save();
  const turnRows=()=>store.db.prepare("SELECT rowid,body FROM records WHERE kind='turn' ORDER BY rowid").all();const before=turnRows();
  store.state.ui.drafts={a:{text:'草稿'}};store.state.threads[0].turns[0].answer='new';store.saveState();
  assert.deepEqual(turnRows(),before);
  let again=new DatabaseStore(root);assert.equal(again.state.ui.drafts.a.text,'草稿');assert.equal(again.state.threads[0].turns[0].answer,'old');again.close();
  store.save();again=new DatabaseStore(root);assert.equal(again.state.threads[0].turns[0].answer,'new');assert.equal(again.state.ui.drafts.a.text,'草稿');
  again.state.ui.drafts={};again.saveState();assert.throws(()=>store.saveState(),/另一进程已更新/);again.close();store.close();
});
test('light saves write only the touched threads and leave the JSON copies to the next full save',async()=>{
  const root=fixture(),store=new DatabaseStore(root);
  store.state.threads.push({id:'a',turns:[{id:'a1',answer:'one',tools:[]}]},{id:'b',turns:[{id:'b1',answer:'two',tools:[]}]});store.save();await store.flush();
  const copy=id=>{const folder=path.join(root,'sessions');return fs.readdirSync(folder).map(f=>fs.readFileSync(path.join(folder,f),'utf8')).find(text=>text.includes(`"id":"${id}"`));};
  store.state.threads[0].turns[0].answer='streamed';store.state.threads[1].turns[0].answer='not touched';
  store.state.threads.unshift({id:'c',turns:[{id:'c1',answer:'new',tools:[]}]});
  store.save(false,{durable:false,touched:new Set(['a'])});await store.flush();
  assert.match(copy('a'),/"one"/,'the JSON copy is not rewritten by a light save');
  let again=new DatabaseStore(root);const read=s=>Object.fromEntries(s.state.threads.map(t=>[t.id,t.turns[0].answer]));
  assert.deepEqual(read(again),{c:'new',a:'streamed',b:'two'},'a new thread is always written; an untouched one waits');
  assert.deepEqual(again.state.threads.map(t=>t.id),['c','a','b'],'order follows the list');
  again.close();
  store.save();await store.flush();again=new DatabaseStore(root);await again.flush();
  assert.deepEqual(read(again),{c:'new',a:'streamed',b:'not touched'});again.close();
  assert.match(copy('a'),/"streamed"/);
  store.state.threads[1].turns[0].answer='late';store.save(false,{durable:false,touched:new Set(['a'])});store.close();
  assert.match(copy('a'),/"late"/,'closing writes the pending copies');
});
test('a restart rewrites only the copies that are missing, edited or behind the database',async()=>{
  const root=fixture(),store=new DatabaseStore(root),folder=path.join(root,'sessions');
  store.state.threads.push({id:'a',turns:[{id:'a1',answer:'one',tools:[]}]},{id:'b',turns:[{id:'b1',answer:'two',tools:[]}]},{id:'c',turns:[{id:'c1',answer:'three',tools:[]}]});store.save();await store.flush();store.close();
  const writes=[],open=fs.promises.open,openSync=fs.openSync,record=file=>{if(/[a-f0-9]{64}\.json\./.test(path.basename(String(file))))writes.push(path.basename(String(file)).slice(0,64));};
  fs.promises.open=function(file,...rest){record(file);return open.call(this,file,...rest);};fs.openSync=function(file,...rest){record(file);return openSync.call(this,file,...rest);};
  const name=id=>require('node:crypto').createHash('sha256').update(id).digest('hex');
  try{
    let again=new DatabaseStore(root);await again.flush();assert.deepEqual(writes,[],'fresh copies are left alone');
    // A light save defers the copy; a crash (no close) leaves it behind the database.
    again.state.threads[0].turns[0].answer='streamed';again.save(false,{durable:false,touched:new Set(['a'])});again.db.close();
    fs.rmSync(path.join(folder,name('c')+'.json'));
    again=new DatabaseStore(root);await again.flush();assert.deepEqual(writes.sort(),[name('a'),name('c')].sort());
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder,name('a')+'.json'),'utf8')).turns[0].answer,'streamed');
    again.close();writes.length=0;again=new DatabaseStore(root);await again.flush();assert.deepEqual(writes,[]);again.close();
  }finally{Object.assign(fs,{openSync});fs.promises.open=open;}
  assert.deepEqual(fs.readdirSync(folder).sort(),['a','b','c'].map(id=>name(id)+'.json').sort());
});
test('a full save returns before the JSON copy is written, and close writes what is still queued',async()=>{
  const root=fixture(),store=new DatabaseStore(root),text='x'.repeat(2*1024*1024);
  store.state.threads.push({id:'a',turns:[{id:'a1',answer:text,tools:[]}]});store.save();await store.flush();
  const file=path.join(root,'sessions',fs.readdirSync(path.join(root,'sessions'))[0]);
  store.state.threads[0].turns[0].answer=text+'changed';store.save();
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).turns[0].answer,text,'not written inside save()');
  await store.flush();assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).turns[0].answer,text+'changed');
  store.state.threads[0].turns[0].answer='last';store.save();store.close();
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).turns[0].answer,'last');
  const reopened=new DatabaseStore(root);assert.equal(reopened.staleMirrors().size,0);reopened.close();
});
