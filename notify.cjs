// Decides which desktop notifications a thread update deserves, like Codex: a turn
// that finished or failed, a new approval request, a question or a plan to confirm.
// Pure bookkeeping — showing the notification is left to the caller.
const ACTIVE = new Set(['starting', 'waiting', 'thinking', 'generating', 'tool', 'approval', 'stopping']);
const clip = (text, size = 120) => { text = String(text || '').replace(/\s+/g, ' ').trim(); return text.length > size ? text.slice(0, size - 1) + '…' : text; };

function approvalNotice(t, request) {
  const input = request.input || {};
  const who = request.agentName ? `子智能体「${request.agentName}」` : 'Claude ';
  if (Array.isArray(input.questions) && input.questions.length) return { kind: 'question', title: `${who}有问题想问你`, body: clip(input.questions[0].question) || clip(t.title) };
  if (request.name === 'ExitPlanMode') return { kind: 'plan', title: '计划等待你确认', body: clip(input.plan) || clip(t.title) };
  const detail = input.command || input.file_path || input.path || input.url || input.description || '';
  return { kind: 'approval', title: `${who}需要你批准 ${request.name}`, body: clip(detail || request.reason) };
}

class NotificationTracker {
  constructor() { this.seen = new Map(); }
  // Returns the notices for this snapshot and remembers it for the next comparison.
  update(t) {
    const before = this.seen.get(t.id) || { status: null, approvals: new Set() };
    const approvals = new Map();
    for (const turn of t.turns || []) for (const request of turn.approvals || []) approvals.set(request.id, request);
    this.seen.set(t.id, { status: t.status, approvals: new Set(approvals.keys()) });
    const notices = [];
    for (const [id, request] of approvals) if (!before.approvals.has(id)) notices.push(approvalNotice(t, request));
    const wasRunning = ACTIVE.has(before.status);
    // A finished turn with queued messages keeps going, so only the last one notifies.
    if (wasRunning && t.status === 'done' && !t.queue?.length) {
      const answer = t.turns?.at(-1)?.answer;
      notices.push({ kind: 'done', title: `任务已完成 · ${clip(t.title, 40)}`, body: clip(answer) || '本轮已完成' });
    }
    if (wasRunning && t.status === 'error') notices.push({ kind: 'error', title: `运行出错 · ${clip(t.title, 40)}`, body: clip(t.turns?.at(-1)?.error || t.detail) || '本轮运行失败' });
    return notices.map(n => ({ ...n, threadId: t.id }));
  }
  forget(id) { this.seen.delete(id); }
}
module.exports = { NotificationTracker, approvalNotice };
