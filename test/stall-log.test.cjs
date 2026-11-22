const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {startStallLog}=require('../stall-log.cjs');

const wait=ms=>new Promise(r=>setTimeout(r,ms));
function spinForStallTest(ms){const end=Date.now()+ms;while(Date.now()<end);}
function waitForLockForStallTest(file){
  const holder=new DatabaseSync(file),waiter=new DatabaseSync(file);
  holder.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS t(a)');waiter.exec('PRAGMA busy_timeout=1600');
  holder.exec('BEGIN IMMEDIATE');let locked=false;
  try{waiter.exec('BEGIN IMMEDIATE');}catch{locked=true;}
  holder.exec('ROLLBACK');holder.close();waiter.close();return locked;
}

test('a stalled main thread is logged with the IPC request in progress, its JS stack and the time it took',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'desk-stall-')),file=path.join(root,'logs','stalls.log');
  const stalls=startStallLog(file,{threshold:500});
  try{
    await wait(400);
    const done=stalls.begin('project:files');spinForStallTest(1500);done();
    await wait(600);
    let log=fs.readFileSync(file,'utf8');
    assert.match(log,/主进程卡住超过 0\.5 秒，正在处理：project:files/);
    assert.match(log,/调用栈：\n  spinForStallTest test\/stall-log\.test\.cjs:6:/);
    assert.match(log,/主进程恢复，共卡住 1\.\d 秒/);
    // Native code holding the thread (SQLite waiting for a lock) is logged right away under
    // the request name; a stack, if any, is only where JS ran next.
    fs.writeFileSync(file,'');
    const save=stalls.begin('ui:save');assert.equal(waitForLockForStallTest(path.join(root,'db.sqlite')),true);save();
    await wait(600);
    log=fs.readFileSync(file,'utf8');
    assert.match(log,/主进程卡住超过 0\.5 秒，正在处理：ui:save/);
    assert.match(log,/主进程恢复，共卡住 1\.\d 秒/);
    fs.writeFileSync(file,'');spinForStallTest(800);await wait(400);
    assert.match(fs.readFileSync(file,'utf8'),/不在处理界面请求/);
    // Idle time is not a stall, and the label goes back to what was running before.
    fs.writeFileSync(file,'');await wait(1200);assert.equal(fs.readFileSync(file,'utf8'),'');
  }finally{await stalls.close();}
});

test('an oversized log is moved aside on start',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'desk-stall-')),file=path.join(root,'stalls.log');
  fs.writeFileSync(file,'x'.repeat(2000));
  const stalls=startStallLog(file,{maxBytes:1000});await stalls.close();
  assert.equal(fs.readFileSync(path.join(root,'stalls.old.log'),'utf8').length,2000);assert.equal(fs.existsSync(file),false);
});
