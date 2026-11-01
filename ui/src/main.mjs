// Entry point: creates the store, actions and views and connects them to the main process.
import { $ } from './core/dom.mjs';
import { createStore } from './core/store.mjs';
import { isUnread } from './core/format.mjs';
import { createToast, createConfirm } from './core/ui.mjs';
import { createActions } from './features/actions.mjs';
import { createComposer } from './views/composer.mjs';
import { createConversation } from './views/conversation.mjs';
import { createStatus } from './views/status.mjs';
import { createSidebar } from './views/sidebar.mjs';
import { createInspector } from './views/inspector.mjs';
import { createReview } from './views/review.mjs';
import { createDock } from './views/dock.mjs';
import { createManager } from './views/manager.mjs';
import { createChrome } from './views/chrome.mjs';
import { createRewind } from './views/rewind.mjs';
import { createTerminalPanel } from './views/terminal.mjs';

const desk = window.desk;
const api = (name, ...args) => desk.invoke(name, ...args);
const store = createStore();
const toast = createToast(), confirm = createConfirm();

// Composer and actions, inspector and review refer to each other; the getters resolve after creation.
let actions, inspector;
const composer = createComposer({ store, api, toast, actions: () => actions });
actions = createActions({ store, api, composer, toast, confirm });
const dock = createDock({ $, store, api, toast, onSelectThread: id => actions.selectThread(id) });
const review = createReview({ store, api, toast, confirm, inspector: () => inspector });
inspector = createInspector({ store, actions, api, composer, toast, dock, review, confirm });
const conversation = createConversation({ store, actions, api, composer, toast, reviewPanel: review });
const status = createStatus({ store, actions, api, composer, toast });
createRewind({ store, api, actions, composer, toast });
createTerminalPanel({ store, api, toast, desk });
const sidebar = createSidebar({ store, actions, toast });
const manager = createManager({ store, api, toast, confirm });
createChrome({ store, actions, api, toast, manager, composer, sidebar });

store.on('composer', () => inspector.renderPanel());
store.on('removed', id => dock.refresh(id));
desk.onThread(thread => {
  if (!store.mergeThread(thread)) actions.fetchFull(thread.id).catch(e => toast(e.message));
  else if (thread.id === store.selected && document.hasFocus() && isUnread(store.thread(thread.id))) actions.markSeen(thread.id);
  dock.refresh(thread.id);
});
// A conversation that finished while the window was in the background is read once you come back to it.
window.addEventListener('focus', () => { if (isUnread(store.current())) actions.markSeen(store.selected); });
desk.onNavigateThread?.(id => { if (store.thread(id)) actions.selectThread(id); else toast('所属会话已删除'); });
desk.onStorageError?.(message => { $('#save-indicator').textContent = '保存失败'; $('#save-indicator').classList.add('error'); toast('会话保存失败：' + message); });
// Elapsed times advance without re-rendering anything else.
setInterval(() => { conversation.tick(); status.tick(); inspector.tick(); }, 1000);

(async () => {
  const state = await api('state');
  store.load(state);
  $('.version').textContent = 'v' + state.version;
  $('#connection-label').textContent = state.provider.cliPath ? state.provider.host : '未找到 Claude CLI';
  $('#connection-dot').classList.toggle('error', !state.provider.cliPath);
  store.panelTab = state.ui?.panelTab === 'files' ? 'files' : 'changes';
  actions.selectThread(null);
  composer.initialize();
  inspector.selectTab(store.panelTab);
  if (state.recovery?.fromBackup || state.recovery?.merged) toast('已恢复并合并本地会话记录。项目和对话现在统一保存在固定目录。');
})().catch(e => { toast('启动失败：' + e.message); $('#connection-label').textContent = '连接失败'; });
