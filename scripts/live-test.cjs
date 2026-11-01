const path = require('node:path');
const fs = require('node:fs');
const { Engine, JsonStore } = require('../engine.cjs');
(async () => {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const root = path.resolve(__dirname, '../../../work/claude-desk-live'); fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'state.json');
  const engine = new Engine({ query, store: new JsonStore(file), cliPath: path.join(process.env.USERPROFILE, '.local/bin/claude.exe') });
  const project = engine.addProject(root); const t = engine.create(project.id);
  function completed() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { engine.removeListener('thread', changed); reject(Error('Live test timed out')); }, 65000);
      function changed(x) { if (x.id !== t.id || !['done', 'error', 'stopped'].includes(x.status)) return; clearTimeout(timeout); engine.removeListener('thread', changed); x.status === 'done' ? resolve(x) : reject(Error(x.error || x.status)); }
      engine.on('thread', changed);
    });
  }
  try {
    let done = completed(); await engine.send(t.id, 'Connectivity test. Remember the exact code SILVER-482. Reply only SILVER-482. Do not use tools.');
    let result = await done; console.log('TURN 1:', result.turns.at(-1).answer);
    done = completed(); await engine.send(t.id, 'What exact code did I ask you to remember? Reply only that code. Do not use tools.');
    result = await done; console.log('TURN 2:', result.turns.at(-1).answer);
    if (!result.turns.at(-1).answer.includes('SILVER-482')) throw Error('Multi-turn context lost');
    await engine.shutdown();
    const restarted = new Engine({ query, store: new JsonStore(file), cliPath: path.join(process.env.USERPROFILE, '.local/bin/claude.exe') });
    const old = restarted.thread(t.id);
    const restartDone = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Restart test timed out')), 65000);
      restarted.on('thread', x => { if(x.id === old.id && ['done','error'].includes(x.status)) { clearTimeout(timer); x.status === 'done' ? resolve(x) : reject(Error(x.error)); } });
    });
    await restarted.send(old.id, 'What code did I ask you to remember earlier? Reply only that code. Do not use tools.');
    const restored = await restartDone; console.log('AFTER RESTART:', restored.turns.at(-1).answer);
    if (!restored.turns.at(-1).answer.includes('SILVER-482')) throw Error('Saved context lost');
    await restarted.shutdown(); console.log('LIVE MULTI-TURN + RESTART PASSED');
  } finally { await engine.shutdown(); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
