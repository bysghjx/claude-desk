const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { createZip } = require('../scripts/zip.cjs');
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

test('preview channel compares versions, paginates, excludes drafts and never downgrades on stable', async () => {
  const calls = [];
  const service = new GitHubUpdates({ version: '1.0.0', network: { updatePrerelease: true, updateProxy: 'http://127.0.0.1:7890', updateMirror: 'https://mirror.example/' }, fetch: async (url, options, proxy) => {
    calls.push({ url, proxy });
    if (url.endsWith('/latest')) return Response.json(release());
    if (url.endsWith('page=1')) return Response.json([release({ tag_name: 'v9.0.0', draft: true }), release({ tag_name: 'v1.1.0-rc.1', prerelease: true }), release({ tag_name: 'v1.1.0-beta.10', prerelease: true })], { headers: { link: '<https://api.github.com/example?page=2>; rel="next"' } });
    return Response.json([release({ tag_name: 'v1.1.0' }), release({ tag_name: 'unsupported' })]);
  } });
  assert.equal((await service.check()).version, '1.1.0');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.url.startsWith('https://api.github.com/') && c.proxy === 'http://127.0.0.1:7890'));
  await service.configure({});
  assert.equal((await service.check()).version, '1.1.0'); assert.ok(calls.at(-1).url.endsWith('/latest'));
  service.version = '1.2.0-beta.1';
  assert.equal((await service.check(true)).status, 'current');
  await service.configure({ updatePrerelease: true });
  service.version = '1.0.0';
  service.fetch = async () => Response.json([release({ tag_name: 'v1.2.0-beta.2', prerelease: true, assets: [asset({ name: 'ClaudeDesk-1.0.0-to-1.2.0-beta.2-update.zip' })] }), release()]);
  const preview = await service.check();
  assert.equal(preview.version, '1.2.0-beta.2'); assert.equal(preview.update.prerelease, true);
  assert.throws(() => releaseInfo(release({ tag_name: 'v1.2.0-beta.2' }), '1.0.0'));
  assert.equal(releaseInfo(release({ prerelease: true }), '1.0.0', true).update.prerelease, true);
  service.fetch = async () => Response.json([]);
  assert.equal((await service.check(true)).status, 'empty');
});

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-github-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'pkg'); fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'claude-desk-update.json'), JSON.stringify({ app: 'ClaudeDesk', from: '1.0.0', to: '1.1.0', files: {}, ...extra }));
  const file = path.join(root, 'fixture.zip');
  createZip(pkg, file);
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
  await assert.rejects(() => f.service.configure({ updatePrerelease: true }), /下载完成/);
  resolve(new Response(f.bytes)); await pending;
});

test('official download succeeds without using the mirror; failed attempts restart and verify the mirror', { skip: process.platform !== 'win32' }, async t => {
  for (const failure of ['none', 'network', 'http', 'interrupted', 'digest']) {
    const f = fixture(t), calls = [], events = [];
    await f.service.configure({ updateMirror: 'https://mirror.example/prefix/', updateProxy: 'http://127.0.0.1:7890' });
    f.service.fetch = async (url, options, proxy) => {
      calls.push({ url, proxy });
      if (calls.length === 1) {
        if (failure === 'network') throw Error('offline');
        if (failure === 'http') return new Response('unavailable', { status: 503 });
        if (failure === 'interrupted') return new Response(new ReadableStream({ start(controller) { controller.enqueue(f.bytes.subarray(0, 10)); controller.error(Error('stream interrupted')); } }));
        if (failure === 'digest') return new Response(Buffer.alloc(f.bytes.length));
      }
      return new Response(f.bytes);
    };
    const file = await f.service.download(f.update, event => events.push(event));
    assert.deepEqual(fs.readFileSync(file), f.bytes);
    assert.equal(calls.length, failure === 'none' ? 1 : 2);
    assert.equal(calls[0].url, f.update.url);
    assert.equal(events[0].route, 'proxy');
    if (failure !== 'none') {
      assert.equal(calls[1].url, 'https://mirror.example/prefix/' + f.update.url);
      const mirror = events.filter(e => e.route === 'mirror'); assert.equal(mirror[0].received, 0); assert.equal(mirror.at(-1).received, f.bytes.length);
    }
    assert.ok(calls.every(c => c.proxy === 'http://127.0.0.1:7890'));
    assert.deepEqual(fs.readdirSync(f.service.downloadDir), [path.basename(file)]);
  }
});

test('a corrupt mirror is rejected and both failure reasons survive without partial files', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t); await f.service.configure({ updateMirror: 'https://mirror.example/' });
  let calls = 0;
  f.service.fetch = async () => { if (!calls++) throw Error('official offline'); return new Response(Buffer.alloc(f.bytes.length)); };
  await assert.rejects(() => f.service.download(f.update), /official offline.*加速下载也失败.*校验失败/);
  assert.equal(calls, 2); assert.deepEqual(fs.readdirSync(f.service.downloadDir), []); assert.equal(f.service.downloading, false);
});

test('preview release automation accepts suffixes and keeps delta bases for both channels', () => {
  const { validateVersion, baseReleases } = require('../scripts/github-release.cjs');
  const pkg = { version: '1.2.0-beta.2' }; validateVersion('v' + pkg.version, pkg, { ...pkg, packages: { '': pkg } });
  const item = version => release({ tag_name: 'v' + version, prerelease: version.includes('-'), assets: [{ name: version + '.json' }] });
  const all = ['1.0.0', '1.1.0', '1.2.0-beta.1', '1.2.0-beta.2', '1.2.0-rc.1'].map(item);
  assert.deepEqual(baseReleases(all, '1.2.0-beta.2').map(r => r.tag_name), ['v1.1.0', 'v1.0.0', 'v1.2.0-beta.1']);
  assert.deepEqual(baseReleases(all, '1.2.0', 1).map(r => r.tag_name), ['v1.1.0', 'v1.2.0-rc.1']);
  const previewBase = asset({ name: 'ClaudeDesk-1.2.0-beta.2-to-1.2.0-update.zip' });
  assert.equal(releaseInfo(release({ tag_name: 'v1.2.0', assets: [previewBase] }), '1.2.0-beta.2').status, 'available');
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
  const { validateVersion, previousRelease, baseReleases, validateManifest } = require('../scripts/github-release.cjs');
  const pkg = { version: '1.1.0' }, lock = { ...pkg, packages: { '': pkg } };
  validateVersion('v1.1.0', pkg, lock);
  for (const tag of ['v1.0.0', 'v1.1.0-beta', '1.1.0', '--help']) assert.throws(() => validateVersion(tag, pkg, lock));
  assert.throws(() => validateVersion('v1.1.0', pkg, { ...lock, version: '1.0.0' }));
  assert.equal(previousRelease([release({ tag_name: 'v1.0.0' }), release({ tag_name: 'v1.0.5' }), release({ tag_name: 'v1.0.9', prerelease: true }), release({ tag_name: 'v1.0.8', draft: true }), release()], '1.1.0').tag_name, 'v1.0.5');
  // Update bases: the newest earlier stable releases with a manifest, at most count, newest first.
  const withManifest = tag => release({ tag_name: tag, assets: [{ name: tag.slice(1) + '.json' }] });
  const all = [withManifest('v1.0.0'), withManifest('v1.0.5'), release({ tag_name: 'v1.0.3', assets: [] }), withManifest('v1.0.4'), withManifest('v1.0.9'), release({ tag_name: 'v1.0.8', draft: true }), withManifest('v1.2.0')];
  assert.deepEqual(baseReleases(all, '1.1.0').map(r => r.tag_name), ['v1.0.9', 'v1.0.5', 'v1.0.4', 'v1.0.0']);
  assert.deepEqual(baseReleases(all, '1.1.0', 2).map(r => r.tag_name), ['v1.0.9', 'v1.0.5']);
  assert.deepEqual(baseReleases([], '1.1.0'), []);
  assert.throws(() => baseReleases([...all, release({ tag_name: 'v1.0.10', assets: [] })], '1.1.0'), /1.0.10.json/);
  validateManifest({ app: 'ClaudeDesk', version: '1.0.0', files: { 'resources/app.asar': 'a'.repeat(64) } }, '1.0.0');
  assert.throws(() => validateManifest({ app: 'ClaudeDesk', version: '1.0.0', files: { '../evil.exe': 'a'.repeat(64) } }, '1.0.0'));
});
