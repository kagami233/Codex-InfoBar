import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {syncWindowsShortcuts,restoreWindowsShortcuts,debugArguments} from '../src/windows-shortcuts.mjs';
import {powershell,psLiteral} from '../src/platform.mjs';
import {fileURLToPath} from 'node:url';
import {desiredShellRoute,setShortcutShellRoute,shortcutShellRoute,managedShellAppId} from '../src/windows-shell.mjs';

test('Windows existing icons launch the official executable with loopback debugging and uninstall restores exact originals',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"infobar shortcut O'Brien ")));
 t.after(async()=>{if(!path.resolve(directory).startsWith(path.resolve(await fs.realpath(os.tmpdir()))+path.sep))throw new Error('Unsafe cleanup');await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
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

test('stable pins survive consecutive package changes and default-link recreation without replacing the pin',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'infobar stable pin ')));
 t.after(async()=>{if(!path.resolve(directory).startsWith(path.resolve(await fs.realpath(os.tmpdir()))+path.sep))throw new Error('Unsafe cleanup');await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const links=path.join(directory,'TaskBar'),stateRoot=path.join(directory,'state');await fs.mkdir(links);
 const first=path.join(directory,'first.exe'),next=path.join(directory,'next.exe'),launchTarget=path.join(directory,'stable.exe'),icon=path.join(directory,'stable.ico');
 for(const file of [first,next,launchTarget,icon])await fs.writeFile(file,'fixture only');
 const pin=path.join(links,'same icon.lnk'),clone=path.join(links,'later pin.lnk');
 await powershell(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${psLiteral(pin)});$s.TargetPath=${psLiteral(first)};$s.Description='same name';$s.Save()`);
 const options={app:{executable:first},port:9341,stateRoot,run:powershell,roots:[links],launchTarget,iconLocation:icon+',0'};
 const read=async file=>JSON.parse(await powershell(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${psLiteral(file)});@{target=$s.TargetPath;arguments=$s.Arguments;description=$s.Description}|ConvertTo-Json -Compress`));
 await syncWindowsShortcuts(options);assert.equal((await read(pin)).target,launchTarget);assert.equal((await read(pin)).arguments,'');
 const newer={...options,app:{executable:next}};
 await syncWindowsShortcuts(newer);assert.equal((await read(pin)).target,launchTarget,'target is independent of installed version');
 await fs.copyFile(pin,clone);await syncWindowsShortcuts(newer);
 const route=JSON.parse(await powershell(`Add-Type -LiteralPath ${psLiteral(fileURLToPath(new URL('../src/windows-shell.cs',import.meta.url)))};[CodexInfoBar.WindowsShellRoute]::ReadShortcut(${psLiteral(pin)})|ConvertTo-Json -Compress`));
 await setShortcutShellRoute({file:pin,run:powershell,expected:route,desired:{appId:'com.openai.codex',relaunch:null,displayName:null,icon:null}});
 assert.deepEqual((await syncWindowsShortcuts(newer)).updated,[await fs.realpath(pin)],'an update may reset only Shell metadata while keeping the stable target');
 await setShortcutShellRoute({file:pin,run:powershell,expected:route,desired:{...route,appId:'owner.custom.application'}});
 assert.deepEqual((await syncWindowsShortcuts(newer)).skipped,[await fs.realpath(pin)],'a foreign owner application identity must remain protected');
 await setShortcutShellRoute({file:pin,run:powershell,expected:{...route,appId:'owner.custom.application'},desired:route});
 // Store/Explorer can recreate the same file with the registered app's defaults.
 await fs.rm(pin);
 await powershell(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${psLiteral(pin)});$s.TargetPath=${psLiteral(next)};$s.Arguments='';$s.Description='same name';$s.WorkingDirectory=${psLiteral(path.dirname(next))};$s.IconLocation=',0';$s.Save()`);
 assert.deepEqual((await syncWindowsShortcuts(newer)).updated,[await fs.realpath(pin)]);
 assert.deepEqual(await read(pin),{target:launchTarget,arguments:'',description:'same name'});
 await restoreWindowsShortcuts({stateRoot,run:powershell});
 assert.equal((await read(pin)).target,next);assert.equal((await read(pin)).arguments,'');
 assert.equal((await read(clone)).target,next,'copied stable pins must also return to the official executable');
});

test('Windows upgrade refreshes the same pin despite Explorer binary metadata changes and preserves real owner edits',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'infobar upgrade '));
 t.after(async()=>{if(!path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('Unsafe cleanup');await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const links=path.join(directory,'TaskBar'),stateRoot=path.join(directory,'state');await fs.mkdir(links);
 const oldExe=path.join(directory,'version-1.exe'),newExe=path.join(directory,'version-2.exe');
 await fs.writeFile(oldExe,'fixture; never launched');await fs.writeFile(newExe,'fixture; never launched');
 const pin=path.join(links,'ChatGPT.lnk');
 await powershell(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${psLiteral(pin)});$s.TargetPath=${psLiteral(oldExe)};$s.Description='original title';$s.Save()`);
 const options={app:{executable:oldExe},port:9341,stateRoot,run:powershell,roots:[links]};
 await syncWindowsShortcuts(options);
 // Reproduce v0.3.1 backups and a valid timestamp/tracking-only Shell Link update.
 const stateFile=path.join(stateRoot,'shortcuts.json'),saved=JSON.parse(await fs.readFile(stateFile,'utf8'));
 delete saved.entries[0].metadata;await fs.writeFile(stateFile,JSON.stringify(saved));
 const bytes=await fs.readFile(pin);bytes.writeBigUInt64LE(bytes.readBigUInt64LE(28)+10000000n,28);await fs.writeFile(pin,bytes);
 const result=await syncWindowsShortcuts({...options,app:{executable:newExe}});
 assert.deepEqual(result.updated,[await fs.realpath(pin)],'upgrade must update the existing taskbar pin');
 let current=JSON.parse(await powershell(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${psLiteral(pin)});@{target=$s.TargetPath;arguments=$s.Arguments;description=$s.Description}|ConvertTo-Json -Compress`));
 assert.equal(current.target,await fs.realpath(newExe));assert.equal(current.arguments,debugArguments(9341));assert.equal(current.description,'original title');
 await restoreWindowsShortcuts({stateRoot,run:powershell});
 current=JSON.parse(await powershell(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${psLiteral(pin)});@{target=$s.TargetPath;arguments=$s.Arguments}|ConvertTo-Json -Compress`));
 assert.equal(current.target,await fs.realpath(newExe),'uninstall must not restore a removed package version');assert.equal(current.arguments,'');
 const upgraded={...options,app:{executable:newExe}};await syncWindowsShortcuts(upgraded);
 await powershell(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${psLiteral(pin)});$s.Description='owner changed title';$s.Save()`);
 assert.deepEqual((await syncWindowsShortcuts({...upgraded,port:9431})).skipped,[await fs.realpath(pin)]);
 await restoreWindowsShortcuts({stateRoot,run:powershell});
 current=JSON.parse(await powershell(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${psLiteral(pin)});@{description=$s.Description;arguments=$s.Arguments}|ConvertTo-Json -Compress`));
 assert.equal(current.description,'owner changed title');assert.equal(current.arguments,debugArguments(9341));
});

test('a repinned legacy helper migrates identity and uninstall removes its inherited relaunch command',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'infobar legacy identity ')));
 t.after(async()=>{if(!path.resolve(directory).startsWith(path.resolve(await fs.realpath(os.tmpdir()))+path.sep))throw new Error('Unsafe cleanup');await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const stateRoot=path.join(directory,'state'),links=path.join(directory,'TaskBar');await fs.mkdir(path.join(stateRoot,'launcher'),{recursive:true});await fs.mkdir(links);
 const oldHelper=path.join(stateRoot,'launcher','ChatGPT.exe'),newHelper=path.join(stateRoot,'launcher','CodexInfoBarLauncher.exe'),official=path.join(directory,'official.exe');
 for(const file of [oldHelper,newHelper,official])await fs.writeFile(file,'fixture only; never launched');
 const pin=path.join(links,'ChatGPT (2).lnk');
 await powershell(`$w=New-Object -ComObject WScript.Shell;$l=$w.CreateShortcut(${psLiteral(pin)});$l.TargetPath=${psLiteral(official)};$l.Save()`);
 const options={app:{executable:official},port:9341,stateRoot,run:powershell,roots:[links],launchTarget:oldHelper};
 await syncWindowsShortcuts(options);
 const read=async()=>JSON.parse(await powershell(`$w=New-Object -ComObject WScript.Shell;$s=New-Object -ComObject Shell.Application;$l=$w.CreateShortcut(${psLiteral(pin)});$i=$s.NameSpace(${psLiteral(links)}).ParseName('ChatGPT (2).lnk');@{target=$l.TargetPath;appId=$i.ExtendedProperty('System.AppUserModel.ID');relaunch=$i.ExtendedProperty('System.AppUserModel.RelaunchCommand');displayName=$i.ExtendedProperty('System.AppUserModel.RelaunchDisplayNameResource');relaunchIcon=$i.ExtendedProperty('System.AppUserModel.RelaunchIconResource')}|ConvertTo-Json -Compress`));
 const legacy={...desiredShellRoute(oldHelper,official+',0'),appId:'com.openai.codex'};
 await setShortcutShellRoute({file:pin,run:powershell,expected:shortcutShellRoute(await read()),desired:legacy});
 // Recreate the backup state produced when the user pins an already managed window.
 const file=path.join(stateRoot,'shortcuts.json'),saved=JSON.parse(await fs.readFile(file,'utf8')),entry=saved.entries[0];
 entry.adopted=true;entry.routeBefore=legacy;entry.metadata={...entry.metadata,appId:legacy.appId,relaunch:legacy.relaunch,displayName:legacy.displayName,relaunchIcon:legacy.icon};await fs.writeFile(file,JSON.stringify(saved));
 assert.deepEqual((await syncWindowsShortcuts({...options,launchTarget:newHelper})).updated,[await fs.realpath(pin)]);
 let current=await read();assert.equal(current.target,newHelper);assert.equal(current.appId,managedShellAppId);assert.equal(current.displayName,'ChatGPT');
 await restoreWindowsShortcuts({stateRoot,run:powershell});current=await read();assert.equal(current.target,official);assert.equal(current.appId,'com.openai.codex');assert.equal(current.relaunch,null);
});
