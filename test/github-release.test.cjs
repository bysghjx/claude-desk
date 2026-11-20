const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

test('publishing checks uploaded draft assets before making a new or retried release public', async () => {
  // Earlier releases: 1.0.0 is the previous one; 0.9.0 had no changes since, so it has no update package; 0.8.0 has no manifest.
  const earlier = ['1.0.0', '0.9.0', '0.8.0', '0.7.0'].map(v => ({ tag_name: 'v' + v, draft: false, prerelease: false, assets: v === '0.8.0' ? [] : [{ name: v + '.json' }] }));
  // Previews built locally, with manifests in the repository: 1.1.0-beta gets a package, 1.0.0-rc.1 had no changes, 1.2.0-beta is not older.
  const previews = ['1.0.0-rc.1.json', '1.2.0-beta.json', '1.1.0-beta.json', 'notes.txt'];
  const updateName = from => 'ClaudeDesk-' + from + '-to-1.1.0-update.zip';
  const script = path.resolve(__dirname, '../scripts/github-release.cjs');
  const source = fs.readFileSync(script, 'utf8');
  const hash = 'a'.repeat(64), version = '1.1.0', tag = 'v' + version;
  const pkg = { version }, lock = { version, packages: { '': pkg } };
  const manifest = { app: 'ClaudeDesk', version, files: { 'ClaudeDesk.exe': hash } };
  for (const retry of [false, true]) for (const valid of [false, true]) {
    const commands = []; let uploaded = false;
    const draft = { id: 123, tag_name: tag, draft: true, prerelease: false, assets: [] };
    const result = { ...draft, assets: ['ClaudeDesk-' + version + '-win-x64.zip', version + '.json', updateName('1.0.0'), updateName('0.7.0'), updateName('1.1.0-beta')].map((name, id) => ({
      id, name, state: 'uploaded', size: 10, digest: 'sha256:' + (valid ? hash : 'b'.repeat(64)), browser_download_url: 'https://github.com/bysghjx/claude-desk/releases/download/' + tag + '/' + name
    })) };
    const child = { execFileSync(exe, args) {
      if (exe === 'git') return 'commit';
      assert.equal(exe, 'gh'); commands.push(args);
      if (args[0] === 'api') {
        assert.equal(args[1], 'repos/bysghjx/claude-desk/releases?per_page=100');
        return JSON.stringify([[...earlier, ...(uploaded ? [result] : retry ? [draft] : [])]]);
      }
      if (args[1] === 'upload') uploaded = true;
      return '';
    } };
    let notes = '';
    const fakeFs = { readFileSync: () => JSON.stringify(manifest), statSync: () => ({ size: 10 }), writeFileSync(file, text) { notes = text; }, existsSync: file => !/0\.9\.0|rc\.1/.test(file), readdirSync: dir => { assert.equal(path.basename(dir), 'preview-manifests'); return previews; } };
    const module = { exports: {} };
    const promise = vm.runInNewContext(source + '\nrun("publish")', {
      __dirname: path.dirname(script), module, console: { log() {} },
      process: { env: { RELEASE_TAG: tag, GITHUB_REPOSITORY: 'bysghjx/claude-desk' } },
      require(name) {
        if (name === 'node:fs') return fakeFs;
        if (name === 'node:child_process') return child;
        if (name === '../package.json') return pkg;
        if (name === '../package-lock.json') return lock;
        if (name === '../updates.cjs') return { ...require('../updates.cjs'), hashFile: async () => hash };
        if (name === '../github-updates.cjs') return require('../github-updates.cjs');
        return require(name);
      }
    });
    if (valid) await promise; else await assert.rejects(promise, /校验不符/);
    assert.equal(commands.some(args => args[1] === 'edit' && args.includes('--draft=false')), valid);
    assert.equal(commands.some(args => args[1] === 'create'), !retry);
    const upload = commands.find(args => args[1] === 'upload').map(arg => path.basename(arg));
    assert.deepEqual(Array.from(upload.filter(name => name.endsWith('update.zip'))), [updateName('1.0.0'), updateName('0.7.0'), updateName('1.1.0-beta')]);
    assert.match(notes, /从 1.0.0、0.7.0、1.1.0-beta 升级到 1.1.0/);
  }
});

test('preparing fetches published manifests and copies the ones kept for locally built previews', async () => {
  const script = path.resolve(__dirname, '../scripts/github-release.cjs');
  const version = '1.1.0', pkg = { version }, lock = { version, packages: { '': pkg } };
  const published = ['1.0.0', '1.1.0-beta.1'].map(v => ({ tag_name: 'v' + v, draft: false, prerelease: v.includes('-'), assets: [{ name: v + '.json' }] }));
  const downloaded = [], copied = [];
  const child = { execFileSync(exe, args) {
    if (exe === 'git') return 'commit';
    if (args[0] === 'api') return JSON.stringify([published]);
    assert.equal(args[0] + ' ' + args[1], 'release download'); downloaded.push(args[2]);
    return '';
  } };
  // 1.1.0-beta.1 is on GitHub, so its published manifest is used instead of the committed one.
  const fakeFs = {
    mkdirSync() {}, readdirSync: () => ['1.1.0-beta.1.json', '1.1.0-beta.2.json', '1.1.0.json'],
    copyFileSync(from, to) { assert.equal(path.basename(path.dirname(from)), 'preview-manifests'); assert.equal(path.basename(path.dirname(to)), 'manifests'); copied.push(path.basename(to)); },
    readFileSync: file => JSON.stringify({ app: 'ClaudeDesk', version: path.basename(file, '.json'), files: { 'ClaudeDesk.exe': 'a'.repeat(64) } })
  };
  await vm.runInNewContext(fs.readFileSync(script, 'utf8') + '\nrun("prepare")', {
    __dirname: path.dirname(script), module: { exports: {} }, console: { log() {} },
    process: { env: { RELEASE_TAG: 'v' + version, GITHUB_REPOSITORY: 'bysghjx/claude-desk' } },
    require(name) {
      if (name === 'node:fs') return fakeFs;
      if (name === 'node:child_process') return child;
      if (name === '../package.json') return pkg;
      if (name === '../package-lock.json') return lock;
      return require(name);
    }
  });
  assert.deepEqual(downloaded, ['v1.0.0', 'v1.1.0-beta.1']);
  assert.deepEqual(copied, ['1.1.0-beta.2.json']);
});
