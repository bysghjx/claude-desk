// Update packages: a zip holding only the files that changed between two
// versions, plus claude-desk-update.json describing them. Installing one checks
// the package against the running version and every file's hash, then copies the
// files over the app folder after Claude Desk exits and starts it again.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');

const UPDATE_FILE = 'claude-desk-update.json';
// Files that are not part of a release: Electron's crash log, and an update package's own description and instructions.
const SKIP = new Set(['debug.log', UPDATE_FILE, '怎么安装.txt']);

const hashFile = file => new Promise((resolve, reject) => { const hash = createHash('sha256'); fs.createReadStream(file).on('data', d => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject); });
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel)); else if (entry.isFile() && !SKIP.has(rel)) out.push(rel);
  }
  return out.sort();
}
// Every file of an app folder with its hash, paths with forward slashes.
async function manifestOf(dir, version) {
  const files = {};
  for (const rel of listFiles(dir)) files[rel] = await hashFile(path.join(dir, rel));
  return { app: 'ClaudeDesk', version, files };
}
function diff(from, to) {
  return {
    changed: Object.keys(to.files).filter(rel => from.files[rel] !== to.files[rel]),
    removed: Object.keys(from.files).filter(rel => !(rel in to.files))
  };
}
// A path from an update package must stay inside the app folder.
function safe(rel) {
  const normal = path.posix.normalize(String(rel));
  if (!normal || normal.startsWith('../') || normal === '..' || path.isAbsolute(normal) || /^[a-z]:/i.test(normal) || normal.includes('\\')) throw Error('更新包里有不安全的路径：' + rel);
  return normal;
}
// Checks an extracted update package: right app, made for the running version, every file present with its hash.
async function verifyUpdate(dir, currentVersion) {
  let info; try { info = JSON.parse(fs.readFileSync(path.join(dir, UPDATE_FILE), 'utf8')); } catch { throw Error('这不是 Claude Desk 的更新包（缺少 ' + UPDATE_FILE + '）'); }
  if (info.app !== 'ClaudeDesk' || !info.to || !info.files || typeof info.files !== 'object') throw Error('更新包内容不完整');
  if (info.from !== currentVersion) throw Error(`这个更新包是从 ${info.from} 升级到 ${info.to} 用的，当前是 ${currentVersion}。请用对应版本的更新包，或者下载完整包。`);
  let size = 0;
  for (const [rel, hash] of Object.entries(info.files)) {
    const file = path.join(dir, safe(rel));
    if (!fs.existsSync(file)) throw Error('更新包缺少文件：' + rel);
    if (await hashFile(file) !== hash) throw Error('更新包里的文件已损坏：' + rel);
    size += fs.statSync(file).size;
  }
  (info.removed || []).forEach(safe);
  return { from: info.from, to: info.to, files: Object.keys(info.files).length, removed: (info.removed || []).length, size, notes: String(info.notes || '') };
}
// Runs after Claude Desk exits: copy the files (retrying while Windows still holds
// them), delete the removed ones, then start the app again. Paths come from the
// package's JSON, so the script itself stays ASCII.
const APPLY_SCRIPT = String.raw`param([string]$Stage, [string]$Target, [int]$WaitPid, [string]$Exe, [switch]$NoRestart)
$ErrorActionPreference = 'Stop'
$log = Join-Path $Stage 'install.log'
try {
  if ($WaitPid) { Wait-Process -Id $WaitPid -Timeout 120 -ErrorAction SilentlyContinue }
  $info = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $Stage 'claude-desk-update.json') | ConvertFrom-Json
  foreach ($rel in $info.files.PSObject.Properties.Name) {
    $src = Join-Path $Stage $rel; $dst = Join-Path $Target $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
    for ($i = 0; ; $i++) { try { Copy-Item -LiteralPath $src -Destination $dst -Force; break } catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 500 } }
  }
  foreach ($rel in @($info.removed)) { if ($rel) { $dst = Join-Path $Target $rel; if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force } } }
  "ok $($info.from) -> $($info.to)" | Out-File -Encoding UTF8 $log
} catch { "failed: $_" | Out-File -Encoding UTF8 $log }
if (-not $NoRestart) { Start-Process -FilePath $Exe }
`;
const powershell = (args, options = {}) => new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, timeout: 300000, ...options }, (error, stdout, stderr) => error ? reject(Error(String(stderr || error.message).trim().split('\n').slice(-3).join('\n'))) : resolve(stdout)));
// Extracts a zip with the PowerShell that ships with Windows. Paths go in through the environment:
// -Command joins its arguments into one string, which would split paths at spaces.
const extract = (zip, dir) => powershell(['-Command', 'Expand-Archive -LiteralPath $env:CLAUDE_DESK_ZIP -DestinationPath $env:CLAUDE_DESK_DIR -Force'], { env: { ...process.env, CLAUDE_DESK_ZIP: zip, CLAUDE_DESK_DIR: dir } });

class Updater {
  constructor({ installDir, version, tempRoot = os.tmpdir() }) { Object.assign(this, { installDir, version, tempRoot }); this.staged = null; }
  async stage(zip) {
    const dir = path.join(this.tempRoot, 'claude-desk-update-' + randomBytes(4).toString('hex'));
    try { await extract(zip, dir); this.staged = { dir, ...await verifyUpdate(dir, this.version) }; return this.staged; }
    catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  }
  // Starts the installer and leaves it waiting for this process; the caller quits the app.
  // PowerShell started straight from a detached process exits at once, and one started
  // as an ordinary child ends with the app, so `start /b` from cmd launches it on its own.
  apply({ pid = process.pid, exe = process.execPath, restart = true } = {}) {
    if (!this.staged) throw Error('请先选择更新包');
    const script = path.join(this.staged.dir, 'apply-update.ps1');
    fs.writeFileSync(script, APPLY_SCRIPT);
    const quote = value => `"${value}"`;
    const command = ['start "" /b powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File', quote(script), '-Stage', quote(this.staged.dir), '-Target', quote(this.installDir), '-WaitPid', String(pid), '-Exe', quote(exe), ...(restart ? [] : ['-NoRestart'])].join(' ');
    const child = spawn('cmd.exe', ['/d', '/c', command], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.unref(); return child;
  }
  // On the next start: remove staged packages and report an install that failed.
  cleanup() {
    let failed = '';
    let names = []; try { names = fs.readdirSync(this.tempRoot).filter(name => name.startsWith('claude-desk-update-')); } catch {}
    for (const name of names) {
      const dir = path.join(this.tempRoot, name);
      try { const log = fs.readFileSync(path.join(dir, 'install.log'), 'utf8').replace(/^﻿/, '').trim(); if (log.startsWith('failed')) failed = log.replace(/^failed:\s*/, ''); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return failed;
  }
}
module.exports = { Updater, manifestOf, diff, verifyUpdate, listFiles, hashFile, safe, extract, UPDATE_FILE, APPLY_SCRIPT };
