const {test}=require('node:test');const assert=require('node:assert/strict');
const http=require('node:http');
const {OpenAICompatProxy,StreamAdapter,toOpenAIRequest,toAnthropicMessage,mapError,joinUrl}=require('../openai-compat.cjs');

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
const parseSSE=text=>text.trim().split('\n\n').filter(Boolean).map(block=>{
  const lines=block.split('\n');
  const event=lines.find(l=>l.startsWith('event:'))?.slice(6).trim();
  const data=lines.filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
  return{event,data:JSON.parse(data)};
});
const sseLine=obj=>`data: ${JSON.stringify(obj)}\n\n`;

test('joinUrl handles trailing slashes and existing or missing /v1 segments',()=>{
  assert.equal(joinUrl('https://api.openai.com/v1','/chat/completions'),'https://api.openai.com/v1/chat/completions');
  assert.equal(joinUrl('https://api.openai.com/v1/','/chat/completions'),'https://api.openai.com/v1/chat/completions');
  assert.equal(joinUrl('https://api.openai.com','/chat/completions'),'https://api.openai.com/v1/chat/completions');
  assert.equal(joinUrl('https://api.openai.com/','/models'),'https://api.openai.com/v1/models');
  assert.equal(joinUrl('https://api.openai.com/v1','/v1/models'),'https://api.openai.com/v1/models');
  assert.equal(joinUrl('https://dashscope.aliyuncs.com/compatible-mode/v1/','models'),'https://dashscope.aliyuncs.com/compatible-mode/v1/models');
  assert.equal(joinUrl('https://relay.example.com/customv1','/models'),'https://relay.example.com/customv1/v1/models');
});

test('toOpenAIRequest converts system, multimodal user messages, PDF fallback, tools and reasoning params',()=>{
  const req=toOpenAIRequest({
    model:'gpt-4o',
    system:[{type:'text',text:'Be concise.'},{type:'text',text:'Use Chinese.'}],
    messages:[
      {role:'user',content:[
        {type:'text',text:'Check these'},
        {type:'image',source:{type:'base64',media_type:'image/png',data:'AAAA'}},
        {type:'image',source:{type:'url',url:'https://example.com/a.png'}},
        {type:'document',title:'spec.pdf',source:{type:'base64',media_type:'application/pdf',data:'JVBERi'}}
      ]}
    ],
    tools:[
      {name:'Read',description:'Read file',input_schema:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']}},
      {type:'web_search_20250305',name:'web_search'}
    ],
    tool_choice:{type:'any'},
    max_tokens:1024,
    stop_sequences:['END'],
    temperature:0.3,
    top_p:0.9,
    stream:true,
    metadata:{user_id:'u1'},
    container:{id:'c1'},
    mcp_servers:[{name:'x'}]
  });
  assert.equal(req.model,'gpt-4o');
  assert.deepEqual(req.messages[0],{role:'system',content:'Be concise.\n\nUse Chinese.'});
  assert.deepEqual(req.messages[1],{role:'user',content:[
    {type:'text',text:'Check these'},
    {type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}},
    {type:'image_url',image_url:{url:'https://example.com/a.png'}},
    {type:'text',text:'[附件 spec.pdf 无法发送给 OpenAI 格式的模型]'}
  ]});
  assert.equal(req.tools.length,1);
  assert.deepEqual(req.tools[0],{type:'function',function:{name:'Read',description:'Read file',parameters:{type:'object',properties:{file_path:{type:'string'}},required:['file_path']}}});
  assert.equal(req.tool_choice,'required');
  assert.equal(req.max_completion_tokens,1024);
  assert.equal('max_tokens' in req,false);
  assert.deepEqual(req.stop,['END']);
  assert.equal(req.temperature,0.3);
  assert.equal(req.top_p,0.9);
  assert.equal(req.stream,true);
  assert.deepEqual(req.stream_options,{include_usage:true});
  assert.equal('metadata' in req,false);assert.equal('container' in req,false);assert.equal('mcp_servers' in req,false);

  // String system + all tool_choice variants + reasoning model drops temperature and maps thinking budget.
  assert.equal(toOpenAIRequest({model:'gpt-4o',system:'Hi',messages:[],tool_choice:{type:'auto'}}).tool_choice,'auto');
  assert.equal(toOpenAIRequest({model:'gpt-4o',messages:[],tool_choice:{type:'none'}}).tool_choice,'none');
  assert.deepEqual(toOpenAIRequest({model:'gpt-4o',messages:[],tool_choice:{type:'tool',name:'Read'}}).tool_choice,{type:'function',function:{name:'Read'}});
  const o3=toOpenAIRequest({model:'o3-mini',messages:[],temperature:0.7,thinking:{type:'enabled',budget_tokens:2000}});
  assert.equal('temperature' in o3,false);assert.equal(o3.reasoning_effort,'low');
  assert.equal(toOpenAIRequest({model:'gpt-5',messages:[],temperature:0.5,thinking:{type:'enabled',budget_tokens:8000}}).reasoning_effort,'medium');
  assert.equal(toOpenAIRequest({model:'gpt-5',messages:[],thinking:{type:'enabled',budget_tokens:32000}}).reasoning_effort,'high');
  assert.equal('temperature' in toOpenAIRequest({model:'gpt-5-mini',messages:[],temperature:1}),false);
});

test('toOpenAIRequest orders tool_result before user text, discards thinking, and handles errors and tool images',()=>{
  const req=toOpenAIRequest({
    model:'deepseek-chat',
    messages:[
      {role:'assistant',content:[
        {type:'thinking',thinking:'internal',signature:'sig'},
        {type:'redacted_thinking',data:'xyz'},
        {type:'text',text:'Checking two files'},
        {type:'tool_use',id:'call_1',name:'Read',input:{file_path:'a.txt'}},
        {type:'tool_use',id:'call_2',name:'Read',input:{file_path:'b.png'}}
      ]},
      {role:'user',content:[
        {type:'text',text:'Now summarize both.'},
        {type:'tool_result',tool_use_id:'call_1',content:'missing',is_error:true},
        {type:'tool_result',tool_use_id:'call_2',content:[
          {type:'text',text:'Image loaded'},
          {type:'image',source:{type:'base64',media_type:'image/jpeg',data:'BBBB'}}
        ]}
      ]}
    ]
  });
  assert.equal(req.messages.length,4);
  assert.deepEqual(req.messages[0],{
    role:'assistant',
    content:'Checking two files',
    tool_calls:[
      {id:'call_1',type:'function',function:{name:'Read',arguments:'{"file_path":"a.txt"}'}},
      {id:'call_2',type:'function',function:{name:'Read',arguments:'{"file_path":"b.png"}'}}
    ]
  });
  assert.deepEqual(req.messages[1],{role:'tool',tool_call_id:'call_1',content:'Error: missing'});
  assert.deepEqual(req.messages[2],{role:'tool',tool_call_id:'call_2',content:'Image loaded'});
  assert.deepEqual(req.messages[3],{role:'user',content:[
    {type:'text',text:'Now summarize both.'},
    {type:'image_url',image_url:{url:'data:image/jpeg;base64,BBBB'}}
  ]});
});

test('StreamAdapter handles text, reasoning, parallel multi-chunk tool calls, usage and arbitrary byte splits with CRLF',()=>{
  // 1. Plain text + reasoning + usage with cached tokens + arbitrary 1-byte CRLF chunking.
  const raw1=(
    'data: {"model":"deepseek-r1","choices":[{"delta":{"reasoning_content":"思考"}}]}\r\n\r\n'+
    'data: {"model":"deepseek-r1","choices":[{"delta":{"content":"你好，世界！"}}]}\r\n\r\n'+
    'data: {"model":"deepseek-r1","choices":[{"delta":{},"finish_reason":"length"}]}\r\n\r\n'+
    'data: {"model":"deepseek-r1","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":20}}}\r\n\r\n'+
    'data: [DONE]\r\n\r\n'
  );
  const adapter1=new StreamAdapter('fallback');
  const buf=Buffer.from(raw1,'utf8');
  let out1='';
  for(let i=0;i<buf.length;i++)out1+=adapter1.push(buf.subarray(i,i+1));
  out1+=adapter1.end();
  const events1=parseSSE(out1);
  assert.equal(events1[0].event,'message_start');
  assert.equal(events1[0].data.message.model,'deepseek-r1');
  assert.match(events1[0].data.message.id,/^msg_/);
  assert.deepEqual(events1[1].data,{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}});
  assert.deepEqual(events1[2].data,{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'思考'}});
  assert.deepEqual(events1[3].data,{type:'content_block_stop',index:0});
  assert.deepEqual(events1[4].data,{type:'content_block_start',index:1,content_block:{type:'text',text:''}});
  assert.deepEqual(events1[5].data,{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'你好，世界！'}});
  assert.deepEqual(events1[6].data,{type:'content_block_stop',index:1});
  assert.deepEqual(events1[7].data,{type:'message_delta',delta:{stop_reason:'max_tokens',stop_sequence:null},usage:{input_tokens:100,output_tokens:30,cache_read_input_tokens:20}});
  assert.deepEqual(events1[8].data,{type:'message_stop'});

  // 2. Text followed by 2 parallel tool calls whose arguments arrive in >5 pieces each; finish_reason='stop' becomes 'tool_use'.
  const chunks2=[
    {model:'gpt-5',choices:[{delta:{content:'Reading files...'}}]},
    {model:'gpt-5',choices:[{delta:{tool_calls:[{index:0,id:'call_a',type:'function',function:{name:'Read',arguments:'{"'}}]}}]},
    {model:'gpt-5',choices:[{delta:{tool_calls:[{index:0,function:{arguments:'file_'}}]}}]},
    {model:'gpt-5',choices:[{delta:{tool_calls:[{index:0,function:{arguments:'path":'}}]}}]},
    {model:'gpt-5',choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"a.'}}]}}]},
    {model:'gpt-5',choices:[{delta:{tool_calls:[{index:0,function:{arguments:'txt"'}}]}}]},
    {model:'gpt-5',choices:[{delta:{tool_calls:[{index:0,function:{arguments:'}'}}]}}]},
    {model:'gpt-5',choices:[{delta:{tool_calls:[{index:1,type:'function',function:{name:'Bash',arguments:'{"'}}]}}]},
    {model:'gpt-5',choices:[{delta:{tool_calls:[{index:1,function:{arguments:'com'}}]}}]},
    {model:'gpt-5',choices:[{delta:{tool_calls:[{index:1,function:{arguments:'mand":'}}]}}]},
    {model:'gpt-5',choices:[{delta:{tool_calls:[{index:1,function:{arguments:'"echo '}}]}}]},
    {model:'gpt-5',choices:[{delta:{tool_calls:[{index:1,function:{arguments:'ok"'}}]}}]},
    {model:'gpt-5',choices:[{delta:{tool_calls:[{index:1,function:{arguments:'}'}}]}}]},
    {model:'gpt-5',choices:[{delta:{},finish_reason:'stop'}]}
  ];
  const adapter2=new StreamAdapter('gpt-5');
  let out2='';for(const c of chunks2)out2+=adapter2.push(sseLine(c));out2+=adapter2.push('data: [DONE]\n\n')+adapter2.end();
  const events2=parseSSE(out2);
  const starts=events2.filter(e=>e.event==='content_block_start');
  assert.equal(starts.length,3);
  assert.equal(starts[0].data.content_block.type,'text');
  assert.equal(starts[1].data.content_block.id,'call_a');assert.equal(starts[1].data.content_block.name,'Read');
  assert.match(starts[2].data.content_block.id,/^toolu_/);assert.equal(starts[2].data.content_block.name,'Bash');
  const json1=events2.filter(e=>e.event==='content_block_delta'&&e.data.index===1).map(e=>e.data.delta.partial_json).join('');
  const json2=events2.filter(e=>e.event==='content_block_delta'&&e.data.index===2).map(e=>e.data.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(json1),{file_path:'a.txt'});
  assert.deepEqual(JSON.parse(json2),{command:'echo ok'});
  assert.equal(events2.find(e=>e.event==='message_delta').data.delta.stop_reason,'tool_use');
});

test('StreamAdapter emits error event on mid-stream error or premature disconnect without finish_reason',()=>{
  const a=new StreamAdapter('gpt-5');
  const outA=a.push(sseLine({model:'gpt-5',choices:[{delta:{content:'partial'}}]}))+a.end();
  const eventsA=parseSSE(outA);
  assert.equal(eventsA.at(-1).event,'error');
  assert.equal(eventsA.some(e=>e.event==='message_stop'),false);

  const b=new StreamAdapter('gpt-5');
  const outB=b.push(sseLine({model:'gpt-5',choices:[{delta:{content:'hi'}}]}))+b.push(sseLine({error:{message:'overloaded',status:429}}))+b.push('data: [DONE]\n\n')+b.end();
  const eventsB=parseSSE(outB);
  assert.equal(eventsB.at(-1).event,'error');
  assert.equal(eventsB.at(-1).data.error.type,'rate_limit_error');
  assert.equal(eventsB.at(-1).data.error.message,'overloaded');
  assert.equal(eventsB.some(e=>e.event==='message_stop'),false);
});

test('toAnthropicMessage and mapError convert non-streaming responses and HTTP errors',()=>{
  const msg=toAnthropicMessage({
    model:'gpt-5',
    choices:[{message:{reasoning:'hmm',content:'Done',tool_calls:[{id:'c1',type:'function',function:{name:'Read',arguments:'{"file_path":"a.js"}'}}]},finish_reason:'tool_calls'}],
    usage:{prompt_tokens:50,completion_tokens:12,prompt_tokens_details:{cached_tokens:10}}
  });
  assert.equal(msg.stop_reason,'tool_use');
  assert.deepEqual(msg.usage,{input_tokens:40,output_tokens:12,cache_read_input_tokens:10});
  assert.deepEqual(msg.content,[
    {type:'thinking',thinking:'hmm',signature:''},
    {type:'text',text:'Done'},
    {type:'tool_use',id:'c1',name:'Read',input:{file_path:'a.js'}}
  ]);
  assert.equal(toAnthropicMessage({choices:[{message:{content:'blocked'},finish_reason:'content_filter'}]}).stop_reason,'refusal');

  assert.deepEqual(mapError(400,'{"error":{"message":"bad param"}}'),{type:'error',error:{type:'invalid_request_error',message:'bad param'}});
  assert.equal(mapError(401,'{}').error.type,'authentication_error');
  assert.equal(mapError(403,'{}').error.type,'permission_error');
  assert.equal(mapError(404,'{}').error.type,'not_found_error');
  assert.equal(mapError(413,'{}').error.type,'request_too_large');
  assert.equal(mapError(429,'{"error":{"message":"slow down"}}').error.type,'rate_limit_error');
  assert.equal(mapError(502,'Gateway Timeout').error.type,'api_error');
  assert.equal(mapError(500,'X'.repeat(700)).error.message.length,500);
});

test('OpenAICompatProxy handles messages, count_tokens, models, headers, errors and origin checks',async t=>{
  const seen=[];let mode='stream';
  const upstream=http.createServer(async(req,res)=>{
    if(req.url==='/v1/models'){
      seen.push({url:req.url,method:req.method,headers:req.headers});
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({data:[{id:'gpt-5',created:1700000000},{id:'gpt-5-mini'}]}));
      return;
    }
    const parts=[];for await(const b of req)parts.push(b);
    const body=JSON.parse(Buffer.concat(parts));
    seen.push({url:req.url,method:req.method,headers:req.headers,body});
    if(mode==='rate_limit'){res.writeHead(429,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'Too many requests'}}));return;}
    if(mode==='redirect'){res.writeHead(302,{location:'https://elsewhere.example'}).end();return;}
    if(mode==='json'){
      res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({model:body.model,choices:[{message:{content:'non-stream reply'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4}}));
      return;
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write(sseLine({model:body.model,choices:[{delta:{content:'hello '}}]}));
    res.write(sseLine({model:body.model,choices:[{delta:{content:'world'},finish_reason:'stop'}]}));
    res.write(sseLine({model:body.model,choices:[],usage:{prompt_tokens:15,completion_tokens:5}}));
    res.end('data: [DONE]\n\n');
  });
  const origin=await listen(upstream);
  const proxy=new OpenAICompatProxy();await proxy.start();
  t.after(()=>{proxy.close();upstream.closeAllConnections();upstream.close();});
  const base=proxy.urlFor(origin+'/v1','k1');

  // count_tokens is computed locally without hitting upstream.
  const countRes=await fetch(base+'/v1/messages/count_tokens',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'12345678'}]})});
  assert.equal(countRes.status,200);assert.ok((await countRes.json()).input_tokens>0);assert.equal(seen.length,0);

  // models translates OpenAI list to Anthropic shape.
  const modelsRes=await fetch(base+'/v1/models',{headers:{authorization:'Bearer sk-test'}});
  assert.equal(modelsRes.status,200);
  const modelsJson=await modelsRes.json();
  assert.equal(modelsJson.data[0].type,'model');assert.equal(modelsJson.first_id,'gpt-5');assert.equal(modelsJson.last_id,'gpt-5-mini');
  assert.equal(seen[0].headers.authorization,'Bearer sk-test');

  // streaming messages + header stripping.
  const streamRes=await fetch(base+'/v1/messages?beta=true',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer sk-test','x-api-key':'leak','anthropic-version':'2023-06-01','anthropic-beta':'x','x-stainless-lang':'js','x-app':'cli'},body:JSON.stringify({model:'gpt-5',stream:true,messages:[{role:'user',content:'hi'}]})});
  assert.equal(streamRes.status,200);
  const events=parseSSE(await streamRes.text());
  assert.equal(events.filter(e=>e.event==='content_block_delta').map(e=>e.data.delta.text).join(''),'hello world');
  assert.equal(seen[1].url,'/v1/chat/completions');
  assert.equal(seen[1].headers.authorization,'Bearer sk-test');
  assert.equal(seen[1].headers['x-api-key'],undefined);
  assert.equal(seen[1].headers['anthropic-version'],undefined);
  assert.equal(seen[1].headers['x-stainless-lang'],undefined);

  // non-streaming JSON response.
  mode='json';
  const jsonRes=await fetch(base+'/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',stream:false,messages:[{role:'user',content:'hi'}]})});
  assert.equal(jsonRes.status,200);assert.equal((await jsonRes.json()).content[0].text,'non-stream reply');

  // 429 error preserves status and maps body.
  mode='rate_limit';
  const errRes=await fetch(base+'/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}]})});
  assert.equal(errRes.status,429);assert.deepEqual(await errRes.json(),{type:'error',error:{type:'rate_limit_error',message:'Too many requests'}});

  // redirect refused + browser Origin rejected.
  mode='redirect';
  const redirRes=await fetch(base+'/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'gpt-5',messages:[{role:'user',content:'hi'}]})});
  assert.equal(redirRes.status,400);assert.match((await redirRes.json()).error.message,/OpenAI 兼容模式：.*重定向/);
  assert.equal((await fetch(base+'/v1/messages',{method:'POST',headers:{origin:'https://evil.example'},body:'{}'})).status,404);
});
