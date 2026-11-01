const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('agentView',{
  invoke:action=>{if(!['state','main','copy','min','max','close'].includes(action))throw Error('不支持此操作');return ipcRenderer.invoke('agent:view',action);},
  onUpdate:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('agent:update',listener);return()=>ipcRenderer.removeListener('agent:update',listener);}
});
