// Everything that changes conversations or selection goes through these actions.
// They talk to the main process via `api`, to the input box via `composer`, and
// never touch the DOM, so they can be tested with plain fakes.
import { isActive } from '../core/format.mjs';

export function createActions({ store, api, composer, toast, confirm }) {
  let sending = false;

  async function fetchFull(id) { store.mergeThread(await api('thread:get', id)); }
  // Applies a thread returned by the main process; fetches it whole if a reused turn is unknown.
  async function apply(thread) {
    if (!thread || typeof thread !== 'object' || !thread.id) return thread;
    if (!store.mergeThread(thread)) await fetchFull(thread.id);
    return store.thread(thread.id);
  }

  function selectThread(id) {
    if (store.ready) store.drafts.set(store.selected || 'new', composer.capture());
    store.selected = id || null;
    const thread = store.current();
    if (thread) store.projectId = thread.projectId;
    const draft = store.drafts.get(id || 'new');
    composer.restore(draft, draft?.options?.model ? draft.options : (thread || store.state.settings));
    store.ready = true;
    store.emit('select', store.selected);
    composer.save();
  }
  function showHome() { store.projectId = null; selectThread(null); composer.focus(); }
  function selectProject(projectId) { store.projectId = projectId || null; selectThread(null); composer.focus(); }

  async function addProject() {
    const project = await api('project:add'); if (!project) return null;
    store.addProject(project); store.projectId = project.id;
    selectThread(null); composer.focus(); return project;
  }
  async function newThread() {
    const project = store.currentProject();
    if (!project) return addProject();
    const thread = await apply(await api('thread:create', project.id));
    selectThread(thread.id); composer.focus(); return thread;
  }

  // Sends the composer contents (or `text` for retries). While the conversation is
  // running, the message joins its queue and goes out when the turn finishes.
  async function sendMessage(text) {
    if (sending) return;
    const draft = composer.capture(), images = draft.images || [];
    text = String(text ?? draft.text ?? '').trim();
    if (!text && !images.length) return;
    if (!store.current() && !store.currentProject()) { toast('请先在主页选择一个工作项目，或点击「添加文件夹」。'); composer.focusProject?.(); return; }
    sending = true;
    const fromHome = !store.current(), queueing = !fromHome && isActive(store.current());
    try {
      if (fromHome) { await newThread(); if (!store.current()) return; }
      const id = store.selected, chosen = composer.options();
      const options = { model: draft.options?.model || chosen.model, effort: draft.options?.effort || chosen.effort, mode: draft.options?.mode || chosen.mode, references: draft.references || [], images };
      if (fromHome) store.drafts.delete('new');
      store.drafts.delete(id); composer.clear();
      if (queueing) { await apply(await api('thread:queue', id, text, options)); toast('已加入队列，本轮完成后自动发送'); }
      else await apply(await api('thread:send', id, text, options));
      store.state.settings = { ...store.state.settings, model: options.model, effort: options.effort, mode: options.mode };
      await api('settings', store.state.settings);
      composer.save();
    } catch (e) {
      composer.restore({ ...draft, text }); composer.save(); toast(e.message);
    } finally { sending = false; store.emit('composer'); }
  }
  const stop = () => store.selected && api('thread:stop', store.selected);

  async function deleteThread(id) {
    const thread = store.thread(id); if (!thread) return false;
    if (!await confirm({ title: '删除整个会话？', description: '将删除全部问答、工具记录和草稿，并停止当前会话的运行。项目文件保留。此操作无法撤销。', preview: thread.title, label: '删除会话' })) return false;
    if (!await api('thread:delete', id)) return false;
    const wasSelected = store.selected === id;
    store.removeThread(id);
    if (wasSelected) { store.ready = false; store.selected = null; showHome(); }
    composer.save(); toast('会话已删除'); return true;
  }
  async function deleteTurn(turnId) {
    const id = store.selected, turn = store.current()?.turns.find(t => t.id === turnId); if (!turn) return false;
    if (!await confirm({ title: '删除这轮问答？', description: '将删除这一轮的提问、回复、思考和工具记录。后续问答与项目文件保留。此操作无法撤销。', preview: turn.user, label: '删除这轮' })) return false;
    await apply(await api('turn:delete', id, turnId)); toast('这轮问答已删除'); return true;
  }
  async function rename(id, title) {
    const thread = store.thread(id); title = String(title || '').trim();
    if (!thread || !title || title === thread.title) return;
    await apply(await api('thread:rename', id, title));
  }
  async function setPinned(id, pinned) { await apply(await api('thread:meta', id, { pinned })); }
  async function setArchived(id, archived) {
    await apply(await api('thread:meta', id, { archived }));
    if (archived && store.selected === id) showHome();
    toast(archived ? '会话已归档，可在侧栏底部「已归档」中找回' : '已取消归档');
  }

  async function sendQueuedNow(queueId) { await api('queue:send', store.selected, queueId); }
  async function removeQueued(queueId) { await api('queue:remove', store.selected, queueId); }
  async function editQueued(queueId) {
    if (!composer.isEmpty()) { toast('输入框里还有内容，请先发送或清空后再编辑排队消息'); return; }
    const item = await api('queue:take', store.selected, queueId); if (!item) return;
    composer.restore({ text: item.text, references: item.options?.references || [], images: item.options?.images || [] });
    composer.save(); composer.focus(); store.emit('composer');
  }

  async function retry(turnId) { const turn = store.current()?.turns.find(t => t.id === turnId); if (turn) await sendMessage(turn.user); }
  async function copyAnswer(turnId) { const turn = store.current()?.turns.find(t => t.id === turnId); if (turn) { await api('copy', turn.answer); toast('已复制回复'); } }

  return { apply, fetchFull, selectThread, showHome, selectProject, addProject, newThread, sendMessage, stop, deleteThread, deleteTurn, rename, setPinned, setArchived, sendQueuedNow, removeQueued, editQueued, retry, copyAnswer };
}
