const {test}=require('node:test');const assert=require('node:assert/strict');
const load=()=>import('../ui/src/lib/worklog.mjs');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

test('line diff counts only changed lines and keeps unchanged context',async()=>{
  const worklog=await load();
  const diff=worklog.lineDiff('a\nb\nc\nd','a\nB\nc\nd\ne');
  assert.equal(diff.added,2);assert.equal(diff.removed,1);
  assert.deepEqual(diff.lines.map(l=>l.type+l.text),[' a','-b','+B',' c',' d','+e']);
  assert.equal(worklog.lineDiff('','one\ntwo\n').added,2);
  const big=worklog.lineDiff(Array.from({length:900},(_,i)=>'x'+i).join('\n'),Array.from({length:900},(_,i)=>'y'+i).join('\n'));
  assert.equal(big.added,900);assert.equal(big.removed,900);
});
test('Codex patches and commands map to Codex-style rows',async()=>{
  const worklog=await load();
  const patch='*** Begin Patch\n*** Update File: src/a.js\n@@\n-old\n+new\n+more\n*** Add File: b.md\n+hello\n*** End Patch';
  const view=worklog.toolView({name:'apply_patch',input:{text:patch}});
  assert.equal(view.kind,'edit');assert.deepEqual(view.files.map(f=>[f.path,f.added,f.removed]),[['src/a.js',2,1],['b.md',1,0]]);
  assert.equal(worklog.toolView({name:'exec',input:{text:'text(await tools.exec_command({cmd:"npm test -- --grep \\"x\\"",yield_time_ms:1000}))'}}).target,'npm test -- --grep "x"');
  assert.equal(worklog.toolView({name:'exec',input:{text:'*** Begin Patch\n*** Update File: c.js\n+x\n*** End Patch'}}).files[0].path,'c.js');
  assert.equal(worklog.toolView({name:'Bash',input:{command:'ls'}}).verb,'运行');
  assert.equal(worklog.toolView({name:'mcp__github__create_issue',input:{}}).verb,'调用 github');
  assert.deepEqual(worklog.toolView({name:'TodoWrite',input:{todos:[{content:'a',status:'completed'},{content:'b',status:'in_progress'}]}}).todos.map(t=>t.status),['done','active']);
});
test('a turn splits into ordered work and the final answer, with legacy turns supported',async()=>{
  const worklog=await load();
  const turn={id:'t',tools:[{id:'x',name:'Bash',input:{command:'ls'},status:'done'}],items:[{type:'thinking',text:'plan'},{type:'text',text:'checking'},{type:'tool',id:'x'},{type:'text',text:'final'},{type:'text',text:''}]};
  const split=worklog.splitTurn(turn);
  assert.deepEqual(split.work.map(i=>i.type),['thinking','text','tool']);assert.equal(split.final,'final');
  const legacy=worklog.splitTurn({thinking:'t',answer:'answer',tools:[{id:'y',name:'Read',input:{}}]});
  assert.deepEqual(legacy.work.map(i=>i.type),['thinking','tool']);assert.equal(legacy.final,'answer');
  assert.deepEqual(worklog.splitTurn({answer:'only text'}).work,[]);
});
test('change summary aggregates edits per project-relative file and skips failed tools',async()=>{
  const worklog=await load();
  const turn={tools:[
    {name:'Edit',status:'done',input:{file_path:'C:\\repo\\src\\a.js',old_string:'a',new_string:'b'}},
    {name:'Edit',status:'done',input:{file_path:'c:/repo/src/a.js',old_string:'x',new_string:'y\nz'}},
    {name:'Write',status:'error',input:{file_path:'C:\\repo\\bad.js',content:'x'}}]};
  const changes=worklog.fileChanges(turn,'C:\\repo');
  assert.deepEqual(changes,[{path:'src/a.js',added:3,removed:2}]);
  const html=worklog.changesHtml(changes,escape);
  assert.match(html,/1 个文件已更改/);assert.match(html,/data-review-file="src\/a.js"/);
  assert.equal(worklog.changesHtml([],escape),'');
});
test('step parts escape untrusted tool input and output',async()=>{
  const worklog=await load();
  const parts=worklog.stepParts({id:'x',name:'Bash',input:{command:'<img src=x onerror=alert(1)>'},output:'<script>bad()</script>',status:'running'},{escape,cwd:''});
  assert.equal(parts.className,'step step-command running');
  for(const html of [parts.summary,parts.body]){assert.doesNotMatch(html,/<img src=x|<script>/);}
  assert.match(parts.summary,/&lt;img src=x/);assert.match(parts.summary,/运行中/);
  const edit=worklog.stepParts({id:'e',name:'Edit',input:{file_path:'C:\\repo\\a.js',old_string:'a',new_string:'b'},status:'done'},{escape,cwd:'C:\\repo'});
  assert.match(edit.summary,/a\.js/);assert.match(edit.summary,/\+1/);assert.match(edit.body,/diff-add/);
});
