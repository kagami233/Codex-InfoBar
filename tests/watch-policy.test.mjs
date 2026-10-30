import test from 'node:test';
import assert from 'node:assert/strict';
import { WatchPolicy } from '../src/watch-policy.mjs';
test('protect existing app indefinitely; attach only when endpoint verified', () => {
  const p = new WatchPolicy(10, 0);
  assert.equal(p.decide({pid:10, now:999999}), 'existing');
  assert.equal(p.decide({pid:10, ready:true}), 'attach');
});
test('only new launches restart after grace; no repeated restarts', () => {
  const p = new WatchPolicy(10, 0);
  p.decide({pid:null, now:100});
  assert.equal(p.decide({pid:20, now:1000}), 'waiting');
  assert.equal(p.decide({pid:20, now:16000}), 'restart');
  assert.equal(p.decide({pid:20, now:999999}), 'failed');
  p.protect(21);
  assert.equal(p.decide({pid:21, now:999999}), 'failed');
});
test('foreign port and cooldown prevent restart', () => {
  const p = new WatchPolicy(null,0);
  p.decide({pid:20, now:0});
  assert.equal(p.decide({pid:20, occupied:true, now:20000}), 'port-conflict');
  assert.equal(p.decide({pid:20, now:20000}), 'restart');
  p.decide({pid:30, now:30000});
  assert.equal(p.decide({pid:30, now:50000}), 'waiting');
});
