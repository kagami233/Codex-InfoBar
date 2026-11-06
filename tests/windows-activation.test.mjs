import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';
import {ensureWindowsLauncher} from '../src/windows-launcher.mjs';import {powershell,psLiteral} from '../src/platform.mjs';

test('activation waits for a naturally exiting instance, focuses a live window and uses available package activation',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const root=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(root,'infobar activation ')),children=[];
 t.after(async()=>{for(const child of children){if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}}if(!path.resolve(directory).startsWith(root+path.sep))throw new Error('Unsafe fixture cleanup');await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const launcher=await ensureWindowsLauncher({stateRoot:path.join(directory,'state'),app:{executable:process.execPath},run:powershell});
 const load=`[Reflection.Assembly]::LoadFile(${psLiteral(launcher.executable)})|Out-Null;`;
 const closing=path.join(directory,'closing/ChatGPT.exe'),live=path.join(directory,'live/ChatGPT.exe');await fs.mkdir(path.dirname(closing));await fs.mkdir(path.dirname(live));
 await powershell(`Add-Type -TypeDefinition 'using System;using System.IO;using System.Threading;public static class ClosingFixture{[STAThread]public static void Main(string[] args){File.WriteAllText(args[0],"closing");Thread.Sleep(3000);File.AppendAllText(args[0],";natural-exit");}}' -OutputAssembly ${psLiteral(closing)} -OutputType WindowsApplication`);
 await powershell(`Add-Type -TypeDefinition ${psLiteral(await fs.readFile(new URL('./fixtures/tray-app.cs',import.meta.url),'utf8'))} -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly ${psLiteral(live)} -OutputType WindowsApplication`);
 async function start(exe,name){const log=path.join(directory,name),child=spawn(exe,[log],{windowsHide:true,stdio:'ignore'});children.push(child);const deadline=Date.now()+10000;while(Date.now()<deadline){try{if((await fs.stat(log)).size)return {child,log};}catch{}await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Fixture startup timed out');}
 const old=await start(closing,'closing.log');
 assert.equal(await powershell(`${load}$m=[CodexInfoBar.StableLauncher]::InspectMain(${psLiteral(closing)});[CodexInfoBar.StableLauncher]::WaitForExistingWindowOrExit(${psLiteral(closing)},$m,10000)|ConvertTo-Json -Compress`),'false');
 assert.match(await fs.readFile(old.log,'utf8'),/natural-exit/,'waiting must allow the instance to finish by itself');
 const app=await start(live,'live.log');
 const result=JSON.parse(await powershell(`${load}$m=[CodexInfoBar.StableLauncher]::InspectMain(${psLiteral(live)});@{ready=[CodexInfoBar.StableLauncher]::WaitForExistingWindowOrExit(${psLiteral(live)},$m,1000);activated=[CodexInfoBar.StableLauncher]::ActivateExistingWindow(${psLiteral(live)},$m);family=[CodexInfoBar.StableLauncher]::PackageFamily([uint32]$m.Pid)}|ConvertTo-Json -Compress`));
 assert.deepEqual(result,{ready:true,activated:true,family:null});assert.equal(app.child.exitCode,null);assert.doesNotMatch(await fs.readFile(app.log,'utf8'),/query-end-session/);
 const error=await powershell(`${load}try{[CodexInfoBar.StableLauncher]::ActivatePackagedApplication('CodexInfoBar.Tests.Missing_1234567890abc!App','')|Out-Null;throw 'Unexpected activation'}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};$e.HResult.ToString('X8')}`);
 assert.notEqual(error,'80040154','the out-of-process package activation COM class must exist');assert.notEqual(error,'800401F0','COM must be initialized');assert.match(error,/^8[0-9A-F]{7}$/);
});
