import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {psLiteral} from './windows-native.mjs';

export function debugArguments(port) {
 if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid debug port');
 return `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
}

const properties=`target=$s.TargetPath;arguments=$s.Arguments;description=$s.Description;iconLocation=$s.IconLocation;workingDirectory=$s.WorkingDirectory;hotkey=$s.Hotkey;windowStyle=$s.WindowStyle;appId=$shell.NameSpace([IO.Path]::GetDirectoryName($f)).ParseName([IO.Path]::GetFileName($f)).ExtendedProperty('System.AppUserModel.ID')`;
const metadata=link=>({description:link.description??'',iconLocation:(link.iconLocation??'').toLowerCase(),workingDirectory:(link.workingDirectory??'').toLowerCase(),hotkey:link.hotkey??'',windowStyle:link.windowStyle??1,appId:link.appId??null});
const sameMetadata=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function readShortcut(file,run){return JSON.parse(await run(`$w=New-Object -ComObject WScript.Shell;$shell=New-Object -ComObject Shell.Application;$f=${psLiteral(file)};$s=$w.CreateShortcut($f);@{${properties}}|ConvertTo-Json -Compress`));}
async function withOriginal(entry,stateRoot,run,callback){
 const directory=await fs.mkdtemp(path.join(stateRoot,'shortcut-original-')),file=path.join(directory,'original.lnk');
 try{await fs.writeFile(file,Buffer.from(entry.original,'base64'));return await callback(await readShortcut(file,run));}
 finally{await fs.rm(file,{force:true});await fs.rmdir(directory);}
}
async function ownsShortcut(entry,link,{stateRoot,run,recovery}){
 const targetMatches=link.target.toLowerCase()===entry.target.toLowerCase();
 if(!targetMatches||link.arguments!==entry.arguments){
  // A registered app update may recreate a managed link with its official
  // default target and no flags. Only repair that default shape; custom
  // arguments, titles, hotkeys and icons remain owner-controlled.
  if(!recovery||(!targetMatches&&link.target.toLowerCase()!==recovery.app.executable.toLowerCase())||!['',entry.arguments].includes(link.arguments))return false;
  const original=entry.metadata??await withOriginal(entry,stateRoot,run,link=>metadata(link));
  const expected={...original},current=metadata(link);
  const defaultDirectories=[path.win32.dirname(entry.target),path.win32.dirname(recovery.app.executable)].map(value=>value.toLowerCase());
  if(defaultDirectories.includes(current.workingDirectory))current.workingDirectory=expected.workingDirectory;
  if(expected.iconLocation===(recovery.iconLocation??'').toLowerCase()&&['',',0'].includes(current.iconLocation))current.iconLocation=expected.iconLocation;
  return sameMetadata(expected,current);
 }
 const current=metadata(link);
 if(entry.metadata)return sameMetadata(entry.metadata,current);
 if(!entry.digest||createHash('sha256').update(await fs.readFile(entry.path)).digest('hex')===entry.digest)return true;
 // Explorer can refresh binary tracking/timestamp data without changing any
 // launch or user-authored properties. Migrate old backups using those properties,
 // rather than treating every byte change as an owner edit.
 return withOriginal(entry,stateRoot,run,original=>{
  const expected=metadata(original);
  return sameMetadata(expected,current)||sameMetadata({...expected,workingDirectory:path.win32.dirname(entry.target).toLowerCase()},current);
 });
}

export async function syncWindowsShortcuts({app,port,stateRoot,run,roots,launchTarget,iconLocation}) {
 app={...app,executable:await fs.realpath(app.executable)};
 const launcher=path.join(stateRoot,'shortcuts','ChatGPT.lnk');
 await fs.mkdir(path.dirname(launcher),{recursive:true});
 const target=launchTarget?await fs.realpath(launchTarget):app.executable;
 if(launchTarget&&iconLocation){const comma=iconLocation.lastIndexOf(',');if(comma>0)iconLocation=await fs.realpath(iconLocation.slice(0,comma))+iconLocation.slice(comma);}
 const launchArguments=launchTarget?'':debugArguments(port);
 const file=path.join(stateRoot,'shortcuts.json');
 let saved={version:1,entries:[]};try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(saved.version!==1||!Array.isArray(saved.entries))throw new Error('Invalid shortcut backup');
 const retained=[];
 for(const entry of saved.entries){try{await fs.access(entry.path);retained.push(entry);}catch(error){if(error.code!=='ENOENT')throw error;}}
 if(retained.length!==saved.entries.length){saved.entries=retained;const temporary=file+'.tmp';await fs.writeFile(temporary,JSON.stringify(saved,null,2));await fs.rename(temporary,file);}
 const allowedRoots=roots?`@(${roots.map(psLiteral).join(',')})`:"@([Environment]::GetFolderPath('Desktop'),(Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),(Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned'))";
 const known=saved.entries.map(entry=>entry.path);
 const raw=await run(`$w=New-Object -ComObject WScript.Shell;$shell=New-Object -ComObject Shell.Application;$rows=@();foreach($root in ${allowedRoots}){if(Test-Path -LiteralPath $root){foreach($item in @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)){$f=$item.FullName;$s=$w.CreateShortcut($f);$id=$shell.NameSpace($item.DirectoryName).ParseName($item.Name).ExtendedProperty('System.AppUserModel.ID');if($s.TargetPath -ieq ${psLiteral(app.executable)} -or $s.TargetPath -ieq ${psLiteral(target)} -or $id -eq 'OpenAI.Codex_2p2nqsd0c76g0!App' -or $item.FullName -in @(${known.map(psLiteral).join(',')})){$rows+=@{path=$f;${properties}}}}}};ConvertTo-Json -InputObject $rows -Compress`);
 const links=JSON.parse(raw||'[]'),updated=[],skipped=[];
 // Carry the app's existing shell identity and icon metadata into the stable
 // launch target, so its running window groups with the same taskbar button.
 const template=links.find(link=>link.appId==='com.openai.codex'&&link.target.toLowerCase()===app.executable.toLowerCase());
 if(template)await fs.copyFile(template.path,launcher);
 await run(`$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(${psLiteral(launcher)});if($s.TargetPath -ine ${psLiteral(target)} -or $s.Arguments -cne ${psLiteral(launchArguments)}){$s.TargetPath=${psLiteral(target)};$s.Arguments=${psLiteral(launchArguments)};$s.WorkingDirectory=${psLiteral(path.win32.dirname(target))};$s.Description='ChatGPT';$s.IconLocation=${psLiteral(iconLocation??app.executable+',0')};$s.Save()}`);
 const argumentsValue=launchArguments;
 async function save(){await fs.mkdir(stateRoot,{recursive:true});const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(saved,null,2));await fs.rename(temp,file);}
 for(const link of links){
  let entry=saved.entries.find(entry=>entry.path.toLowerCase()===link.path.toLowerCase());
  if(entry){
   if(!await ownsShortcut(entry,link,{stateRoot,run,recovery:launchTarget?{app,iconLocation}:null})){skipped.push(link.path);continue;}
  }else{
   // Preserve custom launch commands; only adopt an ordinary app shortcut.
   if(link.arguments&&link.arguments!==argumentsValue&&!(launchTarget&&link.arguments===debugArguments(port))){skipped.push(link.path);continue;}
   const original=await fs.readFile(link.path);
   entry={path:link.path,original:original.toString('base64'),target:link.target,arguments:link.arguments,digest:createHash('sha256').update(original).digest('hex'),adopted:Boolean(link.arguments)||Boolean(launchTarget&&link.target.toLowerCase()===target.toLowerCase())};
   saved.entries.push(entry);await save();
  }
  if(!entry.metadata){entry.metadata=metadata(link);await save();}
  if(launchTarget&&(entry.kind!=='stable-launcher'||entry.restoreTarget!==app.executable)){entry.kind='stable-launcher';entry.restoreTarget=app.executable;await save();}
  if(link.target.toLowerCase()===target.toLowerCase()&&link.arguments===argumentsValue)continue;
  const upgraded=link.target.toLowerCase()!==app.executable.toLowerCase();
  // Save the original link before touching it. Keep icon, title, pin and other
  // shell metadata intact; launching still targets the official executable.
  const useIcon=iconLocation&&(!link.iconLocation||link.iconLocation===',0'||link.iconLocation.toLowerCase()===link.target.toLowerCase()+',0');
  await run(`$w=New-Object -ComObject WScript.Shell;$link=$w.CreateShortcut(${psLiteral(link.path)});if($link.TargetPath -ine ${psLiteral(link.target)} -or $link.Arguments -cne ${psLiteral(link.arguments)}){throw 'Shortcut changed during installation'};$link.TargetPath=${psLiteral(target)};$link.Arguments=${psLiteral(argumentsValue)};$link.WorkingDirectory=${psLiteral(path.win32.dirname(target))};${useIcon?`$link.IconLocation=${psLiteral(iconLocation)};`:''}$link.Save()`);
  if(upgraded)entry.restoreTarget=app.executable;
  entry.target=target;entry.arguments=argumentsValue;entry.metadata=metadata(await readShortcut(link.path,run));entry.digest=createHash('sha256').update(await fs.readFile(link.path)).digest('hex');await save();updated.push(link.path);
 }
 return {updated,skipped,launcher};
}

export async function restoreWindowsShortcuts({stateRoot,run}) {
 const file=path.join(stateRoot,'shortcuts.json');let saved;
 try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}
 if(saved.version!==1||!Array.isArray(saved.entries))throw new Error('Invalid shortcut backup');
 const remaining=[];
 for(const entry of saved.entries){
  try{await fs.access(entry.path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  const current=await readShortcut(entry.path,run);
  if(await ownsShortcut(entry,current,{stateRoot,run})){
   if(entry.adopted)await run(`$w=New-Object -ComObject WScript.Shell;$link=$w.CreateShortcut(${psLiteral(entry.path)});if($link.TargetPath -ine ${psLiteral(entry.target)} -or $link.Arguments -cne ${psLiteral(entry.arguments)}){throw 'Shortcut changed during removal'};${entry.kind==='stable-launcher'?`$link.TargetPath=${psLiteral(entry.restoreTarget)};$link.WorkingDirectory=${psLiteral(path.win32.dirname(entry.restoreTarget))};`:''}$link.Arguments='';$link.Save()`);
   else{
    await fs.writeFile(entry.path,Buffer.from(entry.original,'base64'));
    if(entry.restoreTarget)await run(`$w=New-Object -ComObject WScript.Shell;$link=$w.CreateShortcut(${psLiteral(entry.path)});$link.TargetPath=${psLiteral(entry.restoreTarget)};$link.WorkingDirectory=${psLiteral(path.win32.dirname(entry.restoreTarget))};$link.Save()`);
   }
  }
  else remaining.push(entry); // Never overwrite a shortcut edited by its owner.
 }
 await fs.writeFile(file,JSON.stringify({version:1,entries:remaining},null,2));
}
