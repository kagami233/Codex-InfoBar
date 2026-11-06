import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {psLiteral} from './windows-native.mjs';
export const windowsLauncherPaths=stateRoot=>({executable:path.join(stateRoot,'launcher','CodexInfoBarLauncher.exe'),icon:path.join(stateRoot,'launcher','ChatGPT.ico')});

export async function ensureWindowsLauncher({stateRoot,app,run}){
 const directory=path.join(stateRoot,'launcher');await fs.mkdir(directory,{recursive:true});
 const {executable,icon}=windowsLauncherPaths(stateRoot);
 const sources=['windows-launcher.cs','windows-native.cs','windows-shell.cs','windows-window-bootstrap.cs'].map(name=>fileURLToPath(new URL(name,import.meta.url)));
 const source=(await Promise.all(sources.map(file=>fs.readFile(file,'utf8')))).join('\n');
 const digest=createHash('sha256').update(source).digest('hex'),revision=path.join(directory,'source.sha256');
 let installed;try{installed=await fs.readFile(revision,'utf8');await fs.access(executable);}catch{installed=null;}
 if(installed!==digest){
  const temporary=path.join(directory,`CodexInfoBarLauncher.${process.pid}.new.exe`);
  try{
   await run(`Add-Type -LiteralPath @(${sources.map(psLiteral).join(',')}) -ReferencedAssemblies System.Runtime.Serialization,System.Management,System.Windows.Forms,System.Xml -OutputAssembly ${psLiteral(temporary)} -OutputType WindowsApplication`,{timeout:60000});
   await fs.rename(temporary,executable);await fs.writeFile(revision,digest);
  }finally{await fs.rm(temporary,{force:true});}
 }
 try{await fs.access(icon);}catch(error){if(error.code!=='ENOENT')throw error;
  await run(`Add-Type -AssemblyName System.Drawing;$icon=[Drawing.Icon]::ExtractAssociatedIcon(${psLiteral(app.executable)});if(!$icon){throw 'Official Codex icon unavailable'};$file=[IO.File]::Create(${psLiteral(icon)});try{$icon.Save($file)}finally{$file.Dispose();$icon.Dispose()}`);
 }
 const config=path.join(directory,'config.json'),content=JSON.stringify({nodePath:process.execPath});
 let prior;try{prior=await fs.readFile(config,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(prior!==content)await fs.writeFile(config,content);
 return {executable,icon};
}
