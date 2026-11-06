import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {spawn} from 'node:child_process';
import {powershell,psLiteral} from '../src/platform.mjs';import {syncWindowsShell,desiredShellRoute} from '../src/windows-shell.mjs';
test('Windows window routing follows the managed pin and restores properties without touching the client',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const root=await fs.realpath(os.tmpdir()),directory=await fs.mkdtemp(path.join(root,'infobar shell '));let child;
 t.after(async()=>{if(child?.exitCode===null&&child.signalCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}if(!path.resolve(directory).startsWith(root+path.sep))throw new Error('Unsafe cleanup');await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const executable=path.join(directory,'fixture.exe'),log=path.join(directory,'fixture.log');
 await powershell(`Add-Type -TypeDefinition ${psLiteral(await fs.readFile(new URL('./fixtures/tray-app.cs',import.meta.url),'utf8'))} -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly ${psLiteral(executable)} -OutputType WindowsApplication`);
 child=spawn(executable,[log],{windowsHide:true,stdio:'ignore'});
 const deadline=Date.now()+10000;while(Date.now()<deadline){try{if((await fs.readFile(log,'utf8')).includes('ready'))break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
 const launcher={executable:path.join(directory,'stable.exe'),icon:path.join(directory,'icon.ico')},stateRoot=path.join(directory,'state');
 const options={pid:child.pid,app:{executable},stateRoot,launcher,run:powershell};
 const first=await syncWindowsShell(options);assert.equal(first.updated,1,JSON.stringify(first));assert.equal(child.exitCode,null);
 assert.equal((await syncWindowsShell(options)).updated,0,'existing routing is idempotent');
 const file=path.join(stateRoot,'shell-windows.json'),saved=JSON.parse(await fs.readFile(file,'utf8'));
 assert.deepEqual(saved.entries[0].applied,desiredShellRoute(launcher.executable,launcher.icon+',0'));assert.equal(saved.entries[0].original.relaunch,null);
 await assert.rejects(syncWindowsShell({...options,app:{executable:executable+'.wrong'}}),/identity changed/);assert.equal(child.exitCode,null);
 assert.equal((await syncWindowsShell({...options,restore:true})).updated,1);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).entries.length,0);
 assert.equal((await syncWindowsShell(options)).updated,1,'restore returns the fixture to its original properties');
});
