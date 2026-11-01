// The terminal panel under the conversation, like Codex: one shell per workspace
// (the project folder, or the conversation's worktree), kept alive while you switch.
// Shells are drawn in a frame (see ui/terminal.html); this side owns the IPC.
import { $, setText } from '../core/dom.mjs';
import { guarded } from '../core/ui.mjs';

export function createTerminalPanel({ store, api, toast, desk }) {
  const panel = $('#terminal-panel'), frame = $('#terminal-frame'), toggleButton = $('#toggle-terminal');
  const sessions = new Map(); // workspace key -> { id, cwd, shell }
  let host = null, loading = null, current = null;

  function loadHost() {
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      frame.addEventListener('load', () => {
        host = frame.contentWindow?.terminalHost;
        if (!host) return reject(Error('终端页面加载失败'));
        host.setHandlers({
          input: (id, data) => api('terminal:write', id, data).catch(() => {}),
          resize: (id, cols, rows) => api('terminal:resize', id, cols, rows).catch(() => {}),
          toggle: () => toggle(false),
          copy: text => api('copy', text).catch(() => {}),
          paste: () => api('clipboard:read').catch(() => '')
        });
        resolve(host);
      }, { once: true });
      frame.src = 'terminal.html';
    });
    return loading;
  }
  const keyOf = workspace => workspace.id + '|' + workspace.path;

  async function showCurrent() {
    const workspace = store.workspace();
    if (!workspace) { current = null; setText($('#terminal-cwd'), '先在主页选择一个项目'); return; }
    await loadHost();
    const key = keyOf(workspace);
    let session = sessions.get(key);
    if (!session) { session = await api('terminal:open', workspace.id); sessions.set(key, session); }
    current = key;
    setText($('#terminal-cwd'), session.cwd); setText($('#terminal-shell'), session.shell);
    host.show(session.id);
  }

  function toggle(open = panel.hidden) {
    panel.hidden = !open; document.body.classList.toggle('terminal-open', open); toggleButton.classList.toggle('active', open); toggleButton.setAttribute('aria-pressed', String(open));
    if (open) showCurrent().catch(e => toast(e.message));
    else $('#prompt').focus();
  }

  async function restart() {
    const session = current && sessions.get(current);
    if (session) { sessions.delete(current); await api('terminal:close', session.id); host?.dispose(session.id); }
    await showCurrent();
  }

  // Dragging the left edge changes the column width, like the sub-agent column.
  const handle = $('#terminal-resize');
  handle.addEventListener('pointerdown', event => { handle.setPointerCapture(event.pointerId); handle.classList.add('dragging'); frame.style.pointerEvents = 'none'; });
  handle.addEventListener('pointermove', event => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const area = document.querySelector('.main-area').getBoundingClientRect();
    document.documentElement.style.setProperty('--terminal-width', Math.max(320, Math.min(area.width - 420, area.right - event.clientX)) + 'px');
  });
  handle.addEventListener('pointerup', event => { handle.releasePointerCapture(event.pointerId); handle.classList.remove('dragging'); frame.style.pointerEvents = ''; host?.fit(); });

  desk.onTerminal?.(event => {
    if (event.type === 'data') host?.write(event.id, event.data);
    if (event.type === 'exit') { host?.exited(event.id, event.code); for (const [key, s] of sessions) if (s.id === event.id) sessions.delete(key); }
  });
  toggleButton.addEventListener('click', () => toggle());
  $('#terminal-restart').addEventListener('click', guarded(toast, restart));
  $('#terminal-clear').addEventListener('click', () => { host?.clear(); host?.focus(); });
  $('#terminal-hide').addEventListener('click', () => toggle(false));
  document.addEventListener('keydown', event => { if (event.ctrlKey && event.code === 'Backquote') { event.preventDefault(); toggle(); } });
  store.on('select', () => { if (!panel.hidden) showCurrent().catch(e => toast(e.message)); });
  return { toggle };
}
