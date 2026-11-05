const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { GitHubUpdates, releaseInfo, CHECK_INTERVAL } = require('../github-updates.cjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const asset = extra => ({ id: 123, name: 'ClaudeDesk-1.0.0-to-1.1.0-update.zip', size: 100, state: 'uploaded', digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://github.com/bysghjx/claude-desk/releases/download/v1.1.0/ClaudeDesk-1.0.0-to-1.1.0-update.zip', ...extra });
const release = extra => ({ tag_name: 'v1.1.0', draft: false, prerelease: false, assets: [asset()], ...extra });

test('GitHub updates select a stable newer release with an exact-from asset and digest', () => {
  assert.equal(releaseInfo(release(), '1.0.0').update.file, 'github:123');
  for (const version of ['1.1.0', '2.0.0']) assert.equal(releaseInfo(release(), version).status, 'current');
  assert.equal(releaseInfo(release(), '0.9.0').status, 'manual');
  for (const extra of [{ digest: null }, { browser_download_url: 'https://example.com/file' }, { browser_download_url: 'invalid' }, { state: 'new' }, { size: -1 }, { name: '../evil.zip' }]) assert.equal(releaseInfo(release({ assets: [asset(extra)] }), '1.0.0').status, 'manual');
  for (const extra of [{ prerelease: true }, { draft: true }, { tag_name: 'v1.1.0-beta' }]) assert.throws(() => releaseInfo(release(extra), '1.0.0'), /正式版本/);
});

test('online checks cache, deduplicate, allow a forced retry and handle missing releases', async () => {
  let calls = 0, now = 1000;
  const service = new GitHubUpdates({ version: '1.0.0', now: () => now, fetch: async () => { calls++; return Response.json(release()); } });
  const [a, b] = await Promise.all([service.check(), service.check()]);
  assert.equal(a, b); assert.equal(calls, 1);
  await service.check(); assert.equal(calls, 1);
  now += CHECK_INTERVAL; await service.check(); assert.equal(calls, 2);
  await service.check(true); assert.equal(calls, 3);
  service.fetch = async () => new Response('', { status: 404 });
  assert.equal((await service.check(true)).status, 'empty');
  service.fetch = async () => new Response('', { status: 403 });
  assert.match((await service.check(true)).message, /限制了检查频率/);
  service.fetch = async () => { throw Error('offline'); };
  assert.match((await service.check(true)).message, /offline/);
});

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-github-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'pkg'); fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'claude-desk-update.json'), JSON.stringify({ app: 'ClaudeDesk', from: '1.0.0', to: '1.1.0', files: {}, ...extra }));
  const file = path.join(root, 'fixture.zip');
  execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', file, '-C', pkg, 'claude-desk-update.json'], { windowsHide: true });
  const bytes = fs.readFileSync(file), update = releaseInfo(release({ assets: [asset({ size: bytes.length, digest: 'sha256:' + digest(bytes) })] }), '1.0.0').update;
  let calls = 0;
  const service = new GitHubUpdates({ version: '1.0.0', downloadDir: path.join(root, 'downloads'), fetch: async () => { calls++; return new Response(bytes); } });
  return { service, bytes, update, calls: () => calls };
}

test('a streamed ZIP is verified, progress is reported and a valid cache is reused', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), progress = [];
  const file = await f.service.download(f.update, event => progress.push(event));
  assert.deepEqual(fs.readFileSync(file), f.bytes);
  assert.equal(progress.at(-1).received, f.bytes.length);
  assert.equal(await f.service.download(f.update), file); assert.equal(f.calls(), 1);
  fs.writeFileSync(file, 'tampered');
  await f.service.download(f.update); assert.equal(f.calls(), 2);
  assert.equal(fs.readdirSync(f.service.downloadDir).length, 1);
});

test('corrupt, incomplete and wrong-version downloads are rejected without partial files', { skip: process.platform !== 'win32' }, async t => {
  for (const kind of ['digest', 'short', 'long', 'version', 'network']) {
    const f = fixture(t, kind === 'version' ? { from: '0.9.0' } : {});
    if (kind === 'digest') f.update.sha256 = 'b'.repeat(64);
    if (kind === 'short') f.update.size++;
    if (kind === 'long') f.update.size--;
    if (kind === 'network') f.service.fetch = async () => { throw Error('offline'); };
    await assert.rejects(() => f.service.download(f.update), /校验失败|不一致|offline/);
    assert.deepEqual(fs.readdirSync(f.service.downloadDir), []);
    assert.equal(f.service.downloading, false);
  }
});

test('a second download cannot replace an in-progress download', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); let resolve;
  f.service.fetch = () => new Promise(r => { resolve = r; });
  const pending = f.service.download(f.update);
  await assert.rejects(() => f.service.download(f.update), /正在下载/);
  resolve(new Response(f.bytes)); await pending;
});

test('online UI explains download, failures and full-package fallback', async () => {
  const { updateCardHtml, noticeOf } = await import('../ui/src/lib/updates.mjs');
  const update = releaseInfo(release(), '1.0.0').update;
  const scan = { ready: [update], other: [], dirs: [], version: '1.0.0', installable: true };
  assert.match(updateCardHtml(scan), /下载并安装/);
  assert.doesNotMatch(updateCardHtml(scan), /undefined/);
  assert.match(noticeOf(scan, update, { mode: 'ask' }).detail, /GitHub 新版本/);
  assert.match(updateCardHtml({ ...scan, ready: [], online: { status: 'manual', version: '1.1.0' } }), /下载完整包/);
  assert.match(updateCardHtml({ ...scan, ready: [], online: { status: 'error', message: 'offline' } }), /offline/);
});

test('release automation rejects mismatched versions and unsafe base manifests', () => {
  const { validateVersion, previousRelease, validateManifest } = require('../scripts/github-release.cjs');
  const pkg = { version: '1.1.0' }, lock = { ...pkg, packages: { '': pkg } };
  validateVersion('v1.1.0', pkg, lock);
  for (const tag of ['v1.0.0', 'v1.1.0-beta', '1.1.0', '--help']) assert.throws(() => validateVersion(tag, pkg, lock));
  assert.throws(() => validateVersion('v1.1.0', pkg, { ...lock, version: '1.0.0' }));
  assert.equal(previousRelease([release({ tag_name: 'v1.0.0' }), release({ tag_name: 'v1.0.5' }), release({ tag_name: 'v1.0.9', prerelease: true }), release({ tag_name: 'v1.0.8', draft: true }), release()], '1.1.0').tag_name, 'v1.0.5');
  validateManifest({ app: 'ClaudeDesk', version: '1.0.0', files: { 'resources/app.asar': 'a'.repeat(64) } }, '1.0.0');
  assert.throws(() => validateManifest({ app: 'ClaudeDesk', version: '1.0.0', files: { '../evil.exe': 'a'.repeat(64) } }, '1.0.0'));
});
