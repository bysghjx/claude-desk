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

test('update form saves before checking, preserves failed edits and keeps input during progress', async t => {
  const { createUpdates } = await import('../ui/src/views/updates.mjs');
  const old = { document: global.document, window: global.window, setInterval: global.setInterval, clearInterval: global.clearInterval };
  t.after(() => Object.assign(global, old));
  const nodes = new Map(), events = new Map(), calls = [], toasts = [];
  const node = id => { if (!nodes.has(id)) nodes.set(id, { handlers: {}, addEventListener(name, cb) { this.handlers[name] = cb; } }); return nodes.get(id); };
  global.document = { querySelector: node };
  let progress, fail = false;
  global.window = { addEventListener() {}, desk: { onUpdateProgress(cb) { progress = cb; } } };
  global.setInterval = () => 0; global.clearInterval = () => {};
  const store = { state: { threads: [], settings: { autoUpdate: false, updateProxy: 'http://old:7890', updateMirror: '', updatePrerelease: false } }, on: (name, cb) => events.set(name, cb) };
  const update = { file: 'github:1', source: 'github', from: '1.0.0', to: '1.1.0-beta.1', prerelease: true, size: 10 };
  let finishDownload;
  const view = createUpdates({ store, toast: x => toasts.push(x), confirm: async () => true, api: async (name, value) => {
    calls.push({ name, value });
    if (name === 'update:scan') return { ready: [update], other: [], dirs: [], installable: true };
    if (name === 'update:stage') return new Promise(r => { finishDownload = r; });
    if (name === 'update:settings') { if (fail) throw Error('invalid proxy'); return { ...value, updateProxy: value.updateProxy.trim() }; }
  } });
  view.open(); await new Promise(setImmediate);
  assert.equal(node('#update-proxy').value, 'http://old:7890');
  node('#update-proxy').value = ' http://new:7890 '; node('#update-prerelease-toggle').checked = true;
  await node('#update-settings-form').handlers.submit({ preventDefault() {} });
  assert.equal(store.state.settings.updateProxy, 'http://new:7890'); assert.equal(store.state.settings.updatePrerelease, true);
  assert.deepEqual(calls.slice(-2).map(c => c.name), ['update:settings','update:scan']); assert.equal(calls.at(-1).value, true);
  fail = true; node('#update-proxy').value = 'invalid';
  await node('#update-settings-form').handlers.submit({ preventDefault() {} });
  assert.equal(store.state.settings.updateProxy, 'http://new:7890'); assert.equal(node('#update-proxy').value, 'invalid'); assert.deepEqual(toasts, ['invalid proxy']);
  fail = false; node('#update-proxy').value = ''; node('#update-mirror').value = ''; node('#update-prerelease-toggle').checked = false;
  await node('#update-settings-form').handlers.submit({ preventDefault() {} }); assert.equal(store.state.settings.updateProxy, '');
  node('#update-proxy').value = 'unsaved';
  const install = node('#update-notice-primary').handlers.click(); await new Promise(setImmediate);
  progress({ file: update.file, route: 'mirror', received: 5, total: 10 });
  assert.match(node('#update-notice-detail').textContent, /加速地址.*50%/); assert.equal(node('#update-proxy').value, 'unsaved'); assert.equal(node('#save-update-settings').disabled, true);
  finishDownload({ to: update.to }); await install;
});
