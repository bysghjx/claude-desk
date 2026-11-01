// File checkpoints for rewinding a conversation. Before each turn the project's
// files are recorded in a private git object store under the app's data folder,
// keyed by folder. The project's own .git, index and branches are never touched;
// .gitignore rules still apply, and very large files and dependency folders are skipped.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');

const MAX_FILE = 10 * 1024 * 1024, MAX_FILES = 40000;
const EXCLUDE = ['.git/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '.next/', '.nuxt/', '.cache/', '.gradle/', '.idea/', '.vs/', '*.pyc'];
const IDENTITY = { GIT_AUTHOR_NAME: 'Claude Desk', GIT_AUTHOR_EMAIL: 'checkpoints@claude-desk.local', GIT_COMMITTER_NAME: 'Claude Desk', GIT_COMMITTER_EMAIL: 'checkpoints@claude-desk.local' };

function run(args, { cwd, env, input, timeout = 60000 }) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, env, windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) { error.message = String(stderr || '').trim() || error.message; reject(error); } else resolve(stdout.toString('utf8'));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}
const nulList = text => text.split('\0').filter(Boolean);

class Checkpoints {
  constructor(root) { this.root = root; this.busy = new Map(); }
  key(cwd) { return createHash('sha1').update(path.resolve(cwd).toLowerCase()).digest('hex').slice(0, 16); }
  async git(cwd, args, options = {}) {
    const gitDir = path.join(this.root, this.key(cwd) + '.git');
    const env = { ...process.env, ...IDENTITY, GIT_DIR: gitDir, GIT_WORK_TREE: path.resolve(cwd), GIT_INDEX_FILE: path.join(gitDir, 'index'), GIT_OPTIONAL_LOCKS: '0' };
    delete env.GIT_CEILING_DIRECTORIES;
    if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
      fs.mkdirSync(gitDir, { recursive: true });
      await run(['init', '--quiet'], { cwd, env });
      for (const [key, value] of [['core.autocrlf', 'false'], ['core.longpaths', 'true'], ['core.quotepath', 'false'], ['gc.auto', '0'], ['core.fsmonitor', 'false']]) await run(['config', key, value], { cwd, env });
      fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
      fs.writeFileSync(path.join(gitDir, 'info/exclude'), EXCLUDE.join('\n') + '\n');
    }
    return run(args, { cwd, env, ...options });
  }
  // One git operation per folder at a time (they share an index).
  serial(cwd, task) {
    const key = this.key(cwd), previous = this.busy.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task); this.busy.set(key, next);
    return next.finally(() => { if (this.busy.get(key) === next) this.busy.delete(key); });
  }

  // Records the folder and returns the tree id.
  snapshot(cwd) { return this.serial(cwd, () => this.record(cwd)); }
  async record(cwd) {
    if (!fs.statSync(cwd).isDirectory()) throw Error('项目文件夹不存在');
    const listed = nulList(await this.git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
    const unique = [...new Set(listed)];
    if (unique.length > MAX_FILES) throw Error(`文件超过 ${MAX_FILES} 个，未记录快照`);
    const add = [], drop = [];
    for (const rel of unique) {
      let stat; try { stat = fs.lstatSync(path.join(cwd, rel)); } catch { add.push(rel); continue; } // deleted: `add -A` records the removal
      if (stat.isFile() && stat.size <= MAX_FILE || stat.isSymbolicLink()) add.push(rel); else drop.push(rel);
    }
    if (drop.length) await this.git(cwd, ['update-index', '--force-remove', '-z', '--stdin'], { input: drop.join('\0') + '\0' });
    if (add.length) await this.git(cwd, ['add', '-A', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: add.join('\0') + '\0' }).catch(e => { if (!/ignore-errors|unable to (index|stat)|warning/i.test(e.message)) throw e; });
    const tree = (await this.git(cwd, ['write-tree'])).trim();
    // Chain the trees into commits so they stay reachable.
    const parent = (await this.git(cwd, ['rev-parse', '--verify', '-q', 'refs/heads/checkpoints']).catch(() => '')).trim();
    const commit = (await this.git(cwd, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'checkpoint'])).trim();
    await this.git(cwd, ['update-ref', 'refs/heads/checkpoints', commit]);
    return tree;
  }

  // Files that differ between the checkpoint and the folder now.
  // status: 'M' changed since, 'D' deleted since (will be recreated), 'A' created since (will be removed).
  changes(cwd, tree) {
    return this.serial(cwd, async () => {
      const now = await this.record(cwd);
      const out = nulList(await this.git(cwd, ['diff-tree', '-r', '--no-renames', '--name-status', '-z', tree, now]));
      const list = [];
      for (let i = 0; i < out.length; i += 2) list.push({ status: out[i][0], path: out[i + 1] });
      return { now, files: list };
    });
  }

  // Puts every recorded file back to its state in `tree`. Returns the files touched
  // and the tree of the state just before, so the rewind itself could be undone.
  async restore(cwd, tree) {
    const { now, files } = await this.changes(cwd, tree);
    return this.serial(cwd, async () => {
      const root = path.resolve(cwd), inside = rel => { const file = path.resolve(root, rel); const r = path.relative(root, file); if (!r || r.startsWith('..') || path.isAbsolute(r)) throw Error('路径越界：' + rel); return file; };
      const back = files.filter(f => f.status !== 'A').map(f => f.path);
      if (back.length) await this.git(cwd, ['checkout', tree, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: back.join('\0') + '\0' });
      for (const f of files.filter(f => f.status === 'A')) {
        const file = inside(f.path); try { fs.rmSync(file, { force: true }); } catch {}
        // Remove folders left empty by the deletion, up to the project root.
        for (let dir = path.dirname(file); dir !== root && dir.startsWith(root); dir = path.dirname(dir)) { try { fs.rmdirSync(dir); } catch { break; } }
      }
      return { before: now, files };
    });
  }
}
module.exports = { Checkpoints, MAX_FILE };
