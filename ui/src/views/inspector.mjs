// Right-hand panel: project files and changes, referenced sources and sub-agents.
import { $, escape, setHtml } from '../core/dom.mjs';
import { AGENT_ACTIVE, AGENT_LABELS, TOOL_LABELS, elapsed } from '../core/format.mjs';
import { guarded } from '../core/ui.mjs';

// Sub-agents of the selected conversation, or the running ones of every conversation on the home page.
export function collectAgents(store) {
  const thread = store.current();
  return (thread ? [thread] : store.state.threads)
    .flatMap(t => t.turns.flatMap(turn => (turn.subagents || []).filter(a => !a.ambient && (thread || AGENT_ACTIVE.has(a.status))).map(a => ({ ...a, ownerId: t.id, ownerTitle: t.title }))))
    .sort((a, b) => Number(AGENT_ACTIVE.has(b.status)) - Number(AGENT_ACTIVE.has(a.status)) || b.startedAt - a.startedAt);
}

// Running sub-agents get a card each; finished ones fold into one 已结束 row that
// opens to a compact list, so a long conversation does not fill the panel.
export function agentCardsHtml(agents, { home, now = Date.now() }) {
  if (!agents.length) return `<p class="context-empty">${home ? '目前没有运行中的子智能体。进入会话后可查看该会话的子任务记录。' : '本会话尚未启动子智能体。可在消息中要求 Claude 使用子智能体分工处理任务。'}</p>`;
  const live = agents.filter(a => AGENT_ACTIVE.has(a.status)), ended = agents.filter(a => !AGENT_ACTIVE.has(a.status));
  // A row names the task; agents started without a description fall back to their summary.
  const label = a => (a.name && a.name !== '子智能体' ? a.name : a.summary || a.type || a.name || '子智能体').slice(0, 160);
  const rows = ended.map(a => `<button type="button" class="agent-row" data-agent-window="${escape(a.id)}" data-agent-thread="${escape(a.ownerId)}" title="在右侧分栏查看 · ${escape(a.name)}${a.summary ? ' — ' + escape(a.summary.slice(0, 300)) : ''}"><span class="dot ${a.status === 'error' ? 'error' : 'muted-dot'}"></span><span class="agent-row-name">${escape(label(a))}</span><span class="agent-row-state">${a.status === 'done' ? '' : AGENT_LABELS[a.status] || a.status}</span><span class="agent-row-time">${elapsed(a.startedAt, a.finishedAt || now)}</span></button>`).join('');
  const history = ended.length ? `<details class="agent-history" data-agent-detail="history"><summary><span>已结束 ${ended.length} 个</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 3 3 3-3 3"/></svg></summary><div class="agent-rows">${rows}</div></details>` : '';
  return liveCards(live, { home, now }) + history;
}
function liveCards(agents, { home, now }) {
  return agents.map(a => {
    const key = a.ownerId + '-agent-' + a.id, live = AGENT_ACTIVE.has(a.status), tools = a.tools || [];
    const tool = tools.findLast(x => x.status === 'running') || tools.at(-1);
    const toolTarget = tool?.input?.file_path || tool?.input?.command || tool?.input?.pattern || '';
    const brief = a.summary || (a.lastTool && '最近工具 · ' + a.lastTool) || (a.status === 'approval' ? '等待你批准工具操作' : live ? '已启动，等待 CLI 返回进展' : AGENT_LABELS[a.status] || a.status);
    const toolBrief = tool ? `${tool.name}${toolTarget ? ' · ' + String(toolTarget).slice(0, 120) : ''}` : '';
    const meta = toolBrief || (home ? a.ownerTitle : '');
    const time = `<span data-agent-start="${a.startedAt}" data-agent-end="${a.finishedAt || ''}">${elapsed(a.startedAt, a.finishedAt || now)}</span>`;
    return `<details class="agent-card ${live ? 'live' : ''}" data-agent-detail="${escape(key)}"><summary data-agent-window="${escape(a.id)}" data-agent-thread="${escape(a.ownerId)}" title="在右侧分栏查看 · ${escape(a.name)}"><span class="dot ${live ? 'active' : a.status === 'error' ? 'error' : 'muted-dot'}"></span><span class="agent-name">${escape(a.name)}</span><span class="agent-state">${AGENT_LABELS[a.status] || a.status}</span><span class="agent-brief">${escape(brief.slice(0, 200))}</span><span class="agent-brief-meta"><span title="${escape(meta)}">${escape(meta)}</span>${time}</span></summary><div class="agent-card-body"><button class="agent-open-window" data-agent-window="${escape(a.id)}" data-agent-thread="${escape(a.ownerId)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3h4v4m0-4L7 9M6 3H3v10h10v-3"/></svg>独立窗口</button>${home ? `<button class="agent-open-chat" data-agent-owner="${escape(a.ownerId)}">进入所属会话</button>` : ''}<div class="agent-meta">${a.type ? escape(a.type) + ' · ' : ''}${time}${a.model ? ' · ' + escape(a.model) : ''}${a.background ? ' · 后台' : ''}</div>${a.parentTaskId || a.parentId ? '<div class="agent-meta">嵌套子任务</div>' : ''}${a.usage ? `<div class="agent-meta">${Number(a.usage.totalTokens || 0).toLocaleString()} tokens · ${a.usage.toolUses || 0} 次工具调用</div>` : ''}${a.description ? `<p>${escape(a.description.slice(0, 3000))}</p>` : ''}${a.summary ? `<p class="agent-summary">${escape(a.summary)}</p>` : a.lastTool ? `<p class="agent-summary">最近工具 · ${escape(a.lastTool)}</p>` : ''}${a.answer ? `<pre>${escape(a.answer)}</pre>` : ''}${a.thinking ? `<details class="agent-thinking"><summary>思考过程</summary><pre>${escape(a.thinking)}</pre></details>` : ''}${tools.map(t => `<details class="agent-tool"><summary>${escape(t.name)} · ${TOOL_LABELS[t.status] || t.status}</summary><pre>${escape(JSON.stringify(t.input, null, 2))}${t.output ? '\n' + escape(t.output) : ''}</pre></details>`).join('')}${a.error ? `<p class="agent-error">${escape(a.error)}</p>` : ''}</div></details>`;
  }).join('');
}

const diffLines = text => text.split('\n').map(line => `<span class="${line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}">${escape(line)}\n</span>`).join('');

// The bar above the file list for a conversation that runs in its own worktree.
export function worktreeBarHtml(wt, state) {
  const text = !state ? '正在读取状态…' : !state.exists ? '工作树已失效，可以移除' : state.dirty ? `${state.dirty} 个未提交的改动` : state.merged ? `已合并到 ${state.target}` : state.ahead ? `${state.ahead} 个提交待合并` : '还没有新的提交';
  const canMerge = state?.exists && !state.dirty && state.ahead > 0 && !state.merged && state.target;
  return `<div class="worktree-info"><strong>独立工作树</strong><span title="${escape(wt.path)}">${escape(wt.branch)} · 基于 ${escape(wt.base || wt.baseCommit.slice(0, 7))}</span><span class="worktree-state${state?.merged ? ' merged' : ''}">${text}</span></div><div class="worktree-actions"><button type="button" data-worktree="merge" ${canMerge ? '' : 'disabled'} title="${state?.dirty ? '先在下面提交工作树里的改动' : ''}">合并到 ${escape(state?.target || wt.base || '当前分支')}</button><button type="button" data-worktree="remove">移除</button></div>`;
}

export function createInspector({ store, actions, api, composer, toast, dock, review, confirm }) {
  let worktreeState = null;
  async function worktreeBar(workspace) {
    const bar = $('#worktree-bar'), wt = workspace?.worktree;
    bar.hidden = !wt; if (!wt) return;
    setHtml(bar, worktreeBarHtml(wt, worktreeState?.id === workspace.id ? worktreeState.state : null));
    try { const state = await api('worktree:status', workspace.id); worktreeState = { id: workspace.id, state }; if (store.workspace()?.id === workspace.id) setHtml(bar, worktreeBarHtml(wt, state)); } catch (e) { toast(e.message); }
  }
  $('#worktree-bar').addEventListener('click', guarded(toast, async event => {
    const button = event.target.closest('[data-worktree]'), workspace = store.workspace(); if (!button || !workspace?.worktree) return;
    const wt = workspace.worktree, state = worktreeState?.id === workspace.id ? worktreeState.state : await api('worktree:status', workspace.id);
    if (button.dataset.worktree === 'merge') {
      if (!await confirm({ title: `合并到 ${state.target}？`, description: `工作树分支 ${wt.branch} 上的 ${state.ahead} 个提交会以一个合并提交并入主目录当前的 ${state.target} 分支。有冲突时会自动取消，主目录不受影响。`, label: '合并', kind: 'neutral' })) return;
      button.disabled = true;
      const result = await api('worktree:merge', workspace.id); toast(`已把 ${result.commits} 个提交合并到 ${result.target}`);
    } else {
      const lost = state.exists && state.dirty, unmerged = state.ahead > 0 && !state.merged;
      const description = (lost ? `工作树里有 ${state.dirty} 个未提交的改动，移除后会丢失。` : '') + (unmerged ? `分支 ${wt.branch} 上的提交还没合并，分支会保留，以后可以手动合并。` : '') + '移除后这个会话会在项目目录里继续。';
      if (!await confirm({ title: '移除独立工作树？', description, preview: wt.path, label: lost ? '丢弃改动并移除' : '移除', kind: lost ? 'danger' : 'neutral' })) return;
      const result = await api('worktree:remove', workspace.id, lost); await actions.apply(result.thread);
      toast(result.branchKept ? `工作树已移除，分支 ${wt.branch} 已保留` : '工作树已移除');
    }
    worktreeState = null; await refreshFiles();
  }));
  let generation = 0, lastProject = '', panelKey = '';
  const list = $('#file-list');

  async function refreshFiles() {
    const project = store.workspace(), current = ++generation;
    worktreeBar(project);
    if (!project) {
      list.dataset.view = 'files';
      setHtml(list, '<div class="empty-files"><span class="empty-icon"><svg class="folder-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 1.6h4.8A1.6 1.6 0 0 1 14 6.2v5.2a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4Z"/></svg></span><strong>尚未选择项目</strong>选择项目后，在这里查看文件与改动。</div>');
      $('#branch').textContent = '本地项目'; $('#change-count').textContent = '0'; $('#diff-view').hidden = true; return;
    }
    try {
      if (lastProject !== project.id) { $('#diff-view').hidden = true; lastProject = project.id; }
      const changes = await api('project:changes', project.id); if (current !== generation) return;
      $('#change-count').textContent = changes.files.length; $('#branch').textContent = changes.branch || '本地文件夹';
      if (store.panelTab === 'changes') return review.render(project, changes);
      const files = (await api('project:files', project.id)).map(path => ({ path, status: '' }));
      if (current !== generation) return;
      list.dataset.view = 'files';
      setHtml(list, files.length ? files.map(f => `<button class="file-row" data-file="${escape(f.path)}" title="${escape(f.path)}"><span class="file-icon">▧</span><span class="file-path">${escape(f.path.replaceAll('\\', '/'))}</span><span class="file-status"></span></button>`).join('') : '<div class="empty-files"><span class="empty-icon"><svg class="folder-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 1.6h4.8A1.6 1.6 0 0 1 14 6.2v5.2a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4Z"/></svg></span><strong>没有文件</strong>这个文件夹里还没有可显示的文件。</div>');
    } catch (e) { if (current === generation) setHtml(list, `<div class="empty-files">${escape(e.message)}</div>`); }
  }

  function renderPanel() {
    const thread = store.current(), sources = new Map();
    for (const r of [...(thread?.turns.flatMap(t => t.references || []) || []), ...(composer.capture().references || [])]) sources.set(r.kind + ':' + (r.path || r.id), r);
    const agents = collectAgents(store);
    const key = JSON.stringify([[...sources.keys()], agents.map(a => [a.id, a.status, a.summary, a.lastTool, a.tools?.length, a.answer?.length])]);
    if (key === panelKey) return; panelKey = key;
    $('#source-count').textContent = sources.size || '';
    setHtml($('#source-list'), sources.size ? [...sources.values()].map(r => `<div class="source-row" title="${escape(r.label || r.path || r.id)}"><span>${r.kind === 'file' ? '@' : '@@'}</span><span>${escape(r.label || r.path || r.id)}</span></div>`).join('') : '<p class="context-empty">使用 @ 文件或 @@ 会话添加来源</p>');
    const running = agents.filter(a => AGENT_ACTIVE.has(a.status)).length;
    $('#agent-count').textContent = agents.length ? `${running ? running + ' 个进行中 · ' : ''}${agents.length} 个` : '';
    // Keep cards the user opened open across updates.
    const open = new Set([...document.querySelectorAll('#agent-list details[open]')].map(d => d.dataset.agentDetail).filter(Boolean));
    setHtml($('#agent-list'), agentCardsHtml(agents, { home: !thread }));
    for (const details of document.querySelectorAll('#agent-list details[data-agent-detail]')) if (open.has(details.dataset.agentDetail)) details.open = true;
  }
  function tick() {
    for (const node of document.querySelectorAll('#agent-list [data-agent-start]')) node.textContent = elapsed(Number(node.dataset.agentStart), Number(node.dataset.agentEnd) || Date.now());
  }

  function selectTab(tab) {
    store.panelTab = tab;
    $('#tab-changes').classList.toggle('selected', tab === 'changes'); $('#tab-files').classList.toggle('selected', tab === 'files');
    $('#diff-view').hidden = true; composer.save(); return refreshFiles();
  }
  $('#tab-changes').addEventListener('click', () => selectTab('changes'));
  $('#tab-files').addEventListener('click', () => selectTab('files'));
  $('#refresh-files').addEventListener('click', refreshFiles);
  $('#open-folder').addEventListener('click', guarded(toast, () => store.workspace() && api('project:open', store.workspace().id)));
  $('#close-diff').addEventListener('click', () => { $('#diff-view').hidden = true; });
  list.addEventListener('click', guarded(toast, async event => {
    if (store.panelTab !== 'files') return;
    const file = event.target.closest('[data-file]'); if (!file) return;
    const text = await api('project:diff', store.workspace().id, file.dataset.file);
    $('#diff-title').textContent = file.dataset.file; $('#diff-content').innerHTML = diffLines(text); $('#diff-view').hidden = false;
  }));
  $('#agent-list').addEventListener('click', event => {
    const detached = event.target.closest('[data-agent-window]');
    if (detached) { event.preventDefault(); dock.open(detached.dataset.agentThread, detached.dataset.agentWindow); return; }
    const owner = event.target.closest('[data-agent-owner]'); if (owner) actions.selectThread(owner.dataset.agentOwner);
  });

  store.on('select', () => { renderPanel(); refreshFiles(); });
  store.on('thread', thread => {
    if (thread.id === store.selected || !store.selected) renderPanel();
    if (thread.id === store.selected && ['done', 'error', 'stopped'].includes(thread.status)) refreshFiles();
  });
  // While tools run, file changes appear without a manual refresh.
  setInterval(() => { if (store.current()?.status === 'tool') refreshFiles(); }, 12000);
  return { refreshFiles, renderPanel, selectTab, tick };
}
