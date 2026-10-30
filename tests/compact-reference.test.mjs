import test from 'node:test';
import assert from 'node:assert/strict';
import {compactReference} from '../src/compact-reference.mjs';
test('model-default reference uses raw window, checks usable window and remains explicitly approximate',()=>{
  const models=[{slug:'model',context_window:272000,effective_context_window_percent:95}];
  const s={model:'model',contextWindowTokens:258400,contextUsedTokens:200000};
  assert.deepEqual(compactReference(s,models),{kind:'model-default-reference',limit:244800,remaining:44800,remainingPercent:44800/244800*100});
  assert.equal(compactReference({...s,contextUsedTokens:250000},models).remaining,0);
  assert.equal(compactReference({...s,contextWindowTokens:500000},models),null);
  assert.equal(compactReference({...s,contextUsedTokens:null},models),null);
  assert.equal(compactReference({...s,model:'unknown'},models),null);
});
