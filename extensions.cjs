const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const exec=promisify(execFile);
const LIBRARY='desk-user-skills';
const safeName=name=>typeof name==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)&&! /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
const safePlugin=id=>typeof id==='string'&&/^[a-zA-Z0-9][\w.-]*(?:@[a-zA-Z0-9][\w.-]*)?$/.test(id)&&id.length<180;
function metadata(text,fallback=''){
  const header=/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const value=key=>{
    const match=new RegExp('^'+key+':\\s*(.*)$','m').exec(header?.[1]||'');if(!match)return'';
    let raw=match[1].trim();
    if(raw.startsWith('"'))try{return JSON.parse(raw);}catch{}
    if(raw.startsWith("'"))return raw.slice(1,-1).replaceAll("''", "'");
    if(/^[>|][-+]?$/.test(raw))return(header[1].slice(match.index+match[0].length).match(/^(?:\r?\n[ \t]+.*)+/)?.[0]||'').trim().replace(/\s+/g,' ');
    return raw;
  };
  return{name:value('name')||fallback,description:value('description'),body:header?text.slice(header[0].length):text};
}
function inside(root,target){const relative=path.relative(path.resolve(root),path.resolve(target));if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('路径不在技能目录内');return path.resolve(target);}
function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}}
function readSkill(file){
  if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>512*1024)throw Error('技能文件无效或超过 512 KB');
  const text=fs.readFileSync(file,'utf8');return{text,...metadata(text,path.basename(path.dirname(file)))};
}
class ExtensionsManager{
  constructor({cliPath,dataRoot,store,home=os.homedir(),execute=exec}){
    Object.assign(this,{cliPath,dataRoot,store,home,execute});this.cache=new Map();this.busy=false;
    this.library=path.join(dataRoot,'extensions',LIBRARY);this.skillsRoot=path.join(this.library,'skills');
    store.state.extensions||={revision:0,skillMode:'all',selectedSkills:[]};
  }
  changed(){this.store.state.extensions.revision=(this.store.state.extensions.revision||0)+1;this.store.save();this.cache.clear();}
  async command(args,cwd,timeout=20000){
    if(!this.cliPath)throw Error('未找到官方 Claude CLI');
    const env={...process.env};delete env.CLAUDECODE;delete env.ELECTRON_RUN_AS_NODE;
    try{return(await this.execute(this.cliPath,args,{cwd:cwd||this.home,env,windowsHide:true,timeout,maxBuffer:12*1024*1024})).stdout.trim();}
    catch(e){let message=String(e.stderr||e.stdout||e.message||e).slice(-3000);message=message.replace(/(?:sk-ant-|sk-)[A-Za-z0-9_-]{12,}/g,'[密钥已隐藏]').replace(/Bearer\s+\S+/gi,'Bearer [密钥已隐藏]');throw Error(message||'Claude CLI 操作失败');}
  }
  async catalog(cwd,refresh=false){
    const key=cwd||this.home,previous=this.cache.get(key);
    if(!refresh&&previous&&Date.now()-previous.time<30000)return previous.value;
    const raw=JSON.parse(await this.command(['plugin','list','--json','--available'],cwd));
    const clean=(item,installed)=>({id:item.pluginId||item.id||item.name,name:item.name||(item.pluginId||item.id||'').split('@')[0],description:String(item.description||''),version:String(item.version||''),marketplace:item.marketplaceName||String(item.pluginId||item.id||'').split('@')[1]||'',scope:item.scope||'user',enabled:item.enabled??item.isEnabled??true,installPath:item.installPath||item.install_path||'',installed});
    const installed=(Array.isArray(raw)?raw:raw.installed||[]).map(item=>clean(item,true)).filter(item=>safePlugin(item.id));
    const available=(raw.available||[]).map(item=>clean(item,false)).filter(item=>safePlugin(item.id));
    const value={installed,available};this.cache.set(key,{time:Date.now(),value});return value;
  }
  async pluginAction(action,id,scope,cwd){
    if(!['install','enable','disable','uninstall','update'].includes(action)||!safePlugin(id)||!['user','project','local'].includes(scope))throw Error('插件操作或名称无效');
    if(scope!=='user'&&!cwd)throw Error('请先选择项目');
    if(this.busy)throw Error('另一个插件操作仍在执行');this.busy=true;
    try{
      const args=['plugin',action,id,'--scope',scope,'--json'];if(action==='uninstall')args.push('--keep-data');
      // Do not bypass CLI confirmation for marketplace-declared shell commands.
      const output=await this.command(args,cwd,120000);
      let result;try{result=JSON.parse(output);}catch{}
      if(result?.success===false||result?.status==='error'||result?.shownCommand)throw Error(result.message||result.error||'此插件需要在官方 CLI 中确认安装命令，客户端未自动放行');
      this.changed();return{message:'操作完成，下次发送时生效'};
    }finally{this.busy=false;}
  }
  async addMarketplace(source,cwd){
    if(typeof source!=='string'||source.length>600)throw Error('市场地址无效');
    if(!/^[\w.-]+\/[\w.-]+$/.test(source)){
      let url;try{url=new URL(source);}catch{throw Error('请输入 GitHub owner/repo 或 HTTPS 地址');}
      if(url.protocol!=='https:'||url.username||url.password)throw Error('市场地址只支持不带凭据的 HTTPS 地址');
    }
    if(this.busy)throw Error('另一个插件操作仍在执行');this.busy=true;
    try{await this.command(['plugin','marketplace','add',source,'--json'],cwd,120000);this.changed();return true;}finally{this.busy=false;}
  }
  scanSkills(cwd,installed=[]){
    const result=[],seen=new Set();
    const scan=(root,source,prefix='',owned=false)=>{
      if(!fs.existsSync(root))return;
      for(const entry of fs.readdirSync(root,{withFileTypes:true})){
        if(!entry.isDirectory()||entry.isSymbolicLink()||entry.name.startsWith('.'))continue;
        const file=path.join(root,entry.name,'SKILL.md');if(!fs.existsSync(file))continue;
        try{
          const skill=readSkill(file),name=prefix?`${prefix}:${skill.name}`:skill.name,id=owned?'owned:'+entry.name:source+':'+file;
          if(seen.has(id))continue;seen.add(id);
          result.push({id,name,description:skill.description,source,path:file,owned,folder:entry.name});
        }catch{}
      }
    };
    scan(path.join(this.home,'.claude','skills'),'用户');
    if(cwd)scan(path.join(cwd,'.claude','skills'),'项目');
    scan(this.skillsRoot,'Claude Desk',LIBRARY,true);
    const registry=readJson(path.join(this.home,'.claude','plugins','installed_plugins.json'),{plugins:{}});
    const roots=[];
    for(const plugin of installed)if(plugin.enabled&&plugin.installPath)roots.push({path:plugin.installPath,name:plugin.name});
    for(const [id,entries]of Object.entries(registry.plugins||{}))if(installed.some(p=>p.id===id&&p.enabled))for(const item of Array.isArray(entries)?entries:[])if(item.installPath)roots.push({path:item.installPath,name:id.split('@')[0]});
    for(const plugin of roots){const manifest=readJson(path.join(plugin.path,'.claude-plugin','plugin.json'),{});scan(path.join(plugin.path,'skills'),'插件 '+plugin.name,manifest.name||plugin.name);}
    return result;
  }
  ownedFolder(name){if(!safeName(name))throw Error('技能名称只允许小写字母、数字和短横线，最长 64 位');const folder=inside(this.skillsRoot,path.join(this.skillsRoot,name));if(fs.existsSync(folder)&&fs.lstatSync(folder).isSymbolicLink())throw Error('技能目录不能是符号链接');return folder;}
  ensureLibrary(){fs.mkdirSync(path.join(this.library,'.claude-plugin'),{recursive:true});fs.writeFileSync(path.join(this.library,'.claude-plugin','plugin.json'),JSON.stringify({name:LIBRARY,version:'1.0.0',description:'Claude Desk 用户技能库'},null,2));}
  saveSkill({id,name,description,body,raw}){
    const folder=this.ownedFolder(name);
    if(id&&id!=='owned:'+name)throw Error('只能编辑 Claude Desk 管理的技能，名称不能改动');
    if(!id&&fs.existsSync(folder))throw Error('该技能名称已存在');
    let text;
    if(id&&typeof raw==='string'){
      const parsed=metadata(raw);
      if(parsed.name!==name||!parsed.description||Buffer.byteLength(raw)>512*1024)throw Error('SKILL.md 必须保留原 name、有效 description，且不超过 512 KB');
      text=raw;
    }else{
      if(typeof description!=='string'||!description.trim()||description.length>1000||typeof body!=='string'||!body.trim()||Buffer.byteLength(body)>256*1024)throw Error('请填写描述和技能正文（正文最多 256 KB）');
      text=`---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${body.trim()}\n`;
    }
    this.ensureLibrary();fs.mkdirSync(folder,{recursive:true});
    fs.writeFileSync(path.join(folder,'SKILL.md.tmp'),text);fs.renameSync(path.join(folder,'SKILL.md.tmp'),path.join(folder,'SKILL.md'));
    this.changed();return'owned:'+name;
  }
  importSkill(source){
    const root=fs.realpathSync(source),file=path.join(root,'SKILL.md');
    if(!fs.statSync(root).isDirectory()||!fs.existsSync(file))throw Error('请选择根目录包含 SKILL.md 的技能文件夹');
    const skill=readSkill(file);if(!safeName(skill.name)||!skill.description)throw Error('SKILL.md 必须包含有效的 name 和 description');
    const target=this.ownedFolder(skill.name);if(fs.existsSync(target))throw Error('同名技能已存在，请编辑现有技能');
    const files=[];let total=0;
    const walk=(dir,depth=0)=>{if(depth>12)throw Error('技能目录层级过深');for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
      const full=path.join(dir,ent.name);if(ent.isSymbolicLink())throw Error('技能目录不能包含符号链接');
      if(ent.isDirectory())walk(full,depth+1);else if(ent.isFile()){total+=fs.statSync(full).size;if(total>20*1024*1024||files.length>=512)throw Error('技能超过 20 MB 或 512 个文件');files.push(full);}
    }};walk(root);
    this.ensureLibrary();fs.mkdirSync(target,{recursive:true});
    try{for(const file of files){const dest=inside(target,path.join(target,path.relative(root,file)));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);}}
    catch(error){fs.rmSync(this.ownedFolder(skill.name),{recursive:true,force:true});throw error;}
    this.changed();return'owned:'+skill.name;
  }
  removeSkill(id){if(typeof id!=='string'||!id.startsWith('owned:'))throw Error('只能移除 Claude Desk 管理的技能');const folder=this.ownedFolder(id.slice(6));fs.rmSync(folder,{recursive:true,force:true});this.changed();}
  selection(mode,names){if(!['all','selected'].includes(mode)||!Array.isArray(names)||names.length>1000||names.some(name=>typeof name!=='string'||name.length>200||! /^[\w.:-]+$/.test(name)))throw Error('技能选择无效');Object.assign(this.store.state.extensions,{skillMode:mode,selectedSkills:[...new Set(names)]});this.changed();}
  sessionOptions(){const settings=this.store.state.extensions;return{revision:settings.revision||0,skills:settings.skillMode==='selected'?settings.selectedSkills||[]:'all',plugins:fs.existsSync(this.skillsRoot)?[{type:'local',path:this.library}]:[]};}
}
module.exports={ExtensionsManager,metadata,safeName,safePlugin,inside};
