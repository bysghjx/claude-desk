// Window chrome: header, left rail, window buttons, settings dialog and shortcuts.
import { $, $$, escape, setText } from '../core/dom.mjs';
import { guarded } from '../core/ui.mjs';

const RAIL_TABS = { mcp: 'manage-mcp', plugins: 'manage-plugins', skills: 'manage-skills', usage: 'manage-usage', 'last-import': 'rail-import' };
// Manager tabs that light up a rail button other than their own page name.
const RAIL_OF_TAB = { import: 'rail-import', 'claude-import': 'rail-import' };

export function createChrome({ store, actions, api, toast, manager, composer, sidebar }) {
  function header() {
    setText($('#project-label'), store.current() && !store.current().projectId ? '对话' : store.currentProject()?.name || '工作空间');
    setText($('#thread-title'), store.current()?.title || '主页');
    const wt = store.current()?.worktree, chip = $('#worktree-chip');
    chip.hidden = !wt || wt.removed; if (wt && !wt.removed) { setText(chip.lastChild, wt.branch); chip.title = `独立工作树：${store.current().cwd}`; }
    $('#new-thread').classList.toggle('selected', !store.current());
    $('#export').disabled = !store.current()?.turns.length;
  }
  // The tool whose window is open stays highlighted; otherwise Home while no conversation is open.
  function rail(active) {
    if (active === undefined) active = $('#manager-dialog').open || $('#settings-dialog').open ? null : store.current() ? '' : 'rail-home';
    if (active !== null) for (const button of $$('.rail-button')) button.classList.toggle('active', button.id === active);
  }
  function render() { header(); rail(); }

  // Appearance: 月之暗面 (dark), 月之亮面 (light) or follow the system.
  function themeButtons() {
    const current = store.state.settings?.theme || 'dark';
    for (const button of $$('[data-theme-choice]')) { const on = button.dataset.themeChoice === current; button.classList.toggle('selected', on); button.setAttribute('aria-checked', String(on)); }
  }
  async function setTheme(theme) {
    store.state.settings = { ...store.state.settings, theme }; themeButtons();
    await api('settings', { theme });
  }

  // Window material (Windows 11): mica or acrylic shows through the sidebar and rail; 纯色 keeps solid colours.
  const MATERIAL_NOTES = { mica: '透出桌面壁纸的颜色，失去焦点时变为纯色', acrylic: '更透，能隐约看到背后的窗口', none: '' };
  function applyMaterial() {
    const supported = store.state.materialSupported, chosen = store.state.settings?.material || 'mica', active = supported ? store.state.material : 'none';
    if (active && active !== 'none') document.documentElement.dataset.material = active; else delete document.documentElement.dataset.material;
    for (const button of $$('[data-material-choice]')) { const on = button.dataset.materialChoice === (supported ? chosen : 'none'); button.classList.toggle('selected', on); button.setAttribute('aria-checked', String(on)); button.disabled = !supported; }
    setText($('#material-note'), supported ? MATERIAL_NOTES[chosen] || '' : '需要 Windows 11');
  }
  async function setMaterial(material) {
    store.state.settings = { ...store.state.settings, material }; store.state.material = material; applyMaterial();
    await api('settings', { material });
  }
  // Accent colour for buttons, toggles, links and highlights; none keeps the neutral look.
  const ACCENTS = { '': '默认', orange: '橙', blue: '蓝', green: '绿', purple: '紫', pink: '粉', yellow: '黄' };
  function applyAccent() {
    const accent = ACCENTS[store.state.settings?.accent] && store.state.settings.accent || '';
    if (accent) document.documentElement.dataset.accent = accent; else delete document.documentElement.dataset.accent;
    for (const button of $$('[data-accent-choice]')) { const on = button.dataset.accentChoice === accent; button.classList.toggle('selected', on); button.setAttribute('aria-checked', String(on)); }
    setText($('#accent-name'), ACCENTS[accent]);
  }
  async function setAccent(accent) {
    store.state.settings = { ...store.state.settings, accent }; applyAccent();
    await api('settings', { accent });
  }
  // Desktop notifications are on unless turned off.
  async function setNotifications(on) {
    store.state.settings = { ...store.state.settings, notifications: on };
    await api('settings', { notifications: on });
  }

  // Keeping the computer awake while Claude works is on unless turned off.
  async function setKeepAwake(on) {
    store.state.settings = { ...store.state.settings, keepAwake: on };
    await api('settings', { keepAwake: on });
  }

  async function openSettings() {
    themeButtons(); $('#notify-toggle').checked = store.state.settings?.notifications !== false; $('#awake-toggle').checked = store.state.settings?.keepAwake !== false;
    const p = store.state.provider;
    $('#config-details').innerHTML = [['服务商', p.host], ['Claude CLI', p.cliPath || '未找到官方原生 Claude'], ['凭据', p.configured ? '已从现有配置读取（界面不显示密钥）' : '未发现 API 配置；CLI 将使用其现有登录'], ['配置文件', p.configPath], ['会话目录', p.dataRoot]].map(([key, value]) => `<div class="config-row"><span>${key}</span><span>${escape(value)}</span></div>`).join('');
    $('#settings-result').textContent = ''; $('#settings-dialog').showModal(); rail('settings');
    try {
      const info = await api('storage:info');
      $('#settings-result').textContent = `SQLite · ${info.threads} 个会话 / ${info.turns} 轮问答\n数据集：${info.datasetId}\n保存版本：${info.revision}\n数据库：${info.database}${info.warning ? '\n' + info.warning : ''}`;
    } catch (e) { $('#settings-result').textContent = e.message; }
  }

  $('#new-thread').addEventListener('click', actions.showHome);
  $('#rail-home').addEventListener('click', () => { actions.showHome(); rail('rail-home'); });
  for (const [page, id] of Object.entries(RAIL_TABS)) $('#' + id).addEventListener('click', () => { manager.open(page); rail(id); });
  document.addEventListener('click', event => { const tab = event.target.closest?.('[data-manager-tab]'); if (tab) rail(RAIL_TABS[tab.dataset.managerTab] || RAIL_OF_TAB[tab.dataset.managerTab] || ''); });
  for (const id of ['#manager-dialog', '#settings-dialog']) $(id).addEventListener('close', () => rail(store.current() ? '' : 'rail-home'));
  $('#thread-title').addEventListener('dblclick', () => { if (store.current()) sidebar.startRename(store.current().id); });
  $('#export').addEventListener('click', guarded(toast, async () => { if (store.selected && await api('export', store.selected)) toast('对话已导出'); }));
  $('#settings').addEventListener('click', guarded(toast, openSettings));
  for (const button of $$('[data-material-choice]')) button.addEventListener('click', guarded(toast, () => setMaterial(button.dataset.materialChoice)));
  for (const button of $$('[data-accent-choice]')) button.addEventListener('click', guarded(toast, () => setAccent(button.dataset.accentChoice)));
  for (const button of $$('[data-theme-choice]')) button.addEventListener('click', guarded(toast, () => setTheme(button.dataset.themeChoice)));
  $('#notify-toggle').addEventListener('change', guarded(toast, () => setNotifications($('#notify-toggle').checked)));
  $('#awake-toggle').addEventListener('change', guarded(toast, () => setKeepAwake($('#awake-toggle').checked)));
  $('#notify-test').addEventListener('click', guarded(toast, async () => { toast(await api('notify:test') ? '已发送测试通知，请看屏幕右下角' : '系统不支持桌面通知，或通知已被 Windows 关闭'); }));
  $('#close-settings').addEventListener('click', () => $('#settings-dialog').close());
  $('#open-config').addEventListener('click', guarded(toast, () => api('config:open')));
  $('#open-data').addEventListener('click', guarded(toast, () => api('data:open')));
  $('#import-codex').addEventListener('click', () => { $('#settings-dialog').close(); manager.open('import'); rail('rail-import'); });
  $('#import-claude').addEventListener('click', () => { $('#settings-dialog').close(); manager.open('claude-import'); rail('rail-import'); });
  $('#backup-data').addEventListener('click', guarded(toast, async () => { if (await api('storage:export')) $('#settings-result').textContent = '全部会话、草稿和用量已备份。'; }));
  $('#refresh-models').addEventListener('click', guarded(toast, async () => {
    const button = $('#refresh-models'); button.disabled = true; $('#settings-result').textContent = '正在读取模型列表…';
    try { const models = await composer.refreshModels(); $('#settings-result').textContent = `已读取 ${models.length} 个模型。选择器已更新。`; } finally { button.disabled = false; }
  }));
  for (const button of $$('[data-window]')) button.addEventListener('click', () => api('window', button.dataset.window));
  window.desk.onMaximized?.(maximized => {
    document.documentElement.classList.toggle('maximized', maximized);
    const button = $('[data-window="max"]'), label = maximized ? '向下还原' : '最大化'; button.title = label; button.setAttribute('aria-label', label);
  });
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); actions.showHome(); }
    if (event.key === 'Escape' && $('#settings-dialog').open) $('#settings-dialog').close();
  });

  for (const event of ['select', 'threads', 'load']) store.on(event, render);
  store.on('load', applyAccent);
  store.on('load', applyMaterial);
  store.on('thread', thread => { if (thread.id === store.selected) header(); });
  return { render };
}
