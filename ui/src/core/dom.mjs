// Small DOM helpers shared by every view.
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Escapes text for both element content and quoted attribute values.
export function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const MARKDOWN_TAGS = ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'];
export function markdown(text) {
  return globalThis.DOMPurify.sanitize(globalThis.marked.parse(text || '', { breaks: true, gfm: true }), { ALLOWED_TAGS: MARKDOWN_TAGS, ALLOWED_ATTR: ['href', 'title', 'class'], ALLOW_DATA_ATTR: false });
}

// Writes innerHTML only when it changed, so untouched nodes keep focus, selection and running transitions.
export function setHtml(element, html) {
  if (element.__html === html) return false;
  element.innerHTML = html; element.__html = html; return true;
}
export function setText(element, text) {
  const value = String(text ?? '');
  if (element.textContent !== value) element.textContent = value;
}

export function element(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) setHtml(node, html);
  return node;
}
