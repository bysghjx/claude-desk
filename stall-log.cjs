// Records main-process stalls (Windows marks the window 「未响应」) to a log file. The main
// thread ticks a shared heartbeat; a worker thread watches it. After 1 s without a tick
// the worker writes at once (the app may be killed before it recovers), names the IPC
// handler in progress, then pauses the main thread through the inspector to log its JS
// stack. A thread blocked in native code (sync fs, SQLite waiting for a lock) can only
// pause where JS runs next, so there the request name is what identifies the cause.
const fs=require('node:fs');const path=require('node:path');const {Worker}=require('node:worker_threads');
const LABEL_BYTES=120;
const stamp=()=>{const d=new Date(),p=(n,w=2)=>String(n).padStart(w,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())+'.'+p(d.getMilliseconds(),3);};
const WORKER_SCRIPT=`const stamp=${stamp};
const fs=require('node:fs'),inspector=require('node:inspector'),{workerData:{beat,label,file,threshold,heartbeat}}=require('node:worker_threads');
const write=text=>{try{fs.appendFileSync(file,text.split('\\n').map((line,i)=>(i?'  ':stamp()+' ')+line).join('\\n')+'\\n');}catch{}};
const bytes=new Uint8Array(label.buffer,4),length=new Int32Array(label.buffer,0,1);
const activity=()=>{const n=Atomics.load(length,0);return n?Buffer.from(bytes.slice(0,n)).toString('utf8'):'';};
const session=new inspector.Session();session.connectToMainThread();
const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(e,v)=>e?reject(e):resolve(v)));
const scripts=new Map();session.on('Debugger.scriptParsed',({params})=>{if(params.url)scripts.set(params.scriptId,params.url);});
let last=Atomics.load(beat,0),since=Date.now(),tick=Date.now(),stalled=null,pausing=false;
session.on('Debugger.paused',({params})=>{
  try{
    const frames=params.callFrames,top=frames[0]?.functionName;
    if(stalled&&!stalled.stack&&Atomics.load(beat,0)===stalled.beat&&top!==heartbeat){
      stalled.stack=true;
      write('调用栈：\\n'+frames.slice(0,20).map(f=>(f.functionName||'(匿名)')+' '+((f.url||scripts.get(f.location.scriptId)||'').replace(/^file:\\/\\/\\/?/,'').split(/[\\\\/]/).slice(-2).join('/')||'?')+':'+(f.location.lineNumber+1)+':'+(f.location.columnNumber+1)).join('\\n'));
    }
  }finally{post('Debugger.resume').catch(()=>{}).then(()=>post('Debugger.disable')).catch(()=>{}).finally(()=>{pausing=false;});}
});
setInterval(()=>{
  const now=Date.now(),value=Atomics.load(beat,0);
  // This thread was frozen too (sleep, hibernation): not a stall of the main thread.
  if(now-tick>threshold){tick=now;last=value;since=now;stalled=null;return;}
  tick=now;
  if(value!==last){if(stalled)write('主进程恢复，共卡住 '+((now-stalled.start)/1000).toFixed(1)+' 秒');last=value;since=now;stalled=null;return;}
  if(stalled||now-since<threshold)return;
  stalled={start:since,beat:value,stack:false};const doing=activity();
  write('主进程卡住超过 '+(threshold/1000)+' 秒'+(doing?'，正在处理：'+doing:'，不在处理界面请求'));
  if(!pausing){pausing=true;post('Debugger.enable').then(()=>post('Debugger.pause')).catch(e=>{pausing=false;write('无法取得调用栈：'+e.message);});}
},100);`;
function startStallLog(file,{threshold=1000,maxBytes=1024*1024}={}){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{if(fs.statSync(file).size>maxBytes)fs.renameSync(file,file.replace(/(\.log)?$/,'.old.log'));}catch{}
  const beat=new Int32Array(new SharedArrayBuffer(4)),label=new Uint8Array(new SharedArrayBuffer(4+LABEL_BYTES)),length=new Int32Array(label.buffer,0,1);
  function stallHeartbeat(){Atomics.add(beat,0,1);}
  const timer=setInterval(stallHeartbeat,200);timer.unref?.();
  const worker=new Worker(WORKER_SCRIPT,{eval:true,workerData:{beat,label,file,threshold,heartbeat:stallHeartbeat.name}});
  worker.unref();worker.on('error',()=>{});
  let current='';
  const set=text=>{const encoded=Buffer.from(text).subarray(0,LABEL_BYTES);Atomics.store(length,0,0);label.set(encoded,4);Atomics.store(length,0,encoded.length);current=text;};
  return{
    // Names what the main thread is doing until the returned function is called.
    begin(text){const previous=current;set(String(text));return()=>set(previous);},
    // Events the main thread sees itself, e.g. the page in the window not responding.
    note(text){try{fs.appendFileSync(file,stamp()+' '+text+'\n');}catch{}},
    close(){clearInterval(timer);return worker.terminate();},
  };
}
module.exports={startStallLog};
