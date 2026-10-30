import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {powershell,processes,psLiteral} from '../src/platform.mjs';
import {requestWindowsQuit,startWindowsDetached,retireWindowsWatcher} from '../src/windows-native.mjs';
import {runWindowsSession,windowsSessionFlag} from '../src/windows-session.mjs';
import {pathToFileURL} from 'node:url';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate, timeout=15000) {
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(await predicate())return;await sleep(100);}
 throw new Error('Isolated Windows fixture timed out');
}
async function temp(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"infobar O'Brien "));
 const disposers=[];
 t.after(async()=>{for(const dispose of disposers.reverse())await dispose();if(!path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('Unsafe fixture cleanup path');await fs.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 return {directory,disposers};
}

test('Windows native lifecycle handles close-to-tray, vetoes and process identity without killing Codex', {skip:process.platform!=='win32',timeout:120000}, async t=>{
 const {directory,disposers}=await temp(t);
 const executable=path.join(directory,'tray fixture.exe');
 const source=await fs.readFile(new URL('./fixtures/tray-app.cs',import.meta.url),'utf8');
 await powershell(`Add-Type -TypeDefinition ${psLiteral(source)} -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly ${psLiteral(executable)} -OutputType WindowsApplication`);
 async function fixture(veto){
  const log=path.join(directory,veto?'veto.log':'tray.log');
  const child=spawn(executable,[log,...(veto?['veto']:[])],{windowsHide:true,stdio:'ignore'});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  disposers.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;});
  await waitFor(async()=>{try{return (await fs.readFile(log,'utf8')).includes('ready');}catch{return false;}});
  return {log,child,exited};
 }
 const app=await fixture(false);
 const handle=Number((await fs.readFile(app.log,'utf8')).match(/ready:(\d+)/)[1]);
 await powershell(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class FixtureClose{[DllImport("user32.dll")]public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);}';[FixtureClose]::SendMessage([IntPtr]${handle},0x10,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null`);
 await waitFor(async()=>(await fs.readFile(app.log,'utf8')).includes('close-hidden'));
 assert.equal(app.child.exitCode,null,'Closing the window reproduces the tray bug');
 assert.equal(await powershell(`(Get-Process -Id ${app.child.pid}).CloseMainWindow()|ConvertTo-Json -Compress`),'false','Old shutdown cannot exit a hidden tray application');
 await assert.rejects(requestWindowsQuit(executable+'.wrong',app.child.pid,powershell),/identity changed/);
 assert.equal(app.child.exitCode,null,'An executable mismatch must not close the fixture');
 assert.equal(await requestWindowsQuit(executable,app.child.pid,powershell),true);
 await waitFor(()=>app.child.exitCode!==null);
 const messages=await fs.readFile(app.log,'utf8');
 assert.match(messages,/query-end-session/);assert.match(messages,/end-session/);
 const refusing=await fixture(true);
 await assert.rejects(requestWindowsQuit(executable,refusing.child.pid,powershell),/graceful shutdown declined/);
 assert.equal(refusing.child.exitCode,null,'A veto must leave the application running');
 assert.doesNotMatch(await fs.readFile(refusing.log,'utf8'),/^end-session$/m);
});

test('Windows independent launch round-trips paths, arguments and user environment after the launcher returns', {skip:process.platform!=='win32',timeout:30000}, async t=>{
 const {directory,disposers}=await temp(t),script=path.join(directory,'child fixture.mjs'),output=path.join(directory,'result.json');
 await fs.writeFile(script,"import fs from 'node:fs';fs.writeFileSync(process.env.INFOBAR_TEST_OUTPUT,JSON.stringify({args:process.argv.slice(2),marker:process.env.INFOBAR_TEST_MARKER}));setTimeout(()=>{},20000);");
 const env={};for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
 env.INFOBAR_TEST_OUTPUT=output;env.INFOBAR_TEST_MARKER="O'Brien $(not a shell)";
 const args=['plain','space in value','quote"inside','trailing\\','space trailing\\'];
 const pid=await startWindowsDetached(process.execPath,[script,...args],{cwd:directory,env,run:powershell});
 disposers.push(async()=>{const row=(await processes()).find(record=>record.pid===pid);if(row?.args?.includes(script)){process.kill(pid);await waitFor(()=>{try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}});}});
 await waitFor(async()=>{try{return (await fs.stat(output)).size>0;}catch{return false;}});
 assert.deepEqual(JSON.parse(await fs.readFile(output,'utf8')),{args,marker:env.INFOBAR_TEST_MARKER});
 const row=(await processes()).find(record=>record.pid===pid);
 assert.ok(row,'Watcher process survives the WMI launcher returning');
 assert.notEqual(row.parent,process.pid,'The long-lived process is not a child of the installer');
 const session=JSON.parse(await powershell(`@{child=(Get-Process -Id ${pid}).SessionId;caller=(Get-Process -Id ${process.pid}).SessionId}|ConvertTo-Json -Compress`));
 assert.equal(session.child,session.caller,'Native desktop operations stay in the user session');
 await assert.rejects(retireWindowsWatcher(row,{script:script+'.wrong'},powershell),/entry point/);
 assert.ok((await processes()).some(record=>record.pid===pid),'A mismatched script must not be retired');
 await retireWindowsWatcher(row,{script},powershell);
 assert.ok(!(await processes()).some(record=>record.pid===pid),'Only the verified project process is retired');
});

test('Windows session runs the same module and returns real user-session output and failure status', {skip:process.platform!=='win32',timeout:30000}, async t=>{
 const {directory}=await temp(t);
 const source=path.join(directory,'src');await fs.mkdir(source);
 const entry=path.join(source,'fixture.mjs');
 await fs.writeFile(entry,"console.log(JSON.stringify({args:process.argv.slice(2),hasSecret:process.env.INFOBAR_TEST_SECRET!==undefined,hasSystemDrive:Boolean(process.env.SystemDrive)}));process.exitCode=7;");
 const prior=process.env.INFOBAR_TEST_SECRET;process.env.INFOBAR_TEST_SECRET='test-only-value';
 try{
  assert.equal(await runWindowsSession(pathToFileURL(entry),['space and "quote"'],{run:powershell,timeout:15000}),7);
 }finally{if(prior===undefined)delete process.env.INFOBAR_TEST_SECRET;else process.env.INFOBAR_TEST_SECRET=prior;}
 const results=await fs.readdir(path.join(directory,'output'));
 const report=JSON.parse(await fs.readFile(path.join(directory,'output',results[0],'result.json'),'utf8'));
 assert.deepEqual(JSON.parse(report.output[0]),{args:['space and "quote"',windowsSessionFlag],hasSecret:false,hasSystemDrive:true});
 assert.notEqual(report.pid,process.pid);
});
