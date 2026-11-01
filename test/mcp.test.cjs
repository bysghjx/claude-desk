const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {McpManager}=require('../mcp.cjs');
function setup(){const home=fs.mkdtempSync(path.join(os.tmpdir(),'desk-mcp-'));const cwd=path.join(home,'project');fs.mkdirSync(cwd);const calls=[];const extensions={home,changed(){this.revision=(this.revision||0)+1;},async command(args,dir){calls.push({args,dir});return 'shared: https://secret.example/?token=SECRET - ✓ Connected\nlocal: command SECRET - ✗ Failed to connect';}};return{home,cwd,calls,extensions,mcp:new McpManager(extensions)};}
test('MCP catalogue shows scope precedence without returning endpoints or credentials',async()=>{
  const {home,cwd,mcp}=setup();fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({mcpServers:{shared:{type:'http',url:'https://secret',headers:{Authorization:'SECRET'}}},projects:{[cwd]:{mcpServers:{local:{command:'secret-command',env:{KEY:'SECRET'}}}}}}));fs.writeFileSync(path.join(cwd,'.mcp.json'),JSON.stringify({mcpServers:{shared:{type:'http',url:'https://project'}}}));
  const rows=mcp.list(cwd);assert.equal(rows.length,3);assert.equal(rows.find(r=>r.scope==='user').shadowed,true);assert.doesNotMatch(JSON.stringify(rows),/SECRET|https:|secret-command/);
  const checked=await mcp.check(cwd);assert.equal(checked.find(r=>r.name==='shared'&&!r.shadowed).status,'已连接');assert.equal(checked.find(r=>r.name==='local').status,'连接失败');assert.doesNotMatch(JSON.stringify(checked),/SECRET/);
});
test('MCP writes use official scoped argument arrays and reject invalid or duplicate configs',async()=>{
  const {home,cwd,mcp,calls,extensions}=setup();await mcp.action('add','sample','user',undefined,'{"type":"http","url":"https://example.com/mcp"}');assert.deepEqual(calls[0].args.slice(0,3),['mcp','add-json','sample']);assert.deepEqual(calls[0].args.slice(-2),['--scope','user']);assert.equal(extensions.revision,1);
  await assert.rejects(()=>mcp.action('add','bad;cmd','user',cwd,'{}'),/无效/);await assert.rejects(()=>mcp.action('add','sample','project',undefined,'{}'),/选择项目/);await assert.rejects(()=>mcp.action('add','sample','user',cwd,'{"command":"npx","args":[1]}'),/args/);
  fs.writeFileSync(path.join(home,'.claude.json'),'{"mcpServers":{"sample":{"command":"npx"}}}');await assert.rejects(()=>mcp.action('add','sample','user',cwd,'{"command":"npx"}'),/已存在/);await mcp.action('remove','sample','user',cwd);assert.deepEqual(calls.at(-1).args,['mcp','remove','sample','--scope','user']);
  extensions.command=async()=>{throw Error('secret-api-token');};await assert.rejects(()=>mcp.action('remove','sample','user',cwd),e=>!e.message.includes('secret-api-token'));
});
test('MCP corrupt configuration fails visibly rather than presenting an empty catalogue',()=>{const {home,mcp}=setup();fs.writeFileSync(path.join(home,'.claude.json'),'{broken');assert.throws(()=>mcp.list(),/JSON/);});
