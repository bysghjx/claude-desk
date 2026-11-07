// Small DOM helpers shared by every view.
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Escapes text for both element content and quoted attribute values.
export function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const MARKDOWN_TAGS = ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'];
// Links keep web addresses and file paths (F:/out/report.html, file:///…, relative); clicks are handled by the app.
export const LINK_URI = /^(?:(?:https?|mailto|file):|[a-z]:[\\/]|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;
export function markdown(text) {
  return enhance(globalThis.DOMPurify.sanitize(globalThis.marked.parse(text || '', { breaks: true, gfm: true }), { ALLOWED_TAGS: MARKDOWN_TAGS, ALLOWED_ATTR: ['href', 'title', 'class'], ALLOW_DATA_ATTR: false, ALLOWED_URI_REGEXP: LINK_URI }));
}

// GitHub-style alerts (> [!WARNING] …) become callouts.
const CALLOUTS = { NOTE: '说明', TIP: '提示', IMPORTANT: '重点', WARNING: '注意', CAUTION: '警告' };
// Inline code naming a file, optionally with :line or :line-line, such as `ui/app.css:42`.
const FILE_REF = /^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@\-一-龥]+[\\/])*[\w@\-一-龥][\w.@\-一-龥]*\.[A-Za-z][A-Za-z0-9]{0,7}(?::(\d+)(?:-\d+)?)?$/;
const unescape = text => text.replace(/&(lt|gt|quot|#39|amp);/g, (_, c) => ({ lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' })[c]);
// Runs on sanitized HTML and only adds attributes it builds itself.
export function enhance(html) {
  return html
    .replace(/<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br>\s*)?/g, (_, kind) => `<blockquote class="callout callout-${kind.toLowerCase()}"><p class="callout-title">${CALLOUTS[kind]}</p><p>`)
    .replace(/<p><\/p>/g, '')
    .replace(/<code>([^<]{3,260})<\/code>/g, (whole, inner) => {
      const text = unescape(inner), match = !text.includes('://') && text.match(FILE_REF); if (!match) return whole;
      const file = match[1] ? text.slice(0, text.lastIndexOf(':' + match[1])) : text;
      return `<code class="file-ref" data-file-ref="${escape(file)}"${match[1] ? ` data-file-line="${match[1]}"` : ''} title="打开 ${escape(file)}">${inner}</code>`;
    });
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
