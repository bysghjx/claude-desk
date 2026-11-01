const {test}=require('node:test');const assert=require('node:assert/strict');const os=require('node:os');
const {Terminals}=require('../terminal.cjs');

function fakePty(){
  const listeners={data:[],exit:[]},calls={writes:[],resizes:[],killed:false};
  return{calls,emit:(name,value)=>listeners[name].forEach(fn=>fn(value)),pty:{onData:fn=>listeners.data.push(fn),onExit:fn=>listeners.exit.push(fn),write:d=>calls.writes.push(d),resize:(c,r)=>calls.resizes.push([c,r]),kill:()=>{calls.killed=true;}}};
}

test('output is batched per frame and exit is reported once', async()=>{
  const fake=fakePty(),events=[];let spawned;
  const terms=new Terminals({send:e=>events.push(e),spawn:(file,args,options)=>{spawned={file,args,options};return fake.pty;}});
  const {id,cwd}=terms.open(os.tmpdir(),3,1);
  assert.equal(cwd,os.tmpdir());
  assert.deepEqual([spawned.options.cols,spawned.options.rows],[20,5],'sizes are clamped');
  assert.equal(spawned.options.env.ELECTRON_RUN_AS_NODE,undefined);
  fake.emit('data','a');fake.emit('data','b');
  assert.equal(events.length,0);
  await new Promise(r=>setTimeout(r,40));
  assert.deepEqual(events,[{type:'data',id,data:'ab'}]);
  fake.emit('data','tail');fake.emit('exit',{exitCode:0});
  assert.deepEqual(events.slice(1),[{type:'data',id,data:'tail'},{type:'exit',id,code:0}],'pending output is flushed before exit');
  assert.equal(terms.list.size,0);
});

test('write, resize and close reach only live shells', ()=>{
  const fake=fakePty();const terms=new Terminals({send:()=>{},spawn:()=>fake.pty});
  const {id}=terms.open(os.tmpdir());
  terms.write(id,'dir\r');terms.write(id,42);terms.write('missing','x');
  terms.resize(id,120,40);
  assert.deepEqual(fake.calls.writes,['dir\r']);assert.deepEqual(fake.calls.resizes,[[120,40]]);
  assert.equal(terms.close(id),true);assert.equal(fake.calls.killed,true);assert.equal(terms.close(id),false);
  assert.throws(()=>terms.open(os.tmpdir()+'/does-not-exist-xyz'),/不存在/);
});
