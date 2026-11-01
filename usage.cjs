const {createHash}=require('node:crypto');
const fields=['input','output','cacheRead','cacheWrite'];
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
const empty=()=>({input:0,output:0,cacheRead:0,cacheWrite:0,cost:0});
function add(target,value){for(const key of [...fields,'cost'])target[key]+=number(value[key]);return target;}
function legacyUsage(state){
  if(!Array.isArray(state.usageLog))state.usageLog=[];
  if(state.usageAccountingVersion===1)return;
  const known=new Set(state.usageLog.map(entry=>entry.id));
  for(const thread of state.threads)for(const turn of thread.turns)if(turn.usage&&!known.has(turn.id)){
    const usage={input:number(turn.usage.input),output:number(turn.usage.output),cacheRead:number(turn.usage.cache),cacheWrite:0,cost:number(turn.usage.cost)};
    state.usageLog.push({id:turn.id,threadId:thread.id,projectId:thread.projectId,time:turn.finishedAt||turn.startedAt||Date.now(),source:'legacy',models:{[thread.model||'unknown']:usage},cost:usage.cost});known.add(turn.id);
  }
  state.usageAccountingVersion=1;
}
function recordUsage(state,run,thread,turn,message){
  legacyUsage(state);
  const signature=message.uuid||createHash('sha256').update(JSON.stringify([turn.id,message.modelUsage,message.usage,message.total_cost_usd])).digest('hex');
  run.accountedResults||=new Set();if(run.accountedResults.has(signature))return;
  run.accountedResults.add(signature);run.usageModels||=Object.create(null);
  const models=Object.create(null);
  for(const [model,data]of Object.entries(message.modelUsage||{})){
    if(!data||typeof data!=='object')continue;
    const current={input:number(data.inputTokens),output:number(data.outputTokens),cacheRead:number(data.cacheReadInputTokens),cacheWrite:number(data.cacheCreationInputTokens),cost:number(data.costUSD)};
    const previous=run.usageModels[model]||empty();
    const reset=[...fields,'cost'].some(key=>current[key]<previous[key]);
    models[model]=Object.fromEntries([...fields,'cost'].map(key=>[key,Math.max(0,current[key]-(reset?0:previous[key]))]));
    run.usageModels[model]=current;
  }
  const detailed=Object.keys(models).length>0;
  if(!detailed){
    if(run.fallbackTurns?.has(turn.id))return;
    (run.fallbackTurns||=new Set()).add(turn.id);
    models[thread.model||'unknown']={input:number(message.usage?.input_tokens),output:number(message.usage?.output_tokens),cacheRead:number(message.usage?.cache_read_input_tokens),cacheWrite:number(message.usage?.cache_creation_input_tokens),cost:0};
  }
  const costTotal=typeof message.total_cost_usd==='number'&&Number.isFinite(message.total_cost_usd)?message.total_cost_usd:null;
  const deltaCost=costTotal===null?Object.values(models).reduce((sum,m)=>sum+m.cost,0):Math.max(0,costTotal<run.usageCost?costTotal:costTotal-(run.usageCost||0));
  if(costTotal!==null)run.usageCost=costTotal;
  if(!detailed)models[thread.model||'unknown'].cost=deltaCost;
  let entry=state.usageLog.find(entry=>entry.id===turn.id);
  if(!entry){entry={id:turn.id,threadId:thread.id,projectId:thread.projectId,time:Date.now(),source:detailed?'modelUsage':'main-only',models:Object.create(null),cost:0};state.usageLog.push(entry);}
  entry.models=Object.assign(Object.create(null),entry.models);
  for(const [model,usage]of Object.entries(models))add(entry.models[model]||=empty(),usage);
  entry.cost+=deltaCost;entry.time=turn.finishedAt||Date.now();
  turn.accounting={source:entry.source,models:structuredClone(entry.models),cost:entry.cost};
}
function dayKey(time){const d=new Date(time);return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function usageSummary(state,{period='all',projectId='',threadId=''}={},now=Date.now()){
  legacyUsage(state);const midnight=new Date(now);midnight.setHours(0,0,0,0);
  const days={today:1,'7d':7,'30d':30}[period];const start=days?new Date(midnight.getFullYear(),midnight.getMonth(),midnight.getDate()-days+1).getTime():0;
  const entries=state.usageLog.filter(e=>e.time>=start&&e.time<=now&&(!projectId||e.projectId===projectId)&&(!threadId||e.threadId===threadId));
  const total=empty(),models=new Map(),daily=new Map();let partial=0;
  for(const entry of entries){
    const date=dayKey(entry.time),day=daily.get(date)||{date,...empty(),turns:0};
    day.turns++;day.cost+=number(entry.cost);total.cost+=number(entry.cost);
    if(entry.source!=='modelUsage')partial++;
    for(const [model,usage]of Object.entries(entry.models||{})){
      const row=models.get(model)||{model,...empty()};add(row,usage);models.set(model,row);
      for(const key of fields){day[key]+=number(usage[key]);total[key]+=number(usage[key]);}
    }
    daily.set(date,day);
  }
  return{...total,tokens:fields.reduce((sum,key)=>sum+total[key],0),turns:entries.length,partial,period,models:[...models.values()].sort((a,b)=>b.input+b.output+b.cacheRead+b.cacheWrite-a.input-a.output-a.cacheRead-a.cacheWrite),daily:[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-30),recordedSince:state.usageLog.length?state.usageLog.reduce((min,e)=>Math.min(min,e.time),Infinity):null,updatedAt:now};
}
function usageCsv(summary){
  const cell=value=>{let s=String(value??'');if(/^[=+@-]/.test(s))s="'"+s;return'"'+s.replaceAll('"','""')+'"';};
  return'\uFEFF'+[['模型','输入 tokens','输出 tokens','缓存读取 tokens','缓存写入 tokens','估算费用 USD'],...summary.models.map(m=>[m.model,m.input,m.output,m.cacheRead,m.cacheWrite,m.cost]),['合计',summary.input,summary.output,summary.cacheRead,summary.cacheWrite,summary.cost]].map(row=>row.map(cell).join(',')).join('\r\n');
}
module.exports={legacyUsage,recordUsage,usageSummary,usageCsv};
