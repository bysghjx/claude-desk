const path=require('node:path');
class AgentWindows{
  constructor({BrowserWindow,ipcMain,engine,mainWindow,clipboard,root=__dirname}){
    Object.assign(this,{BrowserWindow,engine,mainWindow,clipboard,root});this.windows=new Map();
    ipcMain.handle('agent:view',(event,action)=>{
      const entry=[...this.windows.values()].find(item=>item.window.webContents===event.sender&&event.senderFrame===item.window.webContents.mainFrame);
      if(!entry)throw Error('无效的子智能体窗口');
      if(action==='state')return this.snapshot(entry.threadId,entry.agentId);
      if(action==='main'){const win=this.mainWindow();if(win.isMinimized())win.restore();win.show();win.focus();win.webContents.send('thread:navigate',entry.threadId);return true;}
      if(action==='copy'){const value=this.snapshot(entry.threadId,entry.agentId);this.clipboard.writeText(value.available?(value.agent.answer||value.agent.summary||''):'');return true;}
      if(action==='min')entry.window.minimize();else if(action==='max')entry.window.isMaximized()?entry.window.unmaximize():entry.window.maximize();else if(action==='close')entry.window.close();else throw Error('无效操作');
    });
  }
  snapshot(threadId,agentId){
    const thread=this.engine.store.state.threads.find(t=>t.id===threadId);
    for(const turn of thread?.turns||[])for(const agent of turn.subagents||[])if(agent.id===agentId||agent.aliases?.includes(agentId))return{available:true,threadId,threadTitle:thread.title,cwd:thread.cwd,question:turn.user,agent:structuredClone(agent)};
    return{available:false,threadId,message:'此子智能体记录已被移除，或所属会话已删除。'};
  }
  open(threadId,agentId){
    const value=this.snapshot(threadId,agentId);if(!value.available)throw Error('子智能体记录已不存在');
    const key=JSON.stringify([threadId,value.agent.id]),existing=this.windows.get(key);
    if(existing&&!existing.window.isDestroyed()){if(existing.window.isMinimized())existing.window.restore();existing.window.show();existing.window.focus();return true;}
    const window=new this.BrowserWindow({width:920,height:760,minWidth:580,minHeight:440,title:'子智能体 · '+value.agent.name,backgroundColor:'#202020',autoHideMenuBar:true,titleBarStyle:'hidden',webPreferences:{preload:path.join(this.root,'agent-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    this.windows.set(key,{window,threadId,agentId:value.agent.id});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    const sendMaximized=()=>{if(!window.isDestroyed())window.webContents.send('window:maximized',window.isMaximized());};
    window.on('maximize',sendMaximized);window.on('unmaximize',sendMaximized);window.webContents.on('did-finish-load',sendMaximized);
    window.on('closed',()=>this.windows.delete(key));window.loadFile(path.join(this.root,'ui/agent.html'));return true;
  }
  refresh(threadId){for(const entry of this.windows.values())if(entry.threadId===threadId&&!entry.window.isDestroyed()){const value=this.snapshot(entry.threadId,entry.agentId);entry.window.webContents.send('agent:update',value);}}
  close(){for(const {window}of [...this.windows.values()])if(!window.isDestroyed())window.close();}
}
module.exports={AgentWindows};
