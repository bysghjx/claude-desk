// Local Anthropic-to-OpenAI adapter. Claude Code talks Anthropic /v1/messages to
// 127.0.0.1; this proxy translates requests to OpenAI /chat/completions or /responses and back.
const http=require('node:http');
const {randomBytes,randomUUID}=require('node:crypto');
const LIMIT=64*1024*1024;
const REASONING_MODEL=/^(o\d|gpt-5)/i;
const frame=value=>`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

const VERSIONED_BASE=/\/v\d+(?:alpha|beta)?(?:\/openai)?$/i;
const ENDPOINT_TAIL=/\/(?:chat\/completions|responses)$/i;
function joinUrl(baseUrl,pathname){
  const base=String(baseUrl||'').replace(/\/+$/,'').replace(ENDPOINT_TAIL,'');
  const tail=String(pathname||'').replace(/^\/+/,'').replace(/^v1(?=\/|$)\/?/,'');
  return(VERSIONED_BASE.test(base)?base:base+'/v1')+(tail?'/'+tail:'');
}
function docFallback(block){
  const name=block?.title||block?.name||block?.source?.media_type||'文档';
  return`[附件 ${name} 无法发送给 OpenAI 格式的模型]`;
}
function imageUrlOf(block){
  const src=block?.source;if(!src)return'';
  if(src.type==='base64'&&src.data)return`data:${src.media_type||'image/png'};base64,${src.data}`;
  if(src.type==='url'&&src.url)return src.url;
  return'';
}
function imagePart(block){
  const url=imageUrlOf(block);
  return url?{type:'image_url',image_url:{url}}:null;
}
function textOfSystem(system){
  if(typeof system==='string')return system;
  if(Array.isArray(system))return system.map(b=>typeof b==='string'?b:b?.type==='text'?b.text||'':'').filter(Boolean).join('\n\n');
  return'';
}
function convertToolChoice(choice){
  if(!choice||typeof choice!=='object')return undefined;
  if(choice.type==='auto')return'auto';
  if(choice.type==='any')return'required';
  if(choice.type==='none')return'none';
  if(choice.type==='tool'&&choice.name)return{type:'function',function:{name:choice.name}};
  return undefined;
}
function toOpenAIRequest(body={}){
  const messages=[],system=textOfSystem(body.system);
  if(system)messages.push({role:'system',content:system});
  for(const msg of body.messages||[]){
    if(msg.role==='user'){
      if(typeof msg.content==='string'){messages.push({role:'user',content:msg.content});continue;}
      if(!Array.isArray(msg.content))continue;
      const toolResults=[],other=[],toolImages=[];
      for(const b of msg.content){
        if(b?.type==='tool_result')toolResults.push(b);
        else if(b)other.push(b);
      }
      for(const tr of toolResults){
        let text='';
        if(typeof tr.content==='string')text=tr.content;
        else if(Array.isArray(tr.content)){
          const texts=[];
          for(const item of tr.content){
            if(item?.type==='text')texts.push(item.text||'');
            else if(item?.type==='image'){const img=imagePart(item);if(img)toolImages.push(img);}
            else if(item?.type==='document')texts.push(docFallback(item));
          }
          text=texts.join('\n');
        }
        if(tr.is_error)text='Error: '+text;
        messages.push({role:'tool',tool_call_id:tr.tool_use_id,content:text});
      }
      const parts=[];
      for(const b of other){
        if(b.type==='text')parts.push({type:'text',text:b.text||''});
        else if(b.type==='image'){const img=imagePart(b);if(img)parts.push(img);}
        else if(b.type==='document')parts.push({type:'text',text:docFallback(b)});
      }
      parts.push(...toolImages);
      if(parts.length){
        messages.push({role:'user',content:parts.some(p=>p.type==='image_url')?parts:parts.map(p=>p.text).join('\n')});
      }else if(!toolResults.length){
        messages.push({role:'user',content:''});
      }
    }else if(msg.role==='assistant'){
      if(typeof msg.content==='string'){messages.push({role:'assistant',content:msg.content});continue;}
      if(!Array.isArray(msg.content))continue;
      const texts=[],toolCalls=[];
      for(const b of msg.content){
        if(b?.type==='text')texts.push(b.text||'');
        else if(b?.type==='tool_use')toolCalls.push({id:b.id,type:'function',function:{name:b.name,arguments:typeof b.input==='string'?b.input:JSON.stringify(b.input??{})}});
        // thinking / redacted_thinking blocks are discarded.
      }
      const text=texts.join('\n');
      if(toolCalls.length)messages.push({role:'assistant',content:text||null,tool_calls:toolCalls});
      else messages.push({role:'assistant',content:text});
    }else if(msg.role==='system'&&typeof msg.content==='string'){
      messages.push({role:'system',content:msg.content});
    }
  }
  const out={model:body.model,messages};
  const tools=Array.isArray(body.tools)?body.tools.filter(t=>t&&t.name&&t.input_schema).map(t=>({type:'function',function:{name:t.name,...(t.description?{description:t.description}:{}),parameters:t.input_schema}})):[];
  if(tools.length)out.tools=tools;
  if(body.tool_choice&&!(Array.isArray(body.tools)&&!tools.length)){
    const choice=convertToolChoice(body.tool_choice);
    if(choice!==undefined)out.tool_choice=choice;
  }
  if(body.max_tokens!=null)out.max_completion_tokens=body.max_tokens;
  if(Array.isArray(body.stop_sequences)&&body.stop_sequences.length)out.stop=body.stop_sequences;
  const reasoning=REASONING_MODEL.test(String(body.model||''));
  if(body.temperature!=null&&!reasoning)out.temperature=body.temperature;
  if(body.top_p!=null)out.top_p=body.top_p;
  if(reasoning&&Number.isFinite(body.thinking?.budget_tokens)&&body.thinking.budget_tokens>0){
    const budget=body.thinking.budget_tokens;
    out.reasoning_effort=budget<4000?'low':budget<16000?'medium':'high';
  }
  if(body.stream){out.stream=true;out.stream_options={include_usage:true};}
  else if(body.stream===false)out.stream=false;
  return out;
}
function mapStopReason(finishReason,hasToolUse=false){
  if(finishReason==='tool_calls'||finishReason==='function_call')return'tool_use';
  if(finishReason==='length')return'max_tokens';
  if(finishReason==='content_filter')return'refusal';
  if(hasToolUse)return'tool_use';
  return'end_turn';
}
function convertUsage(usage){
  if(!usage||typeof usage!=='object')return{input_tokens:0,output_tokens:0};
  const cached=Number(usage.prompt_tokens_details?.cached_tokens)||0;
  const out={input_tokens:Math.max(0,(Number(usage.prompt_tokens)||0)-cached),output_tokens:Number(usage.completion_tokens)||0};
  if(cached>0)out.cache_read_input_tokens=cached;
  return out;
}
function mapError(status,body){
  const code=Number(status)||500;
  const type={400:'invalid_request_error',401:'authentication_error',403:'permission_error',404:'not_found_error',413:'request_too_large',429:'rate_limit_error'}[code]||(code>=500?'api_error':'invalid_request_error');
  let message='';
  if(body&&typeof body==='object'&&!Buffer.isBuffer(body)){
    message=String(body.error?.message||(typeof body.error==='string'?body.error:'')||body.message||'').trim();
  }else{
    const raw=Buffer.isBuffer(body)?body.toString('utf8'):String(body??'');
    try{const parsed=JSON.parse(raw);message=String(parsed?.error?.message||(typeof parsed?.error==='string'?parsed.error:'')||parsed?.message||'').trim();}
    catch{message=raw.trim().slice(0,500);}
    if(!message)message=raw.trim().slice(0,500);
  }
  return{type:'error',error:{type,message:message||`HTTP ${code}`}};
}
function toAnthropicMessage(json={},fallbackModel=''){
  const choice=json.choices?.[0]||{},msg=choice.message||{},content=[];
  const reasoning=typeof msg.reasoning_content==='string'?msg.reasoning_content:typeof msg.reasoning==='string'?msg.reasoning:'';
  if(reasoning)content.push({type:'thinking',thinking:reasoning,signature:''});
  if(typeof msg.content==='string'&&msg.content)content.push({type:'text',text:msg.content});
  else if(Array.isArray(msg.content)){
    const text=msg.content.filter(b=>b?.type==='text').map(b=>b.text||'').join('');
    if(text)content.push({type:'text',text});
  }
  if(Array.isArray(msg.tool_calls)){
    for(const tc of msg.tool_calls){
      let input={};
      if(typeof tc.function?.arguments==='string'&&tc.function.arguments.trim()){
        try{input=JSON.parse(tc.function.arguments);}catch{input={};}
      }else if(tc.function?.arguments&&typeof tc.function.arguments==='object')input=tc.function.arguments;
      content.push({type:'tool_use',id:tc.id||'toolu_'+randomUUID().replaceAll('-','').slice(0,24),name:tc.function?.name||'',input});
    }
  }
  const hasToolUse=content.some(b=>b.type==='tool_use');
  return{id:'msg_'+randomUUID().replaceAll('-','').slice(0,24),type:'message',role:'assistant',model:json.model||fallbackModel||'',content,stop_reason:mapStopReason(choice.finish_reason,hasToolUse),stop_sequence:null,usage:convertUsage(json.usage)};
}
function messageSSE(message){
  let out=frame({type:'message_start',message:{...message,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}});
  (message.content||[]).forEach((block,index)=>{
    let start=block;const deltas=[];
    if(block.type==='tool_use'){start={...block,input:{}};deltas.push({type:'input_json_delta',partial_json:JSON.stringify(block.input??{})});}
    if(block.type==='text'){start={...block,text:''};deltas.push({type:'text_delta',text:block.text});}
    if(block.type==='thinking'){start={...block,thinking:'',signature:''};deltas.push({type:'thinking_delta',thinking:block.thinking});}
    out+=frame({type:'content_block_start',index,content_block:start});
    for(const delta of deltas)out+=frame({type:'content_block_delta',index,delta});
    out+=frame({type:'content_block_stop',index});
  });
  return out+frame({type:'message_delta',delta:{stop_reason:message.stop_reason,stop_sequence:message.stop_sequence},usage:message.usage||{input_tokens:0,output_tokens:0}})+frame({type:'message_stop'});
}
class StreamAdapter{
  constructor(model=''){
    this.model=model;this.id='msg_'+randomUUID().replaceAll('-','').slice(0,24);
    this.decoder=new TextDecoder();this.pending='';
    this.started=false;this.finished=false;this.failed=false;
    this.blockIndex=-1;this.current=null;this.toolBlocks=new Map();this.nextImplicitTool=0;
    this.hasToolUse=false;this.finishReason=null;this.usage={input_tokens:0,output_tokens:0};
  }
  ensureStart(model){
    if(this.started)return'';
    this.started=true;this.model=model||this.model||'';
    return frame({type:'message_start',message:{id:this.id,type:'message',role:'assistant',model:this.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}});
  }
  closeBlock(){
    if(!this.current)return'';
    const index=this.blockIndex;this.current=null;
    return frame({type:'content_block_stop',index});
  }
  openBlock(type,content_block,extra={}){
    let out=this.closeBlock();
    this.blockIndex++;this.current={type,...extra};
    return out+frame({type:'content_block_start',index:this.blockIndex,content_block});
  }
  fail(error){
    if(this.finished)return'';
    this.failed=true;this.finished=true;
    return frame({type:'error',error});
  }
  handleEvent(data){
    if(this.finished)return'';
    if(data==='[DONE]')return this.finish();
    let chunk;
    try{chunk=JSON.parse(data);}catch{return this.fail({type:'api_error',message:'OpenAI 兼容模式：上游流返回了无法解析的数据'});}
    if(chunk?.error){
      const err=mapError(chunk.error.status||chunk.status||500,{error:chunk.error}).error;
      return this.fail(err);
    }
    if(chunk?.model)this.model=chunk.model;
    let out=this.ensureStart(chunk?.model);
    if(chunk?.usage)this.usage=convertUsage(chunk.usage);
    const choice=chunk?.choices?.[0];
    if(choice){
      const delta=choice.delta||{};
      const reasoning=typeof delta.reasoning_content==='string'?delta.reasoning_content:typeof delta.reasoning==='string'?delta.reasoning:'';
      if(reasoning){
        if(this.current?.type!=='thinking')out+=this.openBlock('thinking',{type:'thinking',thinking:'',signature:''});
        out+=frame({type:'content_block_delta',index:this.blockIndex,delta:{type:'thinking_delta',thinking:reasoning}});
      }
      if(typeof delta.content==='string'&&delta.content.length){
        if(this.current?.type!=='text')out+=this.openBlock('text',{type:'text',text:''});
        out+=frame({type:'content_block_delta',index:this.blockIndex,delta:{type:'text_delta',text:delta.content}});
      }
      if(Array.isArray(delta.tool_calls)){
        for(const tc of delta.tool_calls){
          const toolIdx=tc.index!=null?tc.index:(tc.id&&(this.current?.type!=='tool_use'||this.current.id!==tc.id)?this.nextImplicitTool++:(this.current?.type==='tool_use'?this.current.toolIndex:this.nextImplicitTool++));
          if(!this.toolBlocks.has(toolIdx)){
            const id=tc.id||'toolu_'+randomUUID().replaceAll('-','').slice(0,24);
            out+=this.openBlock('tool_use',{type:'tool_use',id,name:tc.function?.name||'',input:{}},{toolIndex:toolIdx,id});
            this.toolBlocks.set(toolIdx,this.blockIndex);this.hasToolUse=true;
          }
          const args=tc.function?.arguments;
          if(typeof args==='string'&&args.length){
            out+=frame({type:'content_block_delta',index:this.toolBlocks.get(toolIdx),delta:{type:'input_json_delta',partial_json:args}});
          }
        }
      }
      if(choice.finish_reason)this.finishReason=choice.finish_reason;
    }
    return out;
  }
  finish(){
    if(this.finished)return'';
    if(!this.finishReason)return this.fail({type:'api_error',message:'OpenAI 兼容模式：上游流在完成前意外断开'});
    this.finished=true;
    let out=this.ensureStart(this.model);
    out+=this.closeBlock();
    out+=frame({type:'message_delta',delta:{stop_reason:mapStopReason(this.finishReason,this.hasToolUse),stop_sequence:null},usage:this.usage});
    out+=frame({type:'message_stop'});
    return out;
  }
  drain(flush=false){
    let out='',end;
    while((end=this.pending.indexOf('\n\n'))>=0){
      const raw=this.pending.slice(0,end);this.pending=this.pending.slice(end+2);
      const data=raw.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
      if(data)out+=this.handleEvent(data);
    }
    if(flush&&this.pending.trim()){
      const raw=this.pending;this.pending='';
      const data=raw.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
      if(data)out+=this.handleEvent(data);
    }
    return out;
  }
  push(chunk){
    const text=typeof chunk==='string'?chunk:this.decoder.decode(chunk,{stream:true});
    this.pending=(this.pending+text).replace(/\r\n/g,'\n');
    return this.drain(false);
  }
  end(){
    const rest=this.decoder.decode();
    if(rest)this.pending=(this.pending+rest).replace(/\r\n/g,'\n');
    let out=this.drain(true);
    if(!this.finished)out+=this.finish();
    return out;
  }
}
function toOpenAIResponsesRequest(body={}){
  const input=[],instructions=textOfSystem(body.system);
  for(const msg of body.messages||[]){
    if(msg.role==='user'){
      if(typeof msg.content==='string'){input.push({type:'message',role:'user',content:[{type:'input_text',text:msg.content}]});continue;}
      if(!Array.isArray(msg.content))continue;
      const toolResults=[],other=[],toolImages=[];
      for(const b of msg.content){if(b?.type==='tool_result')toolResults.push(b);else if(b)other.push(b);}
      for(const tr of toolResults){
        let text='';
        if(typeof tr.content==='string')text=tr.content;
        else if(Array.isArray(tr.content)){
          const texts=[];
          for(const item of tr.content){
            if(item?.type==='text')texts.push(item.text||'');
            else if(item?.type==='image'){const url=imageUrlOf(item);if(url)toolImages.push({type:'input_image',image_url:url});}
            else if(item?.type==='document')texts.push(docFallback(item));
          }
          text=texts.join('\n');
        }
        if(tr.is_error)text='Error: '+text;
        input.push({type:'function_call_output',call_id:tr.tool_use_id,output:text});
      }
      const parts=[];
      for(const b of other){
        if(b.type==='text')parts.push({type:'input_text',text:b.text||''});
        else if(b.type==='image'){const url=imageUrlOf(b);if(url)parts.push({type:'input_image',image_url:url});}
        else if(b.type==='document')parts.push({type:'input_text',text:docFallback(b)});
      }
      parts.push(...toolImages);
      if(parts.length)input.push({type:'message',role:'user',content:parts});
      else if(!toolResults.length)input.push({type:'message',role:'user',content:[{type:'input_text',text:''}]});
    }else if(msg.role==='assistant'){
      if(typeof msg.content==='string'){input.push({type:'message',role:'assistant',content:[{type:'output_text',text:msg.content}]});continue;}
      if(!Array.isArray(msg.content))continue;
      const texts=[],calls=[];
      for(const b of msg.content){
        if(b?.type==='text'&&b.text)texts.push(b.text);
        else if(b?.type==='tool_use')calls.push({type:'function_call',call_id:b.id,name:b.name,arguments:typeof b.input==='string'?b.input:JSON.stringify(b.input??{})});
      }
      if(texts.length)input.push({type:'message',role:'assistant',content:[{type:'output_text',text:texts.join('\n')}]});
      input.push(...calls);
    }else if(msg.role==='system'&&typeof msg.content==='string'){
      input.push({type:'message',role:'developer',content:[{type:'input_text',text:msg.content}]});
    }
  }
  const out={model:body.model,input,store:false};
  if(instructions)out.instructions=instructions;
  const tools=Array.isArray(body.tools)?body.tools.filter(t=>t&&t.name&&t.input_schema).map(t=>({type:'function',name:t.name,...(t.description?{description:t.description}:{}),parameters:t.input_schema})):[];
  if(tools.length)out.tools=tools;
  if(body.tool_choice&&!(Array.isArray(body.tools)&&!tools.length)){
    const c=body.tool_choice;
    if(c.type==='auto')out.tool_choice='auto';
    else if(c.type==='any')out.tool_choice='required';
    else if(c.type==='none')out.tool_choice='none';
    else if(c.type==='tool'&&c.name)out.tool_choice={type:'function',name:c.name};
  }
  if(body.max_tokens!=null)out.max_output_tokens=body.max_tokens;
  const reasoning=REASONING_MODEL.test(String(body.model||''));
  if(body.temperature!=null&&!reasoning)out.temperature=body.temperature;
  if(body.top_p!=null)out.top_p=body.top_p;
  if(reasoning&&Number.isFinite(body.thinking?.budget_tokens)&&body.thinking.budget_tokens>0){
    const budget=body.thinking.budget_tokens;
    out.reasoning={effort:budget<4000?'low':budget<16000?'medium':'high',summary:'auto'};
  }
  if(body.stream)out.stream=true;
  else if(body.stream===false)out.stream=false;
  return out;
}
function convertResponsesUsage(usage){
  if(!usage||typeof usage!=='object')return{input_tokens:0,output_tokens:0};
  const cached=Number(usage.input_tokens_details?.cached_tokens)||0;
  const out={input_tokens:Math.max(0,(Number(usage.input_tokens)||0)-cached),output_tokens:Number(usage.output_tokens)||0};
  if(cached>0)out.cache_read_input_tokens=cached;
  return out;
}
function mapResponsesStopReason(resp,hasToolUse=false,sawRefusal=false){
  if(hasToolUse)return'tool_use';
  if(resp?.status==='incomplete'){
    const reason=resp.incomplete_details?.reason;
    if(reason==='content_filter')return'refusal';
    return'max_tokens';
  }
  if(sawRefusal)return'refusal';
  return'end_turn';
}
function toAnthropicFromResponses(json={},fallbackModel=''){
  const content=[];let sawRefusal=false;
  for(const item of json.output||[]){
    if(item?.type==='reasoning'){
      const text=(item.summary||[]).filter(s=>s?.text).map(s=>s.text).join('\n')||(item.content||[]).filter(c=>c?.text).map(c=>c.text).join('\n');
      if(text)content.push({type:'thinking',thinking:text,signature:''});
    }else if(item?.type==='message'){
      for(const part of item.content||[]){
        if(part?.type==='output_text'&&part.text)content.push({type:'text',text:part.text});
        else if(part?.type==='refusal'&&part.refusal){sawRefusal=true;content.push({type:'text',text:part.refusal});}
      }
    }else if(item?.type==='function_call'){
      let input={};
      if(typeof item.arguments==='string'&&item.arguments.trim()){try{input=JSON.parse(item.arguments);}catch{input={};}}
      else if(item.arguments&&typeof item.arguments==='object')input=item.arguments;
      content.push({type:'tool_use',id:item.call_id||item.id||'toolu_'+randomUUID().replaceAll('-','').slice(0,24),name:item.name||'',input});
    }
  }
  if(!content.length&&typeof json.output_text==='string'&&json.output_text)content.push({type:'text',text:json.output_text});
  const hasToolUse=content.some(b=>b.type==='tool_use');
  return{id:'msg_'+randomUUID().replaceAll('-','').slice(0,24),type:'message',role:'assistant',model:json.model||fallbackModel||'',content,stop_reason:mapResponsesStopReason(json,hasToolUse,sawRefusal),stop_sequence:null,usage:convertResponsesUsage(json.usage)};
}
class ResponsesStreamAdapter{
  constructor(model=''){
    this.model=model;this.id='msg_'+randomUUID().replaceAll('-','').slice(0,24);
    this.decoder=new TextDecoder();this.pending='';
    this.started=false;this.finished=false;this.failed=false;
    this.blockIndex=-1;this.current=null;
    this.toolById=new Map();this.toolByOutput=new Map();
    this.textDeltas=new Set();
    this.hasToolUse=false;this.sawRefusal=false;this.usage={input_tokens:0,output_tokens:0};
  }
  ensureStart(model){
    if(this.started)return'';
    this.started=true;this.model=model||this.model||'';
    return frame({type:'message_start',message:{id:this.id,type:'message',role:'assistant',model:this.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:0,output_tokens:0}}});
  }
  closeBlock(){
    if(!this.current)return'';
    const index=this.blockIndex;this.current=null;
    return frame({type:'content_block_stop',index});
  }
  openBlock(type,content_block,extra={}){
    let out=this.closeBlock();
    this.blockIndex++;this.current={type,...extra};
    return out+frame({type:'content_block_start',index:this.blockIndex,content_block});
  }
  fail(error){
    if(this.finished)return'';
    this.failed=true;this.finished=true;
    return frame({type:'error',error});
  }
  openTool(item,outputIndex){
    const id=item.call_id||item.id||'toolu_'+randomUUID().replaceAll('-','').slice(0,24);
    let out=this.openBlock('tool_use',{type:'tool_use',id,name:item.name||'',input:{}},{blockIndex:this.blockIndex+1});
    const entry={blockIndex:this.blockIndex,sawDelta:false};
    if(item.id)this.toolById.set(item.id,entry);
    if(outputIndex!=null)this.toolByOutput.set(outputIndex,entry);
    this.hasToolUse=true;
    if(typeof item.arguments==='string'&&item.arguments.length){
      out+=frame({type:'content_block_delta',index:entry.blockIndex,delta:{type:'input_json_delta',partial_json:item.arguments}});
      entry.sawDelta=true;
    }
    return{out,entry};
  }
  findTool(itemId,outputIndex){
    return(itemId&&this.toolById.get(itemId))||(outputIndex!=null?this.toolByOutput.get(outputIndex):null)||null;
  }
  complete(resp){
    if(this.finished)return'';
    this.finished=true;
    if(resp?.model)this.model=resp.model;
    if(resp?.usage)this.usage=convertResponsesUsage(resp.usage);
    let out=this.ensureStart(resp?.model);
    out+=this.closeBlock();
    const stop_reason=mapResponsesStopReason(resp,this.hasToolUse||Boolean(resp?.output?.some(i=>i?.type==='function_call')),this.sawRefusal);
    out+=frame({type:'message_delta',delta:{stop_reason,stop_sequence:null},usage:this.usage});
    out+=frame({type:'message_stop'});
    return out;
  }
  handleEvent(data){
    if(this.finished)return'';
    if(data==='[DONE]')return'';
    let e;
    try{e=JSON.parse(data);}catch{return this.fail({type:'api_error',message:'OpenAI 兼容模式：上游流返回了无法解析的数据'});}
    const type=e?.type;
    if(type==='error'||e?.error){
      const errObj=e.error||e;
      return this.fail(mapError(errObj.status||e.status||500,{error:errObj}).error);
    }
    if(type==='response.failed'){
      const errObj=e.response?.error||{message:'响应生成失败'};
      return this.fail(mapError(errObj.status||500,{error:errObj}).error);
    }
    if(e.response?.model)this.model=e.response.model;
    let out=this.ensureStart(e.response?.model);
    if(type==='response.reasoning_summary_text.delta'||type==='response.reasoning_text.delta'){
      if(typeof e.delta==='string'&&e.delta.length){
        if(this.current?.type!=='thinking')out+=this.openBlock('thinking',{type:'thinking',thinking:'',signature:''});
        out+=frame({type:'content_block_delta',index:this.blockIndex,delta:{type:'thinking_delta',thinking:e.delta}});
      }
    }else if(type==='response.output_text.delta'){
      if(typeof e.delta==='string'&&e.delta.length){
        if(this.current?.type!=='text')out+=this.openBlock('text',{type:'text',text:''});
        out+=frame({type:'content_block_delta',index:this.blockIndex,delta:{type:'text_delta',text:e.delta}});
        this.textDeltas.add(`${e.output_index??0}:${e.content_index??0}`);
      }
    }else if(type==='response.output_text.done'){
      const key=`${e.output_index??0}:${e.content_index??0}`;
      if(!this.textDeltas.has(key)&&typeof e.text==='string'&&e.text.length){
        if(this.current?.type!=='text')out+=this.openBlock('text',{type:'text',text:''});
        out+=frame({type:'content_block_delta',index:this.blockIndex,delta:{type:'text_delta',text:e.text}});
        this.textDeltas.add(key);
      }
    }else if(type==='response.refusal.delta'){
      this.sawRefusal=true;
      if(typeof e.delta==='string'&&e.delta.length){
        if(this.current?.type!=='text')out+=this.openBlock('text',{type:'text',text:''});
        out+=frame({type:'content_block_delta',index:this.blockIndex,delta:{type:'text_delta',text:e.delta}});
      }
    }else if(type==='response.output_item.added'&&e.item?.type==='function_call'){
      out+=this.openTool(e.item,e.output_index).out;
    }else if(type==='response.function_call_arguments.delta'){
      const entry=this.findTool(e.item_id,e.output_index);
      if(entry&&typeof e.delta==='string'&&e.delta.length){
        out+=frame({type:'content_block_delta',index:entry.blockIndex,delta:{type:'input_json_delta',partial_json:e.delta}});
        entry.sawDelta=true;
      }
    }else if(type==='response.function_call_arguments.done'){
      const entry=this.findTool(e.item_id,e.output_index);
      if(entry&&!entry.sawDelta&&typeof e.arguments==='string'&&e.arguments.length){
        out+=frame({type:'content_block_delta',index:entry.blockIndex,delta:{type:'input_json_delta',partial_json:e.arguments}});
        entry.sawDelta=true;
      }
    }else if(type==='response.output_item.done'&&e.item?.type==='function_call'){
      let entry=this.findTool(e.item.id,e.output_index);
      if(!entry){const opened=this.openTool(e.item,e.output_index);out+=opened.out;entry=opened.entry;}
      else if(!entry.sawDelta&&typeof e.item.arguments==='string'&&e.item.arguments.length){
        out+=frame({type:'content_block_delta',index:entry.blockIndex,delta:{type:'input_json_delta',partial_json:e.item.arguments}});
        entry.sawDelta=true;
      }
      if(this.current?.type==='tool_use'&&this.blockIndex===entry.blockIndex)out+=this.closeBlock();
    }else if(type==='response.completed'){
      out+=this.complete(e.response||{status:'completed'});
    }else if(type==='response.incomplete'){
      out+=this.complete({status:'incomplete',...(e.response||{})});
    }
    return out;
  }
  drain(flush=false){
    let out='',end;
    while((end=this.pending.indexOf('\n\n'))>=0){
      const raw=this.pending.slice(0,end);this.pending=this.pending.slice(end+2);
      const data=raw.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
      if(data)out+=this.handleEvent(data);
    }
    if(flush&&this.pending.trim()){
      const raw=this.pending;this.pending='';
      const data=raw.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
      if(data)out+=this.handleEvent(data);
    }
    return out;
  }
  push(chunk){
    const text=typeof chunk==='string'?chunk:this.decoder.decode(chunk,{stream:true});
    this.pending=(this.pending+text).replace(/\r\n/g,'\n');
    return this.drain(false);
  }
  end(){
    const rest=this.decoder.decode();
    if(rest)this.pending=(this.pending+rest).replace(/\r\n/g,'\n');
    let out=this.drain(true);
    if(!this.finished)out+=this.fail({type:'api_error',message:'OpenAI 兼容模式：上游流在完成前意外断开'});
    return out;
  }
}
async function readBody(body){let size=0;const chunks=[];for await(const chunk of body){size+=chunk.length;if(size>LIMIT)throw Error('请求或响应超过大小限制');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}
function upstreamHeaders(reqHeaders,json=false){
  const headers={};
  if(reqHeaders.authorization)headers.authorization=reqHeaders.authorization;
  if(reqHeaders['user-agent'])headers['user-agent']=reqHeaders['user-agent'];
  if(json)headers['content-type']='application/json';
  return headers;
}
function toAnthropicModels(json){
  const list=(json?.data||[]).filter(m=>m&&typeof m.id==='string').map(m=>({
    id:m.id,type:'model',display_name:m.id,
    created_at:typeof m.created_at==='string'?m.created_at:new Date((Number(m.created)||0)*1000).toISOString()
  }));
  return{data:list,has_more:false,first_id:list[0]?.id||null,last_id:list.at(-1)?.id||null};
}
class OpenAICompatProxy{
  constructor({fetch=globalThis.fetch}={}){this.fetch=fetch;this.routes=new Map();this.connections=new Set();}
  async start(){
    if(this.server?.listening)return;
    if(this.starting)return this.starting;
    this.server=http.createServer((req,res)=>this.handle(req,res));
    this.server.on('connection',socket=>{this.connections.add(socket);socket.on('close',()=>this.connections.delete(socket));});
    this.starting=new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',()=>{this.server.removeListener('error',reject);this.server.unref();resolve();});});
    try{await this.starting;}finally{this.starting=null;}
  }
  urlFor(baseUrl,key,format='openai'){
    if(!this.server?.listening)throw Error('OpenAI 兼容服务尚未就绪');
    let route=this.routes.get(key);
    if(!route){route={token:randomBytes(24).toString('hex'),baseUrl:baseUrl.replace(/\/+$/,''),mode:format==='openai-responses'?'responses':'chat'};this.routes.set(key,route);}
    return`http://127.0.0.1:${this.server.address().port}/${route.token}`;
  }
  async handle(req,res){
    const match=req.url.match(/^\/([a-f0-9]{48})(\/v1\/(?:messages(?:\/count_tokens)?|models)(?:\?[^\s]*)?)$/);
    const route=match&&[...this.routes.values()].find(r=>r.token===match[1]);
    if(!route||req.headers.origin||!['GET','POST'].includes(req.method)){res.writeHead(404).end();return;}
    const controller=new AbortController();const cancel=()=>{if(!res.writableFinished)controller.abort();};res.on('close',cancel);
    let ping;
    try{
      const pathname=match[2].split('?')[0];
      if(pathname==='/v1/messages/count_tokens'&&req.method==='POST'){
        const body=await readBody(req);
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({input_tokens:Math.ceil(body.toString('utf8').length/4)}));
        return;
      }
      if(pathname==='/v1/models'&&req.method==='GET'){
        const upstream=await this.fetch(joinUrl(route.baseUrl,'/models'),{method:'GET',headers:upstreamHeaders(req.headers,false),signal:controller.signal,redirect:'manual'});
        if(upstream.status>=300&&upstream.status<400)throw Error('不转发服务商重定向');
        const raw=upstream.body?await readBody(upstream.body):Buffer.alloc(0);
        if(!upstream.ok){res.writeHead(upstream.status,{'content-type':'application/json'}).end(JSON.stringify(mapError(upstream.status,raw)));return;}
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(toAnthropicModels(JSON.parse(raw.toString('utf8')))));
        return;
      }
      if(pathname!=='/v1/messages'||req.method!=='POST'){res.writeHead(404).end();return;}
      const body=await readBody(req),request=JSON.parse(body.toString('utf8'));
      const isResponses=route.mode==='responses';
      const payload=JSON.stringify(isResponses?toOpenAIResponsesRequest(request):toOpenAIRequest(request));
      const upstream=await this.fetch(joinUrl(route.baseUrl,isResponses?'/responses':'/chat/completions'),{method:'POST',headers:upstreamHeaders(req.headers,true),body:payload,signal:controller.signal,redirect:'manual'});
      if(upstream.status>=300&&upstream.status<400)throw Error('不转发服务商重定向');
      if(!upstream.ok){
        const raw=upstream.body?await readBody(upstream.body):Buffer.alloc(0);
        res.writeHead(upstream.status,{'content-type':'application/json'}).end(JSON.stringify(mapError(upstream.status,raw)));
        return;
      }
      const type=upstream.headers.get('content-type')||'application/json';
      if(type.includes('text/event-stream')){
        res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache'});
        ping=setInterval(()=>res.write(frame({type:'ping'})),10000);ping.unref();
        const adapter=isResponses?new ResponsesStreamAdapter(request.model):new StreamAdapter(request.model);let bytes=0;
        for await(const chunk of upstream.body){
          bytes+=chunk.byteLength;if(bytes>LIMIT)throw Error('响应超过大小限制');
          const out=adapter.push(chunk);if(out)res.write(out);
        }
        const tail=adapter.end();if(tail)res.write(tail);
        res.end();
      }else{
        const raw=upstream.body?await readBody(upstream.body):Buffer.alloc(0);
        const parsed=JSON.parse(raw.toString('utf8'));
        const msg=isResponses?toAnthropicFromResponses(parsed,request.model):toAnthropicMessage(parsed,request.model);
        if(request.stream)res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache'}).end(messageSSE(msg));
        else res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(msg));
      }
    }catch(e){
      if(controller.signal.aborted||res.destroyed)return;
      const error={type:'error',error:{type:'invalid_request_error',message:'OpenAI 兼容模式：'+(e.message||'响应处理失败')}};
      if(res.headersSent)res.end(frame(error));else res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify(error));
    }finally{clearInterval(ping);res.removeListener('close',cancel);}
  }
  close(){for(const socket of this.connections)socket.destroy();this.server?.close();this.routes.clear();}
}
module.exports={OpenAICompatProxy,StreamAdapter,ResponsesStreamAdapter,toOpenAIRequest,toOpenAIResponsesRequest,toAnthropicMessage,toAnthropicFromResponses,mapError,joinUrl,messageSSE};
