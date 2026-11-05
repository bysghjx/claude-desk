const {test}=require('node:test');const assert=require('node:assert/strict');
const {contextItems}=require('../context-menu.cjs');
const labels=items=>items.map(i=>i.type==='separator'?'—':i.label);

test('text fields get editing commands, with spelling suggestions first',()=>{
  const items=contextItems({isEditable:true,editFlags:{canUndo:true,canRedo:false,canCut:true,canCopy:true,canPaste:true},dictionarySuggestions:['hello']});
  assert.deepEqual(labels(items),['hello','—','撤销','重做','—','剪切','复制','粘贴','—','全选']);
  assert.equal(items.find(i=>i.label==='重做').enabled,false);assert.equal(items[0].action,'replace');
});

test('selected text can be copied or quoted; links and images get their own items',()=>{
  assert.deepEqual(labels(contextItems({selectionText:'abc'},{canQuote:true})),['复制','引用到输入框']);
  assert.deepEqual(labels(contextItems({selectionText:'abc'})),['复制']);
  assert.deepEqual(labels(contextItems({linkURL:'https://x.dev'})),['复制链接地址','在浏览器中打开']);
  assert.deepEqual(labels(contextItems({linkURL:'javascript:alert(1)'})),['全选'],'only web links');
  assert.deepEqual(labels(contextItems({mediaType:'image',srcURL:'data:image/png;base64,x'})),['复制图片']);
  assert.deepEqual(labels(contextItems({})),['全选']);
});
