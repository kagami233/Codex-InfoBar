import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateCompaction,readCompactionPolicy} from '../src/compaction-estimate.mjs';
const models=[{slug:'model',context_window:272000,effective_context_window_percent:95}];
const base={model:'model',contextWindowTokens:258400,contextUsedTokens:150000};
const disabled={asyncEnabled:false};
test('resolved earlier triggers, observed compactions and request growth reduce optimistic model-only estimates',()=>{
 const prior=estimateCompaction(base,models,disabled);
 assert.equal(prior.limit,244800);
 const async=estimateCompaction(base,models,{asyncEnabled:true});
 assert.equal(async.limit,176800);
 assert.ok(async.remainingPercent<prior.remainingPercent);
 assert.equal(estimateCompaction(base,models,{asyncEnabled:true,tokenBudget:true}).limit,244800);
 assert.equal(estimateCompaction(base,models,{...disabled,postTurnPercent:60}).limit,155040);
 assert.equal(estimateCompaction(base,models,{...disabled,limit:170000}).limit,170000);
 const calibrated=estimateCompaction({...base,compactionSamples:[{model:'model',contextWindow:258400,tokens:190000,trigger:'auto'}]},models,disabled);
 assert.equal(calibrated.limit,184300);
 assert.equal(calibrated.source,'observed-auto');
 const near=estimateCompaction({...base,contextUsedTokens:180000,recentContextGrowth:[10000]},models,{...disabled,limit:190000});
 assert.equal(near.remaining,0,'reserve includes likely next-request growth');
});
test('manual, other-model and other-window samples cannot calibrate this chat; unresolved features use a conservative prior',()=>{
 for(const change of [{trigger:'manual'},{model:'other'},{contextWindow:999999}]){
  const sample={model:'model',contextWindow:258400,tokens:160000,trigger:'auto',...change};
  assert.equal(estimateCompaction({...base,compactionSamples:[sample]},models,disabled).limit,244800);
 }
 assert.equal(estimateCompaction(base,models).source,'unresolved-feature-prior');
 assert.equal(estimateCompaction({...base,contextUsedTokens:null},models),null);
 assert.equal(estimateCompaction({...base,contextWindowTokens:null},models),null);
 assert.equal(estimateCompaction(base,models,{...disabled,scope:'body_after_prefix',limit:10000}).limit,244800,'growth limit must not be subtracted from total usage');
 assert.ok(estimateCompaction({...base,contextUsedTokens:999999},models).remainingPercent===0);
});
test('read-only config lookup sanitizes responses and caches by project directory',async()=>{
 let calls=0;
 const client={evaluate:async expression=>{calls++;assert.match(expression,/config\/read/);assert.match(expression,/experimentalFeature\/list/);return {limit:123456,scope:'total',asyncEnabled:false,postTurnPercent:70,password:'private'};}};
 const p=await readCompactionPolicy(client,'/test/project');
 assert.equal(p.limit,123456);assert.equal(p.asyncEnabled,false);assert.equal(p.password,undefined);
 await readCompactionPolicy(client,'/test/project');assert.equal(calls,1);
 await readCompactionPolicy(client,'/test/other');assert.equal(calls,2);
});
