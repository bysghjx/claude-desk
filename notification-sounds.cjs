const path = require('node:path');
const soundForNotice = kind => kind === 'done' ? 'complete' : ['question', 'approval', 'plan', 'error'].includes(kind) ? 'attention' : null;

class NotificationSounds {
  constructor({ BrowserWindow, now = Date.now }) { Object.assign(this, { BrowserWindow, now, window: null, ready: null, lastAt: -Infinity, lastSound: null, closed: false }); }
  async play(kind) {
    const sound = soundForNotice(kind), at = this.now();
    if (!sound || this.closed || at - this.lastAt < 1200 && !(sound === 'attention' && this.lastSound === 'complete')) return false;
    this.lastAt = at; this.lastSound = sound;
    try {
      if (!this.window || this.window.isDestroyed()) {
        this.window = new this.BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true, webPreferences: {
          preload: path.join(__dirname, 'notification-sound-preload.cjs'), sandbox: true, contextIsolation: true,
          nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required'
        } });
        this.ready = this.window.loadFile(path.join(__dirname, 'ui/notification-sound.html'));
      }
      const window = this.window;
      await this.ready;
      if (this.closed || window.isDestroyed()) return false;
      window.webContents.send('notification:sound', sound); return true;
    } catch { return false; }
  }
  close() { this.closed = true; if (this.window && !this.window.isDestroyed()) this.window.destroy(); }
}
module.exports = { NotificationSounds, soundForNotice };
