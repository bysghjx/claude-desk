const {test}=require('node:test');const assert=require('node:assert/strict');
const {legacyUsage,recordUsage,usageSummary,usageCsv}=require('../usage.cjs');
const make=()=>({threads:[],projects:[],usageLog:[],usageAccountingVersion:1});
const model=(input,output,cost)=>({inputTokens:input,outputTokens:output,cacheReadInputTokens:100,cacheCreationInputTokens:20,costUSD:cost});
test('cumulative SDK totals use deltas across turns and include child models without double counting',()=>{
  const state=make(),run={},thread={id:'thread',projectId:'project',model:'main'},a={id:'a',finishedAt:Date.now()-2000},b={id:'b',finishedAt:Date.now()-1000};
  const first={uuid:'result-a',modelUsage:{main:model(1000,200,0.1),child:model(500,100,0.05)},total_cost_usd:0.15};
  recordUsage(state,run,thread,a,first);recordUsage(state,run,thread,a,first);
  recordUsage(state,run,thread,b,{uuid:'result-b',modelUsage:{main:model(2000,400,0.2),child:model(500,100,0.05)},total_cost_usd:0.25});
  const summary=usageSummary(state);assert.equal(summary.input,2500);assert.equal(summary.output,500);assert.equal(summary.cacheRead,200);assert.equal(summary.cacheWrite,40);assert.equal(summary.turns,2);assert.equal(summary.models.length,2);assert.equal(summary.cost,0.25);
  const restarted={};recordUsage(state,restarted,thread,{id:'c',finishedAt:Date.now()},{modelUsage:{main:model(300,20,0.03)},total_cost_usd:0.03});
  assert.equal(usageSummary(state).input,2800);
});
test('historical usage migrates once, survives deletion and contains no prompt content',()=>{
  const state={threads:[{id:'t',projectId:'p',model:'legacy',turns:[{id:'a',user:'PRIVATE_TEXT',startedAt:Date.now()-1000,usage:{input:10,output:20,cache:5,cost:0.1}}]}],projects:[]};
  legacyUsage(state);legacyUsage(state);assert.equal(state.usageLog.length,1);
  state.threads=[];const summary=usageSummary(state);assert.equal(summary.tokens,35);assert.equal(summary.partial,1);assert.doesNotMatch(JSON.stringify(state.usageLog),/PRIVATE_TEXT/);
});
test('main-only fallback counts cache creation, records cost and cannot duplicate the same turn',()=>{
  const state=make(),run={},thread={id:'t',projectId:'p',model:'m'},turn={id:'a',finishedAt:Date.now()-1};
  const msg={usage:{input_tokens:20,output_tokens:5,cache_read_input_tokens:30,cache_creation_input_tokens:10},total_cost_usd:0.02};
  recordUsage(state,run,thread,turn,msg);recordUsage(state,run,thread,turn,msg);
  const s=usageSummary(state);assert.equal(s.tokens,65);assert.equal(s.models[0].cost,0.02);assert.equal(s.partial,1);
});
test('time and project filters work and CSV export neutralizes spreadsheet formulas',()=>{
  const state=make();state.usageLog=[{id:'a',projectId:'p',time:Date.now()-1000,cost:1,source:'modelUsage',models:{'=malicious':{input:10,output:2,cacheRead:0,cacheWrite:0,cost:1}}},{id:'b',projectId:'other',time:Date.now()-10*86400000,cost:2,models:{other:{input:100,output:20}}}];
  const s=usageSummary(state,{period:'7d',projectId:'p'});assert.equal(s.turns,1);assert.equal(s.tokens,12);assert.match(usageCsv(s),/"'=malicious"/);
});
test('unusual model ids remain plain accounting keys',()=>{
  const state=make();recordUsage(state,{}, {id:'t',projectId:'p',model:'constructor'},{id:'a',finishedAt:Date.now()-1},{modelUsage:JSON.parse('{"constructor":{"inputTokens":7,"outputTokens":2,"costUSD":0.01},"__proto__":{"inputTokens":3,"outputTokens":1,"costUSD":0.02}}'),total_cost_usd:0.03});
  const s=usageSummary(state);assert.equal(s.tokens,13);assert.equal(s.models.length,2);assert.equal(Object.input,undefined);
});
