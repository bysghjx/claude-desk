const {test}=require('node:test');const assert=require('node:assert/strict');
const {DeskTray,trayItems}=require('../tray.cjs');

test('tray menu lists running conversations, newest first, and those waiting on you',()=>{
  const {items,tooltip,running}=trayItems([{id:'a',title:'旧任务',status:'tool',startedAt:1},{id:'b',title:'需要批准',status:'approval',startedAt:2},{id:'c',title:'完成',status:'done'}]);
  assert.equal(running,2);assert.equal(tooltip,'Claude Desk · 2 个任务运行中');
  assert.deepEqual(items.filter(i=>i.action==='thread').map(i=>[i.label,i.threadId]),[['⚠ 需要批准','b'],['旧任务','a']]);
  assert.ok(items.some(i=>i.label==='2 个任务运行中 · 1 个等你处理'&&i.enabled===false));
  assert.equal(items.at(-1).action,'quit');
  assert.ok(trayItems([]).items.some(i=>i.label==='没有运行中的任务'));
  assert.equal(trayItems(Array.from({length:9},(_,i)=>({id:String(i),title:'t',status:'tool'})),6).items.filter(i=>i.action==='thread').length,6);
});

test('tray rebuilds its menu only when it changes and routes clicks',()=>{
  const built=[],actions=[];
  class Tray{constructor(){this.handlers={};}on(e,f){this.handlers[e]=f;}setToolTip(t){this.tip=t;}setContextMenu(m){this.menu=m;}isDestroyed(){return false;}destroy(){}}
  const Menu={buildFromTemplate:template=>{built.push(template);return template;}};
  const tray=new DeskTray({Tray,Menu,icon:{},onAction:a=>actions.push(a)});
  const threads=[{id:'a',title:'x',status:'tool'}];
  tray.create(threads);tray.update(threads);assert.equal(built.length,1);
  built[0].find(i=>i.label==='x').click();tray.tray.handlers.click();
  assert.deepEqual(actions[0],{action:'thread',threadId:'a'});assert.equal(actions[1].action,'show');
  tray.update([]);assert.equal(built.length,2);assert.equal(tray.tray.tip,'Claude Desk');
});
