const {test}=require('node:test'),assert=require('node:assert/strict');
const {NotificationSounds,soundForNotice}=require('../notification-sounds.cjs');

test('attention and completion have separate sounds; informational tray messages remain silent',()=>{
  assert.equal(soundForNotice('done'),'complete');
  for(const kind of ['approval','question','plan','error'])assert.equal(soundForNotice(kind),'attention');
  for(const kind of [undefined,'tray','idle'])assert.equal(soundForNotice(kind),null);
});

test('hidden sound player works while the main window is hidden, rate limits duplicates and closes cleanly',async()=>{
  let now=0;const windows=[],sent=[];
  class Window{
    constructor(options){this.options=options;this.webContents={send:(...args)=>sent.push(args)};windows.push(this);}
    loadFile(file){this.file=file;return Promise.resolve();}
    isDestroyed(){return Boolean(this.dead);}
    destroy(){this.dead=true;}
  }
  const player=new NotificationSounds({BrowserWindow:Window,now:()=>now});
  assert.equal(await player.play('tray'),false);assert.equal(windows.length,0);
  assert.equal(await player.play('done'),true);assert.equal(windows[0].options.show,false);
  assert.equal(windows[0].options.webPreferences.backgroundThrottling,false);
  assert.equal(windows[0].options.webPreferences.sandbox,true);
  assert.equal(await player.play('done'),false);
  // A new question can supersede a just-finished task, but several questions do not stack sounds.
  assert.equal(await player.play('question'),true);assert.equal(await player.play('approval'),false);
  now=1500;assert.equal(await player.play('done'),true);assert.equal(windows.length,1);
  assert.deepEqual(sent.map(s=>s[1]),['complete','attention','complete']);
  player.close();now=3000;assert.equal(await player.play('question'),false);assert.equal(windows[0].dead,true);
});

test('closing during sound-window startup never sends playback after quit',async()=>{
  let ready,sent=false;
  class Window{constructor(){this.webContents={send:()=>{sent=true;}};}loadFile(){return new Promise(r=>{ready=r;});}isDestroyed(){return Boolean(this.dead);}destroy(){this.dead=true;}}
  const player=new NotificationSounds({BrowserWindow:Window});const pending=player.play('question');player.close();ready();
  assert.equal(await pending,false);assert.equal(sent,false);
});
