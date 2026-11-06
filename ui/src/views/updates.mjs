// Update packages: looks for one where downloads usually end up, offers it in a notice and on the
// About page, and installs it after a short countdown once nothing is running (unless turned off).
import { $, setHtml, setText } from '../core/dom.mjs';
import { guarded } from '../core/ui.mjs';
import { isActive } from '../core/format.mjs';
import { updateCardHtml, noticeOf } from '../lib/updates.mjs';

const COUNTDOWN = 10, RESCAN_AFTER = 20000, ONLINE_INTERVAL = 60 * 60 * 1000;

export function createUpdates({ store, api, toast, confirm }) {
  let scan = null, scannedAt = 0, scanning = null, installing = '';
  let shown = null, mode = '', seconds = 0, timer = null;
  const later = new Set(); // put off with 以后再说 or 取消 until Claude Desk restarts
  const running = () => store.state.threads.filter(isActive).length;
  const auto = () => store.state.settings?.autoUpdate !== false;
  let saving = false;
  function fillSettings() {
    const settings = store.state.settings || {};
    $('#update-proxy').value = settings.updateProxy || '';
    $('#update-mirror').value = settings.updateMirror || '';
    $('#update-prerelease-toggle').checked = settings.updatePrerelease === true;
  }

  function renderCard() {
    setHtml($('#update-card'), updateCardHtml(scan, { scanning: Boolean(scanning), installing }));
    $('#auto-update-toggle').checked = auto();
    $('#install-update').disabled = saving || Boolean(installing);
    for (const id of ['#update-proxy', '#update-mirror', '#update-prerelease-toggle', '#save-update-settings']) $(id).disabled = saving || Boolean(installing);
  }
  function renderNotice() {
    const box = $('#update-notice');
    if (!shown) { box.hidden = true; return; }
    const n = noticeOf(scan, shown, { mode, running: running(), seconds, installing });
    setText($('#update-notice-title'), n.title); setText($('#update-notice-detail'), n.detail);
    for (const [id, label] of [['#update-notice-primary', n.primary], ['#update-notice-secondary', n.secondary]]) { setText($(id), label); $(id).hidden = !label; }
    box.hidden = false;
  }
  function stopCountdown() { clearInterval(timer); timer = null; }
  function hide() { stopCountdown(); shown = null; mode = ''; renderNotice(); }

  // Decides what the notice shows for the newest package found, if any.
  function offer() {
    if (installing || saving) return;
    const update = scan?.installable && scan.ready[0];
    if (!update || later.has(update.file)) return hide();
    const next = !auto() ? 'ask' : running() ? 'wait' : 'countdown';
    if (shown?.file === update.file && mode === next) return;
    stopCountdown(); shown = update; mode = next;
    if (mode === 'countdown') {
      seconds = COUNTDOWN;
      timer = setInterval(() => { seconds -= 1; if (seconds > 0) return renderNotice(); stopCountdown(); install(update, { ask: false }).catch(e => toast(e.message)); }, 1000);
    }
    renderNotice();
  }

  async function check(force = false) {
    if (installing) return scan;
    if (scanning) return scanning;
    if (!force && scan && Date.now() - scannedAt < RESCAN_AFTER) return scan;
    scanning = api('update:scan', force).then(result => { scan = result; scannedAt = Date.now(); return result; }).finally(() => { scanning = null; renderCard(); offer(); });
    renderCard(); return scanning;
  }

  // Checks the package, then closes Claude Desk; the installer copies the files and starts it again.
  async function install(update, { ask = true } = {}) {
    if (installing || saving) return;
    if (!ask && (running() || !auto())) return offer();
    stopCountdown(); shown = update; installing = update.source === 'github' ? `正在下载 ${update.to} 更新包…` : `正在检查 ${update.to} 更新包…`; renderNotice(); renderCard();
    try {
      const staged = await api('update:stage', update.file);
      // Tasks and the auto-install setting may have changed during a long download.
      if (!ask && (running() || !auto())) { installing = ''; mode = ''; renderCard(); offer(); return; }
      const n = running();
      if (n && !await confirm({ title: `升级到 ${update.to}？`, description: `正在运行的 ${n} 个会话会停止。Claude Desk 会关闭，更新后自动重新打开，会话记录不受影响。`, preview: `${update.from} → ${update.to}`, label: '停止任务并安装', kind: 'neutral' })) { installing = ''; later.add(update.file); hide(); renderCard(); return; }
      installing = `检查通过，正在关闭并安装 ${staged.to}…`; renderNotice(); renderCard();
      await api('update:apply');
    } catch (e) {
      installing = ''; later.add(update.file); hide(); renderCard();
      throw Error('更新包没有安装：' + e.message);
    }
  }
  function putOff() { if (shown) later.add(shown.file); hide(); }

  $('#update-notice-primary').addEventListener('click', guarded(toast, () => shown && install(shown)));
  $('#update-notice-secondary').addEventListener('click', putOff);
  $('#update-card').addEventListener('click', guarded(toast, event => {
    const action = event.target.closest('[data-update-action]')?.dataset.updateAction, update = scan?.ready[0];
    if (action === 'scan') return check(true);
    if (action === 'install' && update) { later.delete(update.file); return install(update); }
    if (action === 'reveal' && update) return api('update:reveal', update.file);
    if (action === 'releases') return api('update:releases');
  }));
  $('#auto-update-toggle').addEventListener('change', guarded(toast, async () => {
    const on = $('#auto-update-toggle').checked;
    store.state.settings = { ...store.state.settings, autoUpdate: on };
    await api('settings', { autoUpdate: on }); offer();
  }));
  $('#update-settings-form').addEventListener('submit', guarded(toast, async event => {
    event.preventDefault();
    if (saving || installing) return;
    saving = true; hide(); setText($('#update-settings-result'), '正在保存…'); renderCard();
    try {
      if (scanning) await scanning;
      const settings = await api('update:settings', { updateProxy: $('#update-proxy').value, updateMirror: $('#update-mirror').value, updatePrerelease: $('#update-prerelease-toggle').checked });
      store.state.settings = { ...store.state.settings, ...settings }; fillSettings();
      scan = null; scannedAt = 0; later.clear(); hide();
      setText($('#update-settings-result'), '已保存，正在检查更新…');
      await check(true);
      setText($('#update-settings-result'), scan?.online?.status === 'error' ? '已保存；检查更新失败，可重新检查。' : '已保存并重新检查');
    } catch (e) { setText($('#update-settings-result'), e.message); throw e; }
    finally { saving = false; renderCard(); offer(); }
  }));
  // A package anywhere else: pick the zip by hand.
  $('#install-update').addEventListener('click', guarded(toast, async () => {
    if (installing || saving) return;
    stopCountdown(); installing = '正在选择并检查更新包…'; renderCard(); renderNotice();
    const button = $('#install-update'); button.disabled = true;
    try {
      const update = await api('update:pick');
      if (!update) return;
      const n = running();
      const ok = await confirm({ title: `升级到 ${update.to}？`, description: `更新包检查通过：替换 ${update.files} 个文件${update.removed ? `，删除 ${update.removed} 个` : ''}。Claude Desk 会关闭，更新后自动重新打开${n ? `；正在运行的 ${n} 个会话会停止` : ''}。会话记录不受影响。`, preview: `${update.from} → ${update.to}`, label: '安装并重启', kind: 'neutral' });
      if (ok) {
        installing = `正在关闭并安装 ${update.to}…`; renderCard();
        try { await api('update:apply'); } catch (e) { installing = ''; renderCard(); throw Error('更新包没有安装：' + e.message); }
      }
    } finally { installing = ''; button.disabled = false; renderCard(); offer(); }
  }));

  // Looks again when you come back to the window, e.g. after downloading a package.
  window.addEventListener('focus', () => check().catch(() => {}));
  store.on('load', () => { fillSettings(); check().catch(() => {}); });
  setInterval(() => check().catch(() => {}), ONLINE_INTERVAL);
  window.desk?.onUpdateProgress(event => {
    if (!installing || event.file !== shown?.file) return;
    const route = event.route === 'mirror' ? '通过加速地址下载' : event.route === 'proxy' ? '通过 HTTP 代理下载' : '下载';
    installing = `正在${route} ${shown.to} 更新包… ${Math.min(100, Math.floor(event.received / event.total * 100))}%`;
    renderCard(); renderNotice();
  });
  // A task starting cancels the countdown; the last one finishing starts it.
  store.on('threads', offer); store.on('thread', () => { if (shown && !installing && mode !== 'ask') offer(); });

  return { open: () => { fillSettings(); renderCard(); check().catch(e => toast(e.message)); } };
}
