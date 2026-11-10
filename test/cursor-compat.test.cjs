const {test}=require('node:test');const assert=require('node:assert/strict');
const http=require('node:http');
const {CursorCompatProxy,parseInvocation,repairMessage,adaptSSE,messageSSE}=require('../cursor-compat.cjs');
const tools=[{name:'Bash',input_schema:{type:'object',properties:{command:{type:'string'},timeout:{type:'integer',maximum:1000}},required:['command'],additionalProperties:false}},{name:'Read',input_schema:{type:'object',properties:{file_path:{type:'string'},offset:{type:'integer',minimum:1},limit:{type:'integer',default:100}},required:['file_path'],additionalProperties:false}}];
const invocation='<invoke name="Bash">\n<parameter name="command">printf "a &amp; b" &amp;&amp; echo x &lt; y</parameter>\n<parameter name="timeout">500</parameter>\n</invoke>';
const message=text=>({id:'msg_test',type:'message',role:'assistant',model:'test',content:[{type:'text',text}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:12,output_tokens:8}});
const chunks=async function*(value,size=13){const buffer=Buffer.from(value);for(let i=0;i<buffer.length;i+=size)yield buffer.subarray(i,i+size);};
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));

test('complete invocations get typed parameters and declared defaults, without fabricated results',()=>{
  const call=parseInvocation(invocation,tools);assert.equal(call.name,'Bash');assert.equal(call.input.command,'printf "a & b" && echo x < y');assert.equal(call.input.timeout,500);
  const repaired=repairMessage(message('I will check.\n'+invocation+'\nFAKE RESULT\n'+invocation),{tools});
  assert.equal(repaired.stop_reason,'tool_use');assert.equal(repaired.content.length,2);assert.equal(repaired.content[1].type,'tool_use');assert.match(repaired.content[1].id,/^toolu_compat_/);assert.doesNotMatch(JSON.stringify(repaired),/FAKE RESULT/);
  const read=parseInvocation('<invoke name="Read"><parameter name="file_path">file.txt</parameter></invoke>',tools);
  assert.equal(read.input.limit,100);
  const native={...message(invocation),content:[{type:'tool_use',id:'native',name:'Read',input:{file_path:'x'}}]};
  assert.equal(repairMessage(native,{tools}),null);
});

test('examples are ignored, incomplete or invalid calls are never guessed',()=>{
  for(const text of ['```xml\n'+invocation+'\n```',invocation.split('\n').map(l=>'> '+l).join('\n'),'Use `<invoke name="Bash">` in examples.'])assert.equal(parseInvocation(text,tools),null);
  assert.equal(parseInvocation(invocation.slice(0,-5),tools,false),null);
  assert.throws(()=>parseInvocation(invocation.slice(0,-5),tools),/不完整/);
  assert.throws(()=>parseInvocation('<invoke name="Write"></invoke>',tools),/未声明/);
  assert.throws(()=>parseInvocation('<invoke name="Bash"></invoke>',tools),/参数不符合/);
  assert.throws(()=>parseInvocation(invocation.replace('500','5000'),tools),/参数不符合/);
  assert.throws(()=>parseInvocation(invocation.replace('500','abc'),tools),/JSON/);
  assert.throws(()=>parseInvocation(invocation.replace('name="timeout"','name="command"'),tools),/重复/);
  assert.throws(()=>parseInvocation(invocation.replace('name="timeout"','name="__proto__"'),tools),/无效/);
  assert.throws(()=>repairMessage(message(invocation),{tools,tool_choice:{type:'none'}}),/选择限制/);
  assert.throws(()=>repairMessage(message(invocation),{tools,tool_choice:{type:'tool',name:'Read'}}),/选择限制/);
});

test('SSE chunk boundaries and non-ASCII parameters do not change conversion',async()=>{
  const raw=messageSSE(message('准备读取。\n'+invocation));
  const converted=await adaptSSE(chunks(raw,1),{tools});
  assert.equal(converted.converted,true);assert.match(converted.body,/"type":"tool_use"/);assert.doesNotMatch(converted.body,/<invoke/);
  const plain=messageSSE(message('正常回复 😀'));
  assert.deepEqual(await adaptSSE(chunks(plain,1),{tools}),{body:plain,converted:false});
  await assert.rejects(()=>adaptSSE(chunks('event: message_start\ndata: '+JSON.stringify({type:'message_start',message:message('')})+'\n\n'),{tools}),/意外结束/);
  await assert.rejects(()=>adaptSSE(chunks(messageSSE(message(invocation.slice(0,-5)))),{tools}),/不完整/);
  const signed=message('');signed.content=[{type:'thinking',thinking:'Short note',signature:'test-signature'},{type:'text',text:invocation}];
  const result=await adaptSSE(chunks(messageSSE(signed),1),{tools});assert.match(result.body,/signature_delta/);assert.match(result.body,/test-signature/);assert.match(result.body,/input_json_delta/);
});

test('streaming conversion stops reading upstream once the first complete call is available',async()=>{
  const start={type:'message_start',message:{...message(''),content:[]}};
  const frames=[start,{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:invocation}}];
  let canceled=false;
  async function* upstream(){try{for(const e of frames)yield Buffer.from(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);throw Error('fabricated continuation must not be read');}finally{canceled=true;}}
  const result=await adaptSSE(upstream(),{tools});assert.equal(result.converted,true);assert.equal(canceled,true);
});

test('loopback proxy forwards auth and real tool results, rejects browser origins and malformed calls',async t=>{
  const seen=[];let bad=false;
  const upstream=http.createServer(async(req,res)=>{const parts=[];for await(const b of req)parts.push(b);const body=JSON.parse(Buffer.concat(parts));seen.push({url:req.url,headers:req.headers,body});res.writeHead(200,{'content-type':body.stream?'text/event-stream':'application/json'});const msg=message(bad?'<invoke name="Bash"></invoke>':invocation+'\nFAKE RESULT');res.end(body.stream?messageSSE(msg):JSON.stringify(msg));});
  const origin=await listen(upstream);const proxy=new CursorCompatProxy();await proxy.start();
  t.after(()=>{proxy.close();upstream.closeAllConnections();upstream.close();});
  const base=proxy.urlFor(origin,'test-config');assert.equal(proxy.urlFor(origin,'test-config'),base);
  const input={model:'test',tools,messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'previous',content:'REAL RESULT'}]}]};
  const call=extra=>fetch(base+'/v1/messages?beta=true',{method:'POST',headers:{'content-type':'application/json','x-api-key':'dummy-test',...extra},body:JSON.stringify(input)});
  const r=await call();assert.equal(r.status,200);assert.equal((await r.json()).content[0].type,'tool_use');
  assert.equal(seen[0].url,'/v1/messages?beta=true');assert.equal(seen[0].headers['x-api-key'],'dummy-test');assert.deepEqual(seen[0].body.messages,input.messages);
  assert.equal((await call({origin:'https://untrusted.example'})).status,404);assert.equal(seen.length,1);
  const chunked=await new Promise((resolve,reject)=>{const r=http.request(base+'/v1/messages',{method:'POST',headers:{'content-type':'application/json'}},response=>{const parts=[];response.on('data',b=>parts.push(b));response.on('end',()=>resolve(JSON.parse(Buffer.concat(parts))));});r.on('error',reject);const value=JSON.stringify(input);r.write(value.slice(0,20));r.end(value.slice(20));});assert.equal(chunked.content[0].type,'tool_use');
  const s=await fetch(base+'/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...input,stream:true})});assert.match(await s.text(),/"type":"tool_use"/);
  bad=true;const failure=await call();assert.equal(failure.status,400);assert.match((await failure.json()).error.message,/参数不符合/);
});
