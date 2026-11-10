const {test}=require('node:test');const assert=require('node:assert/strict');
const sample=`Checking files.
<invoke name="Bash">
<parameter name="command">git status</parameter>
</invoke>
working tree clean
<invoke name="Read">
<parameter name="file_path">Launcher.xaml</parameter>
</invoke>
<Button Content="Ready"/>
<script>alert(1)</script>`;

test('unrecorded textual tool calls retain their raw content and do not claim completion',async()=>{
  const {hasUnexecutedToolText}=await import('../ui/src/lib/worklog.mjs');
  const {replyHtml,completionLabel}=await import('../ui/src/views/turn.mjs');
  const turn={status:'done',answer:sample,tools:[]};
  assert.equal(hasUnexecutedToolText(turn),true);
  const html=replyHtml(sample,hasUnexecutedToolText(turn));
  assert.match(html,/没有对应的工具执行记录/);
  assert.match(html,/&lt;invoke name=&quot;Bash&quot;&gt;/);
  assert.match(html,/&lt;Button Content=&quot;Ready&quot;\//);
  assert.doesNotMatch(html,/<invoke|<Button|<script>/);
  assert.equal(completionLabel(turn),'! 工具调用异常');
  assert.equal(completionLabel({...turn,status:'error',toolProtocolAborted:true}),'! 工具调用异常，已中止');
});

test('recorded tools and quoted protocol documentation are not flagged',async()=>{
  const {hasUnexecutedToolText}=await import('../ui/src/lib/worklog.mjs');
  const {completionLabel}=await import('../ui/src/views/turn.mjs');
  assert.equal(hasUnexecutedToolText({answer:sample,tools:[{id:'real',name:'Bash'}]}),false);
  for(const fence of ['```','~~~~'])assert.equal(hasUnexecutedToolText({answer:fence+'xml\n'+sample+'\n'+fence,tools:[]}),false);
  assert.equal(hasUnexecutedToolText({answer:sample.split('\n').map(line=>'> '+line).join('\n')}),false);
  assert.equal(hasUnexecutedToolText({answer:'Use `<invoke name="Bash">` and `<invoke name="Read">`.'}),false);
  assert.equal(hasUnexecutedToolText({answer:'A normal response without tools.'}),false);
  assert.equal(completionLabel({status:'done',answer:'Done.'}),'✓ 已完成');
});
