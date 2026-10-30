import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncWindowsShortcuts,restoreWindowsShortcuts,debugArguments} from '../src/windows-shortcuts.mjs';
import {powershell,psLiteral} from '../src/platform.mjs';

test('Windows existing icons launch the official executable with loopback debugging and uninstall restores exact originals',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"infobar shortcut O'Brien "));
 t.after(async()=>{if(!path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('Unsafe cleanup');await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const links=path.join(directory,'links');await fs.mkdir(links);
 const executable=path.join(directory,'official fixture.exe');await fs.writeFile(executable,'fixture only; never launched');
 const app={executable},stateRoot=path.join(directory,'state'),link=path.join(links,'Codex.lnk'),custom=path.join(links,'custom.lnk'),foreign=path.join(links,'foreign.lnk');
 async function writeLink(file,target,args=''){await powershell(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${psLiteral(file)});$s.TargetPath=${psLiteral(target)};$s.Arguments=${psLiteral(args)};$s.Description='keep original icon metadata';$s.Save()`);}
 async function readLink(file){return JSON.parse(await powershell(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${psLiteral(file)});@{target=$s.TargetPath;arguments=$s.Arguments;description=$s.Description}|ConvertTo-Json -Compress`));}
 await writeLink(link,executable);await writeLink(custom,executable,'--custom-launch');await writeLink(foreign,process.execPath);
 const before=await fs.readFile(link),otherBefore=await fs.readFile(foreign),customBefore=await fs.readFile(custom);
 const options={app,port:9341,stateRoot,run:powershell,roots:[links]};
 const result=await syncWindowsShortcuts(options);assert.deepEqual(result.updated,[await fs.realpath(link)]);assert.deepEqual(result.skipped,[await fs.realpath(custom)]);
 assert.equal((await readLink(result.launcher)).target,await fs.realpath(executable));
 assert.equal((await readLink(result.launcher)).arguments,debugArguments(9341));
 assert.deepEqual(await readLink(link),{target:await fs.realpath(executable),arguments:debugArguments(9341),description:'keep original icon metadata'});
 assert.deepEqual((await syncWindowsShortcuts(options)).updated,[],'reinstall is idempotent');
 await syncWindowsShortcuts({...options,port:9431});assert.equal((await readLink(link)).arguments,debugArguments(9431));
 assert.deepEqual(await fs.readFile(foreign),otherBefore);assert.deepEqual(await fs.readFile(custom),customBefore);
 await restoreWindowsShortcuts({stateRoot,run:powershell});assert.deepEqual(await fs.readFile(link),before);
 // Shell pinning copies the managed arguments into a new TaskBar shortcut.
 const pinned=path.join(links,'taskbar clone.lnk');await writeLink(pinned,executable,debugArguments(9341));
 await syncWindowsShortcuts(options);
 await syncWindowsShortcuts({...options,port:9431});assert.equal((await readLink(pinned)).arguments,debugArguments(9431));
 await restoreWindowsShortcuts({stateRoot,run:powershell});assert.equal((await readLink(pinned)).arguments,'');
 // A later owner edit must survive both automatic refresh and uninstall.
 await syncWindowsShortcuts(options);await writeLink(link,executable,'--owner-edited');
 assert.deepEqual((await syncWindowsShortcuts(options)).updated,[]);
 await restoreWindowsShortcuts({stateRoot,run:powershell});assert.equal((await readLink(link)).arguments,'--owner-edited');
});
