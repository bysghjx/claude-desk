const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {Engine,JsonStore}=require('../engine.cjs');const {OpenAICompatProxy}=require('../openai-compat.cjs');

const sse=obj=>`data: ${JSON.stringify(obj)}\n\n`;

test('real Claude Code executes Read tool and finishes through OpenAI-compatible proxy',{skip:process.platform!=='win32',timeout:120000},async()=>{
  const scratch=path.resolve(__dirname,'../../../work/openai-cli-tests');fs.mkdirSync(scratch,{recursive:true});
  const root=fs.mkdtempSync(path.join(scratch,'compat-')),target=path.join(root,'note.txt');
  fs.writeFileSync(target,'OPENAI_COMPAT_READ_OK_9481\n');
  const cli=path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/package.json')),'claude.exe');
  const {query}=await import('@anthropic-ai/claude-agent-sdk');
  const seen=[],states=[],diags=[];let requests=0,sawToolResult=false;
  const upstream=http.createServer(async(req,res)=>{
    const parts=[];for await(const chunk of req)parts.push(chunk);
    const body=parts.length?JSON.parse(Buffer.concat(parts)):{};
    requests++;
    seen.push({url:req.url,headers:req.headers,model:body.model,stream:body.stream,stream_options:body.stream_options,tools:(body.tools||[]).map(t=>t.function?.name),messages:body.messages});
    const toolMsg=(body.messages||[]).findLast(m=>m.role==='tool');
    const hasRead=(body.tools||[]).some(t=>t.function?.name==='Read');
    if(toolMsg&&String(toolMsg.content).includes('OPENAI_COMPAT_READ_OK_9481'))sawToolResult=true;
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8'});
    if(hasRead&&!toolMsg){
      const args=JSON.stringify({file_path:target}),mid=Math.floor(args.length/2);
      res.write(sse({model:body.model,choices:[{delta:{reasoning_content:'Need to read the file first.'}}]}));
      res.write(sse({model:body.model,choices:[{delta:{tool_calls:[{index:0,id:'call_read_1',type:'function',function:{name:'Read',arguments:args.slice(0,mid)}}]}}]}));
      res.write(sse({model:body.model,choices:[{delta:{tool_calls:[{index:0,function:{arguments:args.slice(mid)}}]}}]}));
      res.write(sse({model:body.model,choices:[{delta:{},finish_reason:'tool_calls'}]}));
      res.write(sse({model:body.model,choices:[],usage:{prompt_tokens:100,completion_tokens:25}}));
      res.end('data: [DONE]\n\n');
      return;
    }
    const reply=sawToolResult?'Verified file token: OPENAI_COMPAT_READ_OK_9481':'OK';
    res.write(sse({model:body.model,choices:[{delta:{content:reply}}]}));
    res.write(sse({model:body.model,choices:[{delta:{},finish_reason:'stop'}]}));
    res.write(sse({model:body.model,choices:[],usage:{prompt_tokens:140,completion_tokens:15}}));
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const proxy=new OpenAICompatProxy();await proxy.start();
  const base=proxy.urlFor('http://127.0.0.1:'+upstream.address().port+'/v1','isolated-openai-test');
  const env={...process.env,ANTHROPIC_BASE_URL:base,ANTHROPIC_AUTH_TOKEN:'dummy-openai-token',ANTHROPIC_API_KEY:'',ANTHROPIC_DEFAULT_HAIKU_MODEL:'gpt-5-mini',ANTHROPIC_SMALL_FAST_MODEL:'gpt-5-mini',CLAUDE_CODE_OAUTH_TOKEN:'',CLAUDE_CONFIG_DIR:path.join(root,'config'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost'};
  const store=new JsonStore(path.join(root,'state.json'));
  const engine=new Engine({store,cliPath:cli,env,query:args=>query({...args,options:{...args.options,settingSources:[],tools:['Read'],systemPrompt:'This is an isolated local test. Read the requested file and report its token.',maxTurns:3}})});
  const thread=engine.create(engine.addProject(root).id);
  engine.on('diagnostic',d=>{const text=String(d?.message||'').trim();if(text)diags.push(text);});
  engine.on('thread',t=>{const line=`${t.status}:${t.detail||''}`;if(states.at(-1)!==line)states.push(line);});
  const waitDone=()=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{engine.removeListener('thread',onUpdate);reject(Error(`OpenAI CLI test timed out: ${thread.status} ${thread.error||''} | states=${JSON.stringify(states.slice(-8))} | requests=${requests} | stderr=${JSON.stringify(diags.slice(-5).join('\n').slice(-1000))}`));},90000);
    function onUpdate(t){if(['done','error'].includes(t.status)){clearTimeout(timer);engine.removeListener('thread',onUpdate);resolve(t);}}
    engine.on('thread',onUpdate);
  });
  try{
    const done=waitDone();
    await engine.send(thread.id,'Read note.txt and tell me the token.',{model:'gpt-5'});
    await done;
    assert.equal(thread.status,'done',`${thread.error} | stderr=${diags.join('\n')}`);
    assert.equal(sawToolResult,true,'fake OpenAI upstream should receive Read tool result');
    const turn=thread.turns.at(-1);
    assert.equal(turn.tools[0].name,'Read');assert.equal(turn.tools[0].status,'done');
    assert.match(turn.answer,/OPENAI_COMPAT_READ_OK_9481/);
    const chatReqs=seen.filter(r=>r.url==='/v1/chat/completions');
    assert.ok(chatReqs.length>=2);
    assert.equal(chatReqs[0].headers.authorization,'Bearer dummy-openai-token');
    assert.equal(chatReqs[0].headers['x-api-key'],undefined);
    assert.equal(chatReqs[0].headers['anthropic-version'],undefined);
    assert.deepEqual(chatReqs[0].stream_options,{include_usage:true});
    const followUp=chatReqs.find(r=>r.messages.some(m=>m.role==='tool'));
    assert.ok(followUp,'follow-up request should include tool role message');
    assert.equal(followUp.messages.some(m=>m.role==='assistant'&&Array.isArray(m.tool_calls)&&m.tool_calls[0].id==='call_read_1'),true);
    assert.equal(followUp.messages.some(m=>m.role==='tool'&&m.tool_call_id==='call_read_1'&&String(m.content).includes('OPENAI_COMPAT_READ_OK_9481')),true);
  }finally{await engine.shutdown();proxy.close();upstream.closeAllConnections();upstream.close();}
});
