// Sidebar tree: pinned conversations, then projects with their conversations.
// Re-renders only when something it displays changed, not on every streaming event.
import { $, escape } from '../core/dom.mjs';
import { STATUS_LABELS, isActive, shortAgo, threadDot } from '../core/format.mjs';
import { guarded } from '../core/ui.mjs';

const VISIBLE_LIMIT = 6;

export function createSidebar({ store, actions, toast }) {
  const list = $('#threads'), menu = $('#thread-menu');
  const expanded = new Set();
  const collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem('collapsedProjects') || '[]'); } catch { return []; } })());
  let renaming = null, signature = '';

  function row(t) {
    const editing = renaming === t.id;
    return `<div class="thread-row ${t.id === store.selected ? 'selected' : ''} ${t.pinned ? 'pinned' : ''}" draggable="${editing ? 'false' : 'true'}" data-drag-thread="${escape(t.id)}"><button class="thread-open" data-thread="${escape(t.id)}" title="${escape(t.title)}"><span class="dot thread-dot ${threadDot(t)}" ${threadDot(t) === 'unread' ? 'title="有新回复"' : threadDot(t) === 'error' ? 'title="运行出错，还没查看"' : ''}></span><span class="thread-copy">${editing ? `<input class="thread-rename" data-rename-input="${escape(t.id)}" value="${escape(t.title)}" maxlength="80" aria-label="新的会话名称">` : `<strong>${escape(t.title)}</strong>`}</span>${t.worktree && !t.worktree.removed ? `<span class="thread-worktree" title="独立工作树 · ${escape(t.worktree.branch)}"><svg class="branch-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-2 3-5.5 4"/></svg></span>` : ''}${t.queue?.length ? `<span class="thread-queue" title="排队中的消息">${t.queue.length}</span>` : ''}<span class="thread-time">${isActive(t) ? STATUS_LABELS[t.status] || '' : shortAgo(t.updatedAt)}</span></button><button class="thread-more" data-thread-menu="${escape(t.id)}" title="更多操作" aria-label="会话 ${escape(t.title)} 的更多操作">⋯</button></div>`;
  }

  function treeHtml() {
    const query = $('#search').value.trim().toLowerCase(), archivedView = store.showArchived;
    const matches = t => !query || `${t.title} ${t.turns.map(x => x.user).join(' ')}`.toLowerCase().includes(query);
    const visible = store.state.threads.filter(t => Boolean(t.archived) === archivedView && matches(t)).sort((a, b) => b.updatedAt - a.updatedAt);
    const pinned = archivedView ? [] : visible.filter(t => t.pinned);
    const groups = store.state.projects.map(p => ({ p, threads: visible.filter(t => t.projectId === p.id && !pinned.includes(t)) }))
      .filter(g => g.threads.length || (!query && !archivedView));
    const chats = visible.filter(t => !pinned.includes(t) && !t.projectId);
    const orphans = visible.filter(t => !pinned.includes(t) && t.projectId && !store.state.projects.some(p => p.id === t.projectId));
    const selectedProject = !store.current() && store.currentProject()?.id;
    let html = pinned.length ? `<div class="tree-section">置顶</div>${pinned.map(row).join('')}` : '';
    // Chats (no project) come first, like Codex; drop a conversation here to take it out of its project.
    if (!archivedView && !query || chats.length) html += `<div class="chat-group" data-drop-project=""><div class="tree-section chats-head">对话<button class="project-new" data-new-chat title="新对话（不属于任何项目）" aria-label="新对话">+</button></div>${chats.length ? chats.slice(0, expanded.has('chats') || query ? chats.length : VISIBLE_LIMIT).map(row).join('') + (chats.length > VISIBLE_LIMIT && !expanded.has('chats') && !query ? `<button class="tree-more" data-expand-project="chats">显示其余 ${chats.length - VISIBLE_LIMIT} 个</button>` : '') : `<div class="tree-empty">${archivedView ? '没有归档的对话' : '不选项目直接提问，会出现在这里'}</div>`}</div><div class="tree-section">项目</div>`;
    for (const { p, threads } of groups) {
      const folded = !query && collapsed.has(p.id), limit = expanded.has(p.id) || query ? threads.length : VISIBLE_LIMIT;
      html += `<div class="project-block" data-project-block="${escape(p.id)}"><div class="project-group ${selectedProject === p.id ? 'selected' : ''}" data-drop-project="${escape(p.id)}" draggable="true" data-drag-project="${escape(p.id)}"><button class="project-head" data-project-toggle="${escape(p.id)}" title="${escape(p.path)}" aria-expanded="${!folded}"><span class="project-chevron ${folded ? 'collapsed' : ''}">▾</span><span class="folder"><svg class="folder-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 1.6h4.8A1.6 1.6 0 0 1 14 6.2v5.2a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4Z"/></svg></span><span class="project-name">${escape(p.name)}</span></button><button class="project-new" data-new-in-project="${escape(p.id)}" title="在 ${escape(p.name)} 中新建任务" aria-label="在 ${escape(p.name)} 中新建任务">＋</button></div>`;
      if (!folded) html += threads.length ? threads.slice(0, limit).map(row).join('') + (threads.length > limit ? `<button class="tree-more" data-expand-project="${escape(p.id)}">显示其余 ${threads.length - limit} 个</button>` : '') : `<div class="tree-empty">${archivedView ? '没有归档的会话' : '还没有会话'}</div>`;
      html += '</div>';
    }
    if (orphans.length) html += `<div class="tree-section">其他</div>${orphans.map(row).join('')}`;
    if (html) return html;
    if (!store.state.projects.length) return '<div class="no-project">添加文件夹，让 Claude 在你的项目里工作。</div>';
    return `<div class="empty-list">${query ? '没有匹配的会话' : archivedView ? '没有归档的会话' : '还没有会话<br>从一个新问题开始。'}</div>`;
  }

  function render() {
    const html = treeHtml();
    const archived = store.state.threads.filter(t => t.archived).length;
    $('#show-archived').textContent = store.showArchived ? '← 返回会话' : `已归档${archived ? ' · ' + archived : ''}`;
    $('#show-archived').hidden = !archived && !store.showArchived;
    // Keep an in-progress rename input (and its caret) intact.
    if (html === signature || (renaming && list.querySelector('[data-rename-input]'))) return;
    signature = html; list.innerHTML = html;
    const input = list.querySelector('[data-rename-input]'); if (input) { input.focus(); input.select(); }
  }

  function closeMenu() { menu.hidden = true; menu.dataset.thread = ''; }
  function openMenu(id, anchor) {
    const t = store.thread(id); if (!t) return;
    menu.innerHTML = `<button data-menu-action="rename">重命名</button><button data-menu-action="pin">${t.pinned ? '取消置顶' : '置顶'}</button><button data-menu-action="archive">${t.archived ? '取消归档' : '归档'}</button><div class="menu-line"></div><button data-menu-action="delete" class="danger">删除会话</button>`;
    menu.dataset.thread = id; menu.hidden = false;
    const rect = anchor.getBoundingClientRect();
    menu.style.left = Math.min(rect.right - 4, window.innerWidth - 180) + 'px'; menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 170) + 'px';
    menu.querySelector('button').focus();
  }
  function startRename(id) { closeMenu(); renaming = id; signature = ''; render(); }
  async function finishRename(id, value) {
    if (renaming !== id) return;
    renaming = null; signature = ''; render();
    await actions.rename(id, value);
  }
  function cancelRename() { renaming = null; signature = ''; render(); }

  menu.addEventListener('click', guarded(toast, async event => {
    const action = event.target.closest('[data-menu-action]')?.dataset.menuAction, id = menu.dataset.thread;
    if (!action || !id) return;
    const t = store.thread(id); closeMenu(); if (!t) return;
    if (action === 'rename') return startRename(id);
    if (action === 'pin') return actions.setPinned(id, !t.pinned);
    if (action === 'archive') return actions.setArchived(id, !t.archived);
    if (action === 'delete') return actions.deleteThread(id);
  }));
  document.addEventListener('mousedown', event => { if (!menu.hidden && !event.target.closest?.('#thread-menu,[data-thread-menu]')) closeMenu(); });
  list.addEventListener('keydown', event => {
    const input = event.target.closest?.('[data-rename-input]'); if (!input) return;
    if (event.key === 'Enter') { event.preventDefault(); finishRename(input.dataset.renameInput, input.value).catch(e => toast(e.message)); }
    if (event.key === 'Escape') { event.preventDefault(); cancelRename(); }
  });
  list.addEventListener('focusout', event => { const input = event.target.closest?.('[data-rename-input]'); if (input) finishRename(input.dataset.renameInput, input.value).catch(e => toast(e.message)); });
  list.addEventListener('click', guarded(toast, async event => {
    const target = event.target;
    const remove = target.closest('[data-delete-thread]'); if (remove) return actions.deleteThread(remove.dataset.deleteThread);
    if (target.closest('[data-rename-input]')) return;
    const more = target.closest('[data-thread-menu]');
    if (more) { event.stopPropagation(); return menu.dataset.thread === more.dataset.threadMenu && !menu.hidden ? closeMenu() : openMenu(more.dataset.threadMenu, more); }
    const open = target.closest('[data-thread]'); if (open) return actions.selectThread(open.dataset.thread);
    if (target.closest('[data-new-chat]')) return actions.showHome();
    const fresh = target.closest('[data-new-in-project]'); if (fresh) { collapsed.delete(fresh.dataset.newInProject); return actions.selectProject(fresh.dataset.newInProject); }
    const expand = target.closest('[data-expand-project]'); if (expand) { expanded.add(expand.dataset.expandProject); return render(); }
    const toggle = target.closest('[data-project-toggle]');
    if (toggle) { const id = toggle.dataset.projectToggle; collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); localStorage.setItem('collapsedProjects', JSON.stringify([...collapsed])); render(); }
  }));
  $('#search').addEventListener('input', render);
  // Drag a conversation onto a project, or onto 对话, to move it.
  // Drag a project header above or below another project to reorder the list.
  let dragging = null, draggingProject = null;
  const dropZone = event => event.target.closest?.('[data-drop-project]');
  const clearDrop = () => list.querySelectorAll('.drop-target,.drop-before,.drop-after').forEach(el => el.classList.remove('drop-target', 'drop-before', 'drop-after'));
  // Where the dragged project would land: before or after the block under the pointer.
  function projectSlot(event) {
    const block = event.target.closest?.('[data-project-block]'); if (!block || !draggingProject) return null;
    const rect = block.getBoundingClientRect(), after = event.clientY > rect.top + rect.height / 2;
    return { block, id: block.dataset.projectBlock, after };
  }
  function reordered(slot) {
    const ids = store.state.projects.map(p => p.id).filter(id => id !== draggingProject);
    const at = ids.indexOf(slot.id); if (at < 0) return null;
    ids.splice(at + (slot.after ? 1 : 0), 0, draggingProject);
    return ids.join() === store.state.projects.map(p => p.id).join() ? null : ids;
  }
  list.addEventListener('dragstart', event => {
    const head = event.target.closest?.('[data-drag-project]');
    if (head) {
      draggingProject = head.dataset.dragProject; event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', store.state.projects.find(p => p.id === draggingProject)?.name || '');
      head.closest('[data-project-block]')?.classList.add('dragging'); closeMenu(); return;
    }
    const rowEl = event.target.closest?.('[data-drag-thread]'); if (!rowEl) return;
    dragging = rowEl.dataset.dragThread; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', store.thread(dragging)?.title || '');
    rowEl.classList.add('dragging'); closeMenu();
  });
  list.addEventListener('dragend', () => { list.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging')); dragging = null; draggingProject = null; clearDrop(); });
  list.addEventListener('dragover', event => {
    if (draggingProject) {
      const slot = projectSlot(event); if (!slot || !reordered(slot)) { clearDrop(); return; }
      event.preventDefault(); event.dataTransfer.dropEffect = 'move';
      const name = slot.after ? 'drop-after' : 'drop-before';
      if (!slot.block.classList.contains(name)) { clearDrop(); slot.block.classList.add(name); }
      return;
    }
    const zone = dropZone(event), thread = dragging && store.thread(dragging); if (!zone || !thread) return;
    if ((thread.projectId || '') === zone.dataset.dropProject) { clearDrop(); return; }
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    if (!zone.classList.contains('drop-target')) { clearDrop(); zone.classList.add('drop-target'); }
  });
  list.addEventListener('dragleave', event => { if (!list.contains(event.relatedTarget)) clearDrop(); });
  // Read the target synchronously: dragend (which clears `dragging`) fires right after drop.
  list.addEventListener('drop', event => {
    if (draggingProject) {
      const slot = projectSlot(event), ids = slot && reordered(slot); clearDrop(); draggingProject = null;
      if (ids) { event.preventDefault(); guarded(toast, actions.reorderProjects)(ids); }
      return;
    }
    const zone = dropZone(event), id = dragging; clearDrop(); if (!zone || !id) return;
    event.preventDefault(); dragging = null;
    guarded(toast, actions.moveThread)(id, zone.dataset.dropProject || null);
  });
  $('#show-archived').addEventListener('click', () => { store.showArchived = !store.showArchived; render(); });
  $('#add-project').addEventListener('click', guarded(toast, actions.addProject));

  for (const event of ['thread', 'threads', 'select', 'load']) store.on(event, render);
  setInterval(render, 30000);
  return { render, startRename };
}
