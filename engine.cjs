const {legacyUsage,recordUsage}=require('./usage.cjs');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {atomicWrite,loadRecoverable,mergeLegacy}=require('./storage.cjs');
const {ACTIVE_AGENT,activeAgents,findAgent,ensureAgent,agentFromTool,finishAgentTool,settleAgents,handleAgentMessage}=require('./subagents.cjs');

const questionsOf = args => Array.isArray(args?.questions) && args.questions.length;
const ACTIVE = new Set(['starting', 'waiting', 'thinking', 'generating', 'tool', 'approval', 'stopping']);
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
      for (const turn of t.turns) for (const tool of turn.tools || []) if (['running', 'approval'].includes(tool.status)) tool.status = 'interrupted';
    }
  }
  save() {
    this.state.savedAt=Date.now();atomicWrite(this.file,this.state);
  }
}
class Engine extends EventEmitter {
  constructor({ query, store, cliPath, env = process.env, sessionOptions=()=>({}), attachmentRoot='', chatRoot='' }) {
    super(); Object.assign(this, { query, store, cliPath, env, sessionOptions, attachmentRoot, chatRoot }); this.runs = new Map(); this.pending = new Map();
    this.saveTimer = null; this.eventTimers = new Map(); this.closing = false; this.deleting = new Set(); this.draining = new Set(); this.snapshots = new WeakMap(); this.revision = 0;
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
    if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; try{this.store.save();}catch(e){this.emit('storage-error',e.message);} }, 350);
    if (immediate) { clearTimeout(this.eventTimers.get(id)); this.eventTimers.delete(id); this.emit('thread', this.threadSnapshot(this.thread(id))); }
    else if (!this.eventTimers.has(id)) this.eventTimers.set(id, setTimeout(() => { this.eventTimers.delete(id); if (this.store.state.threads.some(x => x.id === id)) this.emit('thread', this.threadSnapshot(this.thread(id))); }, 70));
  }
  // Snapshots are immutable copies for listeners. Each turn carries a revision:
  // live turns get a new one on every update, settled turns reuse a cached copy
  // until their content fingerprint changes, so unchanged history is not re-cloned.
  turnSnapshot(turn) {
    const live = turn.status === 'running' || turn.approvals?.length || (turn.subagents || []).some(a => ACTIVE_AGENT.has(a.status));
    const fingerprint = live ? null : [turn.status, turn.finishedAt, turn.error, turn.answer?.length, turn.thinking?.length, turn.items?.length, turn.tools?.length, (turn.tools || []).map(x => x.status + (x.output?.length || 0)).join(), (turn.subagents || []).map(a => a.status + (a.tools?.length || 0) + (a.answer?.length || 0)).join(), turn.usage?.output].join('|');
    const cached = this.snapshots.get(turn);
    if (cached && fingerprint !== null && cached.fingerprint === fingerprint) return cached.copy;
    const copy = { ...structuredClone(turn), rev: ++this.revision };
    this.snapshots.set(turn, { fingerprint, copy });
    return copy;
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
    if (!p) { p = { id: randomUUID(), name: path.basename(real), path: real }; this.store.state.projects.push(p); this.store.save(); }
    return p;
  }
  // `worktree` (from worktree.cjs) makes the conversation run in its own checkout.
  // Without a project the conversation is a chat: it works in its own empty folder under chatRoot.
  create(projectId, { worktree } = {}) {
    const p = projectId ? this.store.state.projects.find(p => p.id === projectId) : null; if (projectId && !p) throw Error('项目不存在');
    const id = randomUUID(), cwd = worktree?.cwd || p?.path || this.chatFolder(id);
    const t = { id, projectId: p ? projectId : null, cwd, ...(worktree ? { worktree } : {}), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), status: 'idle', seenAt: Date.now(), turns: [], model: this.store.state.settings.model, effort: this.store.state.settings.effort, mode: this.store.state.settings.mode };
    this.store.state.threads.unshift(t); this.store.save(); return t;
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
    let run = this.runs.get(id);
    if (run && (run.model !== model || run.mode !== mode || run.effort !== effort || run.extensionKey!==extensionKey)) { await this.closeRun(id); run = null; }
    const history = t.turns.filter(x => x.answer || x.tools?.length).map(x => ({ user: x.user, ...(x.images?.length ? { images: `[附带 ${x.images.length} 张图片，图片本身未包含在历史中]` } : {}), context:x.context, answer: x.answer, tools: x.tools?.map(y => ({ name: y.name, input: y.input, output: y.output })) }));
    Object.assign(t, { model, mode, effort, updatedAt: Date.now(), error: '', startedAt: Date.now(), finishedAt: null });
    if (!t.turns.length) t.title = (text || '图片').replace(/\s+/g, ' ').slice(0, 34);
    const turn = { id: randomUUID(), user: text, context:options.context||'', references:options.references||[], images, answer: '', thinking: '', items: [], tools: [], startedAt: Date.now(), status: 'running', usage: null };
    t.turns.push(turn);
    let prompt = text || '请查看我附带的图片。';
    if (options.context) prompt = `${prompt}\n\n<user_selected_context>\n${options.context}\n</user_selected_context>`;
    if (!run) {
      t.contextUsage=null;
      if (history.length) {
        const full = JSON.stringify(history);
        prompt = `<previous_conversation>\n以下为本地保存的历史对话，仅用于上下文。文件状态以当前磁盘为准。\n${full.slice(-120000)}\n</previous_conversation>\n\n${prompt}`;
        turn.contextRestored = true;
      }
      run = this.startRun(t,extensionOptions,extensionKey);
    }
    run.turnId = turn.id; run.partialText = false; run.seen = new Set(); run.blocks = new Map(); run.model = model; run.responseUsage=null; run.mainDone=false;
    this.setStatus(t, 'starting', '正在启动 Claude');
    this.store.save();
    // Record the project files first so this turn can be rewound later.
    if (this.checkpoint) {
      try { turn.checkpoint = await Promise.race([this.checkpoint(t), new Promise((_, reject) => setTimeout(() => reject(Error('记录文件快照超时')), 30000))]); }
      catch (e) { turn.checkpointError = String(e.message || e).slice(0, 300); }
      if (this.runs.get(id) !== run || run.turnId !== turn.id) return t;
    }
    const content = images.length ? [...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: fs.readFileSync(image.path).toString('base64') } })), { type: 'text', text: prompt }] : prompt;
    run.input.push({ type: 'user', session_id: run.sessionId || '', parent_tool_use_id: null, message: { role: 'user', content } });
    return t;
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
  setMeta(id, value = {}) {
    const t = this.thread(id);
    if (typeof value.pinned === 'boolean') t.pinned = value.pinned;
    if (typeof value.archived === 'boolean') { t.archived = value.archived; if (value.archived) t.pinned = false; }
    if (typeof value.title === 'string' && value.title.trim()) t.title = value.title.trim().slice(0, 80);
    if (Number.isFinite(value.seenAt)) t.seenAt = Math.min(value.seenAt, Date.now());
    this.publish(id); this.store.save(); return t;
  }
  startRun(t,extensionOptions={},extensionKey=JSON.stringify(extensionOptions)) {
    const abort = new AbortController(); const input = new InputQueue();
    const run = { input, abort, extensionKey, model: t.model, mode: t.mode, effort: t.effort, turnId: null, finished: false, sessionId: '', seen: new Set(), blocks: new Map() };
    this.runs.set(t.id, run);
    const env = { ...this.env }; delete env.CLAUDECODE; delete env.ELECTRON_RUN_AS_NODE;
    // Each conversation owns a live CLI process; app history is persisted separately.
    // No temporary HOME, shared resume ID, or provider credentials in renderer state.
    const options = {
      cwd: t.cwd, pathToClaudeCodeExecutable: this.cliPath, env,
      ...(extensionOptions.skills!==undefined?{skills:extensionOptions.skills}:{}),
      ...(extensionOptions.plugins?.length?{plugins:extensionOptions.plugins}:{}),
      model: t.model, thinking: { type: 'adaptive' }, effort: t.effort,
      permissionMode: t.mode, settingSources: ['user', 'project', 'local'],
      allowDangerouslySkipPermissions: t.mode === 'bypassPermissions',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: '你在 Claude Desk 本地桌面客户端中工作。默认用中文与用户交流。简明汇报进度；只有实际完成工具操作后才能声称完成。' },
      includePartialMessages: true, persistSession: false, abortController: abort,
      canUseTool: (name, args, ctx) => this.requestApproval(t, run, name, args, ctx),
      stderr: text => { run.stderr = (run.stderr || '').concat(text).slice(-8000); this.emit('diagnostic', { threadId: t.id, message: text.slice(-1500) }); }
    };
    run.task = (async () => {
      try {
        run.query = this.query({ prompt: input, options });
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
    t.error = message; t.finishedAt = Date.now(); const turn = t.turns.at(-1);
    if (turn) { turn.status = 'error'; turn.error = message; turn.finishedAt = Date.now(); for (const tool of turn.tools) if (['running', 'approval'].includes(tool.status)) tool.status = 'error'; }
    this.setStatus(t, 'error', message);
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
    t.lastEventAt = Date.now();
    if(handleAgentMessage(t,run,msg,text=>this.redact(text))){this.publish(t.id,false);return;}
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
        if (e.delta.type === 'text_delta') { turn.answer += e.delta.text; appendItem(turn, 'text', e.delta.text); run.partialText = true; t.status = 'generating'; t.detail = '正在生成回复'; }
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
      const text = blocks.filter(x => x.type === 'text').map(x => x.text).join('\n');
      if (text && !run.partialText) { turn.answer += (turn.answer ? '\n\n' : '') + text; addItem(turn, 'text', text); }
      run.partialText = false;
      for (const b of blocks) if (b.type === 'tool_use') {
        agentFromTool(t,turn,b);
        if (!turn.tools.some(x => x.id === b.id)) { turn.tools.push({ id: b.id, name: b.name, input: b.input, output: '', status: 'running', startedAt: Date.now() }); addItem(turn, 'tool', b.id); }
        if (t.status !== 'approval') this.setStatus(t, 'tool', `执行 ${b.name}`);
      }
      if (msg.error) turn.modelWarning = this.redact(msg.error);
      this.publish(t.id); return;
    }
    if (msg.type === 'user') {
      for (const b of msg.message?.content || []) if (b.type === 'tool_result') {
        const tool = turn.tools.find(x => x.id === b.tool_use_id);
        finishAgentTool(t,b.tool_use_id,b.is_error,this.redact(typeof b.content==='string'?b.content:JSON.stringify(b.content||'')));
        if (tool) { tool.output = this.redact(typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '')).slice(-80000); tool.status = b.is_error ? 'error' : 'done'; tool.finishedAt = Date.now(); }
      }
      if (t.status !== 'approval') this.setStatus(t, 'waiting', '工具已返回，等待模型继续');
      this.publish(t.id); return;
    }
    if (msg.type === 'tool_progress') { if (t.status !== 'approval') this.setStatus(t, 'tool', `${msg.tool_name || '工具'} 执行中 · ${msg.elapsed_time_seconds || 0}s`); return; }
    if (msg.type === 'result') {
      run.mainDone=true;run.resultStatus=msg.is_error||msg.subtype!=='success'?'error':'done';
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
        turn.status = 'done'; this.setStatus(t, 'done', '本轮已完成');
      }
      this.publish(t.id); this.store.save(); return;
    }
    if (msg.type === 'system' && msg.subtype === 'status' && msg.status === 'compacting') this.setStatus(t, 'thinking', '正在压缩上下文');
  }
  requestApproval(t, run, name, args, ctx = {}) {
    if (run.stopping || run.abort.signal.aborted) return Promise.resolve({ behavior: 'deny', message: '运行已停止' });
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
      await this.closeRun(id);
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
    t.finishedAt = Date.now(); const turn = t.turns.at(-1); if (turn) { if(turn.status==='running'){turn.status = 'stopped'; turn.finishedAt = Date.now();} delete turn.approval; for (const tool of turn.tools) if (tool.status === 'running') tool.status = 'interrupted'; }
    this.setStatus(t, 'stopped', '已停止'); this.store.save();
  }
  async shutdown() { this.closing = true; for (const id of [...this.runs.keys()]) { const t = this.thread(id); if (ACTIVE.has(t.status)) await this.stop(id); else await this.closeRun(id); } clearTimeout(this.saveTimer); for (const timer of this.eventTimers.values()) clearTimeout(timer); this.store.save(); }
}
module.exports = { Engine, JsonStore, InputQueue, ACTIVE };
