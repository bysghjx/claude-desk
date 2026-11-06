const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUpdateNetwork, createUpdateFetch } = require('../update-network.cjs');

test('update settings normalize addresses, clear empty fields and reject unsupported proxy syntax', () => {
  assert.deepEqual(normalizeUpdateNetwork(), { updateProxy: '', updateMirror: '', updatePrerelease: false });
  assert.deepEqual(normalizeUpdateNetwork({ updateProxy: ' http://127.0.0.1:7890/ ', updateMirror: ' https://mirror.example/prefix/// ', updatePrerelease: true }), { updateProxy: 'http://127.0.0.1:7890', updateMirror: 'https://mirror.example/prefix/', updatePrerelease: true });
  assert.equal(normalizeUpdateNetwork({ updateProxy: 'https://[::1]:8888' }).updateProxy, 'https://[::1]:8888');
  for (const value of ['socks5://localhost:1080', 'localhost:7890', 'http://name:secret@localhost', 'http://localhost/path', 'http://localhost/?token=secret', 'http://localhost/#hash', 'http://first;second', 'http://localhost:7890 DIRECT', 123]) assert.throws(() => normalizeUpdateNetwork({ updateProxy: value }));
  for (const value of ['file:///tmp', 'https://example.com/?token=secret', 'https://name:secret@example.com/', 'https://example.com/#hash']) assert.throws(() => normalizeUpdateNetwork({ updateMirror: value }));
  assert.throws(() => normalizeUpdateNetwork({ updatePrerelease: 'true' }));
});

test('update fetch isolates each proxy, awaits proxy setup, reuses sessions and omits cookies', async () => {
  const partitions = [], requests = [], proxies = [];
  let ready;
  const fetch = createUpdateFetch({ fromPartition(name, options) {
    partitions.push({ name, options });
    return { setProxy: value => { proxies.push(value); return new Promise(resolve => { ready = resolve; }); }, fetch: async (...args) => { requests.push(args); return 'ok'; } };
  }, get defaultSession() { throw Error('must not touch defaultSession'); } });
  const pending = fetch('https://example.com/file', { credentials: 'include' }, 'http://localhost:7890');
  assert.equal(requests.length, 0); ready(); assert.equal(await pending, 'ok');
  await fetch('https://example.com/other', {}, 'http://localhost:7890');
  assert.equal(partitions.length, 1);
  assert.deepEqual(proxies[0], { mode: 'fixed_servers', proxyRules: 'http://localhost:7890', proxyBypassRules: '<-loopback>' });
  const direct = fetch('https://example.com/file'); ready(); await direct;
  assert.equal(partitions.length, 2); assert.notEqual(partitions[0].name, partitions[1].name);
  assert.ok(partitions.every(p => !p.name.startsWith('persist:') && p.options.cache === false));
  assert.deepEqual(proxies[1], { mode: 'direct' });
  assert.ok(requests.every(([, options]) => options.credentials === 'omit'));
});

test('failed proxy initialization can be retried', async () => {
  let attempts = 0;
  const fetch = createUpdateFetch({ fromPartition: () => ({ setProxy: async () => { if (!attempts++) throw Error('setup failed'); }, fetch: async () => 'ok' }) });
  await assert.rejects(() => fetch('https://example.com'), /setup failed/);
  assert.equal(await fetch('https://example.com'), 'ok');
});
