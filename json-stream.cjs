const fs=require('./disk-fs.cjs');const path=require('node:path');
const STRING_PART=8192,CHUNK_SIZE=256*1024;
// Split before a surrogate pair, so each independently encoded piece is valid.
function* stringParts(text){
  for(let at=0;at<text.length;){let end=Math.min(text.length,at+STRING_PART);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end--;yield text.slice(at,end);at=end;}
}
const omitted=value=>value===undefined||typeof value==='function'||typeof value==='symbol';
function converted(value,key){return value&&typeof value.toJSON==='function'?value.toJSON(key):value;}
function* jsonPieces(value,seen=new Set(),key=''){
  value=converted(value,key);
  if(value===null||typeof value!=='object'){
    if(typeof value==='string'){yield '"';for(const part of stringParts(value))yield JSON.stringify(part).slice(1,-1);yield '"';}
    else yield JSON.stringify(value)??'null';
    return;
  }
  if(seen.has(value))throw TypeError('Converting circular structure to JSON');seen.add(value);
  const array=Array.isArray(value);yield array?'[':'{';let first=true;
  for(const entry of array?value.keys():Object.keys(value)){
    const item=converted(value[entry],String(entry));if(!array&&omitted(item))continue;
    if(!first)yield ',';first=false;
    if(!array){yield* jsonPieces(String(entry));yield ':';}
    yield* jsonPieces(item,seen,String(entry));
  }
  yield array?']':'}';seen.delete(value);
}
function* chunks(pieces){let buffer='';for(const piece of pieces){buffer+=piece;if(buffer.length>=CHUNK_SIZE){yield buffer;buffer='';}}if(buffer)yield buffer;}
function jsonChunks(value){return chunks(jsonPieces(value));}
// SQLite records use a bounded token stream. A turn can exceed the string limit:
// decoding rebuilds its object directly, without joining a turn-sized JSON string.
function* treeTokens(value,seen=new Set(),key=''){
  value=converted(value,key);
  if(typeof value==='string'&&value.length>STRING_PART){yield '[5]\n';for(const part of stringParts(value))yield JSON.stringify([6,part])+'\n';yield '[4]\n';return;}
  if(value===null||typeof value!=='object'){yield JSON.stringify([3,omitted(value)?null:value])+'\n';return;}
  if(seen.has(value))throw TypeError('Converting circular structure to JSON');seen.add(value);
  const array=Array.isArray(value);yield array?'[1]\n':'[0]\n';
  for(const entry of array?value.keys():Object.keys(value)){
    const item=converted(value[entry],String(entry));if(!array&&omitted(item))continue;
    if(!array)yield JSON.stringify([2,String(entry)])+'\n';
    yield* treeTokens(item,seen,String(entry));
  }
  yield '[4]\n';seen.delete(value);
}
function recordChunks(value){return chunks(treeTokens(value));}
function readRecord(parts){
  const stack=[];let root,assigned=false;
  const put=value=>{const frame=stack.at(-1);if(!frame){if(assigned)throw Error('会话记录有多余内容');root=value;assigned=true;}else if(frame.type===1)frame.value.push(value);else if(frame.type===0&&frame.key!==undefined){Object.defineProperty(frame.value,frame.key,{value,writable:true,enumerable:true,configurable:true});frame.key=undefined;}else throw Error('会话记录格式无效');};
  for(const part of parts)for(const line of part.split('\n')){
    if(!line)continue;const [type,value]=JSON.parse(line);
    if(type===0||type===1){const item=type===1?[]:{};put(item);stack.push({type,value:item});}
    else if(type===2){const frame=stack.at(-1);if(frame?.type!==0||frame.key!==undefined)throw Error('会话记录键无效');frame.key=value;}
    else if(type===3)put(value);
    else if(type===5)stack.push({type,value:[]});
    else if(type===6){const frame=stack.at(-1);if(frame?.type!==5)throw Error('会话文本分块无效');frame.value.push(value);}
    else if(type===4){const frame=stack.pop();if(!frame||frame.key!==undefined)throw Error('会话记录未完成');if(frame.type===5)put(frame.value.join(''));}
    else throw Error('未知会话记录类型');
  }
  if(stack.length||!assigned)throw Error('会话记录不完整');return root;
}
function writeJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp',fd=fs.openSync(temp,'w');
  try{for(const chunk of jsonChunks(value))fs.writeFileSync(fd,chunk);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);
}
// Match the existing tail budget without ever serializing the whole history.
function historyTail(turns,budget=120000){
  let tail=']';let found=false;
  for(let at=turns.length-1;at>=0;at--){const x=turns[at];if(!x.answer&&!x.tools?.length)continue;
    const entry={user:x.user,...(x.images?.length?{images:`[附带 ${x.images.length} 张图片，图片本身未包含在历史中]`}:{}),context:x.context,answer:x.toolProtocolAborted?'[本轮因工具调用异常而中止，正文中的工具调用和结果未被执行。]':x.answer,tools:x.tools?.map(y=>({name:y.name,input:y.input,output:y.output}))};
    let text='';for(const chunk of jsonChunks(entry))text=(text+chunk).slice(-budget);
    tail=(text+(found?',':'')+tail).slice(-budget);found=true;if(tail.length===budget)break;
  }
  return found?('['+tail).slice(-budget):'';
}
module.exports={jsonChunks,recordChunks,readRecord,writeJson,historyTail};
