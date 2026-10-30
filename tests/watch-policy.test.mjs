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

test('a debug-enabled launch is never restarted even when endpoint readiness is slow or fails',()=>{
 const p=new WatchPolicy(null,0);
 assert.equal(p.decide({pid:20,debugRequested:true,now:0}),'debug-starting');
 assert.equal(p.decide({pid:20,debugRequested:true,now:20000}),'debug-starting');
 assert.equal(p.decide({pid:20,debugRequested:true,now:60001}),'debug-unavailable');
 assert.equal(p.decide({pid:20,debugRequested:true,occupied:true,now:999999}),'debug-unavailable');
 assert.equal(p.decide({pid:20,debugRequested:true,ready:true,now:1000000}),'attach');
 assert.equal(p.attempted.size,0);
});

test('Windows passive mode never closes a client launched through an unconfigured Store pin',()=>{
 const p=new WatchPolicy(null,0);
 for(const now of [0,15000,600001,9999999])assert.equal(p.decide({pid:20,autoRestart:false,now}),'needs-debug-launch');
 assert.equal(p.attempted.size,0);
 assert.equal(p.decide({pid:20,autoRestart:false,ready:true}),'attach');
});

test('a successful mount does not impose the failure cooldown on the next user launch',()=>{
 const p=new WatchPolicy(null,0);
 assert.equal(p.decide({pid:20,now:0}),'waiting');
 assert.equal(p.decide({pid:20,now:15000}),'restart');
 p.protect(21);
 assert.equal(p.decide({pid:21,ready:true,now:20000}),'attach');
 assert.equal(p.decide({pid:null,now:25000}),'idle');
 assert.equal(p.decide({pid:22,now:26000}),'waiting');
 assert.equal(p.decide({pid:22,now:41000}),'restart');
 assert.equal(p.decide({pid:22,now:999999}),'failed','same PID must still never be restarted twice');
});
