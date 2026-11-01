// Interactive shells for the terminal panel, on ConPTY via node-pty. Output is
// gathered for a frame before it crosses IPC; every shell is closed with the app.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function defaultShell(env = process.env) {
  if (process.platform !== 'win32') return { file: env.SHELL || '/bin/bash', args: ['-l'] };
  const pwsh = (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'pwsh.exe')).find(file => fs.existsSync(file));
  return { file: pwsh || 'powershell.exe', args: ['-NoLogo'] };
}

class Terminals {
  constructor({ send, spawn }) { this.send = send; this.spawn = spawn || ((...args) => require('node-pty').spawn(...args)); this.list = new Map(); }
  open(cwd, cols = 100, rows = 24) {
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw Error('终端目录不存在：' + cwd);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.CLAUDECODE;
    const shell = defaultShell(env), id = randomUUID();
    const pty = this.spawn(shell.file, shell.args, { name: 'xterm-256color', cols: clamp(cols, 20, 500), rows: clamp(rows, 5, 200), cwd, env, useConpty: true });
    const entry = { pty, cwd: path.resolve(cwd), buffer: '', timer: null };
    const flush = () => { entry.timer = null; if (entry.buffer) { this.send({ type: 'data', id, data: entry.buffer }); entry.buffer = ''; } };
    pty.onData(data => { entry.buffer += data; if (entry.buffer.length > 65536) { clearTimeout(entry.timer); flush(); } else if (!entry.timer) entry.timer = setTimeout(flush, 16); });
    pty.onExit(({ exitCode }) => { clearTimeout(entry.timer); flush(); this.list.delete(id); this.send({ type: 'exit', id, code: exitCode }); });
    this.list.set(id, entry);
    return { id, cwd, shell: path.basename(shell.file) };
  }
  write(id, data) { if (typeof data === 'string' && data.length <= 100000) this.list.get(id)?.pty.write(data); }
  resize(id, cols, rows) { const entry = this.list.get(id); if (entry && Number.isFinite(cols) && Number.isFinite(rows)) try { entry.pty.resize(clamp(cols, 20, 500), clamp(rows, 5, 200)); } catch {} }
  close(id) { const entry = this.list.get(id); if (!entry) return false; this.list.delete(id); clearTimeout(entry.timer); try { entry.pty.kill(); } catch {} return true; }
  // Shells started inside a folder that is about to be deleted (Windows keeps it locked otherwise).
  closeIn(folder) { const root = path.resolve(folder); for (const [id, entry] of this.list) { const rel = path.relative(root, entry.cwd); if (!rel.startsWith('..') && !path.isAbsolute(rel)) this.close(id); } }
  closeAll() { for (const id of [...this.list.keys()]) this.close(id); }
}
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(value) || lo)));
module.exports = { Terminals, defaultShell };
