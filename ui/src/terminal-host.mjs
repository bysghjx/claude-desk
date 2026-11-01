// Runs inside the terminal frame. The parent window owns the IPC; this page draws
// the shells with xterm and reports keystrokes and size changes back to it.
const DARK = { background: '#141413', foreground: '#e6e4dd', cursor: '#d97757', selectionBackground: '#d977574d', black: '#1d1d1b', brightBlack: '#6f6e69' };
const LIGHT = { background: '#fbfbfa', foreground: '#1f1f1d', cursor: '#c4552f', selectionBackground: '#c4552f33', black: '#1f1f1d', brightBlack: '#77776f', white: '#5c5c57', brightWhite: '#2b2b28', yellow: '#8a6400', brightYellow: '#7a5a00', brightGreen: '#2f7d32', brightCyan: '#0f6f7f', cyan: '#0f6f7f' };
const light = matchMedia('(prefers-color-scheme: light)');
const theme = () => light.matches ? LIGHT : DARK;
const terms = new Map();
let shown = null, handlers = { input() {}, resize() {}, toggle() {}, copy() {}, paste: async () => '' };

function create(id) {
  const term = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace', fontSize: 12.5, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, theme: theme() });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  const el = document.createElement('div'); el.className = 'term'; el.hidden = id !== shown;
  document.getElementById('terms').append(el); term.open(el);
  term.onData(data => handlers.input(id, data));
  term.onResize(({ cols, rows }) => handlers.resize(id, cols, rows));
  // Ctrl+` hides the panel even while the shell has focus; Ctrl+C copies when text is selected.
  term.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown') return true;
    if (event.ctrlKey && event.code === 'Backquote') { handlers.toggle(); return false; }
    if (event.ctrlKey && event.key.toLowerCase() === 'c' && term.hasSelection()) { handlers.copy(term.getSelection()); term.clearSelection(); return false; }
    if (event.ctrlKey && event.key.toLowerCase() === 'v') { handlers.paste().then(text => text && term.paste(text)); return false; }
    return true;
  });
  const entry = { term, fit, el }; terms.set(id, entry); return entry;
}
const refit = entry => { try { entry.fit.fit(); } catch {} };

window.terminalHost = {
  setHandlers(next) { handlers = { ...handlers, ...next }; },
  show(id) {
    shown = id;
    for (const [key, entry] of terms) entry.el.hidden = key !== id;
    const entry = terms.get(id) || create(id); entry.el.hidden = false;
    requestAnimationFrame(() => { refit(entry); entry.term.focus(); handlers.resize(id, entry.term.cols, entry.term.rows); });
  },
  // Output can arrive before the shell is shown; its terminal is created hidden.
  write(id, data) { (terms.get(id) || create(id)).term.write(data); },
  exited(id, code) { terms.get(id)?.term.write(`\r\n\x1b[90m[进程已退出，代码 ${code}。点「重启」打开新的终端]\x1b[0m\r\n`); },
  dispose(id) { const entry = terms.get(id); if (!entry) return; entry.term.dispose(); entry.el.remove(); terms.delete(id); if (shown === id) shown = null; },
  fit() { const entry = terms.get(shown); if (entry) refit(entry); },
  focus() { terms.get(shown)?.term.focus(); },
  clear() { terms.get(shown)?.term.clear(); }
};
new ResizeObserver(() => window.terminalHost.fit()).observe(document.body);
light.addEventListener('change', () => { for (const entry of terms.values()) entry.term.options.theme = theme(); });
