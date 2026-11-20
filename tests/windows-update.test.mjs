import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {observeWindowsUpdate} from '../src/windows-update.mjs';
import {windowsServiceNode} from '../src/windows-launcher.mjs';

test('Store update recovery survives watcher restarts and offers once per affected package',async t=>{
 const stateRoot=await fs.mkdtemp(path.join(os.tmpdir(),'infobar-update-'));
 t.after(()=>fs.rm(stateRoot,{recursive:true,force:true}));
 const first='OpenAI.Codex_26.1111.9664.0_x64__2p2nqsd0c76g0';
 const second=first.replace('1111.9664','1117.3838');
 const offers=[];
 const observe=(pkg,action,args='ChatGPT.exe',offer=(...values)=>offers.push(values),pid=72)=>
  observeWindowsUpdate({stateRoot,app:{app:path.join(stateRoot,pkg)},action,processRecord:{pid,args},offer});
 await observe(first,'needs-debug-launch');
 await observe(first,'attach');
 await observe(first,'needs-debug-launch');
 await observe(second,'idle');
 await observe(second,'needs-debug-launch',null);
 await observe(second,'debug-starting');
 assert.equal(offers.length,0);
 await assert.rejects(observe(second,'needs-debug-launch','ChatGPT.exe',()=>{throw new Error('spawn failed');}),/spawn failed/);
 // The launcher exited before showing a prompt for the first process.
 await observe(second,'needs-debug-launch');
 await observe(second,'needs-debug-launch','ChatGPT.exe',undefined,73);
 const prompts=path.join(stateRoot,'update-prompts');
 await fs.mkdir(prompts);
 await fs.writeFile(path.join(prompts,second),'');
 await observe(second,'needs-debug-launch');
 await observe(second,'attach');
 await observe(second,'needs-debug-launch');
 assert.deepEqual(offers,[[72,second],[73,second]]);
});

test('installed service Node survives removal of its Store runtime',async t=>{
 const stateRoot=await fs.mkdtemp(path.join(os.tmpdir(),'infobar-service-node-'));
 t.after(()=>fs.rm(stateRoot,{recursive:true,force:true}));
 const bin=path.join(stateRoot,'WindowsApps','Runtime_1.0','bin');
 await fs.mkdir(bin,{recursive:true});
 for(const name of ['node.exe','vcruntime140_1.dll','msvcp140_atomic_wait.dll'])await fs.writeFile(path.join(bin,name),name);
 const source=path.join(bin,'node.exe');
 const installed=await windowsServiceNode(stateRoot,source);
 assert.equal(await windowsServiceNode(stateRoot,source),installed);
 await fs.rm(bin,{recursive:true});
 for(const name of ['node.exe','vcruntime140_1.dll','msvcp140_atomic_wait.dll'])assert.equal(await fs.readFile(path.join(path.dirname(installed),name),'utf8'),name);
});
