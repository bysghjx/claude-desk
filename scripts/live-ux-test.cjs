// Live check for image attachments, queued messages and ordered turn items (uses a little model usage).
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { Engine, JsonStore } = require('../engine.cjs');
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
(async () => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const root = path.resolve(__dirname, '../../../work/claude-desk-live-ux'); fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true });
  const attachmentRoot = path.join(root, 'attachments'); fs.mkdirSync(attachmentRoot);
  const engine = new Engine({ query, store: new JsonStore(path.join(root, 'state.json')), cliPath: path.join(process.env.USERPROFILE, '.local/bin/claude.exe'), attachmentRoot });
  const t = engine.create(engine.addProject(root).id);
  engine.on('thread', x => { if (x.id === t.id && x.status === 'approval') for (const [id, p] of engine.pending) if (p.threadId === t.id) engine.approve(t.id, id, true); });
  const settle = count => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Live UX test timed out')), 180000);
    const check = x => { if (x.id !== t.id) return; if (x.status === 'error') { clearTimeout(timer); reject(Error(x.error)); } if (x.status === 'done' && x.turns.length >= count && !x.queue?.length) { clearTimeout(timer); engine.removeListener('thread', check); resolve(x); } };
    engine.on('thread', check);
  });
  try {
    const image = path.join(attachmentRoot, 'red.png'); fs.writeFileSync(image, png(64, 64, [220, 20, 20]));
    let done = settle(2);
    await engine.send(t.id, 'What is the main colour of the attached image? Reply with one English word only. Do not use tools.', { images: [{ id: 'red', name: 'red.png', mediaType: 'image/png', path: image }] });
    engine.enqueue(t.id, 'Reply only QUEUE-OK. Do not use tools.');
    let result = await done;
    console.log('IMAGE TURN:', result.turns[0].answer.trim());
    console.log('QUEUED TURN:', result.turns[1].answer.trim());
    if (!/red/i.test(result.turns[0].answer)) throw Error('Image was not understood');
    if (!result.turns[1].answer.includes('QUEUE-OK')) throw Error('Queued message was not sent');
    done = settle(3);
    await engine.send(t.id, 'First say "Running it now." in one short sentence, then use the Bash tool to run exactly: echo desk-ok . After it finishes reply only FINISHED.');
    result = await done;
    const turn = result.turns[2];
    console.log('ITEMS:', turn.items.map(i => i.type === 'tool' ? 'tool:' + turn.tools.find(x => x.id === i.id)?.name : i.type + ':' + i.text.trim().slice(0, 30)).join(' | '));
    const toolAt = turn.items.findIndex(i => i.type === 'tool'), last = turn.items.filter(i => i.type === 'text').at(-1);
    if (toolAt < 0 || !turn.items.slice(toolAt + 1).some(i => i.type === 'text') || !/FINISHED/.test(last.text)) throw Error('Turn items are not in streamed order');
    console.log('LIVE UX TEST PASSED');
  } finally { await engine.shutdown(); }
})().catch(e => { console.error('LIVE UX TEST FAILED:', e.message); process.exitCode = 1; });
