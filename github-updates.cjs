// GitHub only supplies release metadata and the zip; the existing updater verifies and installs it.
const fs = require('./disk-fs.cjs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { newer, readZipEntry, UPDATE_FILE } = require('./updates.cjs');

const REPOSITORY = 'https://github.com/bysghjx/claude-desk';
const RELEASES = REPOSITORY + '/releases';
const API = 'https://api.github.com/repos/bysghjx/claude-desk/releases/latest';
const CHECK_INTERVAL = 60 * 60 * 1000;
const VERSION = /^v?(\d+\.\d+\.\d+)$/;
const PACKAGE = /^ClaudeDesk-(\d+\.\d+\.\d+)-to-(\d+\.\d+\.\d+)-update\.zip$/;
const DIGEST = /^sha256:([a-f0-9]{64})$/i;

function releaseInfo(release, version) {
  const to = VERSION.exec(release.tag_name)?.[1];
  if (release.draft || release.prerelease || !to) throw Error('GitHub 返回的不是受支持的正式版本');
  const releaseUrl = RELEASES + '/tag/' + encodeURIComponent(release.tag_name);
  if (!newer(to, version)) return { status: 'current', version: to, releaseUrl };
  for (const asset of release.assets || []) {
    const match = PACKAGE.exec(asset.name);
    if (!match || match[1] !== version || match[2] !== to || asset.state !== 'uploaded') continue;
    let url;try { url = new URL(asset.browser_download_url); } catch { continue; }
    if (url.origin !== 'https://github.com' || url.username || url.password || !url.pathname.startsWith('/bysghjx/claude-desk/releases/download/')) continue;
    if (!Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 2 ** 31 || !DIGEST.test(asset.digest || '')) continue;
    return { status: 'available', version: to, releaseUrl, update: { file: 'github:' + asset.id, source: 'github', name: asset.name, from: version, to, size: asset.size, url: url.href, sha256: DIGEST.exec(asset.digest)[1].toLowerCase() } };
  }
  return { status: 'manual', version: to, releaseUrl };
}

class GitHubUpdates {
  constructor({ version, downloadDir, fetch = globalThis.fetch, now = Date.now }) {
    Object.assign(this, { version, downloadDir, fetch, now });
    this.checkedAt = 0; this.result = null; this.checking = null; this.downloading = null;
  }
  async check(force = false) {
    if (this.checking) return this.checking;
    const interval = this.result?.status === 'error' ? 60000 : CHECK_INTERVAL;
    if (!force && this.result && this.now() - this.checkedAt < interval) return this.result;
    this.checking = (async () => {
      try {
        const response = await this.fetch(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClaudeDesk/' + this.version, 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15000) });
        if (response.status === 404) return { status: 'empty', releaseUrl: RELEASES };
        if ([403, 429].includes(response.status)) throw Error('GitHub 暂时限制了检查频率，请稍后重试');
        if (!response.ok) throw Error('GitHub 检查失败（HTTP ' + response.status + '）');
        return releaseInfo(await response.json(), this.version);
      } catch (e) {
        return { status: 'error', message: '无法检查 GitHub 更新：' + e.message, releaseUrl: RELEASES };
      }
    })();
    try { this.result = await this.checking; this.checkedAt = this.now(); return this.result; }
    finally { this.checking = null; }
  }
  async download(update, progress = () => {}) {
    if (this.downloading) throw Error('更新包正在下载，请稍候');
    this.downloading = true;
    let partial, output;
    try {
      fs.mkdirSync(this.downloadDir, { recursive: true });
      // The digest makes the cached file specific to these exact release bytes.
      output = path.join(this.downloadDir, update.sha256 + '-' + update.name);
      if (fs.existsSync(output)) {
        const { hashFile } = require('./updates.cjs');
        if (fs.statSync(output).size === update.size && await hashFile(output) === update.sha256) return output;
        fs.rmSync(output);
      }
      partial = output + '.part';
      const response = await this.fetch(update.url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!response.ok || !response.body) throw Error('下载失败（HTTP ' + response.status + '）');
      let received = 0, notifiedAt = 0;
      const hash = createHash('sha256');
      const counter = new Transform({ transform: (chunk, encoding, done) => {
        received += chunk.length;
        if (received > update.size) return done(Error('更新包大小与 GitHub 记录不一致'));
        hash.update(chunk);
        if (this.now() - notifiedAt >= 250 || received === update.size) { progress({ file: update.file, received, total: update.size }); notifiedAt = this.now(); }
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(partial));
      if (received !== update.size || hash.digest('hex') !== update.sha256) throw Error('更新包下载不完整或 SHA-256 校验失败，请重试');
      const info = JSON.parse(readZipEntry(partial, UPDATE_FILE)?.toString('utf8') || '{}');
      if (info.app !== 'ClaudeDesk' || info.from !== this.version || info.to !== update.to) throw Error('GitHub 更新包内容与发布版本不一致');
      fs.renameSync(partial, output);
      return output;
    } finally {
      try { if (partial) fs.rmSync(partial, { force: true }); }
      finally { this.downloading = false; }
    }
  }
}

module.exports = { GitHubUpdates, releaseInfo, CHECK_INTERVAL, RELEASES };
