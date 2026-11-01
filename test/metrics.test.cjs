const {test}=require('node:test');const assert=require('node:assert/strict');const load=()=>import('../ui/src/lib/metrics.mjs');
test('reply tok/s uses official output tokens and full turn elapsed time, excluding input/cache tokens',async()=>{const {replySpeed}=await load();
  assert.equal(replySpeed({startedAt:1000,finishedAt:5000,usage:{input:9000,cache:8000,output:100}}),25);
  assert.equal(replySpeed(JSON.parse(JSON.stringify({startedAt:1000,finishedAt:3000,usage:{output:15}}))),7.5);
});
test('reply tok/s stays unknown for live, imported, missing or invalid statistics',async()=>{const {replySpeed}=await load();
  for(const value of [{},{startedAt:1000,usage:{output:5}},{startedAt:1000,finishedAt:1000,usage:{output:5}},{startedAt:2000,finishedAt:1000,usage:{output:5}},{startedAt:1000,finishedAt:2000,usage:{output:NaN}},{startedAt:1000,finishedAt:2000,usage:{output:-1}},{startedAt:1000,finishedAt:2000,usage:{output:0}}])assert.equal(replySpeed(value),null);
});
