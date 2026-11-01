const {test}=require('node:test');const assert=require('node:assert/strict');
const load=()=>import('../ui/src/views/approval.mjs');

test('questions render as clickable options with an "other" choice', async()=>{
  const {approvalHtml}=await load();
  const html=approvalHtml({id:'r',name:'AskUserQuestion',input:{questions:[{header:'颜色',question:'选哪个<颜色>？',options:[{label:'红',description:'暖色'},{label:'蓝'}]}]}});
  assert.match(html,/Claude 有问题想问你/);
  assert.match(html,/<span class="question-header">颜色<\/span>选哪个&lt;颜色&gt;？/);
  assert.equal((html.match(/class="choice"/g)||[]).length,2);
  assert.match(html,/choice-other/);
  assert.match(html,/点选项直接回答/,'one single-choice question answers on click');
  assert.match(html,/data-approve="yes" hidden/);
});

test('several or multi-select questions need an explicit submit; no options means free text', async()=>{
  const {approvalHtml}=await load();
  const html=approvalHtml({id:'r',name:'AskUserQuestion',input:{questions:[{question:'哪些？',multiSelect:true,options:[{label:'A'},{label:'B'}]},{question:'备注？'}]}},'reviewer');
  assert.match(html,/<span class="approval-source">reviewer<\/span>/);
  assert.match(html,/可多选/);
  assert.match(html,/data-multi="true"/);
  assert.doesNotMatch(html,/data-approve="yes" hidden/);
  assert.match(html,/data-choice="other" aria-pressed="true"/,'free-text question starts with the input shown');
});

test('plans render as markdown with two ways to start and a feedback box', async()=>{
  const {approvalHtml}=await load();
  const html=approvalHtml({id:'r',name:'ExitPlanMode',input:{plan:'# 步骤\n1. 改接口'}},'',text=>`<md>${text}</md>`);
  assert.match(html,/计划等待你确认/);
  assert.match(html,/<md># 步骤\n1. 改接口<\/md>/);
  assert.match(html,/data-plan-mode="default"/);
  assert.match(html,/data-plan-mode="acceptEdits"/);
  assert.match(html,/plan-feedback/);
});

test('tool approvals summarise commands and file edits', async()=>{
  const {approvalHtml}=await load();
  const bash=approvalHtml({id:'r',name:'Bash',reason:'运行测试',input:{command:'npm test && echo "<ok>"',description:'跑测试'}});
  assert.match(bash,/<pre class="approval-command">npm test &amp;&amp; echo &quot;&lt;ok&gt;&quot;<\/pre>/);
  assert.match(bash,/跑测试/);
  const edit=approvalHtml({id:'r',name:'Edit',reason:'',input:{file_path:'src/a.js',old_string:'x',new_string:'y'}});
  assert.match(edit,/修改文件 <code>src\/a.js<\/code>/);
  assert.match(edit,/查看完整参数/);
});
