// In-app split view: sub-agent tabs host agent.html in an iframe; a 变更 tab shows what one turn changed.
import { escape as escapeHtml } from '../core/dom.mjs';
import { changesViewHtml } from '../lib/worklog.mjs';

export function createDock({ $, store, api, toast, onSelectThread, escape = escapeHtml, document = globalThis.document, window = globalThis.window }) {
  const attr=value=>escape(value).replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const panel=$('#agent-dock'),tabs=$('#agent-dock-tabs'),views=$('#agent-dock-views'),items=new Map();let active='';
  function data(item){const t=store.state.threads.find(t=>t.id===item.threadId);for(const turn of t?.turns||[])for(const a of turn.subagents||[])if(a.id===item.agentId||a.aliases?.includes(item.agentId))return{available:true,threadId:t.id,threadTitle:t.title,cwd:t.cwd,question:turn.user,agent:a};return{available:false,message:'此子智能体记录已被移除。'};}
  function send(item){if(item.file)return;if(item.turnId)return showChanges(item);item.frame.contentWindow?.postMessage({type:'agent:data',data:data(item)},'*');}
  const turnOf=item=>store.state.threads.find(t=>t.id===item.threadId)?.turns.find(t=>t.id===item.turnId);
  const title=item=>item.file?item.file.split('/').pop():item.turnId?'变更':data(item).agent?.name||'子智能体';
  function showChanges(item){const thread=store.state.threads.find(t=>t.id===item.threadId),turn=turnOf(item),html=turn?changesViewHtml(turn,thread.cwd,escape):'<p class="cv-empty">这一轮已被删除。</p>';if(item.frame.__html!==html){const top=item.frame.scrollTop;item.frame.innerHTML=html;item.frame.__html=html;item.frame.scrollTop=top;}}
  function render(){panel.hidden=!items.size;document.body.classList.toggle('dock-open',Boolean(items.size));tabs.innerHTML=[...items].map(([key,item])=>`<div class="dock-tab ${key===active?'selected':''}"><button data-dock-select="${escape(key)}" title="${attr(title(item))}">${escape(title(item))}</button><button data-dock-close="${escape(key)}" aria-label="关闭子智能体标签">×</button></div>`).join('');for(const [key,item]of items)item.frame.hidden=key!==active;$('#agent-dock-detach').hidden=Boolean(items.get(active)?.frame.tagName!=='IFRAME');}
  function open(threadId,agentId){const key=encodeURIComponent(JSON.stringify([threadId,agentId]));if(!items.has(key)){const frame=document.createElement('iframe');frame.src='agent.html?embedded=1';frame.title='子智能体详情';views.append(frame);const item={threadId,agentId,frame};items.set(key,item);frame.onload=()=>send(item);}active=key;render();}
  // One 变更 tab per conversation; opening it again shows the new turn and scrolls to `file`.
  function openChanges(threadId,turnId,file){const key='changes:'+threadId;let item=items.get(key);if(!item){const frame=document.createElement('div');frame.className='changes-view';views.append(frame);item={threadId,turnId,frame};items.set(key,item);}item.turnId=turnId;active=key;showChanges(item);render();const target=file&&[...item.frame.querySelectorAll('[data-cv-file]')].find(n=>n.dataset.cvFile===file);if(target)target.scrollIntoView({block:'start'});else item.frame.scrollTop=0;}
  // A file Claude named in a reply, with line numbers; `line` is marked and scrolled to. `read` is the file when already read.
  async function openFile(threadId,file,line,read){
    const {path,text}=read||await api('file:read',threadId,file),key='file:'+threadId+':'+path;let item=items.get(key);
    if(!item){const frame=document.createElement('div');frame.className='changes-view file-view';views.append(frame);item={threadId,file:path,frame};items.set(key,item);}
    const at=Number(line)||0,rows=text.split('\n');
    item.frame.innerHTML=`<div class="cv-head"><strong>${escape(path)}</strong><span>${rows.length} 行</span></div><div class="cv-file"><div class="cv-diff">${rows.map((row,i)=>`<div class="cv-line${i+1===at?' marked':''}"><span class="cv-num">${i+1}</span><span class="cv-code">${escape(row)}</span></div>`).join('')}</div></div>`;
    active=key;render();
    const marked=item.frame.querySelector('.marked');if(marked)marked.scrollIntoView({block:'center'});else item.frame.scrollTop=0;
  }
  tabs.onclick=event=>{const close=event.target.closest('[data-dock-close]'),select=event.target.closest('[data-dock-select]');if(close){const key=close.dataset.dockClose;items.get(key)?.frame.remove();items.delete(key);if(active===key)active=[...items.keys()].at(-1)||'';render();}else if(select){active=select.dataset.dockSelect;render();}};
  $('#agent-dock-close').onclick=()=>{for(const item of items.values())item.frame.remove();items.clear();active='';render();};
  $('#agent-dock-detach').onclick=()=>{const item=items.get(active);if(item)api('agent:open',item.threadId,item.agentId).catch(e=>toast(e.message));};
  window.addEventListener('message',event=>{const item=[...items.values()].find(item=>item.frame.contentWindow===event.source);if(!item||event.data?.type!=='agent:action')return;const action=event.data.action;if(action==='state')send(item);if(action==='main')onSelectThread(item.threadId);if(action==='copy'){const a=data(item).agent;api('copy',a?.answer||a?.summary||'');}});
  const handle=$('#agent-dock-resize');handle.onpointerdown=event=>{handle.setPointerCapture(event.pointerId);handle.classList.add('dragging');};handle.onpointermove=event=>{if(!handle.hasPointerCapture(event.pointerId))return;const area=document.querySelector('.main-area').getBoundingClientRect(),width=Math.max(320,Math.min(area.width-380,area.right-event.clientX));panel.style.width=width+'px';document.documentElement.style.setProperty('--agent-dock-width',width+'px');};handle.onpointerup=event=>{handle.releasePointerCapture(event.pointerId);handle.classList.remove('dragging');};
  return {open,openChanges,openFile,refresh(threadId){for(const item of items.values())if(item.threadId===threadId)send(item);render();}};
}
