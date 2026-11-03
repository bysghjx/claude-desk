// Update packages: looks for one where downloads usually end up, offers it in a notice and on the
// About page, and installs it after a short countdown once nothing is running (unless turned off).
import { $, setHtml, setText } from '../core/dom.mjs';
import { guarded } from '../core/ui.mjs';
import { isActive } from '../core/format.mjs';
import { updateCardHtml, noticeOf } from '../lib/updates.mjs';

const COUNTDOWN = 10, RESCAN_AFTER = 20000;

export function createUpdates({ store, api, toast, confirm }) {
  let scan = null, scannedAt = 0, scanning = null, installing = '';
  let shown = null, mode = '', seconds = 0, timer = null;
  const later = new Set(); // put off with 以后再说 or 取消 until Claude Desk restarts
  const running = () => store.state.threads.filter(isActive).length;
  const auto = () => store.state.settings?.autoUpdate !== false;

  function renderCard() {
    setHtml($('#update-card'), updateCardHtml(scan, { scanning: Boolean(scanning), installing }));
    $('#auto-update-toggle').checked = auto();
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
    if (installing) return;
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
    if (scanning) return scanning;
    if (!force && scan && Date.now() - scannedAt < RESCAN_AFTER) return scan;
    scanning = api('update:scan').then(result => { scan = result; scannedAt = Date.now(); return result; }).finally(() => { scanning = null; renderCard(); offer(); });
    renderCard(); return scanning;
  }

  // Checks the package, then closes Claude Desk; the installer copies the files and starts it again.
  async function install(update, { ask = true } = {}) {
    if (installing) return;
    const n = running();
    if (n && ask && !await confirm({ title: `升级到 ${update.to}？`, description: `正在运行的 ${n} 个会话会停止。Claude Desk 会关闭，更新后自动重新打开，会话记录不受影响。`, preview: `${update.from} → ${update.to}`, label: '停止任务并安装', kind: 'neutral' })) return;
    stopCountdown(); shown = update; installing = `正在检查 ${update.to} 更新包…`; renderNotice(); renderCard();
    try {
      const staged = await api('update:stage', update.file);
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
  }));
  $('#auto-update-toggle').addEventListener('change', guarded(toast, async () => {
    const on = $('#auto-update-toggle').checked;
    store.state.settings = { ...store.state.settings, autoUpdate: on };
    await api('settings', { autoUpdate: on }); offer();
  }));
  // A package anywhere else: pick the zip by hand.
  $('#install-update').addEventListener('click', guarded(toast, async () => {
    const button = $('#install-update'); button.disabled = true;
    try {
      const update = await api('update:pick');
      if (!update) return;
      const n = running();
      const ok = await confirm({ title: `升级到 ${update.to}？`, description: `更新包检查通过：替换 ${update.files} 个文件${update.removed ? `，删除 ${update.removed} 个` : ''}。Claude Desk 会关闭，更新后自动重新打开${n ? `；正在运行的 ${n} 个会话会停止` : ''}。会话记录不受影响。`, preview: `${update.from} → ${update.to}`, label: '安装并重启', kind: 'neutral' });
      if (ok) { installing = `正在关闭并安装 ${update.to}…`; renderCard(); await api('update:apply'); }
    } finally { button.disabled = false; }
  }));

  // Looks again when you come back to the window, e.g. after downloading a package.
  window.addEventListener('focus', () => check().catch(() => {}));
  store.on('load', () => check(true).catch(() => {}));
  // A task starting cancels the countdown; the last one finishing starts it.
  store.on('threads', offer); store.on('thread', () => { if (shown && !installing && mode !== 'ask') offer(); });

  return { open: () => { renderCard(); check().catch(e => toast(e.message)); } };
}
