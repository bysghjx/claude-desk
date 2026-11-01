// Run status around the composer: activity bar, send/stop button, queued
// messages and the approval card for the selected conversation.
import { $, escape, markdown, setHtml, setText } from '../core/dom.mjs';
import { approvalHtml, collectAnswers, isPlan, pickChoice, questionsOf } from './approval.mjs';
import { STATUS_LABELS, elapsed, isActive } from '../core/format.mjs';
import { guarded } from '../core/ui.mjs';

export function pendingApproval(thread) {
  return thread?.turns.flatMap(t => t.approvals?.length ? t.approvals : t.approval ? [t.approval] : []).sort((a, b) => a.createdAt - b.createdAt)[0];
}

export function createStatus({ store, actions, api, composer, toast }) {
  let approvalShown = '';

  function sendButton() {
    const active = store.running(), stop = active && composer.isEmpty(), send = $('#send');
    send.classList.toggle('stop', stop);
    send.setAttribute('aria-label', stop ? '停止当前运行' : active ? '加入队列' : '发送消息');
    send.title = stop ? '停止当前运行' : active ? '加入队列 · Enter（本轮完成后发送）' : '发送 · Enter';
  }

  function queue() {
    const items = store.current()?.queue || [];
    $('#queue-list').hidden = !items.length;
    setHtml($('#queue-list'), items.map((q, i) => `<div class="queue-item"><span class="queue-badge">${i ? '排队 ' + (i + 1) : '下一条'}</span><span class="queue-text" title="${escape(q.text)}">${escape(q.text || '（仅图片）')}</span>${q.options?.images?.length ? `<span class="queue-images">${q.options.images.length} 张图片</span>` : ''}<button type="button" data-queue-send="${escape(q.id)}" title="停止当前运行并立即发送这条">立即发送</button><button type="button" data-queue-edit="${escape(q.id)}" title="移回输入框修改">编辑</button><button type="button" class="queue-remove" data-queue-remove="${escape(q.id)}" title="从队列中删除" aria-label="删除排队消息">×</button></div>`).join(''));
  }

  function approval() {
    const thread = store.current(), request = pendingApproval(thread);
    $('#approval').hidden = !request;
    if (!request) { approvalShown = ''; return; }
    const agent = thread.turns.flatMap(turn => turn.subagents || []).find(a => a.id === request.agentId || a.aliases?.includes(request.agentId));
    const source = agent?.name || request.agentName || '', key = request.id + '|' + source;
    if (approvalShown === key) return; approvalShown = key;
    $('#approval').innerHTML = approvalHtml(request, source, markdown);
  }

  function activity() {
    const thread = store.current(), active = isActive(thread);
    $('#activity').hidden = !active;
    $('#prompt').placeholder = active ? '运行中也可以继续输入，Enter 加入队列，本轮完成后自动发送…' : '发送消息到 Claude Code… 输入 / 唤起命令，@ 引用文件，@@ 引用会话，可粘贴图片';
    if (!active) { setText($('#context-hint'), thread?.status === 'error' ? '运行失败，可查看具体错误并重试' : '沿用本机 Claude CLI 配置 · 无需额外账号'); return; }
    $('#activity').classList.toggle('approval-state', thread.status === 'approval');
    setText($('#activity-label'), STATUS_LABELS[thread.status] || thread.status);
    setText($('#elapsed'), elapsed(thread.startedAt));
    const since = Math.floor((Date.now() - (thread.lastEventAt || thread.startedAt)) / 1000);
    setText($('#last-event'), `${since}s 前收到事件`);
    setText($('#activity-detail'), since > 25 && thread.status !== 'approval' ? `进程仍在运行，${since}s 未收到新事件；可能正在等待服务商。` : thread.detail || '等待 Claude 的下一个事件');
    setText($('#context-hint'), thread.status === 'approval' ? '需要你批准后才能继续，不会自动放行' : '运行中 · 可以切换其他会话，当前任务会继续');
  }

  function render() { activity(); sendButton(); queue(); approval(); composer.renderUsage(); }

  $('#queue-list').addEventListener('click', guarded(toast, async event => {
    const send = event.target.closest('[data-queue-send]'); if (send) { send.disabled = true; return actions.sendQueuedNow(send.dataset.queueSend); }
    const edit = event.target.closest('[data-queue-edit]'); if (edit) return actions.editQueued(edit.dataset.queueEdit);
    const remove = event.target.closest('[data-queue-remove]'); if (remove) return actions.removeQueued(remove.dataset.queueRemove);
  }));
  async function answer(allow, button) {
    const request = pendingApproval(store.current()); if (!request) return;
    const card = $('#approval'), questions = questionsOf(request); let answers, extra;
    if (questions && allow) {
      const result = collectAnswers(card, questions);
      if (result.missing) return toast('还没回答：' + result.missing);
      answers = result.answers;
    }
    if (isPlan(request)) extra = allow ? { mode: button?.dataset.planMode || 'default' } : { feedback: card.querySelector('.plan-feedback')?.value.trim() || '' };
    for (const b of card.querySelectorAll('button')) b.disabled = true;
    await api('approval', store.selected, request.id, allow, answers, extra);
    if (extra?.mode) composer.setMode(extra.mode);
  }
  $('#approval').addEventListener('click', guarded(toast, async event => {
    const choice = event.target.closest('.choice');
    if (choice) { if (pickChoice($('#approval'), choice)) await answer(true); return; }
    const button = event.target.closest('[data-approve]'); if (button) await answer(button.dataset.approve === 'yes', button);
  }));
  $('#approval').addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.matches('.choice-input')) { event.preventDefault(); guarded(toast, answer)(true); }
  });
  $('#stop-inline').addEventListener('click', guarded(toast, actions.stop));

  store.on('select', render);
  store.on('composer', sendButton);
  store.on('thread', thread => { if (thread.id === store.selected) render(); });
  return { render, tick: activity, sendButton };
}
