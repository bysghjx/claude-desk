const { app, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { createUpdateFetch } = require('../../update-network.cjs');
const root = process.argv.at(-1);
app.setPath('userData', path.join(root, 'shell'));
app.whenReady().then(async () => {
  let directRequests = 0, proxyRequests = 0;
  const target = http.createServer((req, res) => { directRequests++; res.end('direct'); });
  const proxy = http.createServer((req, res) => { proxyRequests++; assert.match(req.url, /^http:/); res.end('proxy'); });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await listen(target); await listen(proxy);
  try {
    const url = 'http://127.0.0.1:' + target.address().port + '/file';
    const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
    const fetch = createUpdateFetch(session), options = { signal: AbortSignal.timeout(5000) };
    assert.equal(await (await fetch(url, options)).text(), 'direct');
    assert.equal(await (await fetch(url, options, proxyUrl)).text(), 'proxy');
    assert.equal(await (await session.defaultSession.fetch(url, options)).text(), 'direct');
    assert.equal(await (await fetch(url, options, proxyUrl)).text(), 'proxy');
    assert.equal(await (await fetch(url, options)).text(), 'direct');
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ proxyRequests, directRequests }));
  } finally { target.closeAllConnections(); proxy.closeAllConnections(); target.close(); proxy.close(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
