const { test } = require('node:test');
const assert = require('node:assert/strict');

test('automatic installation waits if a task starts or auto-install is turned off during download', async t => {
  const { createUpdates } = await import('../ui/src/views/updates.mjs');
  const old = { document: global.document, window: global.window, setInterval: global.setInterval, clearInterval: global.clearInterval };
  t.after(() => Object.assign(global, old));
  for (const change of ['task', 'setting', 'none']) {
    const nodes = new Map(), timers = new Map(), events = new Map(), calls = [], toasts = [];
    const node = id => { if (!nodes.has(id)) nodes.set(id, { handlers: {}, addEventListener(name, cb) { this.handlers[name] = cb; } }); return nodes.get(id); };
    global.document = { querySelector: node };
    global.window = { addEventListener() {}, desk: { onUpdateProgress() {} } };
    let timerId = 0, finishDownload;
    global.setInterval = (cb, ms) => { timers.set(++timerId, { cb, ms }); return timerId; };
    global.clearInterval = id => timers.delete(id);
    const update = { file: 'github:1', source: 'github', from: '1.0.0', to: '1.1.0', size: 10 };
    const store = { state: { threads: [], settings: {} }, on: (name, cb) => events.set(name, cb) };
    createUpdates({ store, toast: x => toasts.push(x), confirm: async () => { throw Error('automatic install must not stop a task'); }, api: async name => {
      calls.push(name);
      if (name === 'update:scan') return { ready: [update], other: [], dirs: [], installable: true };
      if (name === 'update:stage') return new Promise(r => { finishDownload = r; });
      return true;
    } });
    events.get('load')();
    await new Promise(setImmediate);
    const tick = [...timers.values()].find(t => t.ms === 1000).cb;
    for (let i = 0; i < 10; i++) tick();
    assert.ok(finishDownload, 'countdown starts download');
    if (change === 'task') store.state.threads = [{ status: 'generating' }];
    if (change === 'setting') store.state.settings.autoUpdate = false;
    finishDownload({ to: '1.1.0' }); await new Promise(setImmediate);
    assert.equal(calls.includes('update:apply'), change === 'none');
    assert.deepEqual(toasts, []);
    if (change === 'task') {
      assert.match(node('#update-notice-detail').textContent, /任务在运行/);
      store.state.threads = []; events.get('threads')();
      assert.ok([...timers.values()].some(t => t.ms === 1000), 'finishing task restarts countdown');
    }
    if (change === 'setting') assert.equal(node('#update-notice-primary').textContent, '下载并安装');
  }
});
