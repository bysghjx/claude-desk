const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

test('publishing checks uploaded draft assets before making a new or retried release public', async () => {
  // Earlier releases: 1.0.0 is the previous one; 0.9.0 had no changes since, so it has no update package; 0.8.0 has no manifest.
  const earlier = ['1.0.0', '0.9.0', '0.8.0', '0.7.0'].map(v => ({ tag_name: 'v' + v, draft: false, prerelease: false, assets: v === '0.8.0' ? [] : [{ name: v + '.json' }] }));
  const updateName = from => 'ClaudeDesk-' + from + '-to-1.1.0-update.zip';
  const script = path.resolve(__dirname, '../scripts/github-release.cjs');
  const source = fs.readFileSync(script, 'utf8');
  const hash = 'a'.repeat(64), version = '1.1.0', tag = 'v' + version;
  const pkg = { version }, lock = { version, packages: { '': pkg } };
  const manifest = { app: 'ClaudeDesk', version, files: { 'ClaudeDesk.exe': hash } };
  for (const retry of [false, true]) for (const valid of [false, true]) {
    const commands = []; let uploaded = false;
    const draft = { id: 123, tag_name: tag, draft: true, prerelease: false, assets: [] };
    const result = { ...draft, assets: ['ClaudeDesk-' + version + '-win-x64.zip', version + '.json', updateName('1.0.0'), updateName('0.7.0')].map((name, id) => ({
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
    const fakeFs = { readFileSync: () => JSON.stringify(manifest), statSync: () => ({ size: 10 }), writeFileSync(file, text) { notes = text; }, existsSync: file => !file.includes('0.9.0') };
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
    assert.deepEqual(Array.from(upload.filter(name => name.endsWith('update.zip'))), [updateName('1.0.0'), updateName('0.7.0')]);
    assert.match(notes, /从 1.0.0、0.7.0 升级到 1.1.0/);
  }
});
