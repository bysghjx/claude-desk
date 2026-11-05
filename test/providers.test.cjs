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
