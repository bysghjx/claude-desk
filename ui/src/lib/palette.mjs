// Ctrl+K search: actions, chats, project files and conversation text. Pure, so the
// matching and grouping are tested without a window (see test/palette.test.cjs).
export const TABS = [['all', '全部'], ['actions', '操作'], ['chats', '聊天'], ['files', '文件'], ['text', '内容']];
const norm = value => String(value || '').toLowerCase();

// A short excerpt around the first match, on one line.
export function snippet(text, query, size = 70) {
  const flat = String(text || '').replace(/\s+/g, ' '), at = norm(flat).indexOf(norm(query));
  if (at < 0) return '';
  const start = Math.max(0, at - Math.floor((size - query.length) / 2)), end = Math.min(flat.length, start + size);
  return (start ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

export function paletteSections({ query = '', tab = 'all', threads = [], projects = [], actions = [], files = [] }) {
  const q = norm(query.trim()), want = kind => tab === 'all' || tab === kind, sections = [];
  const place = t => t.projectId ? projects.find(p => p.id === t.projectId)?.name || '' : '对话';
  if (want('actions')) {
    const items = actions.filter(a => !q || norm(`${a.label} ${a.keywords || ''}`).includes(q))
      .map(a => ({ kind: 'action', id: a.id, label: a.label, shortcut: a.shortcut || '', icon: a.icon || 'action' }));
    if (items.length) sections.push({ title: '快捷操作', items });
  }
  if (want('chats')) {
    const items = threads.filter(t => (q ? norm(t.title).includes(q) : !t.archived))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, q || tab === 'chats' ? 30 : 6)
      .map(t => ({ kind: 'chat', id: t.id, label: t.title, meta: place(t) + (t.archived ? ' · 已归档' : ''), icon: 'chat' }));
    if (items.length) sections.push({ title: q ? '聊天' : '最近聊天', items });
  }
  if (want('files') && (q || tab === 'files')) {
    const items = files.filter(file => !q || norm(file).includes(q)).slice(0, 30).map(file => {
      const parts = file.split(/[\\/]/);
      return { kind: 'file', id: file, label: parts.at(-1), meta: parts.slice(0, -1).join('/'), icon: 'file' };
    });
    if (items.length) sections.push({ title: '文件', items });
  }
  if (want('text') && q.length >= 2) {
    const items = [];
    for (const t of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const turn = t.turns?.find(x => norm(x.user).includes(q) || norm(x.answer).includes(q)); if (!turn) continue;
      items.push({ kind: 'text', id: t.id, label: t.title, meta: place(t), snippet: snippet(norm(turn.user).includes(q) ? turn.user : turn.answer, q), icon: 'text' });
      if (items.length >= 30) break;
    }
    if (items.length) sections.push({ title: '对话内容', items });
  }
  return sections;
}
