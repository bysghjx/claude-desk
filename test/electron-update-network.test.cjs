const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
// Needs a real Electron window session: the GitHub Actions runner cannot start its GPU process, so it runs locally only.
test('real Electron updates use their HTTP proxy without changing the default session', { skip: process.platform !== 'win32' || Boolean(process.env.CI), timeout: 30000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-update-network-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), ['--no-sandbox', '--disable-gpu', path.join(__dirname, 'fixtures/electron-update-network.cjs'), root], { env, windowsHide: true, encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error || ''));
  const proof = JSON.parse(fs.readFileSync(path.join(root, 'result.json'), 'utf8'));
  assert.equal(proof.proxyRequests, 2); assert.equal(proof.directRequests, 3);
});
