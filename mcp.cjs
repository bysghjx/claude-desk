const fs=require('node:fs');
const path=require('node:path');
const validName=name=>typeof name==='string'&&/^[\w-]{1,100}$/.test(name);
function read(file){if(!fs.existsSync(file))return{};try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('MCP 配置无法读取，请检查 JSON 格式');}}
class McpManager{
  constructor(extensions){this.extensions=extensions;}
  list(cwd){
    const cfg=read(path.join(this.extensions.home,'.claude.json')),rows=[];
    const append=(servers,scope)=>{for(const [name,config]of Object.entries(servers||{}))if(config&&typeof config==='object')rows.push({name,scope,type:config.type||'stdio',status:'尚未检查'});};
    append(cfg.mcpServers,'user');
    if(cwd){append(read(path.join(cwd,'.mcp.json')).mcpServers,'project');const key=Object.keys(cfg.projects||{}).find(key=>path.resolve(key).toLowerCase()===path.resolve(cwd).toLowerCase());append(cfg.projects?.[key]?.mcpServers,'local');}
    const rank={user:0,project:1,local:2};
    return rows.map(row=>({...row,shadowed:rows.some(other=>other.name===row.name&&rank[other.scope]>rank[row.scope])}));
  }
  validate(name,scope,cwd){if(!validName(name)||!['user','project','local'].includes(scope))throw Error('MCP 名称或范围无效');if(scope!=='user'&&!cwd)throw Error('请先选择项目');}
  async action(action,name,scope,cwd,json){
    this.validate(name,scope,cwd);let args;
    if(action==='add'){
      if(this.list(cwd).some(row=>row.name===name&&row.scope===scope))throw Error('此范围已存在同名 MCP，请先移除旧配置');
      let config;try{config=JSON.parse(json);}catch{throw Error('请输入有效的服务器 JSON');}
      if(!config||Array.isArray(config)||typeof config!=='object'||JSON.stringify(config).length>64000)throw Error('MCP 配置无效或过大');
      const type=config.type||'stdio';
      if(type==='stdio'){if(typeof config.command!=='string'||!config.command.trim())throw Error('stdio 配置需要 command');if(config.args!==undefined&&(!Array.isArray(config.args)||config.args.some(x=>typeof x!=='string')))throw Error('args 必须是字符串数组');}
      else if(['http','streamable-http','sse','ws'].includes(type)){let url;try{url=new URL(config.url);}catch{throw Error('远程 MCP 需要有效的 url');}if(!['http:','https:','ws:','wss:'].includes(url.protocol)||url.username||url.password)throw Error('MCP URL 协议或凭据格式无效');}
      else throw Error('不支持此 MCP 传输类型');
      args=['mcp','add-json',name,JSON.stringify(config),'--scope',scope];
    }else if(action==='remove'){
      if(!this.list(cwd).some(row=>row.name===name&&row.scope===scope))throw Error('MCP 配置已不存在，请刷新');
      args=['mcp','remove',name,'--scope',scope];
    }else throw Error('不支持此 MCP 操作');
    if(this.extensions.busy)throw Error('另一个扩展操作仍在执行');this.extensions.busy=true;
    try{await this.extensions.command(args,cwd,30000);this.extensions.changed();return true;}
    catch{throw Error('MCP 操作失败，请检查配置或在官方 CLI 中查看详情（错误输出已隐藏以保护凭据）');}
    finally{this.extensions.busy=false;}
  }
  async check(cwd){
    let output;try{output=await this.extensions.command(['mcp','list'],cwd,60000);}catch{throw Error('连接检查未完成，请检查网络或在官方 CLI 中运行 claude mcp list');}
    const lines=output.replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/);
    return this.list(cwd).map(row=>{const line=lines.find(line=>line.startsWith(row.name+':'));let status='未返回状态';if(row.shadowed)status='被更高优先级配置覆盖';else if(line){if(/pending approval|not approved/i.test(line))status='等待项目批准';else if(/disabled/i.test(line))status='已停用';else if(/needs authentication|authentication required/i.test(line))status='需要登录';else if(/failed|error|disconnected/i.test(line))status='连接失败';else if(/connected/i.test(line))status='已连接';}return{...row,status};});
  }
}
module.exports={McpManager};
