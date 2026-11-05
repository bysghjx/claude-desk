// Update packages: a zip holding only the files that changed between two
// versions, plus claude-desk-update.json describing them. Installing one checks
// the package against the running version and every file's hash, then copies the
// files over the app folder after Claude Desk exits and starts it again.
const fs = require('./disk-fs.cjs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const zlib = require('node:zlib');
const { execFile, spawn } = require('node:child_process');

const UPDATE_FILE = 'claude-desk-update.json';
const UPDATER_EXE='ClaudeDesk.Updater.exe';
const SOURCE_FILE='source-zip.json';
// Files that are not part of a release: Electron's crash log, and an update package's own description and instructions.
const SKIP = new Set(['debug.log', UPDATE_FILE, '怎么安装.txt','.claude-desk-update.lock']);

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
const powershell = (args, options = {}) => new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, timeout: 300000, ...options }, (error, stdout, stderr) => error ? reject(Error(String(stderr || error.message).trim().split('\n').slice(-3).join('\n'))) : resolve(stdout)));
// Extracts a zip with the PowerShell that ships with Windows. Paths go in through the environment:
// -Command joins its arguments into one string, which would split paths at spaces.
const extract = (zip, dir) => powershell(['-Command', 'Expand-Archive -LiteralPath $env:CLAUDE_DESK_ZIP -DestinationPath $env:CLAUDE_DESK_DIR -Force'], { env: { ...process.env, CLAUDE_DESK_ZIP: zip, CLAUDE_DESK_DIR: dir } });

// Reads one small file out of a zip without extracting it: the central directory at the end
// lists every entry with its size and where its data starts. Stored and deflated entries only.
function readZipEntry(zip, name, limit = 4 << 20) {
  const fd = fs.openSync(zip, 'r');
  try {
    const size = fs.fstatSync(fd).size, tail = Math.min(size, 65557), end = Buffer.alloc(tail);
    fs.readSync(fd, end, 0, tail, size - tail);
    const eocd = end.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) return null;
    const count = end.readUInt16LE(eocd + 10), dirSize = end.readUInt32LE(eocd + 12), dirStart = end.readUInt32LE(eocd + 16);
    if (dirStart + dirSize > size) return null;
    const dir = Buffer.alloc(dirSize); fs.readSync(fd, dir, 0, dirSize, dirStart);
    for (let at = 0, i = 0; i < count && dir.readUInt32LE(at) === 0x02014b50; i++) {
      const method = dir.readUInt16LE(at + 10), packed = dir.readUInt32LE(at + 20), plain = dir.readUInt32LE(at + 24);
      const nameLength = dir.readUInt16LE(at + 28), skip = nameLength + dir.readUInt16LE(at + 30) + dir.readUInt16LE(at + 32), local = dir.readUInt32LE(at + 42);
      if (dir.toString('utf8', at + 46, at + 46 + nameLength) === name) {
        if (plain > limit || ![0, 8].includes(method)) return null;
        const head = Buffer.alloc(30); fs.readSync(fd, head, 0, 30, local);
        const data = Buffer.alloc(packed); fs.readSync(fd, data, 0, packed, local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28));
        return method ? zlib.inflateRawSync(data) : data;
      }
      at += 46 + skip;
    }
    return null;
  } finally { fs.closeSync(fd); }
}
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
// Looks through a few folders (not their subfolders) for update packages newer than the running
// version. Only zips named like Claude Desk's are opened, and only their description is read.
function findUpdates(dirs, version) {
  const ready = [], other = [], seen = new Set();
  for (const dir of dirs) {
    let names = []; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^claude.?desk.*\.zip$/i.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file); if (!stat.isFile()) continue;
        const raw = readZipEntry(file, UPDATE_FILE); if (!raw) continue;
        const info = JSON.parse(raw.toString('utf8'));
        if (info.app !== 'ClaudeDesk' || !info.to || !newer(info.to, version) || seen.has(info.from + '>' + info.to + '>' + stat.size)) continue;
        seen.add(info.from + '>' + info.to + '>' + stat.size);
        (info.from === version ? ready : other).push({ file, name, dir, from: String(info.from), to: String(info.to), size: stat.size, modified: stat.mtimeMs, files: Object.keys(info.files || {}).length });
      } catch {}
    }
  }
  const order = (a, b) => (newer(b.to, a.to) ? 1 : newer(a.to, b.to) ? -1 : b.modified - a.modified);
  return { ready: ready.sort(order), other: other.sort(order) };
}

function sourceZip(dir) {
  try { const { file, size, modified } = JSON.parse(fs.readFileSync(path.join(dir, SOURCE_FILE), 'utf8')); const stat = fs.statSync(file); return stat.isFile() && /\.zip$/i.test(file) && stat.size === size && stat.mtimeMs === modified ? file : ''; } catch { return ''; }
}
class Updater {
  constructor({ installDir, version, tempRoot = os.tmpdir(),helperPath=path.join(installDir,UPDATER_EXE) }) { Object.assign(this, { installDir, version, tempRoot,helperPath }); this.staged = null; }
  async stage(zip) {
    this.staged=null;
    fs.mkdirSync(this.tempRoot,{recursive:true});
    const dir = fs.mkdtempSync(path.join(this.tempRoot, 'claude-desk-update-'));
    try {
      await extract(zip, dir); this.staged = { dir, ...await verifyUpdate(dir, this.version) };
      // Remember which zip this was, so it can go to the recycle bin once it is installed.
      const stat = fs.statSync(zip); fs.writeFileSync(path.join(dir, SOURCE_FILE), JSON.stringify({ file: path.resolve(zip), size: stat.size, modified: stat.mtimeMs }));
      return this.staged;
    }
    catch (e) {
      try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:4,retryDelay:250});}
      catch(cleanup){throw Error(e.message+'；更新暂存目录未能清理：'+dir+'（'+cleanup.message+'）',{cause:e});}
      throw e;
    }
  }
  // Run a private copy, so even the installed updater can be replaced. Wait for
  // its ready signal before quitting: a spawn/validation failure keeps Desk open.
  async apply({ pid = process.pid, exe = process.execPath, restart = true,waitExe=exe,waitMs,retryMs } = {}) {
    if (!this.staged) throw Error('请先选择更新包');
    if(this.applying)throw Error('独立更新器已经在运行');
    if(!fs.existsSync(this.helperPath))throw Error('缺少 '+UPDATER_EXE+'，请解压完整包恢复更新器');
    this.applying=true;
    try{
      const runnerDir=path.join(this.staged.dir,'.runner');fs.mkdirSync(runnerDir,{recursive:true});const runner=path.join(runnerDir,UPDATER_EXE),ready=path.join(this.staged.dir,'runner.ready');
      fs.rmSync(ready,{force:true});fs.copyFileSync(this.helperPath,runner);
      const args=['--stage',this.staged.dir,'--target',this.installDir,'--from',this.version,'--wait-pid',String(pid),'--wait-exe',waitExe,'--exe',exe,...(restart?[]:['--no-restart'])];
      if(waitMs!==undefined)args.push('--wait-ms',String(waitMs));if(retryMs!==undefined)args.push('--retry-ms',String(retryMs));
      const child=spawn(runner,args,{detached:true,stdio:'ignore',windowsHide:true});let failure;child.once('error',e=>{failure=e;});
      for(let i=0;i<300;i++){
        if(fs.existsSync(ready)){child.unref();return child;}
        if(failure||child.exitCode!==null){let log='';try{log=fs.readFileSync(path.join(this.staged.dir,'install.log'),'utf8');}catch{}throw Error(log||'独立更新器启动失败：'+(failure?.message||child.exitCode));}
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      child.kill();throw Error('独立更新器未能就绪，Claude Desk 尚未退出');
    }catch(e){this.applying=false;throw e;}
  }
  // On the next start: remove staged packages and report an install that failed;
  // a successful one is left in this.installed ("0.25.0 -> 0.25.1"), and the zip it came
  // from in this.installedZip if that file is still there unchanged.
  cleanup() {
    let failed = ''; this.installed = ''; this.installedZip = '';
    let names = []; try { names = fs.readdirSync(this.tempRoot).filter(name => name.startsWith('claude-desk-update-')); } catch {}
    for (const name of names) {
      const dir = path.join(this.tempRoot, name);
      try { const log = fs.readFileSync(path.join(dir, 'install.log'), 'utf8').replace(/^﻿/, '').trim(); if (log.startsWith('failed')) failed = log.replace(/^failed:\s*/, ''); else if (log.startsWith('ok ')) { this.installed = log.slice(3); this.installedZip = sourceZip(dir) || this.installedZip; } } catch {}
      const lock=path.join(dir,'install.lock');if(fs.existsSync(lock)){let fd;try{fd=fs.openSync(lock,'r+');}catch{continue;}finally{if(fd!==undefined)fs.closeSync(fd);}}
      let result;try{result=JSON.parse(fs.readFileSync(path.join(dir,'install-result.json'),'utf8'));}catch{}
      if(result?.rollbackComplete===false||(!result&&fs.existsSync(path.join(dir,'backup-index.json')))){failed=(failed?failed+'；':'上次更新未完成；')+'恢复备份已保留：'+dir;continue;}
      try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:4,retryDelay:250});}
      catch(e){failed||='更新暂存目录未能清理：'+dir+'（'+e.message+'）';}
    }
    return failed;
  }
}
module.exports = { Updater, findUpdates, readZipEntry, newer, manifestOf, diff, verifyUpdate, listFiles, hashFile, safe, extract, UPDATE_FILE, UPDATER_EXE };
