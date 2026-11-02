// The 浏览器 panel: one page per conversation in a <webview>. Claude opens and
// drives pages through the desk tools (preview.cjs in the main process); you can
// also type an address. Pages of other conversations stay loaded off-screen, so
// Claude can keep working with them while you look at something else.
import { $ } from '../core/dom.mjs';
import { guarded } from '../core/ui.mjs';

const PAGE_URL = /^(https?:\/\/|about:blank$)/i;
// A bare host or host:port typed in the address bar means a local http page.
const normalize = text => { text = text.trim(); if (!text) return ''; if (/^[a-z]+:\/\//i.test(text) || text === 'about:blank') return text; return (/^(localhost|127\.|\[::1\]|\d+$)/.test(text) ? 'http://' : 'https://') + (/^\d+$/.test(text) ? 'localhost:' + text : text); };

export function createPreviewPanel({ store, api, toast, desk, terminal }) {
  const panel = $('#preview-panel'), views = $('#preview-views'), address = $('#preview-url'), toggleButton = $('#toggle-preview'), empty = $('#preview-empty');
  const pages = new Map(); // thread id -> <webview>

  function page(threadId, url) {
    let view = pages.get(threadId);
    if (view) { if (url && view.getURL?.() !== url) view.loadURL(url).catch(() => {}); return view; }
    view = document.createElement('webview');
    view.setAttribute('partition', 'persist:claude-desk-preview');
    view.setAttribute('webpreferences', 'backgroundThrottling=no');
    view.src = url || 'about:blank';
    view.className = 'preview-view';
    view.addEventListener('dom-ready', () => { if (!view.dataset.attached) { view.dataset.attached = '1'; api('preview:attach', threadId, view.getWebContentsId()).catch(e => toast(e.message)); } });
    const sync = () => { if (store.selected === threadId) address.value = view.getURL(); };
    view.addEventListener('did-navigate', sync); view.addEventListener('did-navigate-in-page', sync);
    view.addEventListener('did-fail-load', event => { if (event.isMainFrame && event.errorCode !== -3 && store.selected === threadId) toast(`页面打不开：${event.errorDescription || event.errorCode}`); });
    views.append(view); pages.set(threadId, view);
    return view;
  }

  // The current conversation's page is in front; the rest stay rendered behind it so screenshots still work.
  function showCurrent() {
    const view = pages.get(store.selected);
    for (const [id, other] of pages) other.classList.toggle('behind', id !== store.selected);
    empty.hidden = Boolean(view);
    address.value = view?.getURL?.() || '';
    address.disabled = !store.selected;
  }

  function toggle(open = panel.hidden) {
    if (open) terminal.toggle(false);
    panel.hidden = !open; document.body.classList.toggle('preview-open', open); toggleButton.classList.toggle('active', open); toggleButton.setAttribute('aria-pressed', String(open));
    if (open) showCurrent();
  }

  address.addEventListener('keydown', guarded(toast, async event => {
    if (event.key !== 'Enter' || !store.selected) return;
    const url = normalize(address.value); if (!PAGE_URL.test(url)) return toast('只能打开 http:// 或 https:// 地址');
    page(store.selected, url); showCurrent();
  }));
  $('#preview-back').addEventListener('click', () => { const view = pages.get(store.selected); if (view?.canGoBack()) view.goBack(); });
  $('#preview-reload').addEventListener('click', () => pages.get(store.selected)?.reload());
  $('#preview-hide').addEventListener('click', () => toggle(false));
  toggleButton.addEventListener('click', () => toggle());

  // Claude opened a page: create it, and show the panel when it is for the conversation on screen.
  desk.onPreview?.(event => {
    if (event.type !== 'open') return;
    page(event.threadId, event.url);
    if (event.threadId === store.selected) { if (panel.hidden) toggle(true); else showCurrent(); }
    else showCurrent();
  });
  // The terminal and the browser share the right side; opening the terminal hides this panel.
  new MutationObserver(() => { if (!$('#terminal-panel').hidden && !panel.hidden) toggle(false); }).observe($('#terminal-panel'), { attributes: true, attributeFilter: ['hidden'] });
  store.on('select', showCurrent);
  store.on('removed', id => { pages.get(id)?.remove(); pages.delete(id); });

  // Dragging the left edge changes the panel width, like the terminal.
  const handle = $('#preview-resize');
  handle.addEventListener('pointerdown', event => { handle.setPointerCapture(event.pointerId); handle.classList.add('dragging'); views.style.pointerEvents = 'none'; });
  handle.addEventListener('pointermove', event => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const area = document.querySelector('.main-area').getBoundingClientRect();
    document.documentElement.style.setProperty('--preview-width', Math.max(360, Math.min(area.width - 420, area.right - event.clientX)) + 'px');
  });
  handle.addEventListener('pointerup', event => { handle.releasePointerCapture(event.pointerId); handle.classList.remove('dragging'); views.style.pointerEvents = ''; });
  return { toggle };
}
