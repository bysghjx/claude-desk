const { createHash } = require('node:crypto');

function normalizeUpdateNetwork({ updateProxy = '', updateMirror = '', updatePrerelease = false } = {}) {
  if (typeof updatePrerelease !== 'boolean') throw Error('预览版更新设置无效');
  function address(value, label) {
    if (typeof value !== 'string' || value.length > 2048) throw Error(label + '地址无效');
    const text = value.trim();
    if (!text) return null;
    let url; try { url = new URL(text); } catch { throw Error(label + '需要完整的 http:// 或 https:// 地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || /[\s\\]/.test(text)) throw Error(label + '需要完整的 http:// 或 https:// 地址');
    if (url.username || url.password || url.search || url.hash) throw Error(label + '不能包含账号密码、查询参数或片段');
    return url;
  }
  const proxy = address(updateProxy, 'HTTP 代理'), mirror = address(updateMirror, '下载加速前缀');
  if (proxy && (proxy.pathname !== '/' || /[;,]/.test(proxy.host))) throw Error('HTTP 代理只填写协议、主机和端口，例如 http://127.0.0.1:7890');
  return { updateProxy: proxy ? proxy.origin : '', updateMirror: mirror ? mirror.href.replace(/\/+$/, '') + '/' : '', updatePrerelease };
}

// Each proxy has its own in-memory session. Changing update settings never changes the
// default session or closes connections belonging to the browser or a running download.
function createUpdateFetch(session) {
  const sessions = new Map();
  return async (url, options = {}, proxy = '') => {
    if (!sessions.has(proxy)) {
      const isolated = session.fromPartition('claude-desk-updates-' + createHash('sha256').update(proxy).digest('hex'), { cache: false });
      const ready = isolated.setProxy(proxy ? { mode: 'fixed_servers', proxyRules: proxy, proxyBypassRules: '<-loopback>' } : { mode: 'direct' }).then(() => isolated);
      sessions.set(proxy, ready);
      ready.catch(() => sessions.delete(proxy));
    }
    return (await sessions.get(proxy)).fetch(url, { ...options, credentials: 'omit' });
  };
}

module.exports = { normalizeUpdateNetwork, createUpdateFetch };
