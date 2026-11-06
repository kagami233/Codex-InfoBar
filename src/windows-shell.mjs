import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {psLiteral} from './windows-native.mjs';

const fields=['relaunch','displayName','icon','appId'];
export const managedShellAppId='local.codex.infobar.launcher';
const equal=(a,b)=>fields.every(key=>(a?.[key]??null)===(b?.[key]??null));
const dictionary=value=>`([CodexInfoBar.WindowsShellRoute]::Values(${fields.map(key=>value?.[key]==null?'$null':psLiteral(value[key])).join(',')}))`;
async function shell(run,script){return run(`Add-Type -LiteralPath ${psLiteral(fileURLToPath(new URL('./windows-shell.cs',import.meta.url)))};${script}`);}
export const desiredShellRoute=(launcher,icon,displayName='ChatGPT')=>({appId:managedShellAppId,relaunch:`"${launcher}"`,displayName,icon});
export const shortcutShellRoute=link=>({appId:link.appId??null,relaunch:link.relaunch??null,displayName:link.displayName??null,icon:link.relaunchIcon??null});
export const sameShellRoute=equal;
export async function setShortcutShellRoute({file,run,expected,desired}){
 const result=await shell(run,`[CodexInfoBar.WindowsShellRoute]::SetShortcut(${psLiteral(file)},${dictionary(expected)},${dictionary(desired)})|ConvertTo-Json -Compress`);
 if(JSON.parse(result)!==true)throw new Error('Shortcut Shell route changed during update');
}
export async function syncWindowsShell({pid,app,stateRoot,launcher,run,restore=false}){
 await fs.mkdir(stateRoot,{recursive:true});
 const file=path.join(stateRoot,'shell-windows.json');let saved={version:1,entries:[]};
 try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(saved.version!==1||!Array.isArray(saved.entries))throw new Error('Invalid Shell window backup');
 const save=async()=>{const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(saved,null,2));await fs.rename(temp,file);};
 let rows=[];if(pid)rows=[].concat(JSON.parse(await shell(run,`ConvertTo-Json -InputObject @([CodexInfoBar.WindowsShellRoute]::Inspect(${pid},${psLiteral(app.executable)})) -Depth 5 -Compress`)));
 // Read native bootstrap backups after taking the window snapshot. The native
 // launcher persists them before changing any properties, avoiding a race that
 // would otherwise mistake already-managed values for the original identity.
 let imported=false;
 for(const row of rows){
  if(saved.entries.some(entry=>entry.Handle===row.Handle&&entry.Pid===row.Pid&&entry.Created===row.Created))continue;
  if(!/^\d+$/.test(row.Created))throw new Error('Invalid window creation identity');
  let early;try{early=JSON.parse(await fs.readFile(path.join(stateRoot,'shell-bootstrap',`${row.Pid}-${row.Created}.json`),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(early.version!==1||!Array.isArray(early.entries))throw new Error('Invalid native window routing backup');
  const entry=early.entries.find(entry=>entry.Handle===row.Handle&&entry.Pid===row.Pid&&entry.Created===row.Created);
  if(entry&&entry.applied?.appId===managedShellAppId&&(equal(row.Values,entry.applied)||equal(row.Values,entry.original))){saved.entries.push(entry);imported=true;}
 }
 if(imported)await save();
 const alive=entry=>rows.some(row=>row.Handle===entry.Handle&&row.Pid===entry.Pid&&row.Created===entry.Created);
 const retained=saved.entries.filter(alive);if(retained.length!==saved.entries.length){saved.entries=retained;await save();}
 let updated=0,skipped=0;
 for(const row of rows){
  let entry=saved.entries.find(entry=>entry.Handle===row.Handle&&entry.Pid===row.Pid&&entry.Created===row.Created);
  const desired=restore?entry?.original:desiredShellRoute(launcher.executable,launcher.icon+',0');
  if(restore&&!entry)continue;
  if(entry&&!equal(row.Values,entry.applied)&&!equal(row.Values,entry.original)){skipped++;continue;}
  if(!entry){if(row.Values.appId&&!['com.openai.codex','OpenAI.Codex_2p2nqsd0c76g0!App',managedShellAppId].includes(row.Values.appId)){skipped++;continue;}
   entry={Handle:row.Handle,Pid:row.Pid,Created:row.Created,original:row.Values,applied:desired};saved.entries.push(entry);await save();
  }
  if(!equal(row.Values,desired)){
   const changed=JSON.parse(await shell(run,`[CodexInfoBar.WindowsShellRoute]::SetWindow(${row.Pid},${psLiteral(app.executable)},${psLiteral(row.Created)},${row.Handle},${dictionary(row.Values)},${dictionary(desired)})|ConvertTo-Json -Compress`));
   if(!changed){skipped++;continue;}updated++;
  }
  if(restore){saved.entries=saved.entries.filter(candidate=>candidate!==entry);await save();}
  else if(!equal(entry.applied,desired)){entry.applied=desired;await save();}
 }
 return {updated,skipped,windows:rows.length};
}
