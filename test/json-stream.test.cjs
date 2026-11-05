const {test}=require('node:test');const assert=require('node:assert/strict');
const {jsonChunks,recordChunks,readRecord,historyTail}=require('../json-stream.cjs');
test('streamed JSON and bounded records round-trip escaped Unicode, empty containers and JSON values',()=>{
  const value={text:'中😀\\\n\r\t"\ud800'.repeat(15000),nil:null,empty:{},list:[undefined,NaN,false,{},[]],ignored:undefined,proto:JSON.parse('{"__proto__":{"safe":true}}')};
  const expected=JSON.parse(JSON.stringify(value));
  const json=[...jsonChunks(value)],records=[...recordChunks(value)];
  assert.deepEqual(JSON.parse(json.join('')),expected);assert.deepEqual(readRecord(records),expected);
  assert.ok(json.length>1&&records.length>1);assert.ok(records.every(x=>x.length<320*1024));
  assert.equal({}.safe,undefined);assert.throws(()=>readRecord(records.slice(0,-1)),/不完整/);
  const cycle={};cycle.self=cycle;assert.throws(()=>[...jsonChunks(cycle)],/circular/);assert.throws(()=>[...recordChunks(cycle)],/circular/);
});
test('context restoration keeps the exact previous tail budget without stringifying a history array or turn',()=>{
  const turns=Array.from({length:12},(_,i)=>({id:String(i),user:'question '+i,answer:'中😀'.repeat(15000),context:i?'context':undefined,tools:[{name:'Read',input:{path:'a'},output:'result'}],images:i?[{}]:[]}));
  const projected=turns.map(x=>({user:x.user,...(x.images.length?{images:`[附带 ${x.images.length} 张图片，图片本身未包含在历史中]`}:{}),context:x.context,answer:x.answer,tools:x.tools.map(y=>({name:y.name,input:y.input,output:y.output}))}));
  const expected=JSON.stringify(projected).slice(-120000),stringify=JSON.stringify;
  JSON.stringify=value=>{assert.ok(value===null||typeof value!=='object','whole objects must not be serialized on the JSON export path');return stringify(value);};
  try{assert.equal(historyTail(turns),expected);assert.equal(historyTail([]),'');}finally{JSON.stringify=stringify;}
});
