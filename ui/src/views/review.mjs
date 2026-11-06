import { $, escape, setHtml } from '../core/dom.mjs';

// Codex-style review of uncommitted changes: per-file +/- counts, staging,
// discarding a file's changes and committing with a message.
export function createReview({ store, api, toast, confirm, inspector }) {
  let project=null,model=null,signature='',message='',busy=false;
  const baseName=p=>p.split('/').pop();
  const dirName=p=>p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
  const kind=f=>f.untracked||f.index==='A'?['新','added']:f.index==='D'||f.worktree==='D'?['删','deleted']:f.index==='R'?['移','renamed']:['改','modified'];
  const delta=f=>f.binary?'<span class="step-delta"><span class="muted">二进制</span></span>':`<span class="step-delta"><span class="plus">+${f.added}</span><span class="minus">−${f.removed}</span></span>`;
  function render(p,changes){
    const sig=JSON.stringify([p.id,changes]),list=$('#file-list');if(sig===signature&&project?.id===p.id&&list.dataset.view==='review')return;
    project=p;model=changes;signature=sig;list.dataset.view='review';
    if(!changes.isGit){setHtml(list,'<div class="empty-files"><span class="empty-icon"><svg class="folder-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 1.6h4.8A1.6 1.6 0 0 1 14 6.2v5.2a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4Z"/></svg></span><strong>这是一个本地文件夹</strong>不是 Git 仓库，无法审查和提交改动。<br>切换到「文件」浏览项目内容。</div>');return;}
    if(!changes.files.length){setHtml(list,`<div class="empty-files"><span class="empty-icon">✓</span><strong>工作区很干净</strong>Claude 产生的文件改动会显示在这里，可以逐个审查、撤销或提交。</div>`);$('#diff-view').hidden=true;return;}
    const staged=changes.files.filter(f=>f.staged&&f.worktree===' ').length,anyStaged=changes.files.some(f=>f.staged);
    const added=changes.files.reduce((n,f)=>n+(f.added||0),0),removed=changes.files.reduce((n,f)=>n+(f.removed||0),0);
    setHtml(list,`<div class="review-head"><strong>${changes.files.length} 个文件已更改</strong>${delta({added,removed})}<label class="review-all" title="暂存全部文件"><input type="checkbox" data-stage-all ${staged===changes.files.length?'checked':''} ${anyStaged&&staged<changes.files.length?'data-partial':''}>全部暂存</label></div>
      <div class="review-files">${changes.files.map(f=>{const [label,cls]=kind(f),full=f.staged&&f.worktree===' ';return `<div class="review-row" data-row="${escape(f.path)}"><input type="checkbox" data-stage="${escape(f.path)}" ${full?'checked':''} ${f.staged&&!full?'data-partial':''} title="${full?'取消暂存':'暂存'}" aria-label="暂存 ${escape(f.path)}"><button type="button" class="review-open" data-review-row="${escape(f.path)}" title="${escape(f.from?f.from+' → '+f.path:f.path)}"><span class="review-status ${cls}">${label}</span><span class="review-name">${escape(baseName(f.path))}</span><span class="review-dir">${escape(dirName(f.path))}</span>${delta(f)}</button><button type="button" class="review-revert" data-revert="${escape(f.path)}" title="撤销这个文件的改动" aria-label="撤销 ${escape(f.path)} 的改动">↶</button></div>`;}).join('')}</div>
      <form class="review-commit"><textarea id="review-message" rows="2" maxlength="5000" placeholder="提交说明（必填）" aria-label="提交说明">${escape(message)}</textarea><div class="review-commit-actions"><span>${anyStaged?`提交已暂存的文件`:'未暂存文件时将提交全部改动'}</span><button type="submit" class="review-commit-button">提交</button></div></form>`);
    list.querySelectorAll('[data-partial]').forEach(box=>{box.indeterminate=true;});
  }
  async function openDiff(file){
    const text=await api('project:review-diff',project.id,file);
    document.querySelectorAll('.review-row.selected').forEach(row=>row.classList.remove('selected'));
    [...document.querySelectorAll('.review-row')].find(row=>row.dataset.row===file)?.classList.add('selected');
    showLines(file,text.split('\n').filter(line=>!/^(diff --git|index |similarity |rename (from|to) |new file mode|deleted file mode)/.test(line)).map(line=>({type:line.startsWith('+++')||line.startsWith('---')?'file':line.startsWith('@@')?'@':line[0],text:line})));
  }
  const LINE_CLASS={file:'diff-file','+':'diff-add','-':'diff-remove','@':'diff-hunk','…':'diff-gap'};
  function showLines(title,lines){
    $('#diff-title').textContent=title;
    $('#diff-content').innerHTML=lines.map(l=>`<span class="${LINE_CLASS[l.type]||''}">${escape(l.text)}\n</span>`).join('');
    $('#diff-view').hidden=false;
  }
  async function act(work){if(busy)return;busy=true;try{await work();}catch(e){toast(e.message);}finally{busy=false;signature='';await inspector().refreshFiles();}}
  $('#file-list').addEventListener('change',event=>{
    if(store.panelTab!=='changes'||!project)return;
    const all=event.target.closest('[data-stage-all]'),one=event.target.closest('[data-stage]');
    if(all)act(()=>api('project:stage',project.id,model.files.map(f=>f.path),all.checked));
    else if(one)act(()=>api('project:stage',project.id,[one.dataset.stage],one.checked));
  });
  $('#file-list').addEventListener('input',event=>{if(event.target.id==='review-message')message=event.target.value;});
  $('#file-list').addEventListener('click',event=>{
    if(store.panelTab!=='changes'||!project)return;
    const row=event.target.closest('[data-review-row]');if(row){openDiff(row.dataset.reviewRow).catch(e=>toast(e.message));return;}
    const revert=event.target.closest('[data-revert]');
    if(revert){
      const file=model.files.find(f=>f.path===revert.dataset.revert);if(!file)return;const isNew=file.untracked||file.index==='A';
      confirm({title:'撤销这个文件的改动？',description:isNew?'这是新文件，撤销会直接删除它。此操作无法恢复。':'文件会恢复到最近一次提交的版本，未提交的修改将丢失。此操作无法恢复。',preview:file.path,label:'撤销改动'}).then(ok=>{if(ok)act(async()=>{await api('project:revert',project.id,file.path);if($('#diff-title').textContent===file.path)$('#diff-view').hidden=true;toast('已撤销 '+baseName(file.path));});});
    }
  });
  $('#file-list').addEventListener('submit',event=>{
    if(!event.target.closest('.review-commit'))return;event.preventDefault();
    if(!message.trim()){toast('请先填写提交说明');$('#review-message')?.focus();return;}
    const all=!model.files.some(f=>f.staged);
    act(async()=>{const result=await api('project:commit',project.id,message,all);message='';toast(`已提交 ${result.hash} · ${result.subject}`);});
  });
  $('#file-list').addEventListener('keydown',event=>{if(event.target.id==='review-message'&&event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();event.target.form.requestSubmit();}});
  return {render};
}
