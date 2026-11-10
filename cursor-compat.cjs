// Opt-in response adapter. Claude Code still owns execution, permissions and results.
const http=require('node:http');
const {randomBytes,randomUUID}=require('node:crypto');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const Ajv=require('ajv');
const Ajv2020=require('ajv/dist/2020');
const LIMIT=64*1024*1024;
const entities=value=>value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,name)=>{
  if(name[0]==='#'){const code=name[1].toLowerCase()==='x'?parseInt(name.slice(2),16):Number(name.slice(1));if(code>0x10ffff||code<0)throw Error('无效的工具参数字符');return String.fromCodePoint(code);}
  return{amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[name.toLowerCase()];
});
function candidate(text){
  let fence=null,offset=0;
  for(const line of text.split('\n')){
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if(fence){if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;}
    else if(marker)fence=marker[1];
    else{const match=line.match(/^ {0,3}(?:<function_calls>\s*)?(<invoke\b)/);if(match)return offset+match[0].lastIndexOf('<invoke');}
    offset+=line.length+1;
  }
  return -1;
}
function parseInvocation(text,tools,complete=true){
  const start=candidate(text);if(start<0)return null;
  const pending=()=>{if(complete)throw Error('Cursor 兼容模式：工具调用不完整，未执行');return null;};
  const head=text.slice(start).match(/^<invoke\s+name=(["'])([\w.:-]+)\1\s*>/);
  if(!head)return pending();
  const tool=tools.find(t=>t.name===head[2]&&t.input_schema);
  if(!tool)throw Error('Cursor 兼容模式：调用了本次请求未声明的工具 '+head[2]);
  let rest=text.slice(start+head[0].length);const input=Object.create(null);
  while(true){
    rest=rest.trimStart();if(rest.startsWith('</invoke>'))break;
    const param=rest.match(/^<parameter\s+name=(["'])([\w.-]+)\1\s*>/);if(!param)return pending();
    if(['__proto__','prototype','constructor'].includes(param[2])||Object.hasOwn(input,param[2]))throw Error('Cursor 兼容模式：重复或无效的参数名');
    const end=rest.indexOf('</parameter>',param[0].length);if(end<0)return pending();
    const raw=entities(rest.slice(param[0].length,end)),schema=tool.input_schema.properties?.[param[2]];
    let value=raw;
    if(schema&&schema.type&&schema.type!=='string'&&!(Array.isArray(schema.type)&&schema.type.includes('string'))){
      try{value=JSON.parse(raw);}catch{throw Error('Cursor 兼容模式：参数 '+param[2]+' 不是有效的 JSON 值');}
    }
    input[param[2]]=value;rest=rest.slice(end+'</parameter>'.length);
  }
  const Validator=tool.input_schema.$schema?.includes('2020-12')?Ajv2020:Ajv;
  const validate=new Validator({strict:false,useDefaults:true,validateFormats:false}).compile(tool.input_schema);
  if(!validate(input))throw Error('Cursor 兼容模式：'+head[2]+' 参数不符合工具定义（'+validate.errors.map(e=>e.instancePath+' '+e.message).join('; ')+')');
  return{start,name:tool.name,input};
}
function repairMessage(message,request,complete=true){
  if(message.content?.some(b=>b.type==='tool_use'||b.type==='server_tool_use'))return null;
  const content=[];
  for(const block of message.content||[]){
    if(block.type!=='text'){content.push(block);continue;}
    const call=parseInvocation(block.text||'',request.tools||[],complete);
    if(!call){content.push(block);continue;}
    if(request.tool_choice?.type==='none'||request.tool_choice?.type==='tool'&&request.tool_choice.name!==call.name)throw Error('Cursor 兼容模式：调用不符合本次工具选择限制');
    const prefix=block.text.slice(0,call.start).replace(/<function_calls>\s*$/,'').trimEnd();
    if(prefix)content.push({type:'text',text:prefix});
    content.push({type:'tool_use',id:'toolu_compat_'+randomUUID().replaceAll('-',''),name:call.name,input:call.input});
    // Only the first complete call is used. Any claimed results or later calls are discarded.
    return{...message,content,stop_reason:'tool_use',stop_sequence:null};
  }
  return null;
}
const frame=value=>`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
function messageSSE(message){
  let out=frame({type:'message_start',message:{...message,content:[],stop_reason:null,stop_sequence:null}});
  message.content.forEach((block,index)=>{
    let start=block;const deltas=[];
    if(block.type==='tool_use'){start={...block,input:{}};deltas.push({type:'input_json_delta',partial_json:JSON.stringify(block.input)});}
    if(block.type==='text'){start={...block,text:''};deltas.push({type:'text_delta',text:block.text});}
    if(block.type==='thinking'){start={...block,thinking:'',signature:''};deltas.push({type:'thinking_delta',thinking:block.thinking});if(block.signature)deltas.push({type:'signature_delta',signature:block.signature});}
    out+=frame({type:'content_block_start',index,content_block:start});
    for(const delta of deltas)out+=frame({type:'content_block_delta',index,delta});
    out+=frame({type:'content_block_stop',index});
  });
  return out+frame({type:'message_delta',delta:{stop_reason:message.stop_reason,stop_sequence:message.stop_sequence},usage:message.usage||{}})+frame({type:'message_stop'});
}
async function adaptSSE(body,request){
  const decoder=new TextDecoder(),blocks=new Map();let pending='',raw='',bytes=0,message=null,done=false,error=false;
  const current=()=>({...message,content:[...blocks].sort((a,b)=>a[0]-b[0]).map(([,b])=>b)});
  for await(const chunk of body){
    bytes+=chunk.byteLength;if(bytes>LIMIT)throw Error('Cursor 兼容响应超过大小限制');
    const text=decoder.decode(chunk,{stream:true});raw+=text;pending=(pending+text).replace(/\r\n/g,'\n');
    let end;
    while((end=pending.indexOf('\n\n'))>=0){
      const data=pending.slice(0,end).split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');pending=pending.slice(end+2);
      if(!data||data==='[DONE]')continue;
      const e=JSON.parse(data);
      if(e.type==='message_start')message={...e.message};
      if(e.type==='error')error=true;
      if(e.type==='content_block_start')blocks.set(e.index,structuredClone(e.content_block));
      if(e.type==='content_block_delta'){
        const b=blocks.get(e.index);if(!b)throw Error('Cursor 兼容响应缺少内容块');
        const key={text_delta:'text',thinking_delta:'thinking',signature_delta:'signature'}[e.delta.type];
        if(key)b[key]=(b[key]||'')+(e.delta[key]||'');
      }
      if(e.type==='message_delta'&&message){Object.assign(message,e.delta);message.usage={...message.usage,...e.usage};}
      if(e.type==='message_stop')done=true;
      if(message&&!error){const repaired=repairMessage(current(),request,done);if(repaired)return{body:messageSSE(repaired),converted:true};}
    }
  }
  if(!error&&!done)throw Error('Cursor 兼容响应意外结束，未执行不完整的调用');
  return{body:raw,converted:false};
}
async function readBody(body){let size=0;const chunks=[];for await(const chunk of body){size+=chunk.length;if(size>LIMIT)throw Error('请求或响应超过大小限制');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}
class CursorCompatProxy{
  constructor({fetch=globalThis.fetch}={}){this.fetch=fetch;this.routes=new Map();this.connections=new Set();}
  async start(){
    if(this.server?.listening)return;
    if(this.starting)return this.starting;
    this.server=http.createServer((req,res)=>this.handle(req,res));
    this.server.on('connection',socket=>{this.connections.add(socket);socket.on('close',()=>this.connections.delete(socket));});
    this.starting=new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',()=>{this.server.removeListener('error',reject);this.server.unref();resolve();});});
    try{await this.starting;}finally{this.starting=null;}
  }
  urlFor(baseUrl,key){
    if(!this.server?.listening)throw Error('Cursor 兼容服务尚未就绪');
    let route=this.routes.get(key);
    if(!route){route={token:randomBytes(24).toString('hex'),baseUrl:baseUrl.replace(/\/+$/,'')};this.routes.set(key,route);}
    return`http://127.0.0.1:${this.server.address().port}/${route.token}`;
  }
  async handle(req,res){
    const match=req.url.match(/^\/([a-f0-9]{48})(\/v1\/(?:messages(?:\/count_tokens)?|models)(?:\?[^\s]*)?)$/);
    const route=match&&[...this.routes.values()].find(r=>r.token===match[1]);
    if(!route||req.headers.origin||!['GET','POST'].includes(req.method)){res.writeHead(404).end();return;}
    const controller=new AbortController();const cancel=()=>{if(!res.writableFinished)controller.abort();};res.on('close',cancel);
    let ping;
    try{
      const body=await readBody(req),headers={};
      for(const [key,value]of Object.entries(req.headers))if(!['host','connection','content-length','transfer-encoding','keep-alive','te','trailer','upgrade','proxy-connection','accept-encoding','cookie','origin','referer','proxy-authorization'].includes(key)&&value!==undefined)headers[key]=value;
      const isMessage=/^\/v1\/messages(?:\?|$)/.test(match[2])&&req.method==='POST';
      const request=isMessage?JSON.parse(body.toString('utf8')):null;
      const upstream=await this.fetch(route.baseUrl+match[2],{method:req.method,headers,body:req.method==='GET'?undefined:body,signal:controller.signal,redirect:'manual'});
      if(upstream.status>=300&&upstream.status<400)throw Error('Cursor 兼容模式不转发服务商重定向');
      const type=upstream.headers.get('content-type')||'application/json';
      if(!upstream.ok||!isMessage){res.writeHead(upstream.status,{'content-type':type});if(upstream.body)await pipeline(Readable.fromWeb(upstream.body),res);else res.end();return;}
      if(type.includes('text/event-stream')){
        res.writeHead(upstream.status,{'content-type':type,'cache-control':'no-cache'});
        ping=setInterval(()=>res.write(frame({type:'ping'})),10000);ping.unref();
        const result=await adaptSSE(upstream.body,request);res.end(result.body);if(result.converted)controller.abort();
      }else{
        const message=JSON.parse((await readBody(upstream.body)).toString('utf8'));
        const output=JSON.stringify(repairMessage(message,request)||message);
        res.writeHead(upstream.status,{'content-type':'application/json'}).end(output);
      }
    }catch(e){
      if(controller.signal.aborted||res.destroyed)return;
      // The CLI receives an API error, never a guessed or partially parsed call.
      const error={type:'error',error:{type:'invalid_request_error',message:'Cursor 兼容模式：'+(e.message||'响应处理失败')}};
      if(res.headersSent)res.end(frame(error));else res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify(error));
    }finally{clearInterval(ping);res.removeListener('close',cancel);}
  }
  close(){for(const socket of this.connections)socket.destroy();this.server?.close();this.routes.clear();}
}
module.exports={CursorCompatProxy,parseInvocation,repairMessage,adaptSSE,messageSSE};
