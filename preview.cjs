// The built-in browser: one page per conversation, shown in the 浏览器 panel (a
// <webview> in the main window) and driven by Claude through the desk tools.
// The renderer creates the page; it reports the page's WebContents here once
// attached, and everything Claude does goes through that WebContents.
const PAGE_URL = /^(https?:\/\/|about:blank$)/i;
const wait = (ms, message) => new Promise((_, reject) => setTimeout(() => reject(Error(message)), ms));

class BrowserPreview {
  // send(event) tells the renderer to show a conversation's page; nativeImage scales screenshots.
  constructor({ send, nativeImage = null }) { this.send = send; this.nativeImage = nativeImage; this.pages = new Map(); this.waiters = new Map(); }

  attach(threadId, contents) {
    const old = this.pages.get(threadId); if (old?.contents === contents) return;
    const page = { contents, console: [] };
    contents.on('console-message', event => {
      const entry = { level: event.level || 'info', message: String(event.message ?? ''), source: `${event.sourceId || ''}:${event.lineNumber ?? ''}`, at: Date.now() };
      page.console.push(entry); if (page.console.length > 300) page.console.shift();
    });
    contents.once('destroyed', () => { if (this.pages.get(threadId) === page) this.pages.delete(threadId); });
    this.pages.set(threadId, page);
    for (const resolve of this.waiters.get(threadId) || []) resolve(page);
    this.waiters.delete(threadId);
  }
  page(threadId) {
    const page = this.pages.get(threadId);
    if (!page || page.contents.isDestroyed()) throw Error('这个会话还没有打开浏览器页面，先用 preview_open 打开一个地址');
    return page;
  }
  attached(threadId) {
    const page = this.pages.get(threadId); if (page && !page.contents.isDestroyed()) return Promise.resolve(page);
    return Promise.race([new Promise(resolve => { const list = this.waiters.get(threadId) || []; list.push(resolve); this.waiters.set(threadId, list); }), wait(15000, '浏览器面板没有响应，请确认 Claude Desk 窗口已打开')]);
  }
  async settled(contents) {
    if (!contents.isLoading()) return;
    await Promise.race([new Promise(resolve => contents.once('did-stop-loading', resolve)), wait(30000, '页面 30 秒内没有加载完成')]);
  }
  async open(threadId, url) {
    url = String(url || '').trim();
    if (!PAGE_URL.test(url)) throw Error('只能打开 http:// 或 https:// 地址');
    this.send({ type: 'open', threadId, url });
    const { contents } = await this.attached(threadId);
    if (contents.getURL() !== url) contents.loadURL(url).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 50)); await this.settled(contents);
    return { url: contents.getURL(), title: contents.getTitle() };
  }
  // capturePage needs the page on screen; when the panel or window is hidden the
  // DevTools protocol still renders a frame.
  async screenshot(threadId) {
    const { contents } = this.page(threadId); await this.settled(contents);
    const image = await contents.capturePage().catch(() => null);
    if (image && !image.isEmpty()) return (image.getSize().width > 1280 ? image.resize({ width: 1280 }) : image).toJPEG(80).toString('base64');
    const tool = contents.debugger, attached = tool.isAttached();
    try {
      if (!attached) tool.attach('1.3');
      // Pages without a background would come out black in a JPEG.
      await tool.sendCommand('Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 1 } });
      const { data } = await tool.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 80, captureBeyondViewport: false });
      await tool.sendCommand('Emulation.setDefaultBackgroundColorOverride', {}).catch(() => {});
      const shot = this.nativeImage?.createFromBuffer(Buffer.from(data, 'base64'));
      return shot && shot.getSize().width > 1280 ? shot.resize({ width: 1280 }).toJPEG(80).toString('base64') : data;
    } catch (e) { throw Error('截图失败：' + e.message); }
    finally { if (!attached && tool.isAttached()) tool.detach(); }
  }
  async evaluate(threadId, expression) {
    const { contents } = this.page(threadId);
    // Errors thrown in the page come back as their message, not a generic failure.
    const result = await contents.executeJavaScript(`(async () => { try { return { value: await (${expression}\n) }; } catch (e) { return { error: String(e && e.message || e) }; } })()`, true);
    if (result?.error) throw Error(result.error);
    const value = result?.value;
    const text = value === undefined ? 'undefined' : JSON.stringify(value, null, 1) ?? String(value);
    return text.length > 20000 ? text.slice(0, 20000) + '\n…（已截断）' : text;
  }
  // Clicks and typing run in the page, so they work while the panel is hidden.
  click(threadId, selector) {
    return this.evaluate(threadId, `(() => { const el = document.querySelector(${JSON.stringify(String(selector))}); if (!el) throw new Error('找不到元素：' + ${JSON.stringify(String(selector))}); el.scrollIntoView({ block: 'center' }); el.click(); return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' ' + (el.innerText || el.value || '').trim().slice(0, 80); })()`);
  }
  fill(threadId, selector, value) {
    return this.evaluate(threadId, `(() => { const el = document.querySelector(${JSON.stringify(String(selector))}); if (!el) throw new Error('找不到元素：' + ${JSON.stringify(String(selector))});
      const value = ${JSON.stringify(String(value))};
      if (el.tagName === 'SELECT') { const option = [...el.options].find(o => o.value === value || o.text === value); if (!option) throw new Error('没有这个选项：' + value); el.value = option.value; }
      else { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); }
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return '已填写'; })()`);
  }
  text(threadId) {
    return this.evaluate(threadId, `(() => ({ url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 15000) }))()`);
  }
  console(threadId, level = 'all') {
    const { console } = this.page(threadId);
    const list = console.filter(e => level === 'error' ? e.level === 'error' : level === 'warn' ? ['error', 'warning'].includes(e.level) : true).slice(-80);
    return list.length ? list.map(e => `[${e.level}] ${e.message}${e.source !== ':' ? ` (${e.source})` : ''}`).join('\n') : '没有控制台输出';
  }
}
module.exports = { BrowserPreview, PAGE_URL };
