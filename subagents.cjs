const ACTIVE_AGENT=new Set(['running','waiting','thinking','generating','tool','approval','paused']);
const isAgentTool=name=>name==='Agent'||name==='Task';
function activeAgents(thread){return thread.turns.flatMap(turn=>turn.subagents||[]).filter(a=>ACTIVE_AGENT.has(a.status)&&!a.ambient);}
function findAgent(thread,taskId,toolId){
  for(const turn of thread.turns)for(const agent of turn.subagents||[])if((taskId&&agent.taskId===taskId)||(toolId&&agent.toolUseId===toolId))return{turn,agent};
}
function ensureAgent(thread,turn,event={}){
  const byTask=findAgent(thread,event.task_id,null),byTool=findAgent(thread,null,event.tool_use_id);
  let found=byTask||byTool;
  if(byTask&&byTool&&byTask.agent!==byTool.agent){
    const a=byTask.agent,b=byTool.agent;
    a.aliases=[...new Set([...(a.aliases||[]),b.id,...(b.aliases||[])])];
    a.answer=a.answer||b.answer;a.thinking=a.thinking||b.thinking;
    a.tools=[...a.tools,...b.tools.filter(tool=>!a.tools.some(x=>x.id===tool.id))];
    byTool.turn.subagents=byTool.turn.subagents.filter(agent=>agent!==b);
  }
  if(found&&event.run_id&&found.agent.runId&&event.run_id<found.agent.runId)return null;
  if(!found){
    const id=event.tool_use_id||event.task_id;if(!id)return null;
    const agent={id,taskId:event.task_id||'',toolUseId:event.tool_use_id||'',name:event.description||event.subagent_type||'子智能体',description:event.prompt||'',status:'running',startedAt:Date.now(),updatedAt:Date.now(),answer:'',thinking:'',tools:[]};
    (turn.subagents||=[]).push(agent);found={turn,agent};
  }
  const a=found.agent;
  if(event.run_id&&a.runId&&event.run_id>a.runId)Object.assign(a,{status:'running',startedAt:Date.now(),finishedAt:null,answer:'',thinking:'',tools:[],usage:null});
  if(event.run_id)a.runId=event.run_id;
  if(event.task_id)a.taskId=event.task_id;if(event.tool_use_id)a.toolUseId=event.tool_use_id;
  if(event.description)a.name=event.description;if(event.subagent_type)a.type=event.subagent_type;
  if(event.parent_task_id)a.parentTaskId=event.parent_task_id;
  if(event.parentId)a.parentId=event.parentId;
  if(event.is_backgrounded!==undefined)a.background=event.is_backgrounded;
  if(event.ambient!==undefined)a.ambient=event.ambient;
  a.updatedAt=Date.now();return found;
}
function agentFromTool(thread,turn,tool,parentId){
  if(!isAgentTool(tool.name))return;
  return ensureAgent(thread,turn,{tool_use_id:tool.id,description:tool.input?.description||tool.input?.subagent_type||'子智能体',prompt:tool.input?.prompt||'',subagent_type:tool.input?.subagent_type,parentId});
}
function finishAgentTool(thread,toolId,isError,output){
  const found=findAgent(thread,null,toolId);if(!found)return;
  const a=found.agent;
  if(!a.background&&ACTIVE_AGENT.has(a.status)){a.status=isError?'error':'done';a.finishedAt=Date.now();a.summary=output||a.summary;}
}
function settleAgents(thread,status){
  for(const turn of thread.turns){
    delete turn.approval;delete turn.approvals;
    for(const a of turn.subagents||[]){
      if(ACTIVE_AGENT.has(a.status)){a.status=status;a.finishedAt=Date.now();}
      for(const tool of a.tools||[])if(['running','approval'].includes(tool.status))tool.status='interrupted';
    }
  }
}
function handleAgentMessage(thread,run,msg,redact){
  const current=thread.turns.find(t=>t.id===run.turnId);if(!current)return false;
  if(msg.type==='system'&&msg.subtype==='background_tasks_changed'){
    const previous=run.backgroundTasks||new Set(),next=new Set();
    for(const event of msg.tasks||[])if(event.task_type==='local_agent'){
      const found=ensureAgent(thread,current,{...event,is_backgrounded:true});
      if(found){next.add(found.agent.id);if(!ACTIVE_AGENT.has(found.agent.status)&&!found.agent.finishedAt)found.agent.status='running';}
    }
    for(const id of previous)if(!next.has(id))for(const turn of thread.turns)for(const a of turn.subagents||[])if((a.id===id||a.aliases?.includes(id))&&ACTIVE_AGENT.has(a.status)){a.status='ended';a.finishedAt=Date.now();}
    run.backgroundTasks=next;return true;
  }
  if(msg.type==='system'&&['task_started','task_progress','task_updated','task_notification'].includes(msg.subtype)){
    const known=findAgent(thread,msg.task_id,msg.tool_use_id);
    if(!known&&msg.task_type!=='local_agent'&&!msg.subagent_type)return false;
    const found=ensureAgent(thread,current,msg);if(!found)return true;
    const a=found.agent;
    if(msg.usage)a.usage={totalTokens:msg.usage.total_tokens,toolUses:msg.usage.tool_uses,durationMs:msg.usage.duration_ms};
    if(msg.summary)a.summary=redact(msg.summary);
    if(msg.last_tool_name)a.lastTool=msg.last_tool_name;
    if(msg.subtype==='task_updated'){
      const p=msg.patch||{};
      if(p.description)a.name=p.description;if(p.error)a.error=redact(p.error);
      if(p.is_backgrounded!==undefined)a.background=p.is_backgrounded;
      const status={pending:'waiting',running:'running',completed:'done',failed:'error',killed:'stopped',paused:'paused'}[p.status];
      if(status&&ACTIVE_AGENT.has(a.status)){a.status=status;if(!ACTIVE_AGENT.has(status))a.finishedAt=p.end_time||Date.now();}
    }
    if(msg.subtype==='task_notification'){
      a.status={completed:'done',failed:'error',stopped:'stopped'}[msg.status]||'ended';a.finishedAt=Date.now();
      if(msg.reason==='worker_restart')a.status='interrupted';
    }
    return true;
  }
  if(!msg.parent_tool_use_id)return false;
  const found=ensureAgent(thread,current,{tool_use_id:msg.parent_tool_use_id});if(!found)return true;
  const {turn,agent:a}=found;
  const streams=(run.agentStreams||=new Map());
  const streamId=a.toolUseId||a.id;
  if(!streams.has(streamId))streams.set(streamId,{partial:false,seen:new Set()});
  const stream=streams.get(streamId),active=ACTIVE_AGENT.has(a.status);
  if(msg.type==='stream_event'){
    const e=msg.event;
    if(e.type==='content_block_delta'){
      if(e.delta.type==='text_delta'){a.answer=(a.answer+e.delta.text).slice(-120000);stream.partial=true;if(active)a.status='generating';}
      if(e.delta.type==='thinking_delta'){a.thinking=(a.thinking+e.delta.thinking).slice(-120000);if(active)a.status='thinking';}
    }
  }
  if(msg.type==='assistant'){
    if(msg.uuid&&stream.seen.has(msg.uuid))return true;if(msg.uuid)stream.seen.add(msg.uuid);
    const blocks=msg.message?.content||[],text=blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n');
    if(text&&!stream.partial)a.answer=(a.answer+(a.answer?'\n\n':'')+text).slice(-120000);
    stream.partial=false;a.model=msg.message?.model||a.model;
    if(msg.message?.usage)a.lastResponseUsage=msg.message.usage;
    for(const b of blocks)if(b.type==='tool_use'){
      if(!a.tools.some(tool=>tool.id===b.id))a.tools.push({id:b.id,name:b.name,input:b.input,status:'running',output:''});
      agentFromTool(thread,turn,b,a.id);a.lastTool=b.name;if(active)a.status='tool';
    }
  }
  if(msg.type==='user')for(const b of msg.message?.content||[])if(b.type==='tool_result'){
    const tool=a.tools.find(tool=>tool.id===b.tool_use_id);
    const output=redact(typeof b.content==='string'?b.content:JSON.stringify(b.content||'')).slice(-80000);
    if(tool){tool.output=output;tool.status=b.is_error?'error':'done';}
    finishAgentTool(thread,b.tool_use_id,b.is_error,output);if(active)a.status='running';
  }
  if(msg.type==='tool_progress'){a.lastTool=msg.tool_name;if(active)a.status='tool';}
  a.updatedAt=Date.now();return true;
}
module.exports={ACTIVE_AGENT,activeAgents,findAgent,ensureAgent,agentFromTool,finishAgentTool,settleAgents,handleAgentMessage};
