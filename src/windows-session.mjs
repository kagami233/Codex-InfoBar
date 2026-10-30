import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startWindowsDetached} from './windows-native.mjs';

export const windowsSessionFlag='--windows-session-worker';
export function windowsEnvironment(overrides={}) {
 const environment={};
 // Pass paths needed by the native user session, never copy credentials or the
 // installer's entire environment into a persistent process.
 for(const key of ['SystemDrive','SystemRoot','WINDIR','ComSpec','PATH','PATHEXT','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','USERNAME','USERDOMAIN','ProgramData','ALLUSERSPROFILE','ProgramFiles','ProgramFiles(x86)','CommonProgramFiles','CommonProgramFiles(x86)','PSModulePath','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','CODEX_INFOBAR_STATE','CODEX_INFOBAR_PORT','CODEX_INFOBAR_APP','CODEX_HOME'])if(process.env[key]!==undefined)environment[key]=process.env[key];
 return {...environment,...overrides};
}

export async function runWindowsSession(moduleUrl,args,{run,timeout=180000}) {
 const entry=fileURLToPath(moduleUrl),root=path.dirname(path.dirname(entry));
 const outputRoot=path.join(root,'output');await fs.mkdir(outputRoot,{recursive:true});
 const directory=await fs.mkdtemp(path.join(outputRoot,'windows-session-'));
 const resultFile=path.join(directory,'result.json');
 // Execute the same repository module, including all filesystem operations,
 // in the same user session that will host the watcher. This also avoids
 // AppData projections used by app-contained installer/assistant processes.
 const bootstrap=`
import fs from 'node:fs/promises';import {pathToFileURL} from 'node:url';import {format} from 'node:util';
const output=[];console.log=(...args)=>output.push(format(...args));console.error=(...args)=>output.push(format(...args));
process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify([...args,windowsSessionFlag])}];
try{await import(pathToFileURL(${JSON.stringify(entry)}).href);}catch(error){console.error(error.stack??error);process.exitCode=1;}
const result={exitCode:process.exitCode??0,output,pid:process.pid};
await fs.writeFile(${JSON.stringify(resultFile+'.tmp')},JSON.stringify(result,null,2));
await fs.rename(${JSON.stringify(resultFile+'.tmp')},${JSON.stringify(resultFile)});
`;
 const pid=await startWindowsDetached(process.execPath,['--input-type=module','-e',bootstrap],{cwd:root,env:windowsEnvironment(),run});
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){
  try{
   const result=JSON.parse(await fs.readFile(resultFile,'utf8'));
   if(result.pid!==pid||!Number.isInteger(result.exitCode)||!Array.isArray(result.output))throw new Error('Invalid Windows session result');
   for(const line of result.output)console.log(line);
   return result.exitCode;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 throw new Error(`Windows user-session command ${pid} did not complete. Diagnostic directory: ${directory}`);
}
