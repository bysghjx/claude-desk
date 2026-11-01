// One conversation turn as a persistent DOM node. `updateTurn` rewrites only the
// parts whose content changed; <details> elements are kept, so their open state
// and any running transition survive streaming updates.
import { escape, markdown, setHtml, element } from '../core/dom.mjs';
import { elapsed } from '../core/format.mjs';
import { splitTurn, stepParts, fileChanges, changesHtml } from '../lib/worklog.mjs';
import { replySpeed } from '../lib/metrics.mjs';

function userHtml(turn) {
  const images = turn.images?.length ? `<div class="user-images">${turn.images.map(image => `<button type="button" class="user-image" data-open-image="${escape(image.id)}" data-image-turn="${escape(turn.id)}" title="${escape(image.name)}">${image.thumb ? `<img src="${escape(image.thumb)}" alt="${escape(image.name)}">` : `<span>${escape(image.name)}</span>`}</button>`).join('')}</div>` : '';
  const references = turn.references?.length ? `<div class="turn-references">${turn.references.map(r => `<span>${r.kind === 'file' ? '@' : '@@'} ${escape(r.label || r.path)}</span>`).join('')}</div>` : '';
  const label = `<div class="assistant-label"><span class="spark">✳</span>${turn.source === 'codex' ? 'Codex · 历史导入' : 'Claude'}${turn.contextRestored ? '<span class="restore" title="应用已从本地历史恢复上下文">从本地历史恢复上下文</span>' : ''}</div>`;
  const rewind = `<div class="user-actions"><button type="button" data-rewind="${escape(turn.id)}" title="删除这一轮及之后的问答，可同时把文件恢复到这一轮开始前；提问放回输入框"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6.5h6a3.5 3.5 0 0 1 0 7H7M3.5 6.5 6 4M3.5 6.5 6 9"/></svg>回退到这里</button></div>`;
  return `<div class="user-line">${images}${turn.user ? `<div class="user-message">${escape(turn.user)}</div>` : ''}${rewind}</div>${references}${label}`;
}

function footerHtml(turn, threadActive) {
  if (turn.status === 'running') return '';
  const speed = replySpeed(turn);
  return `<div class="turn-footer"><span>${turn.status === 'done' ? '✓ 已完成' : turn.status === 'stopped' ? '■ 已停止' : '! 未完成'}</span><span>${elapsed(turn.startedAt, turn.finishedAt || turn.startedAt)}</span><button data-copy="${escape(turn.id)}">复制回复</button><button class="delete-turn" data-delete-turn="${escape(turn.id)}" ${threadActive ? 'disabled' : ''} title="删除这一轮提问、回复与工具记录">删除这轮</button>${['error', 'stopped', 'interrupted'].includes(turn.status) ? `<button data-retry="${escape(turn.id)}">↻ 重试</button>` : ''}${speed != null ? `<span class="reply-speed" title="全程平均：CLI 输出 tokens ÷ 本轮总耗时，包含等待、思考、工具执行与审批时间；不是纯解码速度。">${speed.toFixed(1)} tok/s · 全程平均</span>` : ''}${turn.usage ? `<span class="usage">${turn.usage.output.toLocaleString()} 输出 tokens · $${turn.usage.cost.toFixed(4)}</span>` : ''}</div>`;
}

// Plays a one-off entrance animation; the class is removed afterwards so later
// re-insertions of the same node do not replay it.
export function animateIn(node, className = 'is-entering') {
  // Restart when the same node is triggered again before the previous run ended.
  const runs = node.__motion ||= {};
  runs[className]?.();
  if (node.classList.contains(className)) { node.classList.remove(className); void node.offsetWidth; }
  node.classList.add(className);
  const done = event => {
    if (event && event.target !== node) return;
    node.classList.remove(className); node.removeEventListener('animationend', done); clearTimeout(timer); delete runs[className];
  };
  const timer = setTimeout(done, 900);
  node.addEventListener('animationend', done);
  runs[className] = () => { node.removeEventListener('animationend', done); clearTimeout(timer); };
}

const itemKey = (item, index) => item.type === 'tool' ? 'tool:' + item.id : item.type + ':' + index;

function updateItem(node, item, cwd) {
  if (item.type === 'tool') {
    const parts = stepParts(item.tool, { escape, cwd });
    if (node.className !== parts.className) node.className = parts.className;
    setHtml(node.firstChild, parts.summary); setHtml(node.lastChild, parts.body);
  } else if (item.type === 'thinking') setHtml(node.lastChild, escape(item.text));
  else setHtml(node, markdown(item.text));
}
function createItem(item, cwd) {
  let node;
  if (item.type === 'tool') { node = element('details'); node.append(element('summary'), element('div', 'step-body')); }
  else if (item.type === 'thinking') { node = element('details', 'work-thinking'); node.append(element('summary', '', '思考'), element('div', 'work-thinking-text')); }
  else node = element('div', 'work-note markdown');
  updateItem(node, item, cwd); return node;
}

// The folded group with everything that happened before the final answer.
function updateWork(view, turn, work, live) {
  if (!work.length) { view.work?.remove(); view.work = null; view.items.clear(); return; }
  if (!view.work) {
    view.work = element('details', 'work-group');
    view.work.append(element('summary', '', '<span class="work-label"></span><span class="work-count"></span>'), element('div', 'work-items'));
    view.work.firstChild.addEventListener('click', () => { view.work.dataset.userToggled = '1'; });
    view.final.before(view.work);
    if (view.ready) animateIn(view.work);
  }
  const group = view.work, steps = work.filter(i => i.type === 'tool').length;
  group.classList.toggle('live', live);
  // Open while running, fold when finished, unless the user chose otherwise.
  if (!group.dataset.userToggled) group.open = live;
  const label = group.querySelector('.work-label');
  if (live) label.dataset.since = turn.startedAt; else delete label.dataset.since;
  label.textContent = live ? `正在处理 · ${elapsed(turn.startedAt)}` : steps ? `已处理 ${elapsed(turn.startedAt, turn.finishedAt || turn.startedAt)}` : '已思考';
  group.querySelector('.work-count').textContent = steps ? `${steps} 个步骤` : '';
  const list = group.lastChild, seen = new Set();
  let previous = null;
  work.forEach((item, index) => {
    const key = itemKey(item, index); seen.add(key);
    let node = view.items.get(key);
    if (!node) { node = createItem(item, view.cwd); view.items.set(key, node); if (view.ready) animateIn(node); }
    else updateItem(node, item, view.cwd);
    if (node.previousSibling !== previous || node.parentNode !== list) previous ? previous.after(node) : list.prepend(node);
    previous = node;
  });
  for (const [key, node] of view.items) if (!seen.has(key)) { node.remove(); view.items.delete(key); }
}

export function createTurn(turn, context) {
  const root = element('article', 'turn');
  root.dataset.turn = turn.id;
  const view = { root, rev: null, cwd: context.cwd, items: new Map(), work: null, head: element('div', 'turn-head'), final: element('div', 'markdown turn-final'), tail: element('div', 'turn-tail') };
  root.append(view.head, view.final, view.tail);
  updateTurn(view, turn, context);
  // From now on, new steps and the finishing summary animate; the initial render does not.
  view.ready = true;
  return view;
}

export function updateTurn(view, turn, { threadActive }) {
  if (view.rev === turn.rev && view.threadActive === threadActive && turn.rev != null) return false;
  view.rev = turn.rev; view.threadActive = threadActive;
  const live = turn.status === 'running';
  const { work, final } = splitTurn(turn);
  setHtml(view.head, userHtml(turn));
  updateWork(view, turn, work, live);
  if (setHtml(view.final, markdown(final)) && final && !view.hadFinal && view.ready) animateIn(view.final);
  view.hadFinal = Boolean(final);
  if (view.ready && view.live && !live) animateIn(view.root, 'just-finished');
  view.live = live;
  const changes = live ? [] : fileChanges(turn, view.cwd);
  setHtml(view.tail, `${turn.error ? `<div class="error-card">${escape(turn.error)}</div>` : ''}${changesHtml(changes, escape)}${footerHtml(turn, threadActive)}`);
  return true;
}
