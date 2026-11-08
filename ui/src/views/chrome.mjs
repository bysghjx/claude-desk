// Window chrome: header, left rail, window buttons, settings dialog and shortcuts.
import { $, $$, escape, setText, setHtml } from '../core/dom.mjs';
import { guarded } from '../core/ui.mjs';

const RAIL_TABS = { mcp: 'manage-mcp', plugins: 'manage-plugins', skills: 'manage-skills', usage: 'manage-usage', 'last-import': 'rail-import' };
// Manager tabs that light up a rail button other than their own page name.
const RAIL_OF_TAB = { import: 'rail-import', 'claude-import': 'rail-import' };

export function createChrome({ store, actions, api, toast, manager, composer, sidebar, instructions, updates, env }) {
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
    setText($('#accent-name'), `按钮、开关和选中项的颜色，现在是「${ACCENTS[accent]}」`);
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

  // Settings are split into pages; the last one viewed opens next time.
  let settingsPage = 'appearance';
  function showSettingsPage(page) {
    settingsPage = page;
    for (const tab of $$('[data-settings-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.settingsTab === page));
    for (const section of $$('[data-settings-page]')) section.hidden = section.dataset.settingsPage !== page;
    $('#settings-result').textContent = '';
    if (page === 'about') updates.open();
  }
  // The Claude page leads with whether Claude can be reached at all, then the details.
  function connectionHtml(p) {
    const ready = Boolean(p.cliPath);
    const title = !ready ? '没有找到 Claude Code' : `通过 ${escape(p.host)} 连接`;
    const detail = !ready ? '点下面的「检测环境」，安装官方版或使用内置版。' : p.custom ? `使用服务商「${escape(p.custom)}」，在「服务商」页可以切换。` : p.configured ? '服务商和密钥来自你的 Claude 配置，这里不显示密钥。' : '使用 Claude Code 自己的登录。点「检测环境」可以查看是否已登录。';
    return `<span class="connection-dot${ready ? '' : ' error'}" aria-hidden="true"></span><div><strong>${title}</strong><span>${detail}</span></div>`;
  }

  async function openSettings(page = settingsPage) {
    themeButtons(); $('#notify-toggle').checked = store.state.settings?.notifications !== false; $('#awake-toggle').checked = store.state.settings?.keepAwake !== false; $('#tray-toggle').checked = store.state.settings?.closeToTray !== false;
    const p = store.state.provider;
    setHtml($('#connection-status'), connectionHtml(p));
    setText($('#cli-path'), p.cliPath ? (p.cliBundled ? 'Claude Desk 内置版本：' : '你安装的版本：') + p.cliPath : '没有找到');
    setText($('#config-path'), p.configPath);
    setText($('#data-path'), p.dataRoot);
    setText($('#global-instructions-state'), store.state.settings?.instructions ? '已设置，对所有会话生效。项目提示词在项目的右键菜单里设置' : '对所有会话生效。项目提示词在项目的右键菜单里设置');
    setText($('#app-version'), 'Claude Desk ' + (store.state.version || ''));
    setText($('#data-summary'), '');
    showSettingsPage(page); $('#settings-dialog').showModal(); rail('settings');
    try {
      const info = await api('storage:info');
      setText($('#data-summary'), `共 ${info.threads.toLocaleString()} 个会话、${info.turns.toLocaleString()} 轮问答，保存在本机的 SQLite 数据库里。${info.warning ? info.warning : ''}`);
    } catch (e) { setText($('#data-summary'), '读取会话统计失败：' + e.message); }
  }

  $('#new-thread').addEventListener('click', actions.newTask);
  $('#rail-home').addEventListener('click', () => { actions.showHome(); rail('rail-home'); });
  for (const [page, id] of Object.entries(RAIL_TABS)) $('#' + id).addEventListener('click', () => { manager.open(page); rail(id); });
  document.addEventListener('click', event => { const tab = event.target.closest?.('[data-manager-tab]'); if (tab) rail(RAIL_TABS[tab.dataset.managerTab] || RAIL_OF_TAB[tab.dataset.managerTab] || ''); });
  for (const id of ['#manager-dialog', '#settings-dialog']) $(id).addEventListener('close', () => rail(store.current() ? '' : 'rail-home'));
  $('#thread-title').addEventListener('dblclick', () => { if (store.current()) sidebar.startRename(store.current().id); });
  // Narrow windows fold the 会话信息 panel away; this button shows it over the conversation.
  const contextToggle = $('#toggle-context'), inspector = $('#inspector');
  const showContext = on => { inspector.classList.toggle('shown', on); contextToggle.classList.toggle('active', on); contextToggle.setAttribute('aria-expanded', String(on)); };
  contextToggle.addEventListener('click', () => showContext(!inspector.classList.contains('shown')));
  document.addEventListener('mousedown', event => { if (inspector.classList.contains('shown') && !event.target.closest('#inspector, #toggle-context')) showContext(false); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && inspector.classList.contains('shown')) showContext(false); });
  $('#export').addEventListener('click', guarded(toast, async () => { if (store.selected && await api('export', store.selected)) toast('对话已导出'); }));
  $('#settings').addEventListener('click', guarded(toast, () => openSettings()));
  for (const tab of $$('[data-settings-tab]')) tab.addEventListener('click', () => showSettingsPage(tab.dataset.settingsTab));
  $('#edit-global-instructions').addEventListener('click', () => { $('#settings-dialog').close(); instructions.open('global'); });
  for (const button of $$('[data-material-choice]')) button.addEventListener('click', guarded(toast, () => setMaterial(button.dataset.materialChoice)));
  for (const button of $$('[data-accent-choice]')) button.addEventListener('click', guarded(toast, () => setAccent(button.dataset.accentChoice)));
  for (const button of $$('[data-theme-choice]')) button.addEventListener('click', guarded(toast, () => setTheme(button.dataset.themeChoice)));
  $('#notify-toggle').addEventListener('change', guarded(toast, () => setNotifications($('#notify-toggle').checked)));
  $('#awake-toggle').addEventListener('change', guarded(toast, () => setKeepAwake($('#awake-toggle').checked)));
  $('#tray-toggle').addEventListener('change', guarded(toast, async () => {
    const on = $('#tray-toggle').checked;
    store.state.settings = { ...store.state.settings, closeToTray: on }; await api('settings', { closeToTray: on });
  }));
  $('#notify-test').addEventListener('click', guarded(toast, async () => { toast(await api('notify:test') ? '已发送测试通知，请看屏幕右下角' : '系统不支持桌面通知，或通知已被 Windows 关闭'); }));
  $('#close-settings').addEventListener('click', () => $('#settings-dialog').close());
  $('#open-config').addEventListener('click', guarded(toast, () => api('config:open')));
  $('#open-cli').addEventListener('click', guarded(toast, () => api('cli:open')));
  $('#open-env').addEventListener('click', guarded(toast, () => { $('#settings-dialog').close(); return env.open(); }));
  $('#open-data').addEventListener('click', guarded(toast, () => api('data:open')));
  $('#import-codex').addEventListener('click', () => { $('#settings-dialog').close(); manager.open('import'); rail('rail-import'); });
  $('#open-storage').addEventListener('click', () => { $('#settings-dialog').close(); manager.open('storage'); rail(''); });
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
    if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); actions.newTask(); }
    if (event.key === 'Escape' && $('#settings-dialog').open) $('#settings-dialog').close();
  });

  for (const event of ['select', 'threads', 'load']) store.on(event, render);
  store.on('load', applyAccent);
  store.on('load', applyMaterial);
  store.on('thread', thread => { if (thread.id === store.selected) header(); });
  return { render };
}
