// Conversations that run in their own git worktree, like Codex: a new branch is
// checked out in a separate folder under the app's data directory, so Claude's
// edits never touch the main checkout until you merge them back.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');

const git = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', ['--no-optional-locks', '-C', cwd, ...args], { windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) { error.message = String(stderr || '').trim().split('\n').slice(-3).join('\n') || error.message; reject(error); } else resolve(stdout.trim());
  });
});
const slug = text => String(text).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'project';

class Worktrees {
  constructor(root) { this.root = root; }

  // Creates a worktree on a new branch from the project's current commit.
  // Uncommitted changes in the main checkout stay there.
  async create(projectPath) {
    let top; try { top = path.resolve(await git(projectPath, ['rev-parse', '--show-toplevel'])); } catch { throw Error('这个项目不是 Git 仓库，不能使用独立工作树'); }
    const baseCommit = await git(top, ['rev-parse', '--verify', 'HEAD']).catch(() => { throw Error('仓库还没有任何提交，先提交一次再使用独立工作树'); });
    const base = await git(top, ['branch', '--show-current']).catch(() => '');
    // A project opened at a subfolder of the repository works in the same subfolder.
    const sub = (await git(projectPath, ['rev-parse', '--show-prefix'])).replace(/[\/]+$/, '');
    const id = randomBytes(3).toString('hex'), branch = `claude-desk/${id}`;
    const folder = path.join(this.root, `${slug(path.basename(top))}-${id}`);
    fs.mkdirSync(this.root, { recursive: true });
    await git(top, ['worktree', 'add', '-q', '-b', branch, folder, baseCommit]);
    return { path: folder, cwd: sub ? path.join(folder, sub) : folder, branch, base, baseCommit, repo: top, createdAt: Date.now() };
  }

  async status(wt) {
    // A missing folder, or one git no longer knows as a worktree, can only be removed.
    const listed = fs.existsSync(wt.path) && await git(wt.path, ['rev-parse', '--show-toplevel']).then(top => path.resolve(top).toLowerCase() === path.resolve(fs.realpathSync.native(wt.path)).toLowerCase(), () => false);
    if (!listed) return { exists: false };
    const dirty = (await git(wt.path, ['status', '--porcelain'])).split('\n').filter(Boolean).length;
    const ahead = Number(await git(wt.path, ['rev-list', '--count', `${wt.baseCommit}..HEAD`]).catch(() => '0')) || 0;
    const current = await git(wt.repo, ['branch', '--show-current']).catch(() => '');
    const merged = ahead > 0 && await git(wt.repo, ['merge-base', '--is-ancestor', wt.branch, 'HEAD']).then(() => true, () => false);
    return { exists: true, dirty, ahead, merged, target: current };
  }

  // Merges the worktree's commits into whatever branch the main checkout has out.
  async merge(wt) {
    const state = await this.status(wt);
    if (!state.exists) throw Error('工作树文件夹已不存在');
    if (state.dirty) throw Error(`工作树里还有 ${state.dirty} 个未提交的改动，请先在「改动」里提交`);
    if (!state.ahead) throw Error('工作树里还没有新的提交');
    if (state.merged) throw Error(`已经合并到 ${state.target || '当前分支'}`);
    if (!state.target) throw Error('主目录处于分离 HEAD 状态，请先切换到一个分支');
    try { await git(wt.repo, ['merge', '--no-ff', '--no-edit', '-m', `合并 Claude Desk 工作树 ${wt.branch}`, wt.branch]); }
    catch (e) {
      const conflicted = await git(wt.repo, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
      if (conflicted) { await git(wt.repo, ['merge', '--abort']).catch(() => {}); throw Error(`合并到 ${state.target} 有冲突，已取消合并：\n${conflicted.split('\n').slice(0, 6).join('\n')}`); }
      throw Error('合并失败：' + e.message);
    }
    return { target: state.target, commits: state.ahead };
  }

  // Removes the folder; the branch is deleted only when it is merged (or has no commits).
  async remove(wt, { force = false } = {}) {
    const inside = path.relative(this.root, wt.path), ours = inside && !inside.startsWith('..') && !path.isAbsolute(inside);
    for (let attempt = 0; fs.existsSync(wt.path); attempt++) {
      try { await git(wt.repo, ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path]); break; }
      catch (e) {
        // A folder git already unregistered (an earlier attempt Windows could not finish) is ours to delete.
        if (/is not a working tree/.test(e.message) && ours) { fs.rmSync(wt.path, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); break; }
        // Windows releases a folder a moment after the processes using it exit.
        if (attempt < 5 && /permission denied|not empty|being used|invalid argument|failed to (delete|remove)/i.test(e.message)) { await new Promise(r => setTimeout(r, 500)); continue; }
        throw e;
      }
    }
    await git(wt.repo, ['worktree', 'prune']).catch(() => {});
    const branchKept = await git(wt.repo, ['branch', '-d', wt.branch]).then(() => false, () => true);
    return { branchKept };
  }
}
module.exports = { Worktrees };
