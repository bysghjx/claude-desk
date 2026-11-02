// The pull request card in the right-hand panel: PR state, review and CI checks
// for the conversation's branch, as reported by the GitHub CLI.
const STATES = { OPEN: '打开', MERGED: '已合并', CLOSED: '已关闭' };
const REVIEWS = { APPROVED: '已批准', CHANGES_REQUESTED: '要求修改', REVIEW_REQUIRED: '等待审查' };

export function prHtml(status, { escape, idle }) {
  if (!status) return '<p class="context-empty">正在读取…</p>';
  if (!status.available) return `<p class="context-empty">${escape(status.reason)}</p>`;
  const pr = status.pr;
  if (!pr) return '<p class="context-empty">当前分支还没有拉取请求。</p>';
  const c = pr.checks, state = pr.draft && pr.state === 'OPEN' ? '草稿' : STATES[pr.state] || pr.state;
  const summary = c.total ? `检查 ${c.total} 项：${c.passed} 通过${c.failed ? ` · <span class="pr-failed">${c.failed} 失败</span>` : ''}${c.pending ? ` · ${c.pending} 进行中` : ''}` : '没有 CI 检查';
  const failing = c.failing.map(f => `<li>${f.url ? `<button type="button" class="pr-link" data-pr-open="${escape(f.url)}">${escape(f.name)}</button>` : escape(f.name)}</li>`).join('');
  return `<div class="pr-card pr-state-${c.failed ? 'failed' : c.pending ? 'pending' : 'passed'}"><button type="button" class="pr-title" data-pr-open="${escape(pr.url)}" title="在浏览器中打开">#${pr.number} ${escape(pr.title)}</button>`
    + `<div class="pr-meta"><span class="manager-tag">${escape(state)}</span>${REVIEWS[pr.review] ? `<span>${REVIEWS[pr.review]}</span>` : ''}<span>${escape(pr.head || '')} → ${escape(pr.base || '')}</span>${pr.mergeable === 'CONFLICTING' ? '<span class="pr-failed">有合并冲突</span>' : ''}</div>`
    + `<div class="pr-checks">${summary}</div>${failing ? `<ul class="pr-failing">${failing}</ul>` : ''}`
    + (pr.state === 'OPEN' && (c.failed || pr.mergeable === 'CONFLICTING') ? `<button type="button" class="secondary small" data-pr-fix ${idle ? '' : 'disabled title="等这一轮结束后再让 Claude 处理"'}>让 Claude 处理</button>` : '')
    + '</div>';
}

// What to ask Claude when checks fail or the branch conflicts.
export function fixPrompt(pr) {
  const parts = [];
  if (pr.checks.failed) parts.push(`CI 检查失败：${pr.checks.failing.map(f => f.name).join('、')}。请用 gh pr checks 和 gh run view --log-failed 查看失败原因并修复`);
  if (pr.mergeable === 'CONFLICTING') parts.push(`分支和 ${pr.base} 有合并冲突，请合并 ${pr.base} 并解决冲突`);
  return `拉取请求 #${pr.number}（${pr.title}）：${parts.join('；')}。改好后提交并推送，再确认检查结果。`;
}
