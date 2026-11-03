// The Claude Code environment window: opens by itself when Claude Code is missing and offers the
// official installer or the copy inside Claude Desk, then checks again until it is found.
import { $, setHtml, setText } from '../core/dom.mjs';
import { guarded } from '../core/ui.mjs';
import { commandsHtml, bundleState, checksHtml } from '../lib/env.mjs';

const POLL = 4000;

export function createEnv({ store, api, toast }) {
  const dialog = $('#env-dialog');
  let result = null, timer = null, busy = false;

  // The connection line at the bottom of the sidebar.
  function showProvider(p) {
    store.state.provider = p;
    setText($('#connection-label'), p.cliPath ? p.host : '没有找到 Claude Code');
    $('#connection-dot').classList.toggle('error', !p.cliPath);
  }
  function render() {
    if (!result) return;
    const missing = !result.cli;
    $('#env-setup').hidden = !missing;
    setText($('#env-subtitle'), missing ? '这台电脑上还没有找到 Claude Code' : result.cli.broken ? 'Claude Code 运行失败' : !result.login.ok ? '还需要登录' : '一切就绪');
    setHtml($('#env-commands'), commandsHtml(result.commands));
    const b = bundleState(result.bundle);
    setText($('#env-bundle-desc'), b.text); setText($('#env-extract'), b.label); $('#env-extract').disabled = !b.enabled || busy;
    setHtml($('#env-list'), checksHtml(result));
  }
  async function check(quick = false) {
    const r = await api('env:check', { quick });
    showProvider(r.provider);
    // Found while waiting: run the full check once for the version, login and Git.
    if (quick && r.cli) return check(false);
    const wasMissing = result && !result.cli;
    result = quick && result && 'git' in result ? { ...r, git: result.git, gh: result.gh } : r;
    if (wasMissing && r.cli) { toast('已找到 Claude Code'); status(`已找到 Claude Code ${r.cli.version || ''}。`); }
    render(); poll();
  }
  // While the window is open and Claude Code is still missing, look again every few seconds.
  function poll() {
    clearTimeout(timer);
    if (dialog.open && !result?.cli) timer = setTimeout(() => check(true).catch(() => poll()), POLL);
  }
  const status = text => setText($('#env-status'), text);

  async function open() {
    status(''); if (!dialog.open) dialog.showModal();
    if (!result) setHtml($('#env-list'), '<li class="env-check"><span class="connection-dot idle"></span><div><strong>正在检测…</strong></div></li>');
    await check();
  }

  $('#env-commands').addEventListener('click', guarded(toast, async event => {
    const copy = event.target.closest('[data-env-copy]'), runId = event.target.closest('[data-env-run]')?.dataset.envRun;
    if (copy) { await api('copy', result.commands.find(c => c.id === copy.dataset.envCopy).command); status('已复制。粘贴到对应的终端里运行，装好后这里会自动检测到。'); }
    if (runId) { await api('cli:install', runId); status('已打开安装窗口。看到安装完成后回到这里，会自动检测到。'); poll(); }
  }));
  $('#env-extract').addEventListener('click', guarded(toast, async () => {
    busy = true; render(); status('正在解压内置版…');
    let r;
    try { r = await api('cli:extract'); } catch (e) { status(''); throw e; } finally { busy = false; render(); }
    await check(); status(`已解压并改用内置的 Claude Code ${r.version}${r.removed ? '，自带的压缩文件已删除' : ''}。`);
  }));
  $('#env-list').addEventListener('click', guarded(toast, async event => {
    if (event.target.closest('[data-env-login]')) { await api('cli:open'); status('已打开 Claude Code。输入 /login 按提示登录，完成后点「重新检测」。'); }
  }));
  $('#env-recheck').addEventListener('click', guarded(toast, async () => { const button = $('#env-recheck'); button.disabled = true; status('正在检测…'); try { await check(); status('已重新检测。'); } finally { button.disabled = false; } }));
  for (const id of ['#close-env', '#env-done']) $(id).addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => clearTimeout(timer));
  window.addEventListener('focus', () => { if (dialog.open) check().catch(() => {}); });
  $('#connection-button').addEventListener('click', guarded(toast, open));

  return { open, showProvider };
}
