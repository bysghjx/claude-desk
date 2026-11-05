(() => {
  const $=selector=>document.querySelector(selector),embedded=window.parent!==window&&new URLSearchParams(location.search).has('embedded');
  let updateCallback=null,initialResolve=null;
  const bridge=embedded?{invoke(action){window.parent.postMessage({type:'agent:action',action},'*');return action==='state'?new Promise(resolve=>initialResolve=resolve):Promise.resolve();},onUpdate(callback){updateCallback=callback;}}:window.agentView;
  if(embedded){document.body.classList.add('embedded');window.addEventListener('message',event=>{if(event.source!==window.parent||event.data?.type!=='agent:data')return;if(initialResolve){initialResolve(event.data.data);initialResolve=null;}else updateCallback?.(event.data.data);});}
  const api=action=>bridge.invoke(action);
  const labels={running:'运行中',waiting:'等待中',thinking:'思考中',generating:'生成中',tool:'执行工具',approval:'等待批准',paused:'已暂停',done:'已完成',error:'失败',stopped:'已停止',interrupted:'已中断',ended:'已结束'};
  const active=new Set(['running','waiting','thinking','generating','tool','approval','paused']);
  let value=null,answerSignature='',toolSignature='';
  const escape=text=>String(text??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const duration=(start,end)=>{const seconds=Math.max(0,Math.floor(((end||Date.now())-(start||Date.now()))/1000));return seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+seconds%60+' 秒';};
  function clock(){const a=value?.agent;if(!a)return;$('#elapsed').textContent=duration(a.startedAt,a.finishedAt)+(a.usage?' · '+Number(a.usage.totalTokens||0).toLocaleString()+' tokens · '+Number(a.usage.toolUses||0)+' 次调用':'');}
  function render(next){
    value=next;$('#detail').hidden=!value.available;$('#unavailable').hidden=value.available;$('#copy-output').disabled=!value.available;
    if(!value.available){$('#name').textContent='子智能体记录不可用';$('#unavailable').textContent=value.message;$('#status').textContent='已移除';$('#status').classList.remove('active');$('#live-indicator').textContent='记录已移除';$('#live-indicator').classList.remove('live');$('#elapsed').textContent='';return;}
    const a=value.agent,live=active.has(a.status),tools=a.tools||[],main=$('#agent-content');
    document.title='子智能体 · '+a.name;$('#name').textContent=a.name;$('#status').textContent=labels[a.status]||a.status;$('#status').classList.toggle('active',live);
    $('#meta').textContent=[a.type,a.model,value.cwd,a.background?'后台任务':'',a.parentId||a.parentTaskId?'嵌套子任务':''].filter(Boolean).join(' · ');
    $('#description').textContent=a.description||'CLI 未提供任务描述';$('#owner').textContent='来自：'+value.threadTitle;$('#approval').hidden=a.status!=='approval';
    $('#progress').textContent=a.summary||a.lastTool&&'最近工具 · '+a.lastTool||'';$('#thinking-wrap').hidden=!a.thinking;$('#thinking').textContent=a.thinking||'';
    const answer=a.answer||(!live?a.summary:'')||'';$('#progress').hidden=!$('#progress').textContent||$('#progress').textContent===answer;let changed=false;
    if(answer!==answerSignature){answerSignature=answer;$('#answer').innerHTML=answer?DOMPurify.sanitize(marked.parse(answer),{FORBID_TAGS:['img','iframe','form','input','button','video','audio']}):'<p class="progress">'+(live?'等待 CLI 返回输出…':'此任务没有单独返回文本输出。')+'</p>';changed=true;}
    else if(!answer)$('#answer').textContent=live?'等待 CLI 返回输出…':'此任务没有单独返回文本输出。';
    const signature=JSON.stringify(tools);if(signature!==toolSignature){
      const opened=new Set([...document.querySelectorAll('#tools details[open]')].map(el=>el.dataset.tool));toolSignature=signature;
      $('#tools').innerHTML=tools.map(t=>`<details data-tool="${escape(t.id)}" ${opened.has(String(t.id))?'open':''}><summary>${escape(t.name)}<span class="tool-state">${escape(({running:'运行中',done:'完成',error:'失败',approval:'等待批准',interrupted:'已中断'})[t.status]||t.status)}</span></summary><pre>${escape(JSON.stringify(t.input,null,2))}${t.output?'\n\n'+escape(t.output):''}</pre></details>`).join('');changed=true;
    }
    $('#tools-wrap').hidden=!tools.length;$('#tool-count').textContent=tools.length?'· '+tools.length:'';$('#error').hidden=!a.error;$('#error').textContent=a.error||'';
    $('#live-indicator').textContent=live?'实时更新 · '+(labels[a.status]||a.status):(labels[a.status]||a.status);$('#live-indicator').classList.toggle('live',live);clock();
    if(changed&&$('#follow').checked)main.scrollTop=main.scrollHeight;
  }
  document.querySelectorAll('[data-window]').forEach(button=>button.onclick=()=>api(button.dataset.window));
  // Inside the split view there is no preload, so no agentView and no window to maximize.
  window.agentView?.onMaximized?.(maximized=>{document.documentElement.classList.toggle('maximized',maximized);const button=document.querySelector('[data-window="max"]');if(button){const label=maximized?'向下还原':'最大化';button.title=label;button.setAttribute('aria-label',label);}});
  $('#back-main').onclick=()=>api('main');$('#copy-output').onclick=async()=>{await api('copy');$('#copy-output').textContent='已复制';setTimeout(()=>$('#copy-output').textContent='复制输出',1300);};
  $('#follow').onchange=()=>{if($('#follow').checked)$('#agent-content').scrollTop=$('#agent-content').scrollHeight;};
  $('#agent-content').addEventListener('wheel',()=>{$('#follow').checked=false;},{passive:true});
  $('#agent-content').onclick=event=>{if(event.target.closest('a'))event.preventDefault();};
  let updated=false;bridge.onUpdate(data=>{updated=true;render(data);});api('state').then(data=>{if(!updated)render(data);}).catch(e=>render({available:false,message:e.message}));
  setInterval(clock,1000);
})();
