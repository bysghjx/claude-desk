// The right-click menu Electron does not provide: editing commands in text fields,
// copy (and quoting into the composer) for selected text, links and images. Built as
// plain items so it is tested without Electron.
function contextItems(params, { canQuote = false } = {}) {
  const items = [], flags = params.editFlags || {}, line = () => { if (items.length && items.at(-1).type !== 'separator') items.push({ type: 'separator' }); };
  if (params.isEditable) {
    for (const word of (params.dictionarySuggestions || []).slice(0, 4)) items.push({ label: word, action: 'replace', value: word });
    line();
    items.push({ label: '撤销', role: 'undo', enabled: flags.canUndo !== false }, { label: '重做', role: 'redo', enabled: flags.canRedo !== false }, { type: 'separator' },
      { label: '剪切', role: 'cut', enabled: Boolean(flags.canCut) }, { label: '复制', role: 'copy', enabled: Boolean(flags.canCopy) }, { label: '粘贴', role: 'paste', enabled: flags.canPaste !== false },
      { type: 'separator' }, { label: '全选', role: 'selectAll' });
  } else if (params.selectionText?.trim()) {
    items.push({ label: '复制', role: 'copy' });
    if (canQuote) items.push({ label: '引用到输入框', action: 'quote', value: params.selectionText.slice(0, 20000) });
  }
  if (params.linkURL && /^https?:/i.test(params.linkURL)) { line(); items.push({ label: '复制链接地址', action: 'copy-text', value: params.linkURL }, { label: '在浏览器中打开', action: 'open-link', value: params.linkURL }); }
  if (params.mediaType === 'image' && params.srcURL) { line(); items.push({ label: '复制图片', action: 'copy-image' }); }
  if (!params.isEditable && !items.length) items.push({ label: '全选', role: 'selectAll' });
  while (items.at(-1)?.type === 'separator') items.pop();
  return items;
}

function attachContextMenu(contents, { Menu, clipboard, shell, onQuote = null }) {
  contents.on('context-menu', (_event, params) => {
    const items = contextItems(params, { canQuote: Boolean(onQuote) });
    if (!items.length) return;
    const run = item => {
      if (item.action === 'replace') contents.replaceMisspelling(item.value);
      if (item.action === 'quote') onQuote(item.value);
      if (item.action === 'copy-text') clipboard.writeText(item.value);
      if (item.action === 'open-link') shell.openExternal(item.value);
      if (item.action === 'copy-image') contents.copyImageAt(params.x, params.y);
    };
    Menu.buildFromTemplate(items.map(({ action, value, ...item }) => action ? { ...item, click: () => run({ action, value }) } : item)).popup();
  });
}
module.exports = { contextItems, attachContextMenu };
