const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {StorageUsage,sizeOf}=require('../storage-usage.cjs');
const scratch=path.resolve(__dirname,'../../../work/storage-tests');fs.mkdirSync(scratch,{recursive:true});
function setup(){
  const root=fs.mkdtempSync(path.join(scratch,'usage-')),put=(rel,bytes=10)=>{const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'x'.repeat(bytes));return file;};
  put('workspace.sqlite',100);put('migration-backup.json',5);
  const kept=put('attachments/kept.png',20);put('attachments/orphan.png',30);
  put('checkpoints/project.git/HEAD',7);put('checkpoints/gone.git/HEAD',9);
  const chat=path.dirname(put('chats/live/.keep',1));put('chats/deleted/.keep',2);
  const wt=name=>path.dirname(put(`worktrees/${name}/file.txt`,4));
  const active=wt('active'),archived=wt('archived'),dirty=wt('dirty'),orphan=wt('orphan');
  const threads=[
    {id:'a',cwd:'C:\\proj',worktree:{path:active},turns:[{images:[{path:kept}]}]},
    {id:'b',cwd:chat,archived:true,title:'Archived clean',worktree:{path:archived},turns:[]},
    {id:'c',cwd:'C:\\proj',archived:true,title:'Archived dirty',worktree:{path:dirty},turns:[]}
  ];
  const removed=[];
  const usage=new StorageUsage({dataRoot:root,state:()=>({threads}),checkpointKey:cwd=>cwd==='C:\\proj'?'project':'chat-'+path.basename(cwd),
    worktreeStatus:async wt=>({exists:true,dirty:wt.path===dirty?2:0}),removeWorktree:async t=>{removed.push(t.id);fs.rmSync(t.worktree.path,{recursive:true});}});
  return{root,usage,removed,paths:{kept,active,archived,dirty,orphan}};
}
test('storage scan sizes each kind of data and lists only leftovers as cleanable',async()=>{
  const {usage}=setup(),scan=await usage.scan(),group=key=>scan.groups.find(g=>g.key===key);
  assert.equal(group('database').size,100);assert.equal(group('backups').size,5);
  assert.deepEqual(group('attachments').clean,{count:1,size:30,items:['orphan.png']});
  assert.deepEqual(group('checkpoints').clean.items,['gone.git']);
  assert.deepEqual(group('chats').clean.items,['deleted']);
  assert.deepEqual(group('worktrees').clean.items.sort(),['Archived clean','orphan']);
  assert.equal(scan.total,scan.groups.reduce((n,g)=>n+g.size,0));assert.ok(scan.disk===null||scan.disk.free>0);
});
test('cleaning removes leftovers only, through the worktree remover for conversations',async()=>{
  const {usage,removed,paths}=setup();
  assert.deepEqual(await usage.clean('attachments'),{removed:1,failed:[]});assert.ok(fs.existsSync(paths.kept));
  assert.deepEqual(await usage.clean('worktrees'),{removed:2,failed:[]});assert.deepEqual(removed,['b']);
  assert.ok(fs.existsSync(paths.active));assert.ok(fs.existsSync(paths.dirty));assert.ok(!fs.existsSync(paths.archived));assert.ok(!fs.existsSync(paths.orphan));
  await assert.rejects(()=>usage.clean('database'),/没有可清理/);
  assert.equal((await usage.scan()).groups.find(g=>g.key==='worktrees').clean.count,0);
});
test('sizeOf counts files recursively and tolerates missing paths',async()=>{
  const {root}=setup();assert.deepEqual(await sizeOf(path.join(root,'missing')),{size:0,count:0});assert.equal((await sizeOf(path.join(root,'worktrees'))).count,4);
});
