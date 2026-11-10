const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {Engine,JsonStore}=require('../engine.cjs');const {CursorCompatProxy,messageSSE}=require('../cursor-compat.cjs');

test('real Claude Code asks permission for converted XML and returns the actual tool result',{skip:process.platform!=='win32',timeout:60000},async()=>{
  const scratch=path.resolve(__dirname,'../../../work/cursor-cli-tests');fs.mkdirSync(scratch,{recursive:true});
  const root=fs.mkdtempSync(path.join(scratch,'compat-')),target=path.join(root,'result.txt');
  const cli=path.join(path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/package.json')),'claude.exe');
  const {query}=await import('@anthropic-ai/claude-agent-sdk');
  let receivedResult=false,requests=0,allow=false,approvals=0;const seen=[];
  const upstream=http.createServer(async(req,res)=>{
    const parts=[];for await(const chunk of req)parts.push(chunk);const body=JSON.parse(Buffer.concat(parts));requests++;
    seen.push((body.messages||[]).slice(-3).map(m=>({role:m.role,content:Array.isArray(m.content)?m.content.map(b=>b.type):typeof m.content})));
    if(req.url.includes('count_tokens')){res.writeHead(200,{'content-type':'application/json'}).end('{"input_tokens":10}');return;}
    const last=body.messages?.findLast(m=>m.role==='user');const result=Array.isArray(last?.content)&&last.content.some(b=>b.type==='tool_result');
    const hasWrite=body.tools?.some(t=>t.name==='Write');
    if(result)receivedResult=true;
    const text=hasWrite&&!result?'<invoke name="Write">\n<parameter name="file_path">'+target+'</parameter>\n<parameter name="content">ACTUAL_COMPAT_WRITE</parameter>\n</invoke>\nFAKE_SUCCESS_MUST_BE_DISCARDED':result?'Actual tool result received.':'OK';
    const response={id:'msg_'+requests,type:'message',role:'assistant',model:body.model,content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:10,output_tokens:10}};
    res.writeHead(200,{'content-type':body.stream?'text/event-stream':'application/json'}).end(body.stream?messageSSE(response):JSON.stringify(response));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const proxy=new CursorCompatProxy();await proxy.start();const base=proxy.urlFor('http://127.0.0.1:'+upstream.address().port,'isolated-native-test');
  const env={...process.env,ANTHROPIC_BASE_URL:base,ANTHROPIC_API_KEY:'dummy-local-only',ANTHROPIC_AUTH_TOKEN:'',CLAUDE_CODE_OAUTH_TOKEN:'',CLAUDE_CONFIG_DIR:path.join(root,'config'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost'};
  const store=new JsonStore(path.join(root,'state.json'));
  const engine=new Engine({store,cliPath:cli,env,query:args=>query({...args,options:{...args.options,settingSources:[],tools:['Write'],systemPrompt:'This is an isolated local test. Use Write only when approved.',maxTurns:3}})});
  const thread=engine.create(engine.addProject(root).id);
  engine.on('thread',t=>{const approval=t.turns.at(-1)?.approval;if(!approval)return;approvals++;assert.equal(approval.name,'Write');assert.equal(approval.input.file_path,target);assert.equal(fs.existsSync(target),false);engine.approve(t.id,approval.id,allow);});
  const waitDone=()=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{engine.removeListener('thread',onUpdate);reject(Error('CLI test timed out: '+thread.status+' '+thread.error));},25000);
    function onUpdate(t){if(['done','error'].includes(t.status)){clearTimeout(timer);engine.removeListener('thread',onUpdate);resolve(t);}}
    engine.on('thread',onUpdate);
  });
  try{
    let done=waitDone();await engine.send(thread.id,'Write the test file, after asking permission.');await done;
    assert.equal(thread.status,'done',thread.error+' '+JSON.stringify(seen));assert.ok(approvals>=1);assert.equal(fs.existsSync(target),false);assert.equal(receivedResult,true);
    allow=true;receivedResult=false;const before=approvals;done=waitDone();await engine.send(thread.id,'Try writing the test file again.');await done;
    assert.equal(thread.status,'done',thread.error);assert.ok(approvals>before);assert.equal(fs.readFileSync(target,'utf8'),'ACTUAL_COMPAT_WRITE');assert.equal(receivedResult,true);
    assert.equal(thread.turns.at(-1).tools[0].name,'Write');assert.equal(thread.turns.at(-1).tools[0].status,'done');
    assert.doesNotMatch(thread.turns.map(t=>t.answer).join('\n'),/FAKE_SUCCESS_MUST_BE_DISCARDED|<invoke/);
  }finally{await engine.shutdown();proxy.close();upstream.closeAllConnections();upstream.close();}
});
