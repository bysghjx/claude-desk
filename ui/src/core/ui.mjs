// Toasts, the shared confirmation dialog and the image viewer.
import { $, escape } from './dom.mjs';

export function createToast(node = $('#toast')) {
  let timer;
  return text => { node.textContent = String(text).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); node.hidden = false; clearTimeout(timer); timer = setTimeout(() => { node.hidden = true; }, 5500); };
}

// Styled confirmation: Cancel has focus by default; Esc or clicking outside cancels.
export function createConfirm(get = $) {
  const dialog = get('#delete-dialog');
  get('#delete-cancel').onclick = () => dialog.close('cancel');
  get('#delete-confirm').onclick = () => dialog.close('confirm');
  dialog.onclick = event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close('cancel');
  };
  return function confirm({ title, description, preview, label, kind = 'danger' }) {
    if (dialog.open) return Promise.resolve(false);
    dialog.classList.toggle('neutral-dialog', kind === 'neutral');
    get('#delete-title').textContent = title; get('#delete-description').textContent = description;
    get('#delete-preview').textContent = preview || ''; get('#delete-preview').hidden = !preview;
    get('#delete-confirm').textContent = label; dialog.returnValue = '';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal(); get('#delete-cancel').focus();
    });
  };
}

// Wraps an async handler so failures surface as a toast instead of being lost.
export const guarded = (toast, action) => (...args) => Promise.resolve().then(() => action(...args)).catch(e => toast(e?.message || String(e)));

// Shows an image full size over the window; a click or Esc closes it.
export function showImage(src, name = '') {
  if (!src) return;
  const box = document.createElement('div'); box.className = 'image-viewer'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', name || '图片');
  box.innerHTML = `<img src="${escape(src)}" alt="${escape(name)}">${name ? `<span class="image-viewer-name">${escape(name)}</span>` : ''}`;
  const close = () => { box.remove(); document.removeEventListener('keydown', key, true); };
  const key = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
  box.onclick = close; document.addEventListener('keydown', key, true); document.body.append(box);
}
