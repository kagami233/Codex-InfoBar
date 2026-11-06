import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';
import {ensureWindowsLauncher} from '../src/windows-launcher.mjs';import {powershell,psLiteral} from '../src/platform.mjs';

test('launcher recovery requires confirmation, rejects changed identities and respects shutdown vetoes',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const root=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(root,'infobar recovery ')),children=[];
 t.after(async()=>{for(const child of children){if(child.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}}if(!path.resolve(directory).startsWith(root+path.sep))throw new Error('Unsafe cleanup');await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const launcher=await ensureWindowsLauncher({stateRoot:path.join(directory,'state'),app:{executable:process.execPath},run:powershell});
 const executable=path.join(directory,'ChatGPT.exe');
 await powershell(`Add-Type -TypeDefinition ${psLiteral(await fs.readFile(new URL('./fixtures/tray-app.cs',import.meta.url),'utf8'))} -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly ${psLiteral(executable)} -OutputType WindowsApplication`);
 async function fixture(veto){const log=path.join(directory,veto?'veto.log':'normal.log'),child=spawn(executable,[log,...(veto?['veto']:[])],{windowsHide:true,stdio:'ignore'});children.push(child);const deadline=Date.now()+10000;while(Date.now()<deadline){try{if((await fs.readFile(log,'utf8')).includes('ready'))return {child,log};}catch{}await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('Fixture startup timed out');}
 const load=`[Reflection.Assembly]::LoadFile(${psLiteral(launcher.executable)})|Out-Null;$m=[CodexInfoBar.StableLauncher]::InspectMain(${psLiteral(executable)});`;
 const repair=(confirm,mutate='')=>powershell(`${load}${mutate}[CodexInfoBar.StableLauncher]::RepairExisting(${psLiteral(executable)},$m,${confirm?'$true':'$false'})|ConvertTo-Json -Compress`);
 const normal=await fixture(false);
 assert.equal(await repair(false),'false');assert.equal(normal.child.exitCode,null);assert.doesNotMatch(await fs.readFile(normal.log,'utf8'),/query-end-session/,'cancel must not even request shutdown');
 await assert.rejects(repair(true,'$m.Created+=1;'),/changed while waiting/);assert.equal(normal.child.exitCode,null);
 await assert.rejects(powershell(`${load}[CodexInfoBar.WindowsQuit]::Request([uint32]$m.Pid,${psLiteral(executable)},$m.Created+1)`),/creation time changed/);assert.equal(normal.child.exitCode,null);
 assert.equal(await repair(true),'true');if(normal.child.exitCode===null)await new Promise(resolve=>normal.child.once('exit',resolve));assert.match(await fs.readFile(normal.log,'utf8'),/query-end-session[\s\S]*end-session/);
 const veto=await fixture(true);await assert.rejects(repair(true),/refused normal shutdown/);assert.equal(veto.child.exitCode,null);assert.doesNotMatch(await fs.readFile(veto.log,'utf8'),/^end-session$/m);
});
