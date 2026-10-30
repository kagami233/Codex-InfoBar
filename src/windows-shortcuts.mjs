import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {psLiteral} from './windows-native.mjs';

export function debugArguments(port) {
 if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid debug port');
 return `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
}

export async function syncWindowsShortcuts({app,port,stateRoot,run,roots}) {
 app={...app,executable:await fs.realpath(app.executable)};
 const launcher=path.join(stateRoot,'shortcuts','ChatGPT.lnk');
 await fs.mkdir(path.dirname(launcher),{recursive:true});
 const launchArguments=debugArguments(port);
 const file=path.join(stateRoot,'shortcuts.json');
 let saved={version:1,entries:[]};try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(saved.version!==1||!Array.isArray(saved.entries))throw new Error('Invalid shortcut backup');
 const retained=[];
 for(const entry of saved.entries){try{await fs.access(entry.path);retained.push(entry);}catch(error){if(error.code!=='ENOENT')throw error;}}
 if(retained.length!==saved.entries.length){saved.entries=retained;const temporary=file+'.tmp';await fs.writeFile(temporary,JSON.stringify(saved,null,2));await fs.rename(temporary,file);}
 const allowedRoots=roots?`@(${roots.map(psLiteral).join(',')})`:"@([Environment]::GetFolderPath('Desktop'),(Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),(Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned'))";
 const known=saved.entries.map(entry=>entry.path);
 const raw=await run(`$w=New-Object -ComObject WScript.Shell;$shell=New-Object -ComObject Shell.Application;$rows=@();foreach($root in ${allowedRoots}){if(Test-Path -LiteralPath $root){foreach($item in @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)){$link=$w.CreateShortcut($item.FullName);$id=$shell.NameSpace($item.DirectoryName).ParseName($item.Name).ExtendedProperty('System.AppUserModel.ID');if($link.TargetPath -ieq ${psLiteral(app.executable)} -or $id -eq 'OpenAI.Codex_2p2nqsd0c76g0!App' -or $item.FullName -in @(${known.map(psLiteral).join(',')})){$rows+=@{path=$item.FullName;target=$link.TargetPath;arguments=$link.Arguments;appId=$id}}}}};ConvertTo-Json -InputObject $rows -Compress`);
 const links=JSON.parse(raw||'[]'),updated=[],skipped=[];
 // Carry the app's existing shell identity and icon metadata into the stable
 // launch target, so its running window groups with the same taskbar button.
 const template=links.find(link=>link.appId==='com.openai.codex'&&link.target.toLowerCase()===app.executable.toLowerCase());
 if(template)await fs.copyFile(template.path,launcher);
 await run(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${psLiteral(launcher)});if($s.TargetPath -ine ${psLiteral(app.executable)} -or $s.Arguments -cne ${psLiteral(launchArguments)}){$s.TargetPath=${psLiteral(app.executable)};$s.Arguments=${psLiteral(launchArguments)};$s.WorkingDirectory=${psLiteral(path.win32.dirname(app.executable))};$s.Description='ChatGPT';$s.IconLocation=${psLiteral(app.executable+',0')};$s.Save()}`);
 const argumentsValue=debugArguments(port);
 async function save(){await fs.mkdir(stateRoot,{recursive:true});const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(saved,null,2));await fs.rename(temp,file);}
 for(const link of links){
  let entry=saved.entries.find(entry=>entry.path.toLowerCase()===link.path.toLowerCase());
  if(entry){
   if(link.target.toLowerCase()!==entry.target.toLowerCase()||link.arguments!==entry.arguments||(entry.digest&&createHash('sha256').update(await fs.readFile(link.path)).digest('hex')!==entry.digest)){skipped.push(link.path);continue;}
  }else{
   // Preserve custom launch commands; only adopt an ordinary app shortcut.
   if(link.arguments&&link.arguments!==argumentsValue){skipped.push(link.path);continue;}
   const original=await fs.readFile(link.path);
   entry={path:link.path,original:original.toString('base64'),target:link.target,arguments:link.arguments,digest:createHash('sha256').update(original).digest('hex'),adopted:Boolean(link.arguments)};
   saved.entries.push(entry);await save();
  }
  if(link.target.toLowerCase()===app.executable.toLowerCase()&&link.arguments===argumentsValue)continue;
  // Save the original link before touching it. Keep icon, title, pin and other
  // shell metadata intact; launching still targets the official executable.
  await run(`$w=New-Object -ComObject WScript.Shell;$link=$w.CreateShortcut(${psLiteral(link.path)});if($link.TargetPath -ine ${psLiteral(link.target)} -or $link.Arguments -cne ${psLiteral(link.arguments)}){throw 'Shortcut changed during installation'};$link.TargetPath=${psLiteral(app.executable)};$link.Arguments=${psLiteral(argumentsValue)};$link.WorkingDirectory=${psLiteral(path.win32.dirname(app.executable))};$link.Save()`);
  entry.target=app.executable;entry.arguments=argumentsValue;entry.digest=createHash('sha256').update(await fs.readFile(link.path)).digest('hex');await save();updated.push(link.path);
 }
 return {updated,skipped,launcher};
}

export async function restoreWindowsShortcuts({stateRoot,run}) {
 const file=path.join(stateRoot,'shortcuts.json');let saved;
 try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}
 if(saved.version!==1||!Array.isArray(saved.entries))throw new Error('Invalid shortcut backup');
 const remaining=[];
 for(const entry of saved.entries){
  const raw=await run(`if(Test-Path -LiteralPath ${psLiteral(entry.path)}){$w=New-Object -ComObject WScript.Shell;$link=$w.CreateShortcut(${psLiteral(entry.path)});@{target=$link.TargetPath;arguments=$link.Arguments}|ConvertTo-Json -Compress}`);
  if(!raw)continue;const current=JSON.parse(raw);
  if(current.target.toLowerCase()===entry.target.toLowerCase()&&current.arguments===entry.arguments&&(!entry.digest||entry.digest===createHash('sha256').update(await fs.readFile(entry.path)).digest('hex'))){
   if(entry.adopted)await run(`$w=New-Object -ComObject WScript.Shell;$link=$w.CreateShortcut(${psLiteral(entry.path)});if($link.TargetPath -ine ${psLiteral(entry.target)} -or $link.Arguments -cne ${psLiteral(entry.arguments)}){throw 'Shortcut changed during removal'};$link.Arguments='';$link.Save()`);
   else await fs.writeFile(entry.path,Buffer.from(entry.original,'base64'));
  }
  else remaining.push(entry); // Never overwrite a shortcut edited by its owner.
 }
 await fs.writeFile(file,JSON.stringify({version:1,entries:remaining},null,2));
}
