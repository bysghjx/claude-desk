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
  assert.match(html,/已编辑 1 个文件/);assert.match(html,/data-review-file="src\/a.js"/);
  assert.doesNotMatch(html,/data-undo-turn|changes-more/,'no snapshot, no undo; three files or fewer, nothing folded');
  const many=[1,2,3,4,5].map(i=>({path:`dir/f${i}.js`,added:i,removed:0}));
  const card=worklog.changesHtml(many,escape,{turnId:'t1',undo:'ready'});
  assert.match(card,/data-undo-turn="t1">撤销/);assert.match(card,/\+15/);
  assert.match(card,/<span class="change-dir">dir\/<\/span><span class="change-name">f1.js<\/span>/);
  assert.match(card,/<details class="changes-more"><summary><span class="more-closed">再显示 2 个文件/);
  const undone=worklog.changesHtml(many,escape,{turnId:'t1',undo:'undone',disabled:true});
  assert.match(undone,/已撤销 5 个文件的改动/);assert.match(undone,/data-redo="1" disabled/);
  assert.equal(worklog.changesHtml([],escape),'');
});
test('compact step summaries hide parameters while expanded details remain escaped',async()=>{
  const worklog=await load();
  const parts=worklog.stepParts({id:'x',name:'Bash',input:{command:'<img src=x onerror=alert(1)>'},output:'<script>bad()</script>',status:'running'},{escape,cwd:''});
  assert.equal(parts.className,'step step-command running');
  for(const html of [parts.summary,parts.body]){assert.doesNotMatch(html,/<img src=x|<script>/);}
  assert.doesNotMatch(parts.summary,/img src|step-target/);assert.match(parts.summary,/正在运行命令/);assert.match(parts.summary,/运行中/);
  assert.match(parts.body,/&lt;img src=x/);assert.match(parts.body,/&lt;script&gt;bad/);
  const edit=worklog.stepParts({id:'e',name:'Edit',input:{file_path:'C:\\repo\\a.js',old_string:'a',new_string:'b'},status:'done'},{escape,cwd:'C:\\repo'});
  assert.match(edit.summary,/编辑了文件/);assert.doesNotMatch(edit.summary,/a\.js|\+1/);
  assert.match(edit.body,/a\.js/);assert.match(edit.body,/\+1/);assert.match(edit.body,/diff-add/);
  const image=worklog.stepParts({name:'view_image',input:{path:'private-image.png'},status:'done'},{escape,cwd:''});
  assert.match(image.summary,/已查看 1 张图像/);assert.doesNotMatch(image.summary,/private-image/);assert.match(image.body,/private-image/);
  const failed=worklog.stepParts({name:'Bash',input:{command:'npm test'},status:'error',output:'failure details'},{escape,cwd:''});
  assert.match(failed.summary,/失败/);assert.doesNotMatch(failed.summary,/运行了命令/);assert.match(failed.body,/npm test/);assert.match(failed.body,/failure details/);
});
test('插话 cuts the turn: what Claude wrote back before its next step shows under it, not in the steps',async()=>{
  const worklog=await load();
  const turn={steers:[{id:'s1',text:'use tabs',status:'delivered',deliveredAt:5},{id:'s2',text:'later',status:'pending'}],tools:[{id:'x',name:'Read',input:{}},{id:'y',name:'Edit',input:{}}],
    items:[{type:'tool',id:'x'},{type:'steer',id:'s1'},{type:'thinking',text:'hm'},{type:'text',text:'OK, tabs.'},{type:'tool',id:'y'},{type:'text',text:'final'},{type:'steer',id:'gone'}]};
  const {parts,final,pending}=worklog.turnParts(turn);
  assert.equal(parts.length,2);assert.equal(parts[0].steer,null);assert.deepEqual(parts[0].work.map(i=>i.type),['tool']);
  assert.equal(parts[1].steer.text,'use tabs');assert.equal(parts[1].reply,'OK, tabs.');assert.deepEqual(parts[1].work.map(i=>i.type),['thinking','tool']);
  assert.equal(final,'final');assert.deepEqual(pending.map(s=>s.id),['s2']);
  const split=worklog.splitTurn(turn);
  assert.deepEqual(split.work.map(i=>i.type),['tool','steer','text','thinking','tool']);assert.equal(split.work[1].steer.text,'use tabs');
  const short=worklog.turnParts({steers:[{id:'s1',text:'and?',status:'delivered'}],tools:[{id:'x',name:'Read',input:{}}],items:[{type:'tool',id:'x'},{type:'steer',id:'s1'},{type:'text',text:'answer'}]});
  assert.equal(short.parts[1].reply,'');assert.equal(short.final,'answer','with no step after it the reply is the final answer');
});
test('runs of one kind of step fold into one row; thinking after the run stays outside',async()=>{
  const worklog=await load();
  const bash=(id,status='done')=>({type:'tool',id,tool:{id,name:'Bash',status,input:{command:'echo '+id}}});
  const read=(id,file)=>({type:'tool',id,tool:{id,name:'Read',status:'done',input:{file_path:file}}});
  const work=[bash('a'),{type:'thinking',text:'t1'},bash('b'),{type:'thinking',text:'t2'},bash('c'),{type:'thinking',text:'t3'},read('r1','x.js'),read('r2','x.js'),read('r3','y.js'),bash('d')];
  const groups=worklog.groupSteps(work);
  assert.deepEqual(groups.map(g=>g.indices?g.kind+':'+g.indices.join(','):String(g.index)),['command:0,1,2,3,4','5','read:6,7,8','9']);
  assert.match(worklog.groupSummaryHtml(groups[0]),/运行了 3 个命令/);
  assert.match(worklog.groupSummaryHtml(groups[2]),/读取了 2 个文件/,'files are counted once');
  const live=worklog.groupSteps([bash('a'),bash('b','running')]);
  assert.match(worklog.groupSummaryHtml(live[0]),/正在运行命令 · 已 2 步/);
});
