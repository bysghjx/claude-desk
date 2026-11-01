const fs = require('node:fs');
const path = require('node:path');

function readState(file) {
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!value || !Array.isArray(value.threads) || !Array.isArray(value.projects)) throw Error('会话文件格式无效');
  if(value.threads.some(t=>!t || !Array.isArray(t.turns))) throw Error('会话记录格式无效');
  return value;
}
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.tmp'; const fd=fs.openSync(temp,'w');
  try { fs.writeFileSync(fd,JSON.stringify(value,null,2));fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if(fs.existsSync(file)) {
    try { readState(file);fs.copyFileSync(file,file+'.bak'); } catch { /* Preserve the last valid backup. */ }
  }
  fs.renameSync(temp,file);
}
function loadRecoverable(file, defaults) {
  const existing=[file,file+'.tmp',file+'.bak'].filter(p=>fs.existsSync(p));
  const valid=[];
  for(const p of existing)try{valid.push({file:p,state:readState(p),time:fs.statSync(p).mtimeMs});}catch{}
  valid.sort((a,b)=>((b.state.savedAt||b.time)-(a.state.savedAt||a.time)) || (a.file===file?-1:1));
  if(!valid.length) {
    if(existing.length) throw Error(`会话文件无法读取，已保留原文件，请勿删除：${file}`);
    return {state:defaults,recovered:false};
  }
  const best=valid[0];
  if(best.file!==file) {
    if(fs.existsSync(file)) fs.copyFileSync(file,file+'.unreadable-'+Date.now());
    const snapshot=structuredClone(best.state);atomicWrite(file,snapshot);
  }
  return{state:{...defaults,...best.state,settings:{...defaults.settings,...best.state.settings},ui:{...defaults.ui,...best.state.ui}},recovered:best.file!==file};
}
function mergeLegacy(state, candidates) {
  let recovered=0;const projectMap=new Map();
  for(const file of candidates) {
    let old;try{old=readState(file);}catch{continue;}
    for(const p of old.projects) {
      if(!p.id||typeof p.path!=='string')continue;
      const match=state.projects.find(x=>x.path.toLowerCase()===p.path.toLowerCase());
      projectMap.set(p.id,match?.id||p.id);
      if(!match)state.projects.push(p);
    }
    for(const thread of old.threads) {
      if(!thread.id)continue;
      const prior=state.threads.find(x=>x.id===thread.id);
      if(!prior){state.threads.push({...thread,projectId:projectMap.get(thread.projectId)||thread.projectId});recovered++;continue;}
      const ids=new Set(prior.turns.map(t=>t.id));
      for(const turn of thread.turns)if(!ids.has(turn.id)){prior.turns.push(turn);ids.add(turn.id);recovered++;}
      prior.turns.sort((a,b)=>(a.startedAt||0)-(b.startedAt||0));
    }
  }
  return recovered;
}
module.exports={readState,atomicWrite,loadRecoverable,mergeLegacy};
