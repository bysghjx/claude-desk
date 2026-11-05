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
test('large turns use bounded rows, changed turns alone are rewritten, and export/mirrors remain ordinary JSON',()=>{
  const root=fixture(),store=new DatabaseStore(root),text='中😀\\\n'.repeat(100000);
  store.state.threads.push({id:'a',title:'large',turns:[{id:'one',user:'question',answer:text,items:[{type:'text',text}],tools:[]},{id:'two',user:'other',answer:'same',tools:[]}]});store.save();
  assert.ok(store.db.prepare("SELECT count(*) n FROM records WHERE kind='turn' AND id='one'").get().n>1);
  assert.ok(store.db.prepare('SELECT max(length(CAST(body AS BLOB))) n FROM records').get().n<1024*1024);
  store.db.exec("CREATE TRIGGER unchanged_turn BEFORE DELETE ON records WHEN OLD.kind='turn' AND OLD.id='two' BEGIN SELECT RAISE(ABORT,'unchanged record rewritten'); END;");
  store.state.threads[0].turns[0].answer+='changed';store.save();
  const out=path.join(root,'export.json');store.export(out);assert.deepEqual(JSON.parse(fs.readFileSync(out,'utf8')),store.state);
  const mirror=path.join(root,'sessions',fs.readdirSync(path.join(root,'sessions'))[0]);assert.deepEqual(JSON.parse(fs.readFileSync(mirror,'utf8')),store.state.threads[0]);
  store.close();const reopened=new DatabaseStore(root);assert.equal(reopened.state.threads[0].turns[0].answer,text+'changed');assert.equal(reopened.state.threads[0].turns[1].id,'two');reopened.close();
});
test('missing record chunks fail closed and stale mirrors are repaired on restart',()=>{
  const root=fixture(),store=new DatabaseStore(root);store.state.threads.push({id:'a',turns:[{id:'one',answer:'x'.repeat(400000)}]});store.save();
  const mirror=path.join(root,'sessions',fs.readdirSync(path.join(root,'sessions'))[0]);fs.writeFileSync(mirror,'stale');store.close();
  const reopened=new DatabaseStore(root);assert.equal(JSON.parse(fs.readFileSync(mirror,'utf8')).turns[0].answer.length,400000);
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
