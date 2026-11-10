// Finds the Claude Code CLI and checks what else Claude Desk needs. The official install comes
// first: it keeps itself updated. Claude Desk also carries a copy, compressed and unused, that is
// unpacked to ~/.claude-desk/cli only when asked; the compressed file is deleted afterwards.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const {validVersion,compareVersions}=require('./update-version.cjs');

const BUNDLE = 'claude.exe.zst', BUNDLE_INFO = 'claude-code.json';
// The official installers, written out for the setup window.
const INSTALL_COMMANDS = [
  { id: 'powershell', label: 'PowerShell', command: 'irm https://claude.ai/install.ps1 | iex' },
  { id: 'cmd', label: '命令提示符（CMD）', command: 'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd' },
  { id: 'winget', label: 'WinGet', command: 'winget install Anthropic.ClaudeCode' }
];
const LOGIN_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

const hashFile = file => new Promise((resolve, reject) => { const hash = createHash('sha256'); fs.createReadStream(file).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject); });
const run = (file, args, timeout = 15000) => new Promise(resolve => execFile(file, args, { windowsHide: true, timeout }, (error, stdout) => resolve(error ? null : String(stdout).trim())));
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

class ClaudeCli {
  // home: the user's folder; root: ~/.claude-desk; bundleDir: where the compressed copy ships;
  // devExe: an uncompressed copy to use instead while developing (never deleted).
  constructor({ home, root, bundleDir = '', devExe = '', env = process.env, runner = run, fetch = globalThis.fetch }) {
    Object.assign(this, { home, root, bundleDir, devExe, env, runner, fetch });
    this.extraDirs = [];
  }
  get ownDir() { return path.join(this.root, 'cli'); }
  get ownExe() { return path.join(this.ownDir, 'claude.exe'); }

  // Where an install can be, in order. The installers add their folder to PATH, but Claude Desk keeps
  // the PATH it started with, so the usual folders are checked directly as well.
  candidates() {
    const local = this.env.LOCALAPPDATA || path.join(this.home, 'AppData/Local'), roaming = this.env.APPDATA || path.join(this.home, 'AppData/Roaming');
    const list = [
      { file: path.join(this.home, '.local/bin/claude.exe'), source: 'native' },
      { file: path.join(this.home, '.claude/bin/claude.exe'), source: 'native' },
      { file: path.join(local, 'Microsoft/WinGet/Links/claude.exe'), source: 'winget' },
      { file: path.join(roaming, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'), source: 'npm' }
    ];
    for (const dir of [...(this.env.PATH || '').split(path.delimiter), ...this.extraDirs]) if (dir) list.push({ file: path.join(dir, 'claude.exe'), source: 'path' });
    list.push({ file: this.ownExe, source: 'bundled' });
    return list;
  }
  find() { return this.candidates().find(c => fs.existsSync(c.file)) || null; }

  // PATH as Windows has it now, so an install made after Claude Desk started is found too.
  async refreshPath() {
    if (process.platform !== 'win32') return;
    const dirs = [];
    for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
      const out = await this.runner('reg.exe', ['query', key, '/v', 'Path'], 5000);
      const value = out && out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)?.[1];
      if (value) dirs.push(...value.split(';').map(d => d.trim().replace(/%([^%]+)%/g, (m, name) => this.env[name] ?? m)).filter(Boolean));
    }
    this.extraDirs = dirs;
  }

  // The copy inside Claude Desk: what version it is, and whether it was unpacked already.
  bundle() {
    const info = readJson(path.join(this.bundleDir, BUNDLE_INFO)), own = readJson(path.join(this.ownDir, BUNDLE_INFO));
    const file = this.bundleDir && fs.existsSync(path.join(this.bundleDir, BUNDLE)) ? path.join(this.bundleDir, BUNDLE) : this.devExe && fs.existsSync(this.devExe) ? this.devExe : '';
    return { available: Boolean(file && (info || this.devExe)), file, version: info?.version || own?.version || '', size: info?.size || 0, unpacked: fs.existsSync(this.ownExe) ? own?.version || '未知版本' : '' };
  }

  // Unpacks the copy to ~/.claude-desk/cli, checks it against the hash it was packed with, then
  // deletes the compressed file (not the uncompressed one used while developing).
  async extract() {
    const b = this.bundle();
    if (!b.available) throw Error(b.unpacked ? `内置版已经解压过了（${b.unpacked}）` : '这个 Claude Desk 里没有内置版 Claude Code');
    const info = readJson(path.join(this.bundleDir, BUNDLE_INFO)) || { version: '开发版', sha256: '' };
    fs.mkdirSync(this.ownDir, { recursive: true });
    const temp = this.ownExe + '.partial';
    try {
      if (b.file.endsWith('.zst')) await pipeline(fs.createReadStream(b.file), zlib.createZstdDecompress(), fs.createWriteStream(temp));
      else fs.copyFileSync(b.file, temp);
      if (info.sha256 && await hashFile(temp) !== info.sha256) throw Error('内置版解压后校验不通过，压缩文件可能已损坏，请重新下载完整包');
      fs.renameSync(temp, this.ownExe);
    } catch (e) { fs.rmSync(temp, { force: true }); throw e; }
    fs.writeFileSync(path.join(this.ownDir, BUNDLE_INFO), JSON.stringify({ version: info.version, sha256: info.sha256 }));
    let removed = false;
    if (b.file.endsWith('.zst')) { try { fs.rmSync(b.file); fs.rmSync(path.join(this.bundleDir, BUNDLE_INFO), { force: true }); removed = true; } catch {} }
    return { file: this.ownExe, version: info.version, removed };
  }
  // An update that brings a newer copy replaces one that was already unpacked; nothing happens otherwise.
  async refreshBundled() {
    const info = readJson(path.join(this.bundleDir, BUNDLE_INFO)), own = readJson(path.join(this.ownDir, BUNDLE_INFO));
    if (!info || !own || !fs.existsSync(this.ownExe) || !fs.existsSync(path.join(this.bundleDir, BUNDLE)) || info.sha256 === own.sha256) return null;
    return this.extract();
  }

  // Signed in: a key or provider in the environment or Claude's settings, or a saved account login.
  login() {
    const settings = readJson(path.join(this.home, '.claude/settings.json')) || {}, env = settings.env || {};
    if (LOGIN_KEYS.some(k => this.env[k] || env[k]) || settings.apiKeyHelper) return { ok: true, how: 'API Key 或第三方服务商' };
    if (fs.existsSync(path.join(this.home, '.claude/.credentials.json'))) return { ok: true, how: 'Claude 账号' };
    return { ok: false, how: '' };
  }
  async checkVersion(){
    await this.refreshPath();const found=this.find();
    const output=found&&await this.runner(found.file,['--version']);
    const version=output?output.replace(/\s*\(Claude Code\)\s*$/,'').trim():'';
    const result={cli:found?{...found,version,broken:!version}:null,latest:'',status:'unknown',checkedAt:Date.now(),error:''};
    try{
      const response=await this.fetch('https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest',{signal:AbortSignal.timeout(15000),redirect:'error'});
      if(!response.ok)throw Error('HTTP '+response.status);
      const data=await response.json();if(!validVersion(data.version))throw Error('官方版本信息无效');
      result.latest=data.version;
      if(validVersion(version)){const order=compareVersions(version,data.version);result.status=order<0?'available':order===0?'current':'ahead';}
    }catch{result.error='无法读取官方公开版本，请检查网络后重试';}
    return result;
  }
  // Everything the setup window shows. quick skips running programs, for polling while it is open.
  async check({ quick = false } = {}) {
    await this.refreshPath();
    const found = this.find();
    const result = { cli: found ? { file: found.file, source: found.source, version: '' } : null, bundle: this.bundle(), login: this.login(), commands: INSTALL_COMMANDS };
    if (quick) return result;
    const version = found && await this.runner(found.file, ['--version']);
    if (found) { result.cli.version = version ? version.replace(/\s*\(Claude Code\)\s*$/, '') : ''; result.cli.broken = !version; }
    const [git, gh] = await Promise.all([this.runner('git', ['--version'], 8000), this.runner('gh', ['--version'], 8000)]);
    result.git = git ? git.replace(/^git version\s*/, '').replace(/\.windows.*$/, '') : '';
    result.gh = gh ? (gh.match(/gh version (\S+)/)?.[1] || '已安装') : '';
    return result;
  }
}
module.exports = { ClaudeCli, INSTALL_COMMANDS, BUNDLE, BUNDLE_INFO, hashFile };
