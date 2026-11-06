// Builds release zips from the packaged app (run `npm run package` first):
//   outputs/releases/ClaudeDesk-<version>-win-x64.zip            the full app
//   outputs/releases/ClaudeDesk-<from>-to-<version>-update.zip   only the files that changed since <from>
// Every release's file list is kept in outputs/releases/manifests/<version>.json. One update package
// is built from each of the newest UPDATE_BASES earlier versions, so a client several versions
// behind still updates in one step; --from names the bases instead.
// Usage: node scripts/release.cjs [--from 0.24.1,0.24.0]
const fs = require('node:fs');
const path = require('node:path');
const { createZip } = require('./zip.cjs');
const { manifestOf, diff, UPDATE_FILE } = require('../updates.cjs');

const source = path.resolve(__dirname, '..');
const version = require('../package.json').version;
// DESK_BUILD_DIR: the same folder given to npm run package.
const build = process.env.DESK_BUILD_DIR && path.resolve(process.env.DESK_BUILD_DIR);
const appDir = build ? path.join(build, 'ClaudeDesk-win32-x64') : path.resolve(source, '../ClaudeDesk-Windows/ClaudeDesk-win32-x64');
const releases = path.resolve(source, '../releases'), manifests = path.join(releases, 'manifests');
const work = build ? path.join(build, 'release') : path.resolve(source, '../../work/release');
const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const mb = n => (n / 2 ** 20).toFixed(1) + ' MB';
const { UPDATE_BASES } = require('./github-release.cjs');

(async () => {
  if (!fs.existsSync(path.join(appDir, 'ClaudeDesk.exe'))) throw Error('先运行 npm run package');
  fs.mkdirSync(manifests, { recursive: true });
  // The full app as people get it: the packaged folder plus the usage notes, without Electron's crash log.
  const full = path.join(work, 'full', 'ClaudeDesk');
  fs.rmSync(path.join(work, 'full'), { recursive: true, force: true });
  fs.cpSync(appDir, full, { recursive: true, filter: file => path.basename(file) !== 'debug.log' });
  // Unpacking the built-in Claude Code deletes its compressed file, so take it from the build cache rather than the app folder.
  const packedCli = path.resolve(source, '../../work/claude-code');
  if (!fs.existsSync(path.join(packedCli, 'claude.exe.zst'))) throw Error('缺少内置 Claude Code 的压缩文件，先运行 npm run package');
  fs.rmSync(path.join(full, 'resources/claude-code'), { recursive: true, force: true });
  fs.cpSync(packedCli, path.join(full, 'resources/claude-code'), { recursive: true });
  fs.writeFileSync(path.join(full, '使用说明.txt'), fs.readFileSync(path.join(__dirname, 'release-readme.txt'), 'utf8').replaceAll('{version}', version));
  const manifest = await manifestOf(full, version);
  fs.writeFileSync(path.join(manifests, version + '.json'), JSON.stringify(manifest, null, 1));
  const fullZip = path.join(releases, `ClaudeDesk-${version}-win-x64.zip`);
  console.log('完整包', path.basename(fullZip), mb(createZip(path.dirname(full), fullZip)));

  const flag = process.argv.indexOf('--from');
  const bases = flag > 0 ? process.argv[flag + 1].split(',') : fs.readdirSync(manifests).map(f => f.replace(/\.json$/, '')).filter(v => compare(v, version) < 0).sort(compare).slice(-UPDATE_BASES).reverse();
  if (!bases.length) return console.log('没有更早的版本清单，这次只有完整包');
  for (const from of bases) {
    const base = JSON.parse(fs.readFileSync(path.join(manifests, from + '.json'), 'utf8'));
    const { changed, removed } = diff(base, manifest);
    if (!changed.length && !removed.length) { console.log(`和 ${from} 相比没有变化，不生成更新包`); continue; }
    // Only the changed files, at the same paths as in the app folder, so the zip can also be extracted over it by hand.
    const update = path.join(work, 'update');
    fs.rmSync(update, { recursive: true, force: true });
    for (const rel of changed) { fs.mkdirSync(path.dirname(path.join(update, rel)), { recursive: true }); fs.copyFileSync(path.join(full, rel), path.join(update, rel)); }
    fs.writeFileSync(path.join(update, UPDATE_FILE), JSON.stringify({ app: 'ClaudeDesk', from, to: version, files: Object.fromEntries(changed.map(rel => [rel, manifest.files[rel]])), removed }, null, 1));
    fs.writeFileSync(path.join(update, '怎么安装.txt'), [`Claude Desk ${from} → ${version} 更新包`, '', '方法一（0.25.2 及以后的版本）：不用解压，把这个压缩包放进「下载」文件夹、桌面，或者 Claude Desk 所在的文件夹。打开或切回 Claude Desk 时会自动发现它，倒数 10 秒后关闭、更新并重新打开。', '在 0.25.0 和 0.25.1 上：点左下角齿轮进入设置，点“安装更新包”，选择这个压缩包。', '', '方法二（手动）：先关闭 Claude Desk，把这个压缩包里的所有文件解压到 Claude Desk 所在的文件夹（有 ClaudeDesk.exe 的那个），遇到同名文件选择替换。', ...(removed.length ? ['然后删除这些不再需要的文件：', ...removed] : [])].join('\r\n'));
    const updateZip = path.join(releases, `ClaudeDesk-${from}-to-${version}-update.zip`);
    fs.appendFileSync(path.join(update,'怎么安装.txt'),'\r\n\r\n如果旧版安装更新时报 EPERM 或暂存目录被占用，请先完全退出 Claude Desk，再按方法二手动解压覆盖一次。新版修复后可继续使用内置更新。\r\n');
    console.log('更新包', path.basename(updateZip), mb(createZip(update, updateZip)), `· ${changed.length} 个文件替换，${removed.length} 个删除`);
    for (const rel of changed.slice(0, 20)) console.log('  ' + rel);
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
