// Text for the Claude Code environment window: install options and the list of checks.
import { escape } from '../core/dom.mjs';

export const SOURCE_LABELS = { native: '官方原生版', winget: 'WinGet 安装', npm: 'npm 安装', path: '系统 PATH 里的', bundled: 'Claude Desk 内置版，不会自动更新' };

export function versionCheckText(result){
  const local=result.cli?result.cli.version?`当前使用 ${result.cli.version}（${SOURCE_LABELS[result.cli.source]||'本地安装'}）：${result.cli.file}`:`当前 CLI 运行失败：${result.cli.file}`:'没有找到 Claude Code';
  const latest=result.latest?`官方公开版本（npm）：${result.latest}`:'';
  const state={available:'有新版本可用',current:'与官方公开版本一致',ahead:'当前版本高于官方公开版本'}[result.status]||'';
  return[local,latest,state,result.error].filter(Boolean).join('。');
}

// One install command per row: where to run it, the command, copy and run.
export function commandsHtml(commands) {
  return commands.map(c => `<div class="env-command"><span class="env-command-label">${escape(c.label)}</span><code>${escape(c.command)}</code><div class="env-command-actions"><button type="button" class="secondary" data-env-copy="${escape(c.id)}">复制</button><button type="button" class="${c.id === 'powershell' ? 'primary' : 'secondary'}" data-env-run="${escape(c.id)}">运行</button></div></div>`).join('');
}

// The packed copy: offered while it is there, explained once it is unpacked or missing.
export function bundleState(bundle) {
  if (bundle.unpacked && !bundle.available) return { enabled: false, text: `内置版已经解压过（${bundle.unpacked}），压缩文件已删除。`, label: '已解压' };
  if (!bundle.available) return { enabled: false, text: '这个 Claude Desk 里没有内置版。请安装官方版，或重新下载完整包。', label: '不可用' };
  const size = bundle.size ? `约 ${Math.round(bundle.size / 1048576)} MB` : '';
  return { enabled: true, text: `Claude Desk 自带 Claude Code ${bundle.version || ''}，不用联网下载，但不会自动更新。会解压到用户目录下的 .claude-desk\\cli${size ? `（${size}）` : ''}，解压后删除自带的压缩文件。`, label: '解压并使用内置版' };
}

// Each check: a dot (ok, error or optional), what it is, and what to do about it.
export function checksHtml(r) {
  const row = (state, title, detail, action = '') => `<li class="env-check"><span class="connection-dot${state === 'ok' ? '' : state === 'error' ? ' error' : ' idle'}" aria-hidden="true"></span><div><strong>${escape(title)}</strong><span>${escape(detail)}</span></div>${action}</li>`;
  const out = [];
  if (!r.cli) out.push(row('error', 'Claude Code', '没有找到。安装官方版或使用内置版后会自动检测到。'));
  else if (r.cli.broken) out.push(row('error', 'Claude Code', `找到了但运行失败：${r.cli.file}`));
  else out.push(row('ok', 'Claude Code', `${r.cli.version ? r.cli.version + '，' : ''}${SOURCE_LABELS[r.cli.source] || ''}。${r.cli.file}`));
  if (r.login.ok) out.push(row('ok', '登录', `已配置：${r.login.how}`));
  else out.push(row(r.cli ? 'error' : 'idle', '登录', r.cli ? '没有找到登录信息。点「登录」，在打开的窗口里输入 /login。用其他方式配置了服务商的话可以忽略' : '装好 Claude Code 后再登录', r.cli ? '<button type="button" class="secondary" data-env-login>登录</button>' : ''));
  if ('git' in r) {
    out.push(row(r.git ? 'ok' : 'idle', 'Git', r.git ? r.git : '没有安装（建议装）。回退、独立工作树和改动面板需要它：git-scm.com'));
    out.push(row(r.gh ? 'ok' : 'idle', 'GitHub CLI', r.gh ? r.gh : '没有安装（可选）。拉取请求面板需要它：cli.github.com'));
  }
  return out.join('');
}
