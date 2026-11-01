const fs=require('node:fs');const path=require('node:path');const {Engine,JsonStore}=require('../engine.cjs');
(async()=>{
  const {query}=await import('@anthropic-ai/claude-agent-sdk');
  const root=path.resolve(__dirname,'../../../work/claude-desk-tools');fs.mkdirSync(root,{recursive:true});
  const target=path.join(root,`approval-${Date.now()}.txt`);
  const e=new Engine({query,store:new JsonStore(path.join(root,'state.json')),cliPath:path.join(process.env.USERPROFILE,'.local/bin/claude.exe')});
  const t=e.create(e.addProject(root).id);let approvals=0;const statuses=new Set();
  try{
    const done=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Tool test timeout')),70000);e.on('thread',x=>{
      if(x.id!==t.id)return;statuses.add(x.status);
      const a=x.turns.at(-1)?.approval;
      if(a){const file=a.input?.file_path;const allowed=a.name==='Write'&&file&&path.resolve(file).toLowerCase()===target.toLowerCase();approvals++;console.log('PERMISSION',a.name,allowed?'allow test file':'deny');e.approve(t.id,a.id,allowed);}
      if(['done','error'].includes(x.status)){clearTimeout(timer);x.status==='done'?resolve(x):reject(Error(x.error));}
    });});
    await e.send(t.id,`Use the Write tool exactly once to write the text DESK-TOOL-OK to this absolute path: ${target}. Do not read files, do not run shell commands, and do not use other tools. Then say DONE.`);
    const result=await done;
    if(fs.readFileSync(target,'utf8').trim()!=='DESK-TOOL-OK')throw Error('Written file mismatch');
    if(!approvals||!statuses.has('approval'))throw Error('Permission state never surfaced');
    if(!result.turns.at(-1).tools.some(x=>x.name==='Write'))throw Error('Tool activity missing');
    console.log('WRITE + APPROVAL + TOOL EVENTS PASSED');
    await e.send(t.id,'Think through a detailed explanation of merge sort. Do not use tools.');
    await new Promise(resolve=>setTimeout(resolve,800));await e.stop(t.id);
    if(e.thread(t.id).status!=='stopped'||e.runs.has(t.id))throw Error('Stop failed');
    console.log('LIVE STOP PASSED');
  }finally{await e.shutdown();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
