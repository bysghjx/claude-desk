const ACTIVE_AGENT=new Set(['running','waiting','thinking','generating','tool','approval','paused']);
const isAgentTool=name=>name==='Agent'||name==='Task';
function activeAgents(thread){return thread.turns.flatMap(turn=>turn.subagents||[]).filter(a=>ACTIVE_AGENT.has(a.status)&&!a.ambient);}
function findAgent(thread,taskId,toolId){
  for(const turn of thread.turns)for(const agent of turn.subagents||[])if((taskId&&agent.taskId===taskId)||(toolId&&agent.toolUseId===toolId))return{turn,agent};
}
// The tool call a message points at, in the main turn or inside a sub-agent.
function findTool(thread,toolId){
  for(const turn of thread.turns){
    const tool=(turn.tools||[]).find(t=>t.id===toolId);if(tool)return{turn,tool,agent:null};
    for(const agent of turn.subagents||[]){const tool=(agent.tools||[]).find(t=>t.id===toolId);if(tool)return{turn,tool,agent};}
  }
}
// A sub-agent's thinking, text and tool calls in the order they came, like turn.items.
function agentItem(a,type,text=''){(a.items||=[]).push(type==='tool'?{type,id:text}:{type,text});}
// Thinking blocks the CLI lists in narration_block_indexes are the server's summary of what
// Claude wrote between tool calls, not its reasoning; their items become 'narration'.
function markNarration(items,msg){
  const blocks=msg.message?.content||[];
  for(const i of msg.narration_block_indexes||[]){
    const text=blocks[i]?.type==='thinking'?String(blocks[i].thinking||''):'';if(!text.trim())continue;
    const item=items.findLast(x=>x.type==='thinking'&&x.text.trim()===text.trim());
    if(item)item.type='narration';else items.push({type:'narration',text});
  }
}
function agentAppend(a,type,text){const last=a.items?.at(-1);if(last?.type===type)last.text=(last.text+text).slice(-120000);else agentItem(a,type,text);}
// Older versions took a long Bash call's progress (its parent_tool_use_id is the Bash call
// itself) for a sub-agent and kept an empty 子智能体 for it.
function dropToolAgents(turn){
  if(!turn.subagents?.length)return;
  const plain=new Set((turn.tools||[]).filter(t=>!isAgentTool(t.name)).map(t=>t.id));
  turn.subagents=turn.subagents.filter(a=>!(plain.has(a.toolUseId||a.id)&&!a.tools?.length&&!a.answer));
}
function ensureAgent(thread,turn,event={}){
  const byTask=findAgent(thread,event.task_id,null),byTool=findAgent(thread,null,event.tool_use_id);
  let found=byTask||byTool;
  if(byTask&&byTool&&byTask.agent!==byTool.agent){
    const a=byTask.agent,b=byTool.agent;
    a.aliases=[...new Set([...(a.aliases||[]),b.id,...(b.aliases||[])])];
    a.answer=a.answer||b.answer;a.thinking=a.thinking||b.thinking;
    a.tools=[...a.tools,...b.tools.filter(tool=>!a.tools.some(x=>x.id===tool.id))];
    a.items=[...(a.items||[]),...(b.items||[]).filter(item=>item.type!=='tool'||!a.items?.some(x=>x.id===item.id))];
    byTool.turn.subagents=byTool.turn.subagents.filter(agent=>agent!==b);
  }
  if(found&&event.run_id&&found.agent.runId&&event.run_id<found.agent.runId)return null;
  if(!found){
    const id=event.tool_use_id||event.task_id;if(!id)return null;
    const agent={id,taskId:event.task_id||'',toolUseId:event.tool_use_id||'',name:event.description||event.subagent_type||'子智能体',description:event.prompt||'',status:'running',startedAt:Date.now(),updatedAt:Date.now(),answer:'',thinking:'',tools:[],items:[]};
    (turn.subagents||=[]).push(agent);found={turn,agent};
  }
  const a=found.agent;
  if(event.run_id&&a.runId&&event.run_id>a.runId)Object.assign(a,{status:'running',startedAt:Date.now(),finishedAt:null,answer:'',thinking:'',tools:[],items:[],usage:null});
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
  // Progress of an ordinary tool names that tool as its parent: it belongs to the main
  // turn, or to the sub-agent that made the call.
  const host=!findAgent(thread,null,msg.parent_tool_use_id)&&findTool(thread,msg.parent_tool_use_id);
  if(host&&!isAgentTool(host.tool.name)){
    const a=host.agent;if(!a)return false;
    if(msg.type==='tool_progress'){a.lastTool=msg.tool_name;if(ACTIVE_AGENT.has(a.status))a.status='tool';}
    a.updatedAt=Date.now();return true;
  }
  const found=ensureAgent(thread,current,{tool_use_id:msg.parent_tool_use_id});if(!found)return true;
  const {turn,agent:a}=found;
  const streams=(run.agentStreams||=new Map());
  const streamId=a.toolUseId||a.id;
  if(!streams.has(streamId))streams.set(streamId,{partial:false,seen:new Set()});
  const stream=streams.get(streamId),active=ACTIVE_AGENT.has(a.status);
  if(msg.type==='stream_event'){
    const e=msg.event;
    if(e.type==='content_block_start'&&['text','thinking'].includes(e.content_block?.type))agentItem(a,e.content_block.type);
    if(e.type==='content_block_delta'){
      if(e.delta.type==='text_delta'){a.answer=(a.answer+e.delta.text).slice(-120000);agentAppend(a,'text',e.delta.text);stream.partial=true;if(active)a.status='generating';}
      if(e.delta.type==='thinking_delta'){a.thinking=(a.thinking+e.delta.thinking).slice(-120000);agentAppend(a,'thinking',e.delta.thinking);stream.thought=true;if(active)a.status='thinking';}
    }
  }
  if(msg.type==='assistant'){
    if(msg.uuid&&stream.seen.has(msg.uuid))return true;if(msg.uuid)stream.seen.add(msg.uuid);
    const blocks=msg.message?.content||[],text=blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n');
    if(!stream.thought)for(const b of blocks)if(b.type==='thinking'&&b.thinking){a.thinking=(a.thinking+(a.thinking?'\n\n':'')+b.thinking).slice(-120000);agentItem(a,'thinking',b.thinking);}
    markNarration(a.items||=[],msg);
    if(text&&!stream.partial){a.answer=(a.answer+(a.answer?'\n\n':'')+text).slice(-120000);agentItem(a,'text',text);}
    stream.partial=false;stream.thought=false;a.model=msg.message?.model||a.model;
    if(msg.message?.usage)a.lastResponseUsage=msg.message.usage;
    for(const b of blocks)if(b.type==='tool_use'){
      if(!a.tools.some(tool=>tool.id===b.id)){a.tools.push({id:b.id,name:b.name,input:b.input,status:'running',output:'',startedAt:Date.now()});agentItem(a,'tool',b.id);}
      agentFromTool(thread,turn,b,a.id);a.lastTool=b.name;if(active)a.status='tool';
    }
  }
  if(msg.type==='user')for(const b of msg.message?.content||[])if(b.type==='tool_result'){
    const tool=a.tools.find(tool=>tool.id===b.tool_use_id);
    const output=redact(typeof b.content==='string'?b.content:JSON.stringify(b.content||'')).slice(-80000);
    if(tool){tool.output=output;tool.status=b.is_error?'error':'done';tool.finishedAt=Date.now();}
    finishAgentTool(thread,b.tool_use_id,b.is_error,output);if(active)a.status='running';
  }
  if(msg.type==='tool_progress'){a.lastTool=msg.tool_name;if(active)a.status='tool';}
  a.updatedAt=Date.now();return true;
}
module.exports={markNarration,ACTIVE_AGENT,activeAgents,findAgent,findTool,dropToolAgents,ensureAgent,agentFromTool,finishAgentTool,settleAgents,handleAgentMessage};
