// Custom providers (服务商): an Anthropic-compatible endpoint with its own key, used
// instead of what ~/.claude/settings.json sets. Keys are encrypted by the system
// (Electron safeStorage, DPAPI on Windows) and never go to the window. The CLI gets
// the active provider in its environment and in its flag settings, which outrank the
// user's settings file.
const {randomUUID,createHash}=require('node:crypto');
const {joinUrl}=require('./openai-compat.cjs');
const AUTH_TYPES=new Set(['token','key']);
const FORMATS=new Set(['anthropic','openai']);
const formatOf=value=>FORMATS.has(value)?value:'anthropic';
const MODEL=/^[\w.:/\-\[\]]{1,150}$/;

function cleanModels(value){
  const list=(Array.isArray(value)?value:String(value||'').split(/[\s,，]+/)).map(x=>String(x).trim()).filter(Boolean);
  const bad=list.find(x=>!MODEL.test(x));if(bad)throw Error('模型 ID 不合法：'+bad.slice(0,60));
  return[...new Set(list)].slice(0,50);
}
function cleanUrl(value){
  let url;try{url=new URL(String(value||'').trim());}catch{throw Error('Base URL 格式不对，例如 https://api.example.com');}
  if(!['http:','https:'].includes(url.protocol))throw Error('Base URL 需要以 http:// 或 https:// 开头');
  return url.href.replace(/\/+$/,'');
}

class Providers{
  constructor({store,safeStorage,fetch=globalThis.fetch,cursorProxy=null,openaiProxy=null}){Object.assign(this,{store,safeStorage,fetch,cursorProxy,openaiProxy});}
  get settings(){return this.store.state.settings;}
  get all(){return Array.isArray(this.settings.providers)?this.settings.providers:[];}
  // What the window sees: everything but the key.
  list(){return{active:this.activeId(),providers:this.all.map(({key,...p})=>({...p,format:formatOf(p.format),hasKey:Boolean(key)}))};}
  activeId(){const id=this.settings.provider;return this.all.some(p=>p.id===id)?id:'';}
  encrypt(text){
    if(!this.safeStorage?.isEncryptionAvailable())throw Error('系统加密不可用，无法安全保存密钥');
    return'enc:'+this.safeStorage.encryptString(text).toString('base64');
  }
  decrypt(value){
    if(!value)return'';
    if(!value.startsWith('enc:'))throw Error('密钥格式无法识别，请重新填写');
    try{return this.safeStorage.decryptString(Buffer.from(value.slice(4),'base64'));}catch{throw Error('密钥无法解密（可能换了电脑或 Windows 账户），请重新填写');}
  }
  // `input.key` blank keeps the saved key when editing.
  save(input={}){
    const name=String(input.name||'').trim().slice(0,40);if(!name)throw Error('请填写服务商名称');
    const format=formatOf(input.format),baseUrl=cleanUrl(input.baseUrl);
    const authType=format==='openai'?'token':(AUTH_TYPES.has(input.authType)?input.authType:'token');
    const models=cleanModels(input.models),fastModel=String(input.fastModel||'').trim();
    if(fastModel&&!MODEL.test(fastModel))throw Error('快速模型 ID 不合法');
    const existing=input.id&&this.all.find(p=>p.id===input.id);
    if(input.id&&!existing)throw Error('服务商不存在');
    const typed=String(input.key||'').trim();
    if(!typed&&!existing?.key)throw Error('请填写密钥');
    if(typed.length>4000)throw Error('密钥太长');
    const cursorCompat=format==='openai'?false:input.cursorCompat===true;
    const provider={id:existing?.id||randomUUID(),name,format,baseUrl,authType,models,fastModel,cursorCompat,key:typed?this.encrypt(typed):existing.key};
    this.settings.providers=existing?this.all.map(p=>p===existing?provider:p):[...this.all,provider];
    this.store.save();return provider.id;
  }
  remove(id){
    if(!this.all.some(p=>p.id===id))return false;
    this.settings.providers=this.all.filter(p=>p.id!==id);if(this.settings.provider===id)delete this.settings.provider;
    this.store.save();return true;
  }
  setActive(id){
    if(id&&!this.all.some(p=>p.id===id))throw Error('服务商不存在');
    if(id)this.settings.provider=id;else delete this.settings.provider;
    this.store.save();return this.activeId();
  }
  active(){const p=this.all.find(x=>x.id===this.activeId());return p?{...p,format:formatOf(p.format),key:this.decrypt(p.key)}:null;}
  // For the engine: environment, flag settings and a key that changes with any of them
  // (a hash, so the secret never lands in comparisons or logs). null: Claude Code's own setup.
  options(){
    let p;try{p=this.active();}catch{return null;}
    if(!p)return null;
    const format=formatOf(p.format),authType=format==='openai'?'token':p.authType;
    const env={ANTHROPIC_BASE_URL:p.baseUrl,ANTHROPIC_AUTH_TOKEN:authType==='token'?p.key:'',ANTHROPIC_API_KEY:authType==='key'?p.key:''};
    const firstModel=Array.isArray(p.models)&&p.models[0]||'';
    const fast=p.fastModel||(format==='openai'?firstModel:'');
    if(fast)Object.assign(env,{ANTHROPIC_DEFAULT_HAIKU_MODEL:fast,ANTHROPIC_SMALL_FAST_MODEL:fast});
    if(format==='openai'&&firstModel)Object.assign(env,{ANTHROPIC_DEFAULT_SONNET_MODEL:firstModel,ANTHROPIC_DEFAULT_OPUS_MODEL:firstModel});
    const cursorCompat=format==='openai'?false:Boolean(p.cursorCompat);
    const key=p.id+':'+createHash('sha256').update(JSON.stringify([env,cursorCompat,format])).digest('hex').slice(0,16);
    if(format==='openai'){
      if(!this.openaiProxy)throw Error('OpenAI 兼容服务不可用');
      env.ANTHROPIC_BASE_URL=this.openaiProxy.urlFor(p.baseUrl,key);
      env.NO_PROXY=[process.env.NO_PROXY||process.env.no_proxy,'127.0.0.1','localhost'].filter(Boolean).join(',');
      env.no_proxy=env.NO_PROXY;
    }else if(cursorCompat){
      if(!this.cursorProxy)throw Error('Cursor 兼容服务不可用');
      env.ANTHROPIC_BASE_URL=this.cursorProxy.urlFor(p.baseUrl,key);
      env.NO_PROXY=[process.env.NO_PROXY||process.env.no_proxy,'127.0.0.1','localhost'].filter(Boolean).join(',');
      env.no_proxy=env.NO_PROXY;
    }
    return{key,name:p.name,env,settings:{env}};
  }
  headers(authType,key){return authType==='token'?{Authorization:`Bearer ${key}`,'anthropic-version':'2023-06-01'}:{'x-api-key':key,'anthropic-version':'2023-06-01'};}
  // Reads /v1/models with the given (unsaved) settings, or the saved provider's when `input.id` is set and no key is typed.
  async models(input){
    const saved=input.id&&this.all.find(p=>p.id===input.id);
    const format=formatOf(input.format!==undefined?input.format:saved?.format);
    const baseUrl=cleanUrl(input.baseUrl||saved?.baseUrl),authType=format==='openai'?'token':(AUTH_TYPES.has(input.authType)?input.authType:saved?.authType||'token');
    const key=String(input.key||'').trim()||(saved?this.decrypt(saved.key):'');if(!key)throw Error('请填写密钥');
    const url=format==='openai'?joinUrl(baseUrl,'/models'):baseUrl+'/v1/models';
    const headers=format==='openai'?{Authorization:`Bearer ${key}`}:this.headers(authType,key);
    const response=await this.fetch(url,{signal:AbortSignal.timeout(15000),headers});
    if(!response.ok)throw Error(response.status===401||response.status===403?`密钥被拒绝（HTTP ${response.status}）`:`连接失败：HTTP ${response.status}`);
    const json=await response.json().catch(()=>({}));
    return(json.data||[]).map(x=>x?.id).filter(x=>typeof x==='string'&&MODEL.test(x));
  }
}
module.exports={Providers,cleanModels,cleanUrl};
