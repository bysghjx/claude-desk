// Run status around the composer: activity bar, send/stop button, queued
// messages and the approval card for the selected conversation.
import { $, escape, setHtml, setText } from '../core/dom.mjs';
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
    const questions = request.input?.questions;
    $('#approval').innerHTML = `<div class="approval-title">${source ? escape(source) + ' · ' : ''}${questions ? 'Claude 需要你的回答' : `批准 ${escape(request.name)}？`}</div><p>${escape(request.reason)}</p>${questions ? questions.map((q, i) => `<label class="question">${escape(q.question)}<small>${(q.options || []).map(x => `${escape(x.label)}：${escape(x.description || '')}`).join('<br>')}</small><input data-question="${i}" placeholder="输入你的回答" aria-label="${escape(q.question)}"></label>`).join('') : `<pre>${escape(JSON.stringify(request.input, null, 2))}</pre>`}<div class="approval-actions"><button class="secondary" data-approve="no">${questions ? '取消' : '拒绝'}</button><button class="primary" data-approve="yes">${questions ? '提交回答' : '仅允许这一次'}</button></div>`;
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
  $('#approval').addEventListener('click', guarded(toast, async event => {
    const button = event.target.closest('[data-approve]'); if (!button) return;
    const request = pendingApproval(store.current()); if (!request) return;
    const allow = button.dataset.approve === 'yes'; let answers;
    if (request.input.questions && allow) {
      answers = {};
      for (const input of $('#approval').querySelectorAll('[data-question]')) {
        if (!input.value.trim()) return toast('请填写回答');
        answers[request.input.questions[Number(input.dataset.question)].question] = input.value.trim();
      }
    }
    await api('approval', store.selected, request.id, allow, answers);
  }));
  $('#stop-inline').addEventListener('click', guarded(toast, actions.stop));

  store.on('select', render);
  store.on('composer', sendButton);
  store.on('thread', thread => { if (thread.id === store.selected) render(); });
  return { render, tick: activity, sendButton };
}
