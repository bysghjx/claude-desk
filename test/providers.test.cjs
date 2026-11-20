const {test}=require('node:test');const assert=require('node:assert/strict');
const {Providers,cleanModels}=require('../providers.cjs');

const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('X'+s),decryptString:b=>b.toString().slice(1)};
const setup=(extra={})=>{const store={state:{settings:{}},saves:0,save(){this.saves++;}};return{store,providers:new Providers({store,safeStorage,...extra})};};

test('providers keep keys encrypted, out of the window, and kept when editing with a blank key',()=>{
  const {store,providers}=setup();
  const id=providers.save({name:'Relay',baseUrl:'https://relay.example.com/',authType:'token',key:'sk-secret-1',models:'claude-opus-5-5, claude-sonnet-5-5\nclaude-opus-5-5'});
  const saved=store.state.settings.providers[0];
  assert.equal(saved.baseUrl,'https://relay.example.com');assert.deepEqual(saved.models,['claude-opus-5-5','claude-sonnet-5-5']);
  assert.ok(saved.key.startsWith('enc:'));assert.doesNotMatch(JSON.stringify(store.state),/sk-secret-1/);
  const listed=providers.list();assert.equal(listed.active,'');assert.equal(listed.providers[0].hasKey,true);assert.equal('key' in listed.providers[0],false);
  providers.save({id,name:'Relay 2',baseUrl:'https://relay.example.com',authType:'key',key:''});
  assert.equal(providers.all[0].name,'Relay 2');assert.equal(providers.decrypt(providers.all[0].key),'sk-secret-1');
  assert.throws(()=>providers.save({name:'x',baseUrl:'ftp://a',key:'k'}),/http/);
  assert.throws(()=>providers.save({name:'x',baseUrl:'https://a'}),/密钥/);
  assert.throws(()=>cleanModels('ok bad"model'),/不合法/);
});

test('only the active provider reaches the CLI, and its key changes with its settings',()=>{
  const {providers}=setup();
  assert.equal(providers.options(),null,'without one, Claude Code uses its own setup');
  const id=providers.save({name:'Relay',baseUrl:'https://relay.example.com',authType:'token',key:'tok',fastModel:'claude-haiku-5-5'});
  providers.setActive(id);
  const options=providers.options();
  assert.deepEqual(options.env,{ANTHROPIC_BASE_URL:'https://relay.example.com',ANTHROPIC_AUTH_TOKEN:'tok',ANTHROPIC_API_KEY:'',ANTHROPIC_DEFAULT_HAIKU_MODEL:'claude-haiku-5-5',ANTHROPIC_SMALL_FAST_MODEL:'claude-haiku-5-5'});
  assert.deepEqual(options.settings,{env:options.env});assert.doesNotMatch(options.key,/tok/);
  providers.save({id,name:'Relay',baseUrl:'https://relay.example.com',authType:'key',key:'other'});
  assert.notEqual(providers.options().key,options.key);assert.equal(providers.options().env.ANTHROPIC_API_KEY,'other');
  providers.remove(id);assert.equal(providers.options(),null);assert.equal(providers.activeId(),'');
});

test('testing a provider reads its models with the right header',async()=>{
  const calls=[];const fetch=async(url,init)=>{calls.push([url,init.headers]);return{ok:true,json:async()=>({data:[{id:'m-1'},{id:'bad model'}]})};};
  const {providers}=setup({fetch});
  assert.deepEqual(await providers.models({baseUrl:'https://a.example.com',authType:'key',key:'k1'}),['m-1']);
  assert.equal(calls[0][0],'https://a.example.com/v1/models');assert.equal(calls[0][1]['x-api-key'],'k1');
  const id=providers.save({name:'A',baseUrl:'https://a.example.com',authType:'token',key:'k2'});
  await providers.models({id});assert.equal(calls[1][1].Authorization,'Bearer k2');
  const denied=setup({fetch:async()=>({ok:false,status:401})}).providers;
  await assert.rejects(()=>denied.models({baseUrl:'https://a.example.com',key:'x'}),/密钥被拒绝/);
});

test('Cursor compatibility is opt-in, survives editing, and changing it invalidates live CLI settings',()=>{
  const routes=[];const {providers}=setup({cursorProxy:{urlFor:(url,key)=>{routes.push([url,key]);return'http://127.0.0.1:32100/test-token';}}});
  const value={name:'Relay',baseUrl:'https://relay.example.com',authType:'key',key:'test-secret'};
  const id=providers.save(value);providers.setActive(id);const native=providers.options();
  assert.equal(providers.list().providers[0].cursorCompat,false);assert.equal(routes.length,0);
  providers.save({...value,id,key:'',cursorCompat:true});const compat=providers.options();
  assert.equal(compat.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:32100/test-token');assert.equal(compat.settings.env,compat.env);
  assert.equal(compat.env.ANTHROPIC_API_KEY,'test-secret');assert.match(compat.env.NO_PROXY,/127\.0\.0\.1/);assert.notEqual(compat.key,native.key);
  assert.equal(routes[0][0],value.baseUrl);assert.equal(providers.list().providers[0].cursorCompat,true);
  providers.save({...value,id,key:'',cursorCompat:false});assert.equal(providers.options().env.ANTHROPIC_BASE_URL,value.baseUrl);
});

test('OpenAI-compatible providers force token auth, disable Cursor compat, route via openaiProxy and set default models',async()=>{
  const routes=[],calls=[];
  const fetch=async(url,init)=>{calls.push([url,init.headers]);return{ok:true,json:async()=>({data:[{id:'gpt-5'},{id:'gpt-5-mini'}]})};};
  const {store,providers}=setup({fetch,openaiProxy:{urlFor:(url,key)=>{routes.push([url,key]);return'http://127.0.0.1:32200/openai-tok';}}});
  // Legacy provider without format defaults to anthropic.
  store.state.settings.providers=[{id:'old-1',name:'Legacy',baseUrl:'https://legacy.example.com',authType:'key',models:[],fastModel:'',cursorCompat:false,key:providers.encrypt('sk-old')}];
  assert.equal(providers.list().providers[0].format,'anthropic');
  // Saving an OpenAI provider forces token auth and cursorCompat:false.
  const id=providers.save({name:'OpenAI',format:'openai',baseUrl:'https://api.openai.com/v1',authType:'key',cursorCompat:true,key:'sk-oa',models:'gpt-5\ngpt-5-mini'});
  const listed=providers.list().providers.find(p=>p.id===id);
  assert.equal(listed.format,'openai');assert.equal(listed.authType,'token');assert.equal(listed.cursorCompat,false);
  providers.setActive(id);
  const oa=providers.options();
  assert.equal(oa.env.ANTHROPIC_BASE_URL,'http://127.0.0.1:32200/openai-tok');
  assert.equal(oa.env.ANTHROPIC_AUTH_TOKEN,'sk-oa');assert.equal(oa.env.ANTHROPIC_API_KEY,'');
  assert.equal(oa.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,'gpt-5');assert.equal(oa.env.ANTHROPIC_SMALL_FAST_MODEL,'gpt-5');
  assert.equal(oa.env.ANTHROPIC_DEFAULT_SONNET_MODEL,'gpt-5');assert.equal(oa.env.ANTHROPIC_DEFAULT_OPUS_MODEL,'gpt-5');
  assert.match(oa.env.NO_PROXY,/127\.0\.0\.1/);assert.equal(routes[0][0],'https://api.openai.com/v1');
  // Explicit fastModel overrides Haiku/small-fast while keeping Sonnet/Opus on first model.
  providers.save({id,name:'OpenAI',format:'openai',baseUrl:'https://api.openai.com/v1',key:'',models:'gpt-5\ngpt-5-mini',fastModel:'gpt-5-mini'});
  const withFast=providers.options();
  assert.equal(withFast.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,'gpt-5-mini');assert.equal(withFast.env.ANTHROPIC_SMALL_FAST_MODEL,'gpt-5-mini');
  assert.equal(withFast.env.ANTHROPIC_DEFAULT_SONNET_MODEL,'gpt-5');assert.notEqual(withFast.key,oa.key);
  // Switching format back to anthropic changes cache key and stops using openaiProxy.
  providers.save({id,name:'OpenAI',format:'anthropic',baseUrl:'https://api.openai.com/v1',key:'',models:'gpt-5'});
  const anth=providers.options();
  assert.notEqual(anth.key,withFast.key);assert.equal(anth.env.ANTHROPIC_BASE_URL,'https://api.openai.com/v1');
  // models() joins /models correctly with or without /v1 and uses Bearer only.
  await providers.models({format:'openai',baseUrl:'https://api.openai.com/v1',authType:'key',key:'sk-1'});
  await providers.models({format:'openai',baseUrl:'https://api.deepseek.com',authType:'key',key:'sk-2'});
  assert.equal(calls[0][0],'https://api.openai.com/v1/models');assert.deepEqual(calls[0][1],{Authorization:'Bearer sk-1'});
  assert.equal(calls[1][0],'https://api.deepseek.com/v1/models');assert.deepEqual(calls[1][1],{Authorization:'Bearer sk-2'});
  // UI list renders OpenAI format label.
  const {providerListHtml}=await import('../ui/src/views/providers.mjs');
  const html=providerListHtml({active:'',providers:[{id:'1',name:'DS',format:'openai',baseUrl:'https://api.deepseek.com/v1',authType:'token',models:['deepseek-chat']}]});
  assert.match(html,/OpenAI 格式/);
});
