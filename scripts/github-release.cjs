// GitHub Actions: retain file manifests between runners so the next release can build a delta.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { safe, newer, hashFile } = require('../updates.cjs');
const { releaseInfo } = require('../github-updates.cjs');
const source = path.resolve(__dirname, '..'), releasesDir = path.resolve(source, '../releases');
const version = require('../package.json').version;
const tagPattern = /^v(\d+\.\d+\.\d+)$/;
const gh = args => execFileSync('gh', args, { cwd: source, encoding: 'utf8', windowsHide: true });

function validateVersion(tag, pkg, lock) {
  if (!tagPattern.test(tag) || tag !== 'v' + pkg.version || lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw Error('版本标签、package.json 与 package-lock.json 必须一致（vX.Y.Z）');
}
function previousRelease(releases, current) {
  return releases.filter(r => !r.draft && !r.prerelease && tagPattern.test(r.tag_name) && newer(current, r.tag_name.slice(1)))
    .sort((a, b) => newer(a.tag_name.slice(1), b.tag_name.slice(1)) ? -1 : 1)[0];
}
function validateManifest(manifest, expected) {
  if (manifest.app !== 'ClaudeDesk' || manifest.version !== expected || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) || !Object.keys(manifest.files).length) throw Error('上一版本的文件清单无效');
  for (const [rel, hash] of Object.entries(manifest.files)) { safe(rel); if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('文件清单的 SHA-256 无效'); }
}

async function run(mode) {
  const tag = process.env.RELEASE_TAG, repo = process.env.GITHUB_REPOSITORY;
  validateVersion(tag, require('../package.json'), require('../package-lock.json'));
  if (repo !== 'bysghjx/claude-desk') throw Error('发布目标必须是 bysghjx/claude-desk');
  const commit = ref => execFileSync('git', ['rev-parse', '--verify', ref], { cwd: source, encoding: 'utf8' }).trim();
  if (commit('refs/tags/' + tag + '^{commit}') !== commit('HEAD')) throw Error('版本标签没有指向当前构建的提交');
  const releases = JSON.parse(gh(['api', 'repos/' + repo + '/releases?per_page=100', '--paginate', '--slurp'])).flat();
  const existing = releases.find(r => r.tag_name === tag);
  if (existing && !existing.draft) throw Error('这个版本已经发布，请增加版本号；不会覆盖已发布的文件');
  if (releases.some(r => !r.draft && !r.prerelease && tagPattern.test(r.tag_name) && newer(r.tag_name.slice(1), version))) throw Error('不能把比现有正式版更旧的版本发布为最新版');
  const base = previousRelease(releases, version), from = base?.tag_name.slice(1);
  const manifests = path.join(releasesDir, 'manifests');
  if (mode === 'prepare') {
    fs.mkdirSync(manifests, { recursive: true });
    if (!base) return console.log('首次发布：只生成完整包，并上传文件清单供下次生成增量包');
    if (!base.assets.some(a => a.name === from + '.json')) throw Error('上一正式版缺少文件清单 ' + from + '.json，请补齐后重试');
    gh(['release', 'download', base.tag_name, '--repo', repo, '--pattern', from + '.json', '--dir', manifests, '--clobber']);
    validateManifest(JSON.parse(fs.readFileSync(path.join(manifests, from + '.json'), 'utf8')), from);
    return console.log('增量包基准版本：' + from);
  }
  if (mode !== 'publish') throw Error('Usage: node scripts/github-release.cjs prepare|publish');
  const full = path.join(releasesDir, 'ClaudeDesk-' + version + '-win-x64.zip'), manifest = path.join(manifests, version + '.json');
  const assets = [full, manifest];
  validateManifest(JSON.parse(fs.readFileSync(manifest, 'utf8')), version);
  if (from) assets.push(path.join(releasesDir, 'ClaudeDesk-' + from + '-to-' + version + '-update.zip'));
  for (const file of assets) if (!fs.statSync(file).size) throw Error('发布文件为空：' + file);
  const notes = path.join(releasesDir, 'release-notes.md');
  fs.writeFileSync(notes, '# Claude Desk ' + version + '\n\n- 完整包：解压后运行 ClaudeDesk.exe。\n' + (from ? '- 增量包：从 ' + from + ' 升级到 ' + version + '；支持 GitHub 在线更新的客户端会自动检测。\n' : '- 首次发布仅提供完整包；安装后可接收后续在线更新。\n') + '- 较旧版本没有匹配的增量包时，请下载完整包。\n- JSON 文件是下次构建增量包使用的文件清单，无需手动安装。\n');
  if (!existing) gh(['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--title', 'Claude Desk ' + version, '--notes-file', notes]);
  gh(['release', 'upload', tag, ...assets, '--repo', repo, '--clobber']);
  // Expose the release only after GitHub has processed every asset, including its digest.
  const uploaded = JSON.parse(gh(['api', 'repos/' + repo + '/releases/tags/' + tag]));
  for (const file of assets) {
    const asset = uploaded.assets.find(a => a.name === path.basename(file));
    if (!asset || asset.state !== 'uploaded' || asset.size !== fs.statSync(file).size || asset.digest !== 'sha256:' + await hashFile(file)) throw Error('GitHub 文件尚未准备好或校验不符，Release 保持草稿，请重试：' + file);
  }
  if (from && releaseInfo({ ...uploaded, draft: false }, from).status !== 'available') throw Error('发布的更新包无法被客户端识别，Release 保持草稿');
  gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest', '--title', 'Claude Desk ' + version, '--notes-file', notes]);
  console.log('Published ' + tag);
}
if (require.main === module) run(process.argv[2]).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { validateVersion, previousRelease, validateManifest };
