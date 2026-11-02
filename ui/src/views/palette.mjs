// The Ctrl+K panel: type to search chats, files and conversation text, or run an action.
// ↑ ↓ to move, Enter to open, Tab to switch the filter, Esc to close.
import { $, $$, escape } from '../core/dom.mjs';
import { guarded } from '../core/ui.mjs';
import { TABS, paletteSections } from '../lib/palette.mjs';

const ICONS = {
  action: '<path d="M9 2 4 9h4l-1 5 5-7H8Z"/>',
  newChat: '<path d="M10.5 2.5h-6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-6"/><path d="m7 9 6.3-6.3a1 1 0 0 1 1.4 1.4L8.4 10.4 6.5 11Z"/>',
  folder: '<path d="M2 4.6A1.6 1.6 0 0 1 3.6 3h2.5l1.5 1.6h4.8A1.6 1.6 0 0 1 14 6.2v5.2a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4Z"/>',
  terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="m4.5 6 2 2-2 2M8.5 10.5h3"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
  chat: '<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"/>',
  file: '<path d="M4 1.8h5l3 3v9.4H4Z"/><path d="M9 1.8v3h3"/>',
  text: '<path d="M2.5 4h11M2.5 8h11M2.5 12h7"/>'
};
const icon = name => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ICONS.action}</svg>`;

export function createPalette({ store, api, actions, composer, toast }) {
  const dialog = $('#palette'), input = $('#palette-input'), list = $('#palette-list');
  let tab = 'all', items = [], index = 0, files = [], filesFor = null;
  const click = selector => () => document.querySelector(selector)?.click();
  const ACTIONS = [
    { id: 'new-chat', label: '新聊天', shortcut: 'Ctrl+N', icon: 'newChat', keywords: '新对话 新任务 new chat', run: () => actions.showHome() },
    { id: 'open-folder', label: '打开文件夹', shortcut: 'Ctrl+O', icon: 'folder', keywords: '添加项目 open folder project', run: () => actions.addProject() },
    { id: 'terminal', label: '打开或隐藏终端', shortcut: 'Ctrl+`', icon: 'terminal', keywords: 'terminal shell powershell', run: click('#toggle-terminal') },
    { id: 'settings', label: '设置', icon: 'settings', keywords: 'settings 主题 外观 通知 强调色', run: click('#settings') },
    { id: 'import', label: '导入 Codex 对话', icon: 'action', keywords: 'codex import', run: click('#import-codex') },
    { id: 'import-claude', label: '导入 Claude Code 对话', icon: 'action', keywords: 'claude code import 导入', run: click('#import-claude') },
    { id: 'mcp', label: 'MCP 服务器', icon: 'action', keywords: 'mcp server', run: click('#manage-mcp') },
    { id: 'skills', label: '技能', icon: 'action', keywords: 'skills', run: click('#manage-skills') },
    { id: 'usage', label: '累计用量', icon: 'action', keywords: 'usage cost token', run: click('#manage-usage') },
    { id: 'storage', label: '存储占用', icon: 'action', keywords: 'storage disk 空间 清理', run: click('#open-storage') }
  ];

  function render() {
    const sections = paletteSections({ query: input.value, tab, threads: store.state.threads, projects: store.state.projects, actions: ACTIONS, files });
    items = sections.flatMap(s => s.items); index = Math.min(index, Math.max(0, items.length - 1));
    let n = 0;
    list.innerHTML = sections.length ? sections.map(s => `<div class="palette-section">${escape(s.title)}</div>` + s.items.map(item => {
      const i = n++;
      return `<button type="button" class="palette-item${i === index ? ' active' : ''}" data-index="${i}" role="option" aria-selected="${i === index}">${icon(item.icon)}<span class="palette-label">${escape(item.label)}${item.snippet ? `<small>${escape(item.snippet)}</small>` : ''}</span>${item.shortcut ? `<kbd>${escape(item.shortcut)}</kbd>` : item.meta ? `<span class="palette-meta">${escape(item.meta)}</span>` : ''}</button>`;
    }).join('')).join('') : `<div class="palette-empty">${tab === 'files' && !store.workspace() ? '先打开一个项目或对话，才能搜索它的文件' : tab === 'text' && input.value.trim().length < 2 ? '输入至少两个字，搜索所有对话的内容' : '没有找到匹配的结果'}</div>`;
    for (const button of $$('[data-palette-tab]')) button.classList.toggle('selected', button.dataset.paletteTab === tab);
    list.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  async function loadFiles() {
    const workspace = store.workspace(); if (!workspace) { files = []; filesFor = null; return; }
    if (filesFor === workspace.id + workspace.path) return;
    filesFor = workspace.id + workspace.path; files = [];
    try { files = await api('project:files', workspace.id); } catch { files = []; }
    if (dialog.open) render();
  }

  function open(startTab = 'all') {
    if (dialog.open) { input.select(); return; }
    tab = startTab; index = 0; input.value = ''; render(); dialog.showModal(); input.focus(); loadFiles();
  }
  const close = () => dialog.open && dialog.close();

  async function choose(item) {
    if (!item) return;
    close();
    if (item.kind === 'action') return ACTIONS.find(a => a.id === item.id)?.run();
    if (item.kind === 'chat' || item.kind === 'text') { const t = store.thread(item.id); if (t?.archived) store.showArchived = true; return actions.selectThread(item.id); }
    if (item.kind === 'file') { composer.addReference({ kind: 'file', path: item.id, label: item.id }); composer.focus(); toast('已把文件加入引用'); }
  }

  input.addEventListener('input', () => { index = 0; render(); });
  input.addEventListener('keydown', guarded(toast, async event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (items.length) { index = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; render(); } return; }
    if (event.key === 'Tab') { event.preventDefault(); const order = TABS.map(t => t[0]); tab = order[(order.indexOf(tab) + (event.shiftKey ? -1 : 1) + order.length) % order.length]; index = 0; render(); return; }
    if (event.key === 'Enter') { event.preventDefault(); await choose(items[index]); }
  }));
  list.addEventListener('click', guarded(toast, async event => { const button = event.target.closest('[data-index]'); if (button) await choose(items[Number(button.dataset.index)]); }));
  list.addEventListener('mousemove', event => { const button = event.target.closest('[data-index]'); if (button && Number(button.dataset.index) !== index) { index = Number(button.dataset.index); for (const b of list.querySelectorAll('.palette-item')) b.classList.toggle('active', b === button); } });
  for (const button of $$('[data-palette-tab]')) button.addEventListener('click', () => { tab = button.dataset.paletteTab; index = 0; render(); input.focus(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') { event.preventDefault(); dialog.open ? close() : open(); }
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o' && !dialog.open) { event.preventDefault(); guarded(toast, actions.addProject)(); }
  });
  $('#open-palette')?.addEventListener('click', () => open());
  return { open, close };
}
