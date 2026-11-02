// Pull request and CI status of a project folder's current branch, read with the
// GitHub CLI (gh). Nothing is written: no pushes, comments or merges.
const { execFile } = require('node:child_process');

const FIELDS = 'number,title,url,state,isDraft,headRefName,baseRefName,mergeable,reviewDecision,statusCheckRollup';
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const run = (cwd, args) => new Promise(resolve => execFile('gh', args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })));

// One check as passed / failed / pending. Check runs and commit statuses report differently.
function checkState(c) {
  if (c.__typename === 'StatusContext' || c.state) return FAILED.has(c.state) ? 'failed' : c.state === 'SUCCESS' ? 'passed' : 'pending';
  if (c.status && c.status !== 'COMPLETED') return 'pending';
  return FAILED.has(c.conclusion) ? 'failed' : 'passed';
}
function summarize(rollup) {
  const checks = (Array.isArray(rollup) ? rollup : []).map(c => ({ name: String(c.name || c.context || '检查'), url: String(c.detailsUrl || c.targetUrl || ''), state: checkState(c) }));
  const count = state => checks.filter(c => c.state === state).length;
  return { total: checks.length, passed: count('passed'), failed: count('failed'), pending: count('pending'), failing: checks.filter(c => c.state === 'failed').slice(0, 12) };
}
// Why gh could not answer, in words the user can act on; null when it is just "no PR".
function reason(result) {
  if (result.error?.code === 'ENOENT') return '没有安装 GitHub CLI（gh）。安装后运行 gh auth login 登录，就能在这里看到拉取请求和 CI 状态。';
  const text = result.stderr;
  if (/no pull requests? found/i.test(text)) return null;
  if (/gh auth login|not logged in|authentication/i.test(text)) return 'GitHub CLI 还没有登录。在终端运行 gh auth login 后再刷新。';
  if (/not a git repository|none of the git remotes|no git remotes/i.test(text)) return '这个项目没有 GitHub 远程仓库。';
  return (text.trim().split('\n').pop() || result.error?.message || '读取失败').slice(0, 300);
}

class PullRequests {
  constructor({ exec = run } = {}) { this.exec = exec; }
  async status(cwd) {
    const result = await this.exec(cwd, ['pr', 'view', '--json', FIELDS]);
    if (result.error) { const why = reason(result); return why ? { available: false, reason: why } : { available: true, pr: null }; }
    let data; try { data = JSON.parse(result.stdout); } catch { return { available: false, reason: 'gh 返回的内容无法解析' }; }
    return { available: true, pr: { number: data.number, title: String(data.title || ''), url: String(data.url || ''), state: data.state, draft: Boolean(data.isDraft), head: data.headRefName, base: data.baseRefName, mergeable: data.mergeable, review: data.reviewDecision || '', checks: summarize(data.statusCheckRollup) } };
  }
}
module.exports = { PullRequests, summarize, checkState };
