import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {powershell,psLiteral} from '../src/platform.mjs';import {startupRegistryBase,inspectWindowsStartupTask,syncWindowsStartupTask,restoreWindowsStartupTask,windowsLoginMode,windowsStartupCommand} from '../src/windows-startup.mjs';

test('Windows login routing preserves the prior auto-open preference and always uses the stable login launcher',()=>{
 assert.equal(windowsLoginMode({task:{state:2}}),'launch');assert.equal(windowsLoginMode({task:{state:1}}),'manual');assert.equal(windowsLoginMode({task:{state:null,defaultEnabled:true}}),'launch');
 assert.equal(windowsLoginMode({requested:'manual',prior:'launch',task:{state:2}}),'manual');assert.equal(windowsLoginMode({prior:'launch',task:{state:1}}),'launch');assert.throws(()=>windowsLoginMode({requested:'bad'}),/login mode/);
 assert.equal(windowsStartupCommand({mode:'launch',launcher:'C:\\state dir\\launcher.exe',node:'node',watcher:'watcher'}),'"C:\\state dir\\launcher.exe" --login');assert.equal(windowsStartupCommand({mode:'manual',node:'node',watcher:'watcher'}),'"node" "watcher"');
});

test('official startup is backed up, disabled across package versions, restored on uninstall and policy is respected',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const root=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(root,'infobar startup ')),testKey='Registry::HKEY_CURRENT_USER\\Software\\Codex-InfoBar-Tests\\'+randomUUID();
 // Redirect every native registry operation into a unique test key. No real
 // Codex startup setting is read or written by this test.
 const run=script=>powershell(script.replaceAll(startupRegistryBase,testKey));
 t.after(async()=>{await powershell(`Remove-Item -LiteralPath ${psLiteral(testKey)} -Recurse -Force -ErrorAction SilentlyContinue`);if(!path.resolve(directory).startsWith(root+path.sep))throw new Error('Unsafe fixture cleanup');await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const app={app:directory,executable:path.join(directory,'app/ChatGPT.exe')},stateRoot=path.join(directory,'state');
 const writeManifest=async version=>fs.writeFile(path.join(directory,'AppxManifest.xml'),`<Package><Identity Name="OpenAI.Codex" Version="${version}"/><Applications><Application Id="App"><Extensions><Extension Category="windows.startupTask" Executable="app/ChatGPT.exe"><StartupTask TaskId="App" Enabled="true"/></Extension></Extensions></Application></Applications></Package>`);
 const set=state=>powershell(`New-Item -Path ${psLiteral(testKey+'\\App')} -Force|Out-Null;New-ItemProperty -LiteralPath ${psLiteral(testKey+'\\App')} -Name State -Value ${state} -PropertyType DWord -Force|Out-Null`);
 await writeManifest('1.0.0.0');await set(2);assert.equal((await inspectWindowsStartupTask({app,run})).state,2);
 assert.equal((await syncWindowsStartupTask({app,stateRoot,run,mode:'launch'})).updated,true);assert.equal((await inspectWindowsStartupTask({app,run})).state,1);
 await writeManifest('2.0.0.0');assert.equal((await syncWindowsStartupTask({app,stateRoot,run,onlyIfManaged:true})).updated,false);assert.equal((await inspectWindowsStartupTask({app,run})).state,1);
 let saved=JSON.parse(await fs.readFile(path.join(stateRoot,'startup-routing.json'),'utf8'));assert.equal(saved.entries[0].originalState,2,'reinstall never overwrites the original enabled state');
 await restoreWindowsStartupTask({stateRoot,run});assert.equal((await inspectWindowsStartupTask({app,run})).state,2);
 await syncWindowsStartupTask({app,stateRoot,run,mode:'launch'});await set(0);assert.deepEqual((await restoreWindowsStartupTask({stateRoot,run})).skipped,['App']);assert.equal((await inspectWindowsStartupTask({app,run})).state,0,'a later user disable is preserved');
 await set(4);await assert.rejects(syncWindowsStartupTask({app,stateRoot,run,mode:'launch'}),/policy-controlled/);assert.equal((await inspectWindowsStartupTask({app,run})).state,4);
});
