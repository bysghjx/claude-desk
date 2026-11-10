const {legacyUsage,recordUsage}=require('./usage.cjs');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('./disk-fs.cjs');
const {historyTail}=require('./json-stream.cjs');
const {hasUnexecutedToolText}=require('./ui/src/lib/tool-protocol.mjs');
const path = require('node:path');
const {atomicWrite,loadRecoverable,mergeLegacy}=require('./storage.cjs');
const {markNarration,ACTIVE_AGENT,activeAgents,findAgent,dropToolAgents,ensureAgent,agentFromTool,finishAgentTool,settleAgents,handleAgentMessage}=require('./subagents.cjs');
const {WRAP_UP,PROPOSE,DESK_TOOLS,PROMPT:DESK_PROMPT,wrapUpOf,proposalOf}=require('./desk-tools.cjs');
// How replies are drawn: bold stands out, a file in inline code opens on click, alerts become callouts.
const FORMAT_PROMPT = '回复里的关键点用 **加粗** 标出；提到文件时写成行内代码的路径，例如 `src/app.js:42`，用户点一下就能打开。只有真正有风险、用户必须知道的事（例如会丢数据、还没验证、需要用户操作），才单独一段用 > [!WARNING] 开头写成提示块，每条回复最多一处；大多数回复不需要。';

const questionsOf = args => Array.isArray(args?.questions) && args.questions.length;
const ACTIVE = new Set(['starting', 'waiting', 'thinking', 'generating', 'tool', 'approval', 'stopping']);
// The user's own prompts, added after Claude Desk's part of the system prompt:
// a global one for every conversation and one per project, which wins on conflicts.
const INSTRUCTIONS_MAX = 20000;
const instructionsPrompt = ({ global, project }) => (global ? `\n\n<global_instructions>\n用户对所有会话的要求，与上面的默认做法冲突时以这里为准：\n${global}\n</global_instructions>` : '') + (project ? `\n\n<project_instructions>\n用户对这个项目的要求，与上面的默认做法或全局要求冲突时以这里为准：\n${project}\n</project_instructions>` : '');
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Items keep text, thinking and tool calls in the order they happened so the
// renderer can show the work leading up to the final answer.
function addItem(turn, type, text = '') { (turn.items ||= []).push(type === 'tool' ? { type, id: text } : { type, text }); return turn.items.at(-1); }
function appendItem(turn, type, text) { const last = turn.items?.at(-1); if (last?.type === type) last.text += text; else addItem(turn, type, text); }
class InputQueue {
  constructor() { this.items = []; this.waiters = []; this.closed = false; }
  push(value) { if (this.closed) throw Error('会话已关闭'); const next = this.waiters.shift(); next ? next({ value, done: false }) : this.items.push(value); }
  close() { this.closed = true; for (const next of this.waiters.splice(0)) next({ done: true }); }
  [Symbol.asyncIterator]() { return this; }
  next() { if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false }); if (this.closed) return Promise.resolve({ done: true }); return new Promise(resolve => this.waiters.push(resolve)); }
}
class JsonStore {
  constructor(file, legacyFiles=[]) {
    this.file = file;
    const defaults={threads:[],projects:[],settings:{model:'claude-opus-5-5',effort:'high',mode:'default'},ui:{selectedThread:null,projectId:null,drafts:{}},schemaVersion:2};
    const loaded=loadRecoverable(file,defaults);this.state=loaded.state;this.recovered=loaded.recovered;
    if(!this.state.migrations?.unifiedDataV2){this.recoveredCount=mergeLegacy(this.state,legacyFiles.filter(p=>path.resolve(p)!==path.resolve(file)));this.state.migrations={...this.state.migrations,unifiedDataV2:true};}
    if(this.recoveredCount)delete this.state.usageAccountingVersion;legacyUsage(this.state);
    JsonStore.normalize(this);
  }
  static normalize(store){
    store.state={settings:{model:'claude-opus-5-5',effort:'high',mode:'default'},ui:{selectedThread:null,projectId:null,drafts:{}},schemaVersion:2,...store.state};
    store.state.settings={model:'claude-opus-5-5',effort:'high',mode:'default',...store.state.settings};
    store.state.ui={selectedThread:null,projectId:null,drafts:{},...store.state.ui};
    for (const t of store.state.threads) {
      if(activeAgents(t).length&&!ACTIVE.has(t.status)){t.status='interrupted';t.error='上次运行的子智能体随应用退出而中断。';}
      settleAgents(t,'interrupted');
      if (ACTIVE.has(t.status)) { t.status = 'interrupted'; t.error = '上次运行随应用退出而中断。可以重试。'; const last=t.turns.at(-1); if(last){last.status='interrupted';last.error=t.error;delete last.approval;} }
      for (const turn of t.turns) { dropToolAgents(turn); for (const tool of turn.tools || []) if (['running', 'approval'].includes(tool.status)) tool.status = 'interrupted'; }
    }
  }
  save() {
    this.state.savedAt=Date.now();atomicWrite(this.file,this.state);
  }
}
class Engine extends EventEmitter {
  // deskServer creates the in-process MCP server with Claude Desk's own tools (see desk-tools.cjs).
  constructor({ query, startup = null, store, cliPath, env = process.env, sessionOptions=()=>({}), attachmentRoot='', chatRoot='', deskServer=null, providerOptions=()=>null }) {
    super(); Object.assign(this, { query, startup, store, cliPath, env, sessionOptions, attachmentRoot, chatRoot, deskServer, providerOptions }); this.runs = new Map(); this.pending = new Map(); this.warm = new Map();
    this.saveTimer = null; this.eventTimers = new Map(); this.closing = false; this.deleting = new Set(); this.draining = new Set(); this.snapshots = new WeakMap(); this.toolCopies = new WeakMap(); this.revision = 0;
    // Projects used to be listed by recent activity; keep that order once, then the user's drag order wins.
    const state = this.store.state;
    if (!state.migrations?.projectOrder) {
      const latest = id => Math.max(0, ...state.threads.filter(t => t.projectId === id).map(t => t.updatedAt || 0));
      state.projects.sort((a, b) => latest(b.id) - latest(a.id)); state.migrations = { ...state.migrations, projectOrder: true };
    }
  }
  thread(id) { const t = this.store.state.threads.find(x => x.id === id); if (!t) throw Error('会话不存在'); return t; }
  syncAgentStatus(t,run){
    const pending=[...this.pending.values()].filter(p=>p.threadId===t.id);
    for(const a of activeAgents(t))if(pending.some(p=>(p.agentId===a.id||a.aliases?.includes(p.agentId))))a.status='approval';
    if(t.status==='stopping')return;
    if(pending.length){t.status='approval';t.detail=`等待你批准 ${pending.length} 项操作`;}
    else if(run?.mainDone){
      const agents=activeAgents(t);
      t.status=agents.length?'tool':run.resultStatus||'done';
      t.detail=agents.length?`${agents.length} 个子智能体仍在运行`:t.status==='done'?'本轮已完成':t.error||'';
    }
  }
  publish(id, immediate = true) {
    const t = this.thread(id);
    this.syncAgentStatus(t,this.runs.get(id));
    // Messages queued while a turn ran go out once it finishes cleanly; an error or stop leaves them for the user.
    if (t.status === 'done' && t.queue?.length && !this.closing && !this.draining.has(id)) setImmediate(() => this.drain(id).catch(() => {}));
    // Streaming updates are saved lightly once a second, for the conversations they touched.
    (this.touched ||= new Set()).add(id);
    if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; const touched = this.touched; this.touched = new Set(); try{this.store.save(false, { durable: false, touched });}catch(e){for (const x of touched) this.touched.add(x); this.emit('storage-error',e.message);} }, 1000);
    if (immediate) { clearTimeout(this.eventTimers.get(id)); this.eventTimers.delete(id); this.emit('thread', this.threadSnapshot(this.thread(id))); }
    else if (!this.eventTimers.has(id)) this.eventTimers.set(id, setTimeout(() => { this.eventTimers.delete(id); if (this.store.state.threads.some(x => x.id === id)) this.emit('thread', this.threadSnapshot(this.thread(id))); }, 70));
  }
  // Snapshots are immutable copies for listeners. Each turn carries a revision:
  // live turns get a new one on every update, settled turns reuse a cached copy
  // until their content fingerprint changes, so unchanged history is not re-cloned.
  turnSnapshot(turn) {
    const live = turn.status === 'running' || turn.approvals?.length || (turn.subagents || []).some(a => ACTIVE_AGENT.has(a.status));
    const fingerprint = live ? null : [turn.status, turn.finishedAt, turn.error, turn.answer?.length, turn.thinking?.length, turn.items?.length, turn.tools?.length, (turn.tools || []).map(x => x.status + (x.output?.length || 0)).join(), (turn.subagents || []).map(a => a.status + (a.tools?.length || 0) + (a.answer?.length || 0)).join(), turn.usage?.output, (turn.proposals || []).map(p => p.status).join(), turn.undone?.at, (turn.steers || []).map(s => s.status).join()].join('|');
    const cached = this.snapshots.get(turn);
    if (cached && fingerprint !== null && cached.fingerprint === fingerprint) return cached.copy;
    // Tools are copied one by one and reused while unchanged: a long turn's outputs are
    // not cloned again on every streamed update.
    const { tools, ...rest } = turn;
    const copy = { ...structuredClone(rest), ...(tools ? { tools: tools.map(tool => this.toolSnapshot(tool)) } : {}), rev: ++this.revision };
    this.snapshots.set(turn, { fingerprint, copy });
    return copy;
  }
  // A tool's input is fixed when it is created; status and output change once it finishes.
  toolSnapshot(tool) {
    const key = [tool.status, tool.output?.length, tool.finishedAt].join('|'), cached = this.toolCopies.get(tool);
    if (cached?.key === key) return cached.copy;
    const copy = structuredClone(tool); this.toolCopies.set(tool, { key, copy }); return copy;
  }
  threadSnapshot(t) {
    const { turns, ...meta } = t;
    return { ...structuredClone(meta), turns: turns.map(turn => this.turnSnapshot(turn)) };
  }
  snapshot() { const { threads, ...rest } = this.store.state; return { ...structuredClone(rest), threads: threads.map(t => this.threadSnapshot(t)) }; }
  setStatus(t, status, detail) { t.status = status; t.detail = detail || ''; t.lastEventAt = Date.now(); this.publish(t.id); }
  addProject(directory) {
    const real = fs.realpathSync(directory);
    if (!fs.statSync(real).isDirectory()) throw Error('请选择文件夹');
    let p = this.store.state.projects.find(x => x.path.toLowerCase() === real.toLowerCase());
    if (!p) { p = { id: randomUUID(), name: path.basename(real), path: real }; this.store.state.projects.splice(this.store.state.projects.filter(x => x.pinned).length, 0, p); this.store.save(); }
    return p;
  }
  // `ids` is the full project list in its new order (dragged in the sidebar).
  reorderProjects(ids) {
    const projects = this.store.state.projects;
    if (!Array.isArray(ids) || ids.length !== projects.length || new Set(ids).size !== ids.length || ids.some(id => !projects.some(p => p.id === id))) throw Error('项目列表已变化，请重试');
    projects.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); this.store.save();
    return projects.map(p => p.id);
  }
  // A pinned project goes to the top of the pinned ones; an unpinned one to the top of the rest.
  setProjectPinned(id, pinned) {
    const projects = this.store.state.projects, p = projects.find(x => x.id === id); if (!p) throw Error('项目不存在');
    projects.splice(projects.indexOf(p), 1);
    if (pinned) p.pinned = true; else delete p.pinned;
    projects.splice(pinned ? 0 : projects.filter(x => x.pinned).length, 0, p); this.store.save();
    return structuredClone(projects);
  }
  // `worktree` (from worktree.cjs) makes the conversation run in its own checkout.
  // Without a project the conversation is a chat: it works in its own empty folder under chatRoot.
  create(projectId, { worktree } = {}) {
    const p = projectId ? this.store.state.projects.find(p => p.id === projectId) : null; if (projectId && !p) throw Error('项目不存在');
    const id = randomUUID(), cwd = worktree?.cwd || p?.path || this.chatFolder(id);
    const t = { id, projectId: p ? projectId : null, cwd, ...(worktree ? { worktree } : {}), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), status: 'idle', seenAt: Date.now(), turns: [], model: this.store.state.settings.model, effort: this.store.state.settings.effort, mode: this.store.state.settings.mode };
    this.store.state.threads.unshift(t); this.store.save(); return t;
  }
  // Starts a conversation Claude proposed with propose_session: same project and
  // settings as the conversation it came from, the brief as its first message.
  async startProposal(id, proposalId) {
    const t = this.thread(id), turn = t.turns.find(x => (x.proposals || []).some(p => p.id === proposalId)), proposal = turn?.proposals.find(p => p.id === proposalId);
    if (!proposal) throw Error('找不到这个提议');
    if (proposal.status === 'started') throw Error('这个提议已经开始了');
    const child = this.create(t.projectId); child.parentId = t.id;
    proposal.status = 'started'; proposal.threadId = child.id; this.publish(t.id);
    try { await this.send(child.id, proposal.prompt, { model: t.model, mode: t.mode, effort: t.effort }); }
    catch (e) { proposal.status = 'pending'; delete proposal.threadId; this.publish(t.id); this.store.save(); throw e; }
    child.title = proposal.title; this.publish(child.id); this.store.save();
    return child;
  }
  dismissProposal(id, proposalId) {
    const t = this.thread(id), proposal = t.turns.flatMap(x => x.proposals || []).find(p => p.id === proposalId);
    if (!proposal) throw Error('找不到这个提议');
    if (proposal.status === 'pending') proposal.status = 'dismissed';
    this.publish(t.id); this.store.save(); return t;
  }
  async send(id, text, options = {}) {
    if(this.deleting.has(id))throw Error('会话正在删除，请稍后再试');
    const t = this.thread(id);
    if (ACTIVE.has(t.status)) throw Error('当前会话正在运行，请先停止或等待完成');
    text = String(text || '').trim(); const images = this.images(options.images);
    if ((!text && !images.length) || text.length > 150000) throw Error('请输入消息（最多 150,000 字符）');
    const model = String(options.model || t.model); const mode = options.mode || t.mode;
    if (!/^[\w.:/\-\[\]]{1,150}$/.test(model)) throw Error('模型名称不合法');
    if (!['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'].includes(mode)) throw Error('权限模式不合法');
    const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort) ? options.effort : t.effort || 'high';
    const extensionOptions=this.sessionOptions(t);const extensionKey=JSON.stringify(extensionOptions);
    let run = this.runs.get(id); const reused = Boolean(run);
    // The system prompt is fixed when the CLI starts, so a changed global or project prompt restarts it.
    if (run && (run.model !== model || run.mode !== mode || run.effort !== effort || run.extensionKey!==extensionKey || run.instructions !== JSON.stringify(this.instructionsOf(t)) || run.providerKey !== (this.providerOptions(t)?.key || ''))) { await this.closeRun(id); run = null; }
    const history = !run?historyTail(t.turns):'';
    Object.assign(t, { model, mode, effort, updatedAt: Date.now(), error: '', startedAt: Date.now(), finishedAt: null });
    if (!t.turns.length) t.title = (text || '图片').replace(/\s+/g, ' ').slice(0, 34);
    const turn = { id: randomUUID(), user: text, context:options.context||'', references:options.references||[], images, answer: '', thinking: '', items: [], tools: [], startedAt: Date.now(), status: 'running', usage: null };
    t.turns.push(turn);
    let prompt = text || '请查看我附带的图片。';
    if (options.context) prompt = `${prompt}\n\n<user_selected_context>\n${options.context}\n</user_selected_context>`;
    if (!run) {
      t.contextUsage=null;
      if (history.length) {
        prompt = `<previous_conversation>\n以下为本地保存的历史对话，仅用于上下文。文件状态以当前磁盘为准。\n${history}\n</previous_conversation>\n\n${prompt}`;
        turn.contextRestored = true;
      }
      run = this.startRun(t,extensionOptions,extensionKey);
    }
    run.turnId = turn.id; run.unread = null; run.steersAfterTool = new Set(); run.partialText = false; run.seen = new Set(); run.blocks = new Map(); run.model = model; run.responseUsage=null; run.mainDone=false;
    // A conversation keeps its CLI between messages; only a new one says it is starting.
    const ready = reused ? '已发送，等待模型响应' : '正在启动 Claude';
    this.setStatus(t, reused ? 'waiting' : 'starting', this.checkpoint ? '正在记录文件快照（用于回退和撤销）' : ready);
    this.store.save();
    // Record the project files first so this turn can be rewound later.
    if (this.checkpoint) {
      try { turn.checkpoint = await Promise.race([this.checkpoint(t), new Promise((_, reject) => setTimeout(() => reject(Error('记录文件快照超时')), 30000))]); }
      catch (e) { turn.checkpointError = String(e.message || e).slice(0, 300); }
      if (this.runs.get(id) !== run || run.turnId !== turn.id) return t;
      if (['starting', 'waiting'].includes(t.status)) this.setStatus(t, t.status, ready);
    }
    const content = images.length ? [...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: fs.readFileSync(image.path).toString('base64') } })), { type: 'text', text: prompt }] : prompt;
    run.input.push({ type: 'user', session_id: run.sessionId || '', parent_tool_use_id: null, uuid: randomUUID(), message: { role: 'user', content } });
    run.prompted = turn.id;
    return t;
  }
  // 插话: a message for the turn that is running. The CLI reads it before the model's
  // next step (priority 'next') and the turn carries on with it. It is marked delivered
  // and put into the turn at that point by the first of: a reply naming it
  // (user_message_uuids), the CLI starting it (command_lifecycle 'started'), or the
  // first reply after a tool result that came once it was written: the CLI reads
  // queued messages between a step's tool results and its next request. One the turn
  // ended without reading is settled by settleSteers.
  canSteer(id) {
    const t = this.thread(id), run = this.runs.get(id);
    return Boolean(run && !run.finished && !run.stopping && !run.mainDone && run.prompted && run.prompted === run.turnId && ACTIVE.has(t.status) && t.status !== 'stopping');
  }
  steer(id, text, options = {}) {
    const t = this.thread(id); text = String(text || '').trim(); const images = this.images(options.images);
    if ((!text && !images.length) || text.length > 150000) throw Error('请输入消息（最多 150,000 字符）');
    if (!this.canSteer(id)) throw Error('当前没有可以插话的运行');
    const run = this.runs.get(id), turn = t.turns.find(x => x.id === run.turnId), uuid = randomUUID();
    let prompt = text || '请查看我附带的图片。';
    if (options.context) prompt = `${prompt}\n\n<user_selected_context>\n${options.context}\n</user_selected_context>`;
    const content = images.length ? [...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: fs.readFileSync(image.path).toString('base64') } })), { type: 'text', text: prompt }] : prompt;
    run.input.push({ type: 'user', session_id: run.sessionId || '', parent_tool_use_id: null, uuid, priority: 'next', message: { role: 'user', content } });
    (turn.steers ||= []).push({ id: uuid, text, images, references: options.references || [], at: Date.now(), status: 'pending' });
    this.publish(id); this.store.save(); return t;
  }
  markSteers(t, run, uuids) {
    if (!Array.isArray(uuids) || !uuids.length) return;
    const turn = t.turns.find(x => x.id === run.turnId);
    for (const steer of turn?.steers || []) if (steer.status === 'pending' && uuids.includes(steer.id)) { steer.status = 'delivered'; steer.deliveredAt = Date.now(); (turn.items ||= []).push({ type: 'steer', id: steer.id }); }
  }
  // At the end of a turn, 插话 no reply has confirmed. Claude usually read it with a tool
  // result without the CLI saying so, so it counts as read and shows after the last
  // step. Should the CLI instead start replying again, it ran as a turn of its own:
  // openSteerTurn moves it there.
  settleSteers(t, run, turn) {
    const pending = (turn.steers || []).filter(s => s.status === 'pending'); if (!pending.length) return;
    let at = (turn.items ||= []).length; while (at > 0 && turn.items[at - 1].type !== 'tool' && turn.items[at - 1].type !== 'steer') at--;
    for (const steer of pending) { steer.status = 'delivered'; steer.deliveredAt = Date.now(); }
    turn.items.splice(at, 0, ...pending.map(s => ({ type: 'steer', id: s.id })));
    run.unread = { turnId: turn.id, ids: pending.map(s => s.id) };
  }
  openSteerTurn(t, run) {
    const { turnId, ids } = run.unread; run.unread = null;
    const old = t.turns.find(x => x.id === turnId), moved = (old?.steers || []).filter(s => ids.includes(s.id)); if (!moved.length) return;
    old.steers = old.steers.filter(s => !ids.includes(s.id)); old.items = old.items.filter(i => i.type !== 'steer' || !ids.includes(i.id));
    const next = { id: randomUUID(), user: moved.map(s => s.text).filter(Boolean).join('\n\n'), context: '', references: moved.flatMap(s => s.references || []), images: moved.flatMap(s => s.images || []), answer: '', thinking: '', items: [], tools: [], startedAt: Date.now(), status: 'running', usage: null, fromSteer: true };
    t.turns.push(next);
    Object.assign(run, { turnId: next.id, prompted: next.id, partialText: false, seen: new Set(), blocks: new Map(), responseUsage: null, mainDone: false, steersAfterTool: new Set() });
    t.finishedAt = null; this.setStatus(t, 'waiting', '继续处理你插入的消息');
  }
  // A stop or failure leaves unread 插话 in the queue, under the same id, so nothing typed is lost.
  requeueSteers(t, turn) {
    const pending = (turn?.steers || []).filter(s => s.status === 'pending'); if (!pending.length) return;
    turn.steers = turn.steers.filter(s => s.status !== 'pending');
    (t.queue ||= []).unshift(...pending.map(s => ({ id: s.id, text: s.text, createdAt: s.at, options: { references: s.references || [], context: '', images: s.images || [] } })));
  }
  // Images arrive already saved by the main process; only files inside the
  // attachment folder with a supported type are sent to the model.
  images(list) {
    if (!Array.isArray(list) || !list.length) return [];
    if (list.length > 6) throw Error('一条消息最多附带 6 张图片');
    const root = this.attachmentRoot && path.resolve(this.attachmentRoot);
    return list.map(image => {
      const file = path.resolve(String(image?.path || '')), rel = root ? path.relative(root, file) : '..';
      if (!IMAGE_TYPES.has(image?.mediaType) || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(file)) throw Error('图片附件无效或已被删除');
      return { id: String(image.id || randomUUID()), name: String(image.name || '图片').slice(0, 120), mediaType: image.mediaType, path: file, thumb: typeof image.thumb === 'string' && image.thumb.startsWith('data:image/') && image.thumb.length < 80000 ? image.thumb : '' };
    });
  }
  enqueue(id, text, options = {}) {
    const t = this.thread(id); text = String(text || '').trim(); const images = this.images(options.images);
    if ((!text && !images.length) || text.length > 150000) throw Error('请输入消息（最多 150,000 字符）');
    if ((t.queue ||= []).length >= 10) throw Error('每个会话最多排队 10 条消息');
    const { model, effort, mode, references, context } = options;
    t.queue.push({ id: randomUUID(), text, createdAt: Date.now(), options: { model, effort, mode, references: references || [], context: context || '', images } });
    this.publish(id); this.store.save(); return t;
  }
  dequeue(id, queueId) {
    const t = this.thread(id), item = t.queue?.find(x => x.id === queueId); if (!item) return null;
    t.queue = t.queue.filter(x => x !== item); this.publish(id); this.store.save(); return item;
  }
  // 插话 that can't wait for the running step: stop the run, then send it as the next message.
  async steerNow(id, steerId) {
    const t = this.thread(id);
    if (!(t.turns.at(-1)?.steers || []).some(s => s.id === steerId && s.status === 'pending')) throw Error('Claude 已经读到这条插话');
    await this.stop(id);
    await this.sendQueued(id, steerId);
  }
  async sendQueued(id, queueId) {
    const t = this.thread(id), item = this.dequeue(id, queueId); if (!item) throw Error('排队消息已不存在');
    t.queue.unshift(item);
    if (ACTIVE.has(t.status)) await this.stop(id);
    await this.drain(id);
  }
  async drain(id) {
    if (this.draining.has(id) || this.deleting.has(id)) return;
    const t = this.thread(id); if (ACTIVE.has(t.status) || !t.queue?.length) return;
    this.draining.add(id); const next = t.queue.shift();
    try { await this.send(id, next.text, next.options); }
    catch (e) { t.queue.unshift(next); t.detail = '排队消息未能发送：' + e.message; this.emit('thread', this.threadSnapshot(t)); }
    finally { this.draining.delete(id); }
  }
  chatFolder(id) {
    if (!this.chatRoot) throw Error('先选择一个项目文件夹');
    const folder = path.join(this.chatRoot, id); fs.mkdirSync(folder, { recursive: true }); return folder;
  }
  isChatFolder(folder) { if (!this.chatRoot || !folder) return false; const rel = path.relative(path.resolve(this.chatRoot), path.resolve(folder)); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel); }
  // Moves a conversation into a project (or back to a plain chat). It continues in the new
  // folder; snapshots of the old folder no longer apply, so they are dropped.
  async moveThread(id, projectId) {
    const t = this.thread(id), p = projectId ? this.store.state.projects.find(p => p.id === projectId) : null;
    if (projectId && !p) throw Error('项目不存在');
    if ((t.projectId || null) === (projectId || null)) return t;
    if (this.deleting.has(id)) throw Error('会话正在删除，请稍后再试');
    if (ACTIVE.has(t.status)) throw Error('请先停止当前运行，再移动会话');
    if (t.worktree && !t.worktree.removed) throw Error('这个会话在独立工作树里，先移除工作树再移动');
    await this.closeRun(id);
    const old = t.cwd;
    t.projectId = p ? projectId : null; t.cwd = p ? p.path : this.chatFolder(id);
    for (const turn of t.turns) if (turn.checkpoint) { delete turn.checkpoint; turn.checkpointError = '会话已移到其他文件夹，之前的文件快照不再适用'; }
    if (this.isChatFolder(old) && old !== t.cwd) try { fs.rmdirSync(old); } catch {} // only when empty
    t.updatedAt = Date.now(); this.publish(id); this.store.save(); return t;
  }
  // After its worktree is removed a conversation continues in the project folder.
  async detachWorktree(id) {
    const t = this.thread(id); if (!t.worktree) return t;
    if (ACTIVE.has(t.status)) throw Error('请先停止当前运行');
    await this.closeRun(id);
    t.worktree = { ...t.worktree, removed: true }; t.cwd = this.store.state.projects.find(p => p.id === t.projectId)?.path || t.cwd;
    this.publish(id); this.store.save(); return t;
  }
  instructionsOf(t) {
    const project = t.projectId && this.store.state.projects.find(p => p.id === t.projectId);
    return { global: this.store.state.settings.instructions || '', project: project?.instructions || '' };
  }
  // scope 'global' or 'project'. Takes effect from each conversation's next message;
  // a running turn keeps the prompt it started with.
  setInstructions(scope, projectId, text) {
    const value = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (value.length > INSTRUCTIONS_MAX) throw Error(`提示词最多 ${INSTRUCTIONS_MAX.toLocaleString()} 个字符`);
    const target = scope === 'global' ? this.store.state.settings : scope === 'project' ? this.store.state.projects.find(p => p.id === projectId) : null;
    if (!target) throw Error(scope === 'project' ? '项目不存在' : '提示词范围不对');
    if (value) target.instructions = value; else delete target.instructions;
    this.store.save(); return value;
  }
  setMeta(id, value = {}) {
    const t = this.thread(id);
    if (typeof value.pinned === 'boolean') t.pinned = value.pinned;
    if (typeof value.archived === 'boolean') { t.archived = value.archived; if (value.archived) t.pinned = false; }
    if (typeof value.title === 'string' && value.title.trim()) t.title = value.title.trim().slice(0, 80);
    if (Number.isFinite(value.seenAt)) t.seenAt = Math.min(value.seenAt, Date.now());
    this.publish(id); this.store.save(); return t;
  }
  // Everything that decides how the CLI starts. A pre-started CLI is only used for a
  // message whose key matches the one it was started with.
  runKey(t, extensionKey, { model, mode, effort }) { return JSON.stringify([t.cwd, model, mode, effort, extensionKey, this.instructionsOf(t), this.cliPath, this.providerOptions(t)?.key || '']); }
  newRun(t, extensionKey, { model, mode, effort }) {
    return { input: new InputQueue(), abort: new AbortController(), extensionKey, instructions: JSON.stringify(this.instructionsOf(t)), providerKey: this.providerOptions(t)?.key || '', model, mode, effort, turnId: null, finished: false, sessionId: '', seen: new Set(), blocks: new Map() };
  }
  runOptions(t, run, extensionOptions, { model, mode, effort }) {
    const provider = this.providerOptions(t);
    const env = { ...this.env, ...(provider?.env || {}) }; delete env.CLAUDECODE; delete env.ELECTRON_RUN_AS_NODE;
    // Each conversation owns a live CLI process; app history is persisted separately.
    // No temporary HOME, shared resume ID, or provider credentials in renderer state.
    // A custom provider goes in the flag settings too, which outrank ~/.claude/settings.json.
    return {
      cwd: t.cwd, pathToClaudeCodeExecutable: this.cliPath, env,
      ...(provider?.settings ? { settings: provider.settings } : {}),
      ...(extensionOptions.skills!==undefined?{skills:extensionOptions.skills}:{}),
      ...(extensionOptions.plugins?.length?{plugins:extensionOptions.plugins}:{}),
      ...(this.deskServer?{mcpServers:{desk:this.deskServer(t.id)},allowedTools:DESK_TOOLS}:{}),
      model, thinking: { type: 'adaptive' }, effort,
      permissionMode: mode, settingSources: ['user', 'project', 'local'],
      allowDangerouslySkipPermissions: mode === 'bypassPermissions',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: '你在 Claude Desk 本地桌面客户端中工作。默认用中文与用户交流。简明汇报进度；只有实际完成工具操作后才能声称完成。' + FORMAT_PROMPT + (this.deskServer ? DESK_PROMPT : '') + instructionsPrompt(this.instructionsOf(t)) },
      // Sub-agents send their text and thinking too, so the 子智能体 step shows what they wrote.
      includePartialMessages: true, forwardSubagentText: true, persistSession: false, abortController: run.abort,
      canUseTool: (name, args, ctx) => this.requestApproval(t, run, name, args, ctx),
      stderr: text => { run.stderr = (run.stderr || '').concat(text).slice(-8000); this.emit('diagnostic', { threadId: t.id, message: text.slice(-1500) }); }
    };
  }
  // Starts the CLI of an idle conversation before its next message (when it is opened
  // or typed in), so sending skips the start-up. At most two wait at a time; one
  // unused for four minutes, or started with other settings than the message needs, is closed.
  prewarm(id, choice = {}) {
    if (!this.startup || this.closing || this.runs.has(id) || this.deleting.has(id) || !this.cliPath) return false;
    const t = this.thread(id); if (ACTIVE.has(t.status)) return false;
    const settings = {
      model: /^[\w.:/\-\[\]]{1,150}$/.test(String(choice.model || '')) ? choice.model : t.model,
      mode: ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'].includes(choice.mode) ? choice.mode : t.mode,
      effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(choice.effort) ? choice.effort : t.effort || 'high'
    };
    const extensionOptions = this.sessionOptions(t), extensionKey = JSON.stringify(extensionOptions), key = this.runKey(t, extensionKey, settings);
    const existing = this.warm.get(id);
    if (existing?.key === key) { this.keepWarm(id, existing); return true; }
    this.dropWarm(id);
    while (this.warm.size >= 2) this.dropWarm([...this.warm.entries()].sort((a, b) => a[1].at - b[1].at)[0][0]);
    const run = this.newRun(t, extensionKey, settings), options = this.runOptions(t, run, extensionOptions, settings);
    const entry = { key, run, at: Date.now(), ready: Promise.resolve().then(() => this.startup({ options })).catch(() => null) };
    this.warm.set(id, entry); this.keepWarm(id, entry); return true;
  }
  keepWarm(id, entry) { clearTimeout(entry.timer); entry.at = Date.now(); entry.timer = setTimeout(() => this.dropWarm(id), 4 * 60000); entry.timer.unref?.(); }
  dropWarm(id) {
    const entry = this.warm.get(id); if (!entry) return;
    this.warm.delete(id); clearTimeout(entry.timer); entry.ready.then(spare => spare?.close()).catch(() => {});
  }
  takeWarm(id, key) {
    const entry = this.warm.get(id); if (!entry) return null;
    if (entry.key !== key) { this.dropWarm(id); return null; }
    this.warm.delete(id); clearTimeout(entry.timer); return entry;
  }
  startRun(t,extensionOptions={},extensionKey=JSON.stringify(extensionOptions)) {
    const settings = { model: t.model, mode: t.mode, effort: t.effort };
    const warm = this.takeWarm(t.id, this.runKey(t, extensionKey, settings));
    const run = warm?.run || this.newRun(t, extensionKey, settings), input = run.input;
    this.runs.set(t.id, run);
    const options = warm ? null : this.runOptions(t, run, extensionOptions, settings);
    run.warm = Boolean(warm);
    run.task = (async () => {
      try {
        const spare = warm && await warm.ready;
        run.query = spare ? spare.query(input) : this.query({ prompt: input, options: options || this.runOptions(t, run, extensionOptions, settings) });
        for await (const msg of run.query) { if (this.runs.get(t.id) !== run) break; this.process(t, run, msg); }
        if (this.runs.get(t.id) === run && ACTIVE.has(t.status)) this.fail(t, 'Claude 进程在返回完整结果之前结束。请重试。');
      } catch (e) {
        if (this.runs.get(t.id) === run && !run.stopping && !this.closing) this.fail(t, this.redact(e.message || String(e)));
      } finally {
        run.finished = true; input.close();
        for (const [id, p] of this.pending) if (p.threadId === t.id && p.run === run) { p.resolve({ behavior: 'deny', message: '会话已结束' }); this.pending.delete(id); }
        if (this.runs.get(t.id) === run) {
          this.runs.delete(t.id);
          if(activeAgents(t).length){settleAgents(t,'interrupted');t.status='interrupted';t.detail='子智能体随 CLI 进程结束而中断';this.publish(t.id);}
        }
      }
    })();
    return run;
  }
  redact(text) { return String(text).replace(/(?:sk-ant-|sk-)[A-Za-z0-9_-]{12,}/g, '[已隐藏密钥]').replace(/(Bearer\s+)\S+/gi, '$1[已隐藏]'); }
  fail(t, message) {
    t.error = message; t.finishedAt = Date.now(); const turn = t.turns.at(-1); this.requeueSteers(t, turn);
    if (turn) { turn.status = 'error'; turn.error = message; turn.finishedAt = Date.now(); for (const tool of turn.tools) if (['running', 'approval'].includes(tool.status)) tool.status = 'error'; }
    this.setStatus(t, 'error', message);
  }
  stopUnexecutedToolText(t, turn) {
    if (!hasUnexecutedToolText(turn)) return false;
    turn.toolProtocolAborted = true;
    // closeRun aborts and detaches the CLI synchronously before waiting for exit.
    this.closeRun(t.id).catch(e => this.emit('diagnostic', { threadId: t.id, message: this.redact(e.message) }));
    this.fail(t, '工具调用异常，已中止：回复中出现了工具调用文本，但没有对应的工具执行记录。请检查模型或服务商的工具调用支持。');
    this.store.save();
    return true;
  }
  // The breakdown the CLI computes for /context (by category, against the window it
  // compacts at). Needs the conversation's live CLI; null without one. A known window
  // also fills in the context meter when the result did not report one.
  async contextDetails(id, detail = 'summary') {
    const t = this.thread(id), run = this.runs.get(id);
    if (!run || run.finished || typeof run.query?.getContextUsage !== 'function') return null;
    const usage = await Promise.race([run.query.getContextUsage({ detail: detail === 'full' ? 'full' : 'summary' }), new Promise((_, reject) => setTimeout(() => reject(Error('读取上下文明细超时')), 30000))]);
    const window = usage.rawMaxTokens || usage.maxTokens;
    if (Number.isFinite(window) && window > 0) {
      t.contextUsage = { ...(t.contextUsage || {}), usedTokens: Number.isFinite(t.contextUsage?.usedTokens) ? t.contextUsage.usedTokens : usage.totalTokens, contextWindow: window, model: t.contextUsage?.model || usage.model, updatedAt: Date.now() };
      this.publish(id);
    }
    const servers = new Map(); for (const tool of usage.mcpTools || []) if (tool.isLoaded !== false) servers.set(tool.serverName, (servers.get(tool.serverName) || 0) + tool.tokens);
    return {
      model: usage.model, totalTokens: usage.totalTokens, maxTokens: window, percentage: usage.percentage, detail,
      categories: (usage.categories || []).filter(c => c.kind !== 'deferred' && !c.isDeferred).map(c => ({ id: c.id || '', name: c.name, tokens: c.tokens, kind: c.kind })),
      memoryFiles: (usage.memoryFiles || []).slice(0, 8).map(f => ({ path: f.path, tokens: f.tokens })),
      mcpServers: [...servers].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, tokens]) => ({ name, tokens }))
    };
  }
  recordContext(t,run,usage,model) {
    if(!usage || !Number.isFinite(usage.input_tokens) || usage.input_tokens<0)return;
    const fields=['input_tokens','cache_read_input_tokens','cache_creation_input_tokens','output_tokens'];
    if(fields.some(key=>usage[key]!=null&&(!Number.isFinite(usage[key])||usage[key]<0)))return;
    run.responseUsage={...usage};run.contextModel=model||run.contextModel||t.model;
    const previous=t.contextUsage;
    t.contextUsage={usedTokens:fields.reduce((sum,key)=>sum+(usage[key]||0),0),contextWindow:previous?.model===run.contextModel?previous.contextWindow:null,model:run.contextModel,updatedAt:Date.now()};
  }
  process(t, run, msg) {
    if (run.stopping) return;
    t.lastEventAt = Date.now();
    if(handleAgentMessage(t,run,msg,text=>this.redact(text))){this.publish(t.id,false);return;}
    if ((msg.type === 'assistant' || msg.type === 'stream_event') && msg.parent_tool_use_id == null) {
      if (run.mainDone && run.unread && (msg.type === 'assistant' || msg.event?.type === 'message_start')) this.openSteerTurn(t, run);
      this.markSteers(t, run, msg.user_message_uuids);
      if ((msg.type === 'assistant' || msg.event?.type === 'message_start') && run.steersAfterTool?.size) { this.markSteers(t, run, [...run.steersAfterTool]); run.steersAfterTool.clear(); this.publish(t.id); }
    }
    if (msg.type === 'command_lifecycle') { if (msg.state === 'started' && msg.command_uuid) { this.markSteers(t, run, [msg.command_uuid]); this.publish(t.id); } return; }
    const turn = t.turns.find(x => x.id === run.turnId); if (!turn) return;
    if (msg.type === 'system' && msg.subtype === 'init') { run.sessionId = msg.session_id; this.setStatus(t, 'waiting', '请求已发出，等待模型响应'); return; }
    if (msg.type === 'stream_event') {
      const e = msg.event;
      if(msg.parent_tool_use_id==null){
        if(e.type==='message_start')this.recordContext(t,run,e.message?.usage,e.message?.model);
        if(e.type==='message_delta'&&run.responseUsage&&e.usage)this.recordContext(t,run,{...run.responseUsage,...e.usage},run.contextModel);
      }
      if (e.type === 'content_block_start') {
        run.blocks.set(e.index, e.content_block?.type);
        if (e.content_block?.type === 'thinking') { addItem(turn, 'thinking'); this.setStatus(t, 'thinking', '模型正在思考'); }
        else if (e.content_block?.type === 'text') { addItem(turn, 'text'); this.setStatus(t, 'generating', '正在生成回复'); }
      }
      if (e.type === 'content_block_delta') {
        if (e.delta.type === 'text_delta') { turn.answer += e.delta.text; appendItem(turn, 'text', e.delta.text); run.partialText = true; if (this.stopUnexecutedToolText(t, turn)) return; t.status = 'generating'; t.detail = '正在生成回复'; }
        if (e.delta.type === 'thinking_delta') { turn.thinking += e.delta.thinking; appendItem(turn, 'thinking', e.delta.thinking); t.status = 'thinking'; t.detail = '模型正在思考'; }
        this.publish(t.id, false);
      }
      if (e.type === 'message_start' && t.status === 'starting') this.setStatus(t, 'waiting', '模型已开始处理');
      return;
    }
    if (msg.type === 'assistant') {
      if(msg.parent_tool_use_id==null)this.recordContext(t,run,msg.message?.usage,msg.message?.model);
      if (run.seen.has(msg.uuid)) return; if (msg.uuid) run.seen.add(msg.uuid);
      const blocks = msg.message?.content || [];
      markNarration(turn.items ||= [], msg);
      const text = blocks.filter(x => x.type === 'text').map(x => x.text).join('\n');
      if (text && !run.partialText) { turn.answer += (turn.answer ? '\n\n' : '') + text; addItem(turn, 'text', text); }
      run.partialText = false;
      for (const b of blocks) if (b.type === 'tool_use') {
        agentFromTool(t,turn,b);
        if (b.name === WRAP_UP) { const box = wrapUpOf(b.input); if (box) turn.wrapUp = box; }
        if (b.name === PROPOSE && !(turn.proposals || []).some(p => p.id === b.id)) { const proposal = proposalOf(b.input, b.id); if (proposal) (turn.proposals ||= []).push(proposal); }
        if (!turn.tools.some(x => x.id === b.id)) { turn.tools.push({ id: b.id, name: b.name, input: b.input, output: '', status: 'running', startedAt: Date.now() }); addItem(turn, 'tool', b.id); }
        if (t.status !== 'approval') this.setStatus(t, 'tool', `执行 ${b.name}`);
      }
      if (this.stopUnexecutedToolText(t, turn)) return;
      if (msg.error) turn.modelWarning = this.redact(msg.error);
      this.publish(t.id); return;
    }
    if (msg.type === 'user') {
      const content = msg.message?.content, results = Array.isArray(content) ? content.filter(b => b?.type === 'tool_result') : [];
      if (results.length && msg.parent_tool_use_id == null) for (const s of turn.steers || []) if (s.status === 'pending') (run.steersAfterTool ||= new Set()).add(s.id);
      for (const b of results) {
        const tool = turn.tools.find(x => x.id === b.tool_use_id);
        finishAgentTool(t,b.tool_use_id,b.is_error,this.redact(typeof b.content==='string'?b.content:JSON.stringify(b.content||'')));
        if (tool) { tool.output = this.redact(typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '')).slice(-80000); tool.status = b.is_error ? 'error' : 'done'; tool.finishedAt = Date.now(); }
      }
      if (t.status !== 'approval') this.setStatus(t, 'waiting', '工具已返回，等待模型继续');
      this.publish(t.id); return;
    }
    if (msg.type === 'tool_progress') { if (t.status !== 'approval') this.setStatus(t, 'tool', `${msg.tool_name || '工具'} 执行中 · ${msg.elapsed_time_seconds || 0}s`); return; }
    if (msg.type === 'result') {
      run.mainDone=true;run.steersAfterTool?.clear();run.resultStatus=msg.is_error||msg.subtype!=='success'?'error':'done';
      turn.finishedAt = Date.now(); t.finishedAt = Date.now();
      const entries=Object.entries(msg.modelUsage||{});
      const modelUsage=entries.find(([id,value])=>id===run.contextModel||value.canonicalModel===run.contextModel)||entries.find(([id,value])=>id===t.model||value.canonicalModel===t.model);
      if(t.contextUsage&&modelUsage&&Number.isFinite(modelUsage[1].contextWindow)&&modelUsage[1].contextWindow>0)t.contextUsage.contextWindow=modelUsage[1].contextWindow;
      const totalCost=Number.isFinite(msg.total_cost_usd)?msg.total_cost_usd:run.lastCost||0;
      turn.usage = { input: msg.usage?.input_tokens || 0, output: msg.usage?.output_tokens || 0, cache: msg.usage?.cache_read_input_tokens || 0, cost: Math.max(0,totalCost-(run.lastCost||0)) };
      run.lastCost=totalCost;
      recordUsage(this.store.state,run,t,turn,msg);
      if (msg.is_error || msg.subtype !== 'success') { this.fail(t, this.redact((msg.errors || []).join('\n') || msg.result || `运行失败：${msg.subtype}`)); }
      else {
        if (!turn.answer && msg.result) { turn.answer = msg.result; addItem(turn, 'text', msg.result); }
        if (this.stopUnexecutedToolText(t, turn)) return;
        if (!turn.answer && turn.compacted) { const c = turn.compacted, text = `上下文已压缩${Number.isFinite(c.preTokens) ? `：约 ${c.preTokens.toLocaleString()}${Number.isFinite(c.postTokens) ? ` → ${c.postTokens.toLocaleString()}` : ''} tokens` : ''}`; turn.answer = text; addItem(turn, 'text', text); }
        turn.status = 'done'; this.settleSteers(t, run, turn);
        if (!t.contextUsage?.contextWindow) this.contextDetails(t.id).catch(() => {});
        this.setStatus(t, 'done', '本轮已完成');
      }
      this.publish(t.id); this.store.save(); return;
    }
    if (msg.type === 'system' && msg.subtype === 'status' && msg.status === 'compacting') this.setStatus(t, 'thinking', '正在压缩上下文');
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      const meta = msg.compact_metadata || {}; turn.compacted = { trigger: meta.trigger, preTokens: meta.pre_tokens, postTokens: meta.post_tokens };
      t.contextUsage = Number.isFinite(meta.post_tokens) ? { ...(t.contextUsage || {}), usedTokens: meta.post_tokens, updatedAt: Date.now() } : null;
      this.publish(t.id);
    }
  }
  requestApproval(t, run, name, args, ctx = {}) {
    if (run.stopping || run.abort.signal.aborted) return Promise.resolve({ behavior: 'deny', message: '运行已停止' });
    // Desk tools only draw on screen; they never need the user's approval.
    if (DESK_TOOLS.includes(name)) return Promise.resolve({ behavior: 'allow', updatedInput: args });
    const id = ctx.toolUseID || randomUUID();
    return new Promise(resolve => {
      let turn=t.turns.find(x=>x.id===run.turnId),agent;
      if(ctx.agentID){const found=findAgent(t,ctx.agentID,null)||ensureAgent(t,turn,{task_id:ctx.agentID});if(found){turn=found.turn;agent=found.agent;agent.status='approval';}}
      this.pending.set(id, { resolve, threadId: t.id, run, name, args,turnId:turn?.id,agentId:agent?.id });
      const request = { id, name, input: args, reason: this.redact(ctx.decisionReason || 'Claude 请求执行此操作'), createdAt: Date.now(),agentId:agent?.id,agentName:agent?.name };
      if (turn) {(turn.approvals||=[]).push(request);turn.approval=turn.approvals[0];}
      this.setStatus(t, 'approval', `等待你批准 ${name}`);
      ctx.signal?.addEventListener('abort', () => this.approve(t.id, id, false), { once: true });
    });
  }
  // A plan approval also picks how the work continues (mode); a rejected plan can carry feedback.
  approve(threadId, requestId, allow, answers, extra = {}) {
    const p = this.pending.get(requestId); if (!p || p.threadId !== threadId) return false;
    this.pending.delete(requestId); const t = this.thread(threadId); const turn = t.turns.find(x => x.id === (p.turnId||p.run.turnId));
    if(turn){turn.approvals=(turn.approvals||[]).filter(a=>a.id!==requestId);turn.approval=turn.approvals[0];}
    if(p.agentId){const agent=turn?.subagents?.find(a=>a.id===p.agentId||a.aliases?.includes(p.agentId));if(agent?.status==='approval')agent.status='running';}
    const input = answers && p.args.questions ? { ...p.args, answers } : p.args;
    const plan = p.name === 'ExitPlanMode', feedback = String(extra?.feedback || '').trim().slice(0, 4000);
    const mode = plan && allow ? (['default', 'acceptEdits'].includes(extra?.mode) ? extra.mode : 'default') : null;
    if (mode) { t.mode = mode; p.run.mode = mode; }
    p.resolve(allow ? { behavior: 'allow', updatedInput: input, ...(mode ? { updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] } : {}) }
      : { behavior: 'deny', message: plan ? (feedback ? `用户希望先修改计划，意见如下：\n${feedback}\n请按意见修改计划后再次提交。` : '用户希望继续修改计划，请询问需要调整的地方。') : questionsOf(p.args) ? '用户跳过了这个问题，请按你的判断继续，或换个方式说明。' : '用户拒绝了此操作，请采用其他方式或解释限制。' });
    if (!p.run.stopping) this.setStatus(t, 'tool', allow ? '已批准，继续执行' : '已拒绝，等待模型处理');
    return true;
  }
  async closeRun(id) {
    const run = this.runs.get(id); if (!run) return;
    run.stopping = true;
    for (const [key, p] of this.pending) if (p.run === run) this.approve(id, key, false);
    settleAgents(this.thread(id),'stopped');
    this.runs.delete(id); run.input.close(); run.abort.abort();
    try { run.query?.close(); } catch {}
    await Promise.race([run.task, new Promise(resolve => { const timer = setTimeout(resolve, 2500); timer.unref?.(); })]);
  }
  removeImages(entries) {
    if (!this.attachmentRoot) return;
    const root = path.resolve(this.attachmentRoot);
    for (const image of entries.flatMap(entry => entry?.images || [])) {
      const file = path.resolve(String(image.path || '')), rel = path.relative(root, file);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) try { fs.unlinkSync(file); } catch {}
    }
  }
  // `value` is {tree, files, at} after 撤销 on a turn's change card, null after 重做.
  setUndone(id, turnId, value) {
    const turn = this.thread(id).turns.find(x => x.id === turnId); if (!turn) throw Error('这轮问答不存在');
    if (value) turn.undone = value; else delete turn.undone;
    this.publish(id); this.store.save();
  }
  deleteTurn(id, turnId) { return this.removeTurns(id, [turnId], '删除其中一轮问答'); }
  // Rewinding drops a turn and everything after it. Its text and images come back
  // for editing; restoring files is up to the caller (see checkpoint.cjs).
  async rewind(id, turnId) {
    const t=this.thread(id), index=t.turns.findIndex(turn=>turn.id===turnId);
    if(index<0)throw Error('这轮问答不存在');
    const turn=t.turns[index];
    await this.removeTurns(id, t.turns.slice(index).map(x=>x.id), '回退', new Set((turn.images||[]).map(image=>image.path)));
    return { thread: t, draft: { text: turn.user, images: turn.images || [], references: turn.references || [] } };
  }
  async removeTurns(id, turnIds, action, keepImages=new Set()) {
    const t=this.thread(id), ids=new Set(turnIds);
    if(this.deleting.has(id))throw Error('会话正在删除，请稍后再试');
    if(ACTIVE.has(t.status))throw Error(`请先停止当前运行，再${action}`);
    if(!t.turns.some(turn=>ids.has(turn.id)))throw Error('这轮问答不存在');
    this.deleting.add(id);
    try {
      // A retained CLI would still remember removed messages. Rebuild from saved history next time.
      await this.closeRun(id);
      clearTimeout(this.eventTimers.get(id));this.eventTimers.delete(id);
      const autoTitle=t.turns[0]?.user.replace(/\s+/g,' ').slice(0,34);
      this.removeImages(t.turns.filter(turn=>ids.has(turn.id)).map(turn=>({images:(turn.images||[]).filter(image=>!keepImages.has(image.path))})));
      t.turns=t.turns.filter(turn=>!ids.has(turn.id));
      t.contextUsage=null;
      const last=t.turns.at(-1);
      t.status=last?.status||'idle';t.error=last?.error||'';t.detail='';t.updatedAt=Date.now();
      t.startedAt=last?.startedAt||null;t.finishedAt=last?.finishedAt||null;
      if(!last)t.title='新对话';
      else if(t.title===autoTitle)t.title=t.turns[0].user.replace(/\s+/g,' ').slice(0,34);
      this.store.save();this.store.save();
      this.emit('thread',this.threadSnapshot(t));return t;
    } finally {this.deleting.delete(id);}
  }
  async deleteThread(id) {
    this.thread(id);
    if(this.deleting.has(id))throw Error('会话正在删除，请稍后再试');
    this.deleting.add(id);
    try {
      this.dropWarm(id); await this.closeRun(id);
      clearTimeout(this.eventTimers.get(id));this.eventTimers.delete(id);
      const state=this.store.state;
      const removed=state.threads.find(t=>t.id===id);this.removeImages([...(removed?.turns||[]),...(removed?.queue||[]).map(item=>item.options||{})]);
      state.threads=state.threads.filter(t=>t.id!==id);
      delete state.ui.drafts[id];
      if(state.ui.selectedThread===id)state.ui.selectedThread=null;
      // Refresh the recovery backup too, so ordinary recovery cannot resurrect deleted records.
      this.store.save();this.store.save();return true;
    } finally {this.deleting.delete(id);}
  }
  async stop(id) {
    const t = this.thread(id); if (!ACTIVE.has(t.status)) return;
    this.setStatus(t, 'stopping', '正在停止运行'); await this.closeRun(id);
    t.finishedAt = Date.now(); const turn = t.turns.at(-1); this.requeueSteers(t, turn); if (turn) { if(turn.status==='running'){turn.status = 'stopped'; turn.finishedAt = Date.now();} delete turn.approval; for (const tool of turn.tools) if (tool.status === 'running') tool.status = 'interrupted'; }
    this.setStatus(t, 'stopped', '已停止'); this.store.save();
  }
  async shutdown() { this.closing = true; for (const id of [...this.warm.keys()]) this.dropWarm(id); for (const id of [...this.runs.keys()]) { const t = this.thread(id); if (ACTIVE.has(t.status)) await this.stop(id); else await this.closeRun(id); } clearTimeout(this.saveTimer); for (const timer of this.eventTimers.values()) clearTimeout(timer); this.store.save(); }
}
module.exports = { Engine, JsonStore, InputQueue, ACTIVE };
