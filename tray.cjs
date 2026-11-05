// The notification-area icon. With 关闭时留在托盘 on, closing the window hides it
// here and running conversations carry on; the menu lists them and quits for real.
const {ACTIVE:RUNNING}=require('./engine.cjs');

// Plain menu items (label, click target) so the menu is tested without Electron.
function trayItems(threads,limit=6){
  const running=threads.filter(t=>RUNNING.has(t.status)).sort((a,b)=>(b.startedAt||0)-(a.startedAt||0));
  const waiting=running.filter(t=>t.status==='approval').length;
  const items=[{label:'打开 Claude Desk',action:'show'},{label:'新任务',action:'new-task'},{type:'separator'}];
  if(running.length){
    items.push({label:`${running.length} 个任务运行中${waiting?` · ${waiting} 个等你处理`:''}`,enabled:false});
    for(const t of running.slice(0,limit))items.push({label:(t.status==='approval'?'⚠ ':'')+String(t.title||'未命名会话').slice(0,40),action:'thread',threadId:t.id});
    if(running.length>limit)items.push({label:`还有 ${running.length-limit} 个…`,action:'show'});
  }else items.push({label:'没有运行中的任务',enabled:false});
  items.push({type:'separator'},{label:'退出 Claude Desk',action:'quit'});
  return{items,tooltip:running.length?`Claude Desk · ${running.length} 个任务运行中`:'Claude Desk',running:running.length};
}

class DeskTray{
  constructor({Tray,Menu,icon,onAction}){Object.assign(this,{Tray,Menu,icon,onAction,tray:null,signature:''});}
  create(threads){
    if(this.tray)return;
    this.tray=new this.Tray(this.icon);
    this.tray.on('click',()=>this.onAction({action:'show'}));
    this.update(threads);
  }
  update(threads){
    if(!this.tray||this.tray.isDestroyed())return;
    const {items,tooltip}=trayItems(threads),signature=JSON.stringify(items)+tooltip;
    if(signature===this.signature)return;this.signature=signature;
    this.tray.setToolTip(tooltip);
    this.tray.setContextMenu(this.Menu.buildFromTemplate(items.map(({action,threadId,...item})=>action?{...item,click:()=>this.onAction({action,threadId})}:item)));
  }
  destroy(){if(this.tray&&!this.tray.isDestroyed())this.tray.destroy();this.tray=null;}
}
module.exports={DeskTray,trayItems};
