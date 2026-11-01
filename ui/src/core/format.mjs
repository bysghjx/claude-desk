// Status vocabulary and time formatting used across views.
export const ACTIVE_STATES = new Set(['starting', 'waiting', 'thinking', 'generating', 'tool', 'approval', 'stopping']);
export const STATUS_LABELS = { idle: '就绪', starting: '正在启动', waiting: '等待模型响应', thinking: '正在思考', generating: '正在生成', tool: '执行工具中', approval: '等待你的批准', done: '已完成', error: '运行失败', stopped: '已停止', stopping: '正在停止', interrupted: '已中断' };
export const AGENT_LABELS = { running: '运行中', waiting: '等待中', thinking: '思考中', generating: '生成中', tool: '执行工具', approval: '等待批准', paused: '已暂停', done: '已完成', error: '失败', stopped: '已停止', interrupted: '已中断', ended: '已结束' };
export const AGENT_ACTIVE = new Set(['running', 'waiting', 'thinking', 'generating', 'tool', 'approval', 'paused']);
export const TOOL_LABELS = { running: '运行中', done: '完成', error: '失败', interrupted: '已中断' };

export const isActive = thread => Boolean(thread && ACTIVE_STATES.has(thread.status));

export function elapsed(start, end = Date.now()) {
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
export function shortAgo(time, now = Date.now()) {
  const s = (now - time) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天`;
  return new Date(time).toLocaleDateString();
}
// A finished turn you have not opened yet. Conversations from before this was tracked count as read.
export function isUnread(thread) {
  return Number.isFinite(thread?.seenAt) && !isActive(thread) && ['done', 'error'].includes(thread.status) && (thread.finishedAt || 0) > thread.seenAt;
}
// Sidebar marker: running, waiting for you, or something new to read; nothing otherwise.
export function threadDot(thread) {
  if (thread.status === 'approval') return 'approval';
  if (isActive(thread)) return 'active';
  if (!isUnread(thread)) return '';
  return thread.status === 'error' ? 'error' : 'unread';
}
export function statusClass(thread) {
  if (thread.status === 'error') return 'error';
  if (thread.status === 'approval') return 'approval';
  if (isActive(thread)) return 'active';
  return thread.status === 'done' ? '' : 'muted-dot';
}
