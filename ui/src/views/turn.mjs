// One conversation turn as a persistent DOM node. `updateTurn` rewrites only the
// parts whose content changed; <details> elements are kept, so their open state
// and any running transition survive streaming updates.
import { escape, markdown, setHtml, element } from '../core/dom.mjs';
import { elapsed, STATUS_LABELS } from '../core/format.mjs';
import { turnParts, toolView, stepParts, agentOf, agentParts, fileChanges, changesHtml, taskListHtml, wrapUpHtml, proposalsHtml, groupSteps, groupSummaryHtml } from '../lib/worklog.mjs';
import { replySpeed } from '../lib/metrics.mjs';

function userHtml(turn) {
  const images = turn.images?.length ? `<div class="user-images">${turn.images.map(image => `<button type="button" class="user-image" data-open-image="${escape(image.id)}" data-image-turn="${escape(turn.id)}" title="${escape(image.name)}">${image.thumb ? `<img src="${escape(image.thumb)}" alt="${escape(image.name)}">` : `<span>${escape(image.name)}</span>`}</button>`).join('')}</div>` : '';
  const references = turn.references?.length ? `<div class="turn-references">${turn.references.map(r => `<span>${r.kind === 'file' ? '@' : '@@'} ${escape(r.label || r.path)}</span>`).join('')}</div>` : '';
  const label = `<div class="assistant-label"><span class="spark">✳</span>${turn.source === 'codex' ? 'Codex · 历史导入' : turn.source === 'claude' ? 'Claude Code · 历史导入' : 'Claude'}${turn.contextRestored ? '<span class="restore" title="应用已从本地历史恢复上下文">从本地历史恢复上下文</span>' : ''}</div>`;
  const rewind = `<div class="user-actions"><button type="button" data-edit-turn="${escape(turn.id)}" title="编辑这条消息并重新发送" aria-label="编辑"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3 13 5.5 6 12.5l-3 .5.5-3Z"/><path d="m9 4.5 2.5 2.5"/></svg></button><button type="button" data-rewind="${escape(turn.id)}" title="回退到这里：删除这一轮及之后的问答，可同时把文件恢复到这一轮开始前；提问放回输入框" aria-label="回退到这里"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 6.5h6a3.5 3.5 0 0 1 0 7H7M3.5 6.5 6 4M3.5 6.5 6 9"/></svg></button></div>`;
  const steer = turn.fromSteer ? '<span class="steer-tag" title="运行中插入的消息，上一轮结束后接着处理">插话</span>' : '';
  return `<div class="user-line">${images}${turn.user ? `<div class="user-message">${escape(turn.user)}${steer}</div>` : ''}${rewind}</div>${references}${label}`;
}

function footerHtml(turn, threadActive) {
  if (turn.status === 'running') return '';
  const speed = replySpeed(turn);
  return `<div class="turn-footer"><span>${turn.status === 'done' ? '✓ 已完成' : turn.status === 'stopped' ? '■ 已停止' : '! 未完成'}</span><span>${elapsed(turn.startedAt, turn.finishedAt || turn.startedAt)}</span><button class="icon-action" data-copy="${escape(turn.id)}" title="复制回复" aria-label="复制回复"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/></svg></button><button class="icon-action delete-turn" data-delete-turn="${escape(turn.id)}" ${threadActive ? 'disabled' : ''} title="删除这一轮提问、回复与工具记录" aria-label="删除这轮"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5h11M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5M4 4.5l.6 8.1a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.1M6.7 7v4M9.3 7v4"/></svg></button>${['error', 'stopped', 'interrupted'].includes(turn.status) ? `<button data-retry="${escape(turn.id)}">↻ 重试</button>` : ''}${speed != null ? `<span class="reply-speed" title="全程平均：CLI 输出 tokens ÷ 本轮总耗时，包含等待、思考、工具执行与审批时间；不是纯解码速度。">${speed.toFixed(1)} tok/s · 全程平均</span>` : ''}${turn.usage ? `<span class="usage">${turn.usage.output.toLocaleString()} 输出 tokens · $${turn.usage.cost.toFixed(4)}</span>` : ''}</div>`;
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

const itemKey = (item, index) => item.type === 'tool' || item.type === 'steer' ? item.type + ':' + item.id : item.type + ':' + index;
// 插话 reads like one of your messages, in the place Claude read it. Until then it waits at the
// end of the turn, saying what it waits for, with a way to stop the step and send it at once.
function steerHtml(steer, turn) {
  const images = steer.images?.length ? `<span class="turn-steer-images">${steer.images.length} 张图片</span>` : '';
  const running = steer.status === 'pending' && (turn.tools || []).findLast(t => t.status === 'running');
  const wait = running ? `等「${escape(running.input?.description || toolView(running).target.split('\n')[0].slice(0, 60) || running.name)}」完成后交给 Claude` : '这一步结束后交给 Claude';
  const meta = steer.status === 'pending' ? `<span class="turn-steer-state">${wait}</span><button type="button" data-steer-now="${escape(steer.id)}" title="停止当前步骤，马上把这条消息发给 Claude">打断并立即发送</button>` : '<span class="turn-steer-state">插话 · Claude 已读到</span>';
  return `<div class="turn-steer-text">${escape(steer.text || '（图片）')}${images}</div><div class="turn-steer-meta">${meta}</div>`;
}

// `ctx` is { cwd, turn, ready }: the turn holds the sub-agents an Agent step opens up.
const isAgentStep = tool => toolView(tool).kind === 'agent';
// An Agent step shows what its sub-agent did: the task, every step it took (drawn like the
// turn's own steps) and its conclusion. The task and the steps keep their nodes, so what
// you opened stays open while the sub-agent works.
function updateAgent(node, tool, ctx) {
  const parts = agentParts(tool, agentOf(ctx.turn, tool), { escape });
  if (node.className !== parts.className) node.className = parts.className;
  setHtml(node.firstChild, parts.summary);
  const [head, prompt, steps, empty, final] = node.lastChild.children;
  setHtml(head, parts.head);
  prompt.hidden = !parts.prompt; setHtml(prompt.lastChild, escape(parts.prompt));
  renderSteps(steps, node.agentSteps ||= new Map(), parts.work, ctx);
  empty.hidden = !parts.empty; setHtml(empty, escape(parts.empty));
  final.hidden = !parts.final; setHtml(final.lastChild, markdown(parts.final));
}
function updateItem(node, item, ctx) {
  if (item.type === 'tool' && isAgentStep(item.tool)) updateAgent(node, item.tool, ctx);
  else if (item.type === 'tool') {
    const parts = stepParts(item.tool, { escape, cwd: ctx.cwd });
    if (node.className !== parts.className) node.className = parts.className;
    setHtml(node.firstChild, parts.summary); setHtml(node.lastChild, parts.body);
  } else if (item.type === 'thinking') setHtml(node.lastChild, escape(item.text));
  else setHtml(node, markdown(item.text));
}
function createItem(item, ctx) {
  let node;
  if (item.type === 'tool' && isAgentStep(item.tool)) {
    node = element('details'); node.append(element('summary'), element('div', 'step-body'));
    const prompt = element('details', 'agent-step-prompt'); prompt.append(element('summary', '', '任务说明'), element('div', 'agent-step-prompt-text'));
    const final = element('div', 'agent-step-final'); final.append(element('div', 'agent-step-final-label', '结论'), element('div', 'markdown'));
    node.lastChild.append(element('div'), prompt, element('div', 'agent-steps'), element('p', 'step-empty'), final);
  } else if (item.type === 'tool') { node = element('details'); node.append(element('summary'), element('div', 'step-body')); }
  else if (item.type === 'thinking') { node = element('details', 'work-thinking'); node.append(element('summary', '', '思考'), element('div', 'work-thinking-text')); }
  // What Claude wrote between steps, as the server summarized it (the CLI sends it as thinking).
  else if (item.type === 'narration') { node = element('div', 'work-note work-narration markdown'); node.title = 'Claude 在步骤之间的说明（服务端摘要）'; }
  else node = element('div', 'work-note markdown');
  updateItem(node, item, ctx); return node;
}
// Steps in `list`, runs of one kind folded into a row; `nodes` keeps each step's node by key.
function renderSteps(list, nodes, work, ctx) {
  const seen = new Set();
  const place = (node, parent, before) => { if (node.previousSibling !== before || node.parentNode !== parent) before ? before.after(node) : parent.prepend(node); };
  const itemNode = index => {
    const item = work[index], key = itemKey(item, index); seen.add(key);
    let node = nodes.get(key);
    if (!node) { node = createItem(item, ctx); nodes.set(key, node); if (ctx.ready) animateIn(node); }
    else updateItem(node, item, ctx);
    return node;
  };
  let previous = null;
  for (const entry of groupSteps(work)) {
    let node;
    if (entry.indices) {
      const key = 'group:' + itemKey(work[entry.indices[0]], entry.indices[0]); seen.add(key);
      node = nodes.get(key);
      if (!node) { node = element('details', 'step-group'); node.append(element('summary'), element('div', 'step-group-items')); nodes.set(key, node); }
      node.classList.toggle('running', entry.running);
      setHtml(node.firstChild, groupSummaryHtml(entry));
      let before = null;
      for (const index of entry.indices) { const child = itemNode(index); place(child, node.lastChild, before); before = child; }
    } else node = itemNode(entry.index);
    place(node, list, previous); previous = node;
  }
  for (const [key, node] of nodes) if (!seen.has(key)) { node.remove(); nodes.delete(key); }
}

// The folded group with everything that happened before the final answer.
// While the turn runs its row reads like the status: 等待模型响应 · 41s, with the detail
// (工具已返回，等待模型继续) after it; the row exists from the start, before any step.
export function liveLabel(status, since, lastEventAt, detail, now = Date.now()) {
  const quiet = Math.floor((now - (lastEventAt || since)) / 1000);
  return { label: `${STATUS_LABELS[status] || '正在处理'} · ${elapsed(since, now)}`, detail: quiet > 25 && status !== 'approval' ? `${quiet}s 未收到新事件，可能在等服务商` : detail || '' };
}
// `part` holds one folded group and its step nodes; a turn has one per stretch between 插话.
function updateWork(view, part, turn, work, live, run, span) {
  if (!work.length && !live) { part.work?.remove(); part.work = null; part.items.clear(); return null; }
  if (!part.work) {
    const node = part.work = element('details', 'work-group');
    node.append(element('summary', '', '<span class="work-label"></span><span class="work-count"></span><span class="work-detail"></span>'), element('div', 'work-items'));
    node.firstChild.addEventListener('click', () => { node.dataset.userToggled = '1'; });
    if (view.ready) animateIn(node);
  }
  const group = part.work, steps = work.filter(i => i.type === 'tool').length;
  group.classList.toggle('live', live);
  // Open while running, fold when finished, unless the user chose otherwise.
  if (!group.dataset.userToggled) group.open = live;
  const label = group.querySelector('.work-label'), detail = group.querySelector('.work-detail');
  if (live) Object.assign(label.dataset, { since: turn.startedAt, status: run.status || '', lastEvent: run.lastEventAt || '', detail: run.detail || '' });
  else for (const key of ['since', 'status', 'lastEvent', 'detail']) delete label.dataset[key];
  const now = live ? liveLabel(run.status, turn.startedAt, run.lastEventAt, run.detail) : null;
  label.textContent = live ? now.label : steps ? `已处理 ${elapsed(span.since, span.until)}` : '已思考';
  detail.textContent = live ? now.detail : '';
  group.querySelector('.work-count').textContent = steps ? `${steps} 个步骤` : '';
  // Runs of one kind of step sit in a folded row; the steps keep their own nodes.
  renderSteps(group.lastChild, part.items, work, { cwd: view.cwd, turn, ready: view.ready });
  return group;
}

// The turn's steps and 插话 in order, between the question and the final answer; 插话 not read yet after the answer.
function updateBody(view, turn, live, run) {
  const { parts, final, pending } = turnParts(turn), keep = new Set();
  const place = (node, parent, before) => { if (node.parentNode !== parent || node.previousSibling !== before) before ? before.after(node) : parent.prepend(node); return node; };
  const steerNode = steer => {
    keep.add(steer.id); let node = view.steers.get(steer.id);
    if (!node) { node = element('div', 'turn-steer'); view.steers.set(steer.id, node); if (view.ready) animateIn(node); }
    node.classList.toggle('pending', steer.status === 'pending'); setHtml(node, steerHtml(steer, turn)); return node;
  };
  let previous = null, since = turn.startedAt;
  parts.forEach((p, index) => {
    const key = p.steer?.id || ''; keep.add('part:' + key);
    let part = view.parts.get(key); if (!part) view.parts.set(key, part = { work: null, items: new Map() });
    if (p.steer) {
      previous = place(steerNode(p.steer), view.body, previous); since = p.steer.deliveredAt || since;
      let reply = view.replies.get(p.steer.id);
      if (p.reply) { if (!reply) view.replies.set(p.steer.id, reply = element('div', 'markdown turn-steer-reply')); setHtml(reply, markdown(p.reply)); previous = place(reply, view.body, previous); }
      else if (reply) { reply.remove(); view.replies.delete(p.steer.id); }
    }
    const last = index === parts.length - 1, until = last ? turn.finishedAt || since : parts[index + 1].steer.deliveredAt || since;
    const group = updateWork(view, part, turn, p.work, live && last, run, { since, until });
    if (group) previous = place(group, view.body, previous);
  });
  let after = null;
  for (const steer of live ? pending : []) after = place(steerNode(steer), view.pending, after);
  for (const [key, part] of view.parts) if (!keep.has('part:' + key)) { part.work?.remove(); view.parts.delete(key); }
  for (const [id, node] of view.steers) if (!keep.has(id)) { node.remove(); view.steers.delete(id); view.replies.get(id)?.remove(); view.replies.delete(id); }
  return final;
}

export function createTurn(turn, context) {
  const root = element('article', 'turn');
  root.dataset.turn = turn.id;
  const view = { root, rev: null, cwd: context.cwd, parts: new Map(), steers: new Map(), replies: new Map(), head: element('div', 'turn-head'), body: element('div', 'turn-body'), final: element('div', 'markdown turn-final'), pending: element('div', 'turn-pending'), tail: element('div', 'turn-tail') };
  root.append(view.head, view.body, view.final, view.pending, view.tail);
  updateTurn(view, turn, context);
  // From now on, new steps and the finishing summary animate; the initial render does not.
  view.ready = true;
  return view;
}

// `turns` is the whole conversation, passed for the latest turn only: its task list is built from every turn.
export function updateTurn(view, turn, { threadActive, latest = false, turns = null, run = null }) {
  const runKey = run ? [run.status, run.detail, run.lastEventAt].join('|') : '';
  if (view.rev === turn.rev && view.threadActive === threadActive && view.latest === latest && view.runKey === runKey && turn.rev != null) return false;
  view.rev = turn.rev; view.threadActive = threadActive; view.latest = latest; view.runKey = runKey;
  const live = turn.status === 'running';
  if (!view.head.querySelector('.user-edit')) setHtml(view.head, userHtml(turn));
  const final = updateBody(view, turn, live, run || {});
  if (setHtml(view.final, markdown(final)) && final && !view.hadFinal && view.ready) animateIn(view.final);
  view.hadFinal = Boolean(final);
  if (view.ready && view.live && !live) animateIn(view.root, 'just-finished');
  view.live = live;
  const changes = live ? [] : fileChanges(turn, view.cwd);
  const tasks = latest && turns ? taskListHtml(turns, escape) : '';
  setHtml(view.tail, `${tasks}${turn.error ? `<div class="error-card">${escape(turn.error)}</div>` : ''}${changesHtml(changes, escape, { turnId: turn.id, undo: turn.undone ? 'undone' : turn.checkpoint ? 'ready' : '', disabled: threadActive })}${live ? '' : proposalsHtml(turn, { escape })}${wrapUpHtml(turn, { escape, latest, threadActive })}${footerHtml(turn, threadActive)}`);
  return true;
}
