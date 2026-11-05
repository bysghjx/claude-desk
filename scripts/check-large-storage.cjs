// Opt-in end-to-end check above V8's single-string limit. Uses ~2 GiB of scratch
// disk and removes its own fixture afterwards. Run with Node's 3 GiB heap limit.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {constants}=require('node:buffer');const {DatabaseStore}=require('../database.cjs');
const scratch=path.resolve(__dirname,'../../../work/large-storage-tests');fs.mkdirSync(scratch,{recursive:true});
const root=fs.mkdtempSync(path.join(scratch,'over-limit-'));if(path.dirname(root)!==scratch)throw Error('Invalid scratch path');
const started=Date.now();let store;
try{
  const text='x'.repeat(1024*1024),items=Array.from({length:513},()=>({type:'text',text}));
  const turn={id:'large-turn',user:'over limit',answer:'done',items,tools:[],status:'done'};
  assert.throws(()=>JSON.stringify(turn),{name:'RangeError',message:'Invalid string length'});
  store=new DatabaseStore(root);store.state.threads.push({id:'large',title:'over limit',turns:[turn]});store.save();assert.equal(store.warning,'');
  const largestRow=store.db.prepare('SELECT max(length(CAST(body AS BLOB))) bytes FROM records').get().bytes;
  assert.ok(largestRow<1024*1024);
  const mirror=path.join(root,'sessions',fs.readdirSync(path.join(root,'sessions'))[0]);assert.ok(fs.statSync(mirror).size>constants.MAX_STRING_LENGTH);
  const exported=path.join(root,'backup.json');store.export(exported);assert.ok(fs.statSync(exported).size>constants.MAX_STRING_LENGTH);
  store.close();store=new DatabaseStore(root);const restored=store.state.threads[0].turns[0];assert.equal(restored.items.length,513);for(const item of restored.items)assert.equal(item.text,text);
  const report={maxStringLength:constants.MAX_STRING_LENGTH,legacyStringify:'RangeError: Invalid string length',mirrorBytes:fs.statSync(mirror).size,exportBytes:fs.statSync(exported).size,largestDatabaseValueBytes:largestRow,restoredBlocks:restored.items.length,elapsedSeconds:(Date.now()-started)/1000};
  fs.writeFileSync(path.resolve(scratch,'../large-storage-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{store?.close();fs.rmSync(root,{recursive:true,force:true});}
