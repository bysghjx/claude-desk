const {test}=require('node:test');const assert=require('node:assert/strict');
const {PullRequests,summarize,checkState}=require('../pr.cjs');
const ui=()=>import('../ui/src/lib/pr.mjs');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const view={number:12,title:'Fix <import>',url:'https://github.com/o/r/pull/12',state:'OPEN',isDraft:false,headRefName:'fix',baseRefName:'main',mergeable:'MERGEABLE',reviewDecision:'REVIEW_REQUIRED',statusCheckRollup:[
  {__typename:'CheckRun',name:'build',status:'COMPLETED',conclusion:'SUCCESS',detailsUrl:'https://github.com/o/r/runs/1'},
  {__typename:'CheckRun',name:'test',status:'COMPLETED',conclusion:'FAILURE',detailsUrl:'https://github.com/o/r/runs/2'},
  {__typename:'CheckRun',name:'lint',status:'IN_PROGRESS',conclusion:''},
  {__typename:'StatusContext',context:'ci/legacy',state:'ERROR',targetUrl:'https://ci.example/3'},
  {__typename:'CheckRun',name:'docs',status:'COMPLETED',conclusion:'SKIPPED'}]};
const fake=result=>{const calls=[];return{calls,prs:new PullRequests({exec:async(cwd,args)=>{calls.push([cwd,args]);return{stdout:'',stderr:'',...result};}})};};
test('check runs and commit statuses are counted as passed, failed or pending',()=>{
  assert.equal(checkState({status:'QUEUED'}),'pending');assert.equal(checkState({status:'COMPLETED',conclusion:'TIMED_OUT'}),'failed');assert.equal(checkState({__typename:'StatusContext',state:'PENDING'}),'pending');
  const s=summarize(view.statusCheckRollup);assert.deepEqual([s.total,s.passed,s.failed,s.pending],[5,2,2,1]);assert.deepEqual(s.failing.map(f=>f.name),['test','ci/legacy']);
});
test('gh pr view is read for the folder and summarized',async()=>{
  const {prs,calls}=fake({stdout:JSON.stringify(view)});const r=await prs.status('C:\\proj');
  assert.equal(calls[0][0],'C:\\proj');assert.deepEqual(calls[0][1].slice(0,3),['pr','view','--json']);
  assert.equal(r.available,true);assert.equal(r.pr.number,12);assert.equal(r.pr.review,'REVIEW_REQUIRED');assert.equal(r.pr.checks.failed,2);
});
test('missing gh, no login, no remote and no PR each get a plain answer',async()=>{
  assert.match((await fake({error:Object.assign(Error('spawn gh ENOENT'),{code:'ENOENT'})}).prs.status('x')).reason,/没有安装 GitHub CLI/);
  assert.match((await fake({error:Error('exit 4'),stderr:'To get started with GitHub CLI, please run:  gh auth login'}).prs.status('x')).reason,/还没有登录/);
  assert.match((await fake({error:Error('exit 1'),stderr:'none of the git remotes configured for this repository point to a known GitHub host'}).prs.status('x')).reason,/没有 GitHub 远程仓库/);
  assert.deepEqual(await fake({error:Error('exit 1'),stderr:'no pull requests found for branch "main"'}).prs.status('x'),{available:true,pr:null});
});
test('PR card shows state, checks and failing links, and offers a fix only when idle',async()=>{
  const {prHtml,fixPrompt}=await ui();const {prs}=fake({stdout:JSON.stringify({...view,mergeable:'CONFLICTING'})});const status=await prs.status('x');
  const html=prHtml(status,{escape,idle:true});
  assert.match(html,/#12 Fix &lt;import&gt;/);assert.match(html,/等待审查/);assert.match(html,/2 失败/);assert.match(html,/1 进行中/);assert.match(html,/data-pr-open="https:\/\/github.com\/o\/r\/runs\/2"/);assert.match(html,/有合并冲突/);assert.match(html,/data-pr-fix >/);
  assert.match(prHtml(status,{escape,idle:false}),/data-pr-fix disabled/);
  assert.match(prHtml({available:true,pr:null},{escape}),/还没有拉取请求/);assert.match(prHtml({available:false,reason:'<x>'},{escape}),/&lt;x&gt;/);
  const prompt=fixPrompt(status.pr);assert.match(prompt,/test、ci\/legacy/);assert.match(prompt,/合并冲突/);assert.match(prompt,/推送/);
  assert.doesNotMatch(prHtml({available:true,pr:{...status.pr,state:'MERGED'}},{escape,idle:true}),/data-pr-fix/);
});
