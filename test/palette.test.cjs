const {test}=require('node:test');const assert=require('node:assert/strict');
const load=()=>import('../ui/src/lib/palette.mjs');
const threads=[
  {id:'a',title:'修复登录页',projectId:'p1',updatedAt:3,turns:[{user:'登录按钮点了没反应',answer:'已修好 onClick 绑定'}]},
  {id:'b',title:'随便聊聊',projectId:null,updatedAt:5,turns:[{user:'今天天气怎么样',answer:'我无法查看天气'}]},
  {id:'c',title:'旧的归档会话',projectId:'p1',updatedAt:9,archived:true,turns:[]}
];
const projects=[{id:'p1',name:'web'}],actions=[{id:'new',label:'新聊天',shortcut:'Ctrl+N',keywords:'new chat'},{id:'set',label:'设置',keywords:'主题'}];

test('empty query shows actions and recent chats, newest first, without archived ones', async()=>{
  const {paletteSections}=await load();
  const s=paletteSections({threads,projects,actions});
  assert.deepEqual(s.map(x=>x.title),['快捷操作','最近聊天']);
  assert.deepEqual(s[1].items.map(i=>[i.id,i.meta]),[['b','对话'],['a','web']]);
});

test('typing filters actions by keywords, chats by title and searches conversation text', async()=>{
  const {paletteSections}=await load();
  assert.deepEqual(paletteSections({query:'主题',threads,projects,actions}).flatMap(s=>s.items.map(i=>i.id)),['set']);
  const text=paletteSections({query:'onclick',threads,projects,actions,tab:'text'});
  assert.equal(text[0].title,'对话内容');assert.equal(text[0].items[0].id,'a');assert.match(text[0].items[0].snippet,/onClick/);
  const archived=paletteSections({query:'归档',threads,projects,actions,tab:'chats'});
  assert.equal(archived[0].items[0].meta,'web · 已归档','archived chats are found by name');
  assert.deepEqual(paletteSections({query:'x',threads,projects,actions,tab:'text'}),[],'text search needs two characters');
});

test('files match by path and show their folder', async()=>{
  const {paletteSections}=await load();
  const s=paletteSections({query:'login',tab:'files',files:['src/pages/login.tsx','README.md']});
  assert.deepEqual(s[0].items.map(i=>[i.label,i.meta]),[['login.tsx','src/pages']]);
  assert.equal(paletteSections({tab:'files',files:['a.js']})[0].items.length,1,'the files tab lists files before typing');
});

test('snippets stay on one line around the match', async()=>{
  const {snippet}=await load();
  assert.equal(snippet('first line\nsecond KEY line','key',12),'…ond KEY line');
  assert.equal(snippet('nothing','key'),'');
});
