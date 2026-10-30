import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {watcherOwner,stopWatcher,inspectWatcher} from '../src/service-state.mjs';

const script=path.join(os.tmpdir(),'InfoBar space','watcher.mjs');
const lock={pid:12345,script};
const owner={pid:lock.pid,command:process.execPath,args:`"${process.execPath}" "${script}"`};
async function fixture(t){const stateRoot=await fs.mkdtemp(path.join(os.tmpdir(),'infobar-state-'));t.after(async()=>{if(!path.resolve(stateRoot).startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('Unsafe cleanup');await fs.rm(stateRoot,{recursive:true,force:true});});await fs.writeFile(path.join(stateRoot,'watcher-lock.json'),JSON.stringify(lock));return {stateRoot,allowedScripts:[script]};}

test('watcher lock verifies its exact script and detects PID reuse instead of trusting PID existence',()=>{
 assert.equal(watcherOwner(lock,[owner],[script]),owner);
 assert.equal(watcherOwner(lock,[{...owner,args:'node other.mjs'}],[script]),null);
 assert.equal(watcherOwner(lock,[{...owner,args:`node "${script}.backup"`}],[script]),null);
 assert.equal(watcherOwner(lock,[],[script]),null);
 assert.throws(()=>watcherOwner({...lock,script:script+'.other'},[],[script]),/identity/);
 assert.throws(()=>watcherOwner(lock,[{pid:lock.pid}],[script]),/Cannot verify/);
});

test('reinstall removes an exited watcher lock and does not touch an unrelated process with the reused PID',async t=>{
 const options=await fixture(t);
 await stopWatcher({...options,readProcesses:async()=>[{...owner,args:'node unrelated.mjs'}],timeout:0});
 await assert.rejects(fs.access(path.join(options.stateRoot,'watcher-lock.json')),/ENOENT/);
});

test('stop respects a live owner and never deletes a replacement lock during process verification',async t=>{
 const options=await fixture(t);let queries=0;
 await assert.rejects(stopWatcher({...options,timeout:0,readProcesses:async()=>{if(queries++===0){await fs.writeFile(path.join(options.stateRoot,'watcher-lock.json'),JSON.stringify({...lock,pid:54321}));return [];}return [{...owner,pid:54321}];}}),/did not stop/);
 assert.equal(JSON.parse(await fs.readFile(path.join(options.stateRoot,'watcher-lock.json'),'utf8')).pid,54321);
});

test('diagnostics reject old, future and mismatched status even when a watcher process exists',async t=>{
 const options=await fixture(t),now=100000;
 for(const status of [{observedAt:now},{watcherPid:999,observedAt:now},{watcherPid:lock.pid,observedAt:now+1},{watcherPid:lock.pid,observedAt:now-60000}]){
  await fs.writeFile(path.join(options.stateRoot,'status.json'),JSON.stringify(status));
  assert.equal((await inspectWatcher({...options,readProcesses:async()=>[owner],now})).fresh,false);
 }
 await fs.writeFile(path.join(options.stateRoot,'status.json'),JSON.stringify({watcherPid:lock.pid,observedAt:now-10}));
 assert.equal((await inspectWatcher({...options,readProcesses:async()=>[owner],now})).fresh,true);
 assert.equal((await inspectWatcher({...options,readProcesses:async()=>[],now})).alive,false);
});

test('a hung project watcher is retired only after cooperative stop times out and its identity is verified',async t=>{
 const options=await fixture(t);let alive=true,retired=0;
 await stopWatcher({...options,timeout:0,readProcesses:async()=>alive?[owner]:[],retire:async(record,oldLock)=>{assert.equal(record,owner);assert.deepEqual(oldLock,lock);alive=false;retired++;}});
 assert.equal(retired,1);
 await assert.rejects(fs.access(path.join(options.stateRoot,'watcher-lock.json')),/ENOENT/);
});

test('status written during process lookup is compared with the time after lookup, not an earlier snapshot',async t=>{
 const options=await fixture(t);
 const result=await inspectWatcher({...options,readProcesses:async()=>{await new Promise(resolve=>setTimeout(resolve,5));await fs.writeFile(path.join(options.stateRoot,'status.json'),JSON.stringify({watcherPid:lock.pid,observedAt:Date.now()}));return [owner];}});
 assert.equal(result.fresh,true);
});

test('reinstall tolerates CIM briefly returning an exiting process without identity metadata',async t=>{
 const options=await fixture(t);let queries=0;
 await stopWatcher({...options,interval:1,timeout:1000,readProcesses:async()=>queries++===0?[{pid:lock.pid}]:[],retire:async()=>{throw new Error('Unverified processes must never be terminated');}});
 assert.equal(queries,2);
 await assert.rejects(fs.access(path.join(options.stateRoot,'watcher-lock.json')),/ENOENT/);
});
