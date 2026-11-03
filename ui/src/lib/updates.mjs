// Text for update packages found on disk: the card on the About page and the notice in the window.
import { escape } from '../core/dom.mjs';

export const mb = bytes => (bytes / 1048576).toFixed(1) + ' MB';
export const folderOf = (scan, update) => scan.dirs.find(d => d.path === update.dir)?.label || update.dir;
const folders = scan => scan.dirs.map(d => `「${d.label}」`).join('、');

// What was found and what can be done with it; while installing, only the progress.
export function updateCardHtml(scan, { scanning = false, installing = '' } = {}) {
  const card = (dot, title, detail, actions = '') => `<span class="connection-dot${dot}" aria-hidden="true"></span><div class="update-card-text"><strong>${escape(title)}</strong><span>${escape(detail)}</span></div>${actions ? `<div class="update-card-actions">${actions}</div>` : ''}`;
  const button = (action, label, secondary = true) => `<button type="button" data-update-action="${action}" class="${secondary ? 'secondary' : 'primary'}">${label}</button>`;
  if (installing) return card('', installing, '完成后 Claude Desk 会自动重新打开。');
  if (!scan) return card(' idle', scanning ? '正在查找更新包…' : '还没有检查更新包', '');
  const update = scan.ready[0];
  if (update) {
    const detail = `在「${folderOf(scan, update)}」找到 ${update.name}（${mb(update.size)}），替换 ${update.files} 个文件。` + (scan.installable ? '' : '开发版不能安装，请用正式版。');
    return card('', `可以升级到 ${update.to}`, detail, (scan.installable ? button('install', '安装并重启', false) : '') + button('reveal', '打开所在文件夹'));
  }
  const other = scan.other[0];
  const detail = other
    ? `找到的 ${other.name} 是从 ${other.from} 升级用的，当前是 ${scan.version}。需要 ${scan.version} 开头的更新包，或者下载完整包。`
    : `把更新包（ClaudeDesk-…-update.zip）放到${folders(scan)}，这里会自动发现。`;
  return card(' idle', scanning ? '正在查找更新包…' : other ? '找到的更新包不适用于当前版本' : '没有找到新的更新包', detail, button('scan', '重新检查'));
}

// The notice in the window's corner: asking, waiting for running tasks, or counting down.
export function noticeOf(scan, update, { mode, running = 0, seconds = 0, installing = '' }) {
  const title = `Claude Desk ${update.to} 更新包`;
  if (installing) return { title, detail: installing, primary: '', secondary: '' };
  if (mode === 'countdown') return { title, detail: `${seconds} 秒后自动关闭、更新并重新打开。会话记录不受影响。`, primary: '立即安装', secondary: '取消' };
  if (mode === 'wait') return { title, detail: `有 ${running} 个任务在运行，全部结束后自动安装。`, primary: '现在安装', secondary: '以后再说' };
  return { title, detail: `在「${folderOf(scan, update)}」找到（${mb(update.size)}）。安装时 Claude Desk 会关闭并自动重新打开。`, primary: '安装并重启', secondary: '以后再说' };
}
