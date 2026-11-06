import fs from 'node:fs/promises';
import path from 'node:path';
import {psLiteral} from './windows-native.mjs';

export const startupRegistryBase='Registry::HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\SystemAppData\\OpenAI.Codex_2p2nqsd0c76g0';
const journalName='startup-routing.json';
export function windowsLoginMode({requested,prior,task}={}){
 const mode=requested??prior;if(mode!==undefined){if(!['launch','manual'].includes(mode))throw new Error('Windows login mode must be launch or manual');return mode;}
 return task&&(task.state===2||task.state===4||(task.state===null&&task.defaultEnabled))?'launch':'manual';
}
export function windowsStartupCommand({mode,launcher,node,watcher}){
 return mode==='launch'?`"${launcher}" --login`:`"${node}" "${watcher}"`;
}
async function readState(key,run){
 return JSON.parse(await run(`$key=${psLiteral(key)};$item=Get-Item -LiteralPath $key -ErrorAction SilentlyContinue;$state=$null;if($item -and $item.GetValueNames() -contains 'State'){if($item.GetValueKind('State') -ne [Microsoft.Win32.RegistryValueKind]::DWord){throw 'Unexpected startup State type'};$state=[int]$item.GetValue('State')};@{state=$state}|ConvertTo-Json -Compress`)).state;
}
async function compareState(key,expected,desired,run){
 await run(`$key=${psLiteral(key)};$item=Get-Item -LiteralPath $key -ErrorAction SilentlyContinue;$state=$null;if($item -and $item.GetValueNames() -contains 'State'){if($item.GetValueKind('State') -ne [Microsoft.Win32.RegistryValueKind]::DWord){throw 'Unexpected startup State type'};$state=[int]$item.GetValue('State')};if($state -ne ${expected===null?'$null':Number(expected)}){throw 'Startup state changed during update'};${desired===null?`if($item){Remove-ItemProperty -LiteralPath $key -Name State -ErrorAction Stop}`:`if(!$item){New-Item -Path $key -Force|Out-Null};New-ItemProperty -LiteralPath $key -Name State -Value ${Number(desired)} -PropertyType DWord -Force|Out-Null`}`);
}
export async function inspectWindowsStartupTask({app,run}){
 const manifest=path.join(app.app,'AppxManifest.xml');
 const raw=JSON.parse(await run(`$settings=New-Object Xml.XmlReaderSettings;$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$reader=[Xml.XmlReader]::Create(${psLiteral(manifest)},$settings);try{$doc=New-Object Xml.XmlDocument;$doc.XmlResolver=$null;$doc.Load($reader)}finally{$reader.Dispose()};$identity=$doc.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Identity']");if($identity.GetAttribute('Name') -cne 'OpenAI.Codex'){throw 'Unexpected startup package identity'};$rows=@();foreach($ext in $doc.SelectNodes("//*[local-name()='Application' and @Id='App']/*[local-name()='Extensions']/*[local-name()='Extension' and @Category='windows.startupTask']")){if($ext.GetAttribute('Executable').Replace('\\','/') -cne 'app/ChatGPT.exe'){throw 'Unexpected official startup executable'};foreach($t in $ext.ChildNodes){if($t.LocalName -eq 'StartupTask'){$rows+=@{id=$t.GetAttribute('TaskId');defaultEnabled=($t.GetAttribute('Enabled') -eq 'true')}}}};ConvertTo-Json -InputObject $rows -Compress`));
 if(raw.length>1)throw new Error('Multiple official startup tasks need explicit review');
 if(!raw.length)return null;
 const task=raw[0];if(!/^[A-Za-z0-9_.-]+$/.test(task.id))throw new Error('Invalid official startup task ID');
 task.key=startupRegistryBase+'\\'+task.id;task.state=await readState(task.key,run);return task;
}
async function readJournal(stateRoot){try{const saved=JSON.parse(await fs.readFile(path.join(stateRoot,journalName),'utf8'));if(saved.version!==1||!Array.isArray(saved.entries))throw new Error('Invalid startup routing backup');return saved;}catch(error){if(error.code==='ENOENT')return {version:1,entries:[]};throw error;}}
async function saveJournal(stateRoot,saved){await fs.mkdir(stateRoot,{recursive:true});const file=path.join(stateRoot,journalName),temporary=file+'.tmp';await fs.writeFile(temporary,JSON.stringify(saved,null,2));await fs.rename(temporary,file);}
export async function syncWindowsStartupTask({app,stateRoot,run,mode,onlyIfManaged=false}){
 const saved=await readJournal(stateRoot);if(onlyIfManaged&&!saved.mode)return {managed:false,updated:false};
 mode=mode??saved.mode;if(!['launch','manual'].includes(mode))throw new Error('Missing Windows login mode');
 const task=await inspectWindowsStartupTask({app,run});
 if(task&&(task.state===3||task.state===4))throw new Error('Official Codex startup task is policy-controlled; it was not changed');
 saved.mode=mode;
 if(!task){await saveJournal(stateRoot,saved);return {managed:true,updated:false,mode,task:null};}
 let entry=saved.entries.find(entry=>entry.key===task.key);
 if(!entry){entry={key:task.key,taskId:task.id,originalState:task.state,appliedState:task.state===2||task.state===null?1:task.state};saved.entries.push(entry);await saveJournal(stateRoot,saved);}
 // The user chooses InfoBar as the login route. Only the per-user startup
 // enable state is managed; no package, policy or other app registry is touched.
 let updated=false;if(task.state===2||task.state===null){await compareState(task.key,task.state,1,run);updated=true;}
 await saveJournal(stateRoot,saved);return {managed:true,updated,mode,task:{...task,state:updated?1:task.state}};
}
export async function restoreWindowsStartupTask({stateRoot,run}){
 const saved=await readJournal(stateRoot),skipped=[];
 for(const entry of saved.entries){
  if(!entry.key.startsWith(startupRegistryBase+'\\')||!/^\w[\w.-]*$/.test(entry.taskId)||entry.key!==startupRegistryBase+'\\'+entry.taskId)throw new Error('Invalid startup restore key');
  const current=await readState(entry.key,run);
  if(current===entry.originalState)continue;
  if(current!==entry.appliedState){skipped.push(entry);continue;}
  await compareState(entry.key,current,entry.originalState,run);
 }
 await saveJournal(stateRoot,{version:1,entries:skipped});return {skipped:skipped.map(entry=>entry.taskId)};
}
