import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {psLiteral} from './windows-native.mjs';

export async function ensureWindowsLauncher({stateRoot,app,run}){
 const directory=path.join(stateRoot,'launcher');await fs.mkdir(directory,{recursive:true});
 const executable=path.join(directory,'ChatGPT.exe'),icon=path.join(directory,'ChatGPT.ico');
 const source=await fs.readFile(new URL('./windows-launcher.cs',import.meta.url),'utf8');
 const digest=createHash('sha256').update(source).digest('hex'),revision=path.join(directory,'source.sha256');
 let installed;try{installed=await fs.readFile(revision,'utf8');await fs.access(executable);}catch{installed=null;}
 if(installed!==digest){
  const temporary=path.join(directory,`ChatGPT.${process.pid}.new.exe`);
  try{
   await run(`Add-Type -TypeDefinition ${psLiteral(source)} -ReferencedAssemblies System.Runtime.Serialization,System.Management,System.Windows.Forms,System.Xml -OutputAssembly ${psLiteral(temporary)} -OutputType WindowsApplication`,{timeout:60000});
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
