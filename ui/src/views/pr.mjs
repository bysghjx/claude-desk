// Keeps the pull request card current for the selected conversation: on opening
// it, after each turn (Claude may have pushed), and every minute while checks run.
import { $, escape, setHtml } from '../core/dom.mjs';
import { isActive } from '../core/format.mjs';
import { guarded } from '../core/ui.mjs';
import { prHtml, fixPrompt } from '../lib/pr.mjs';

export function createPrPanel({ store, api, actions, toast }) {
  const section = $('#pr-section'), body = $('#pr-body');
  let shown = null, status = null, generation = 0;
  const render = () => setHtml(body, prHtml(status, { escape, idle: !isActive(store.current()) }));

  async function refresh() {
    const thread = store.current();
    section.hidden = !thread?.projectId;
    if (section.hidden) { shown = null; return; }
    if (shown !== thread.id) { shown = thread.id; status = null; render(); }
    const current = ++generation, before = status?.pr?.checks;
    try {
      const next = await api('pr:status', thread.id);
      if (current !== generation || shown !== thread.id) return;
      status = next; render();
      const after = next.pr?.checks;
      if (before?.pending && after && !after.pending) toast(after.failed ? `#${next.pr.number} 的检查结束：${after.failed} 项失败` : `#${next.pr.number} 的检查全部通过`);
    } catch (e) { if (current === generation) { status = { available: false, reason: e.message }; render(); } }
  }

  body.addEventListener('click', guarded(toast, async event => {
    const link = event.target.closest('[data-pr-open]'); if (link) return api('pr:open', link.dataset.prOpen);
    if (event.target.closest('[data-pr-fix]') && status?.pr) await actions.sendMessage(fixPrompt(status.pr));
  }));
  $('#refresh-pr').addEventListener('click', refresh);
  store.on('select', refresh);
  // Refresh when a turn ends, not on every later update of a finished conversation.
  let wasActive = false;
  store.on('thread', thread => {
    if (thread.id !== store.selected) return;
    const active = isActive(thread);
    if (wasActive && !active) refresh(); else render();
    wasActive = active;
  });
  store.on('select', () => { wasActive = isActive(store.current()); });
  setInterval(() => { if (!section.hidden && status?.pr?.checks.pending) refresh(); }, 60000);
  return { refresh };
}
