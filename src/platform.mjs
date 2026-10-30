import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const run=promisify(execFile);
export const stateRoot=process.env.CODEX_INFOBAR_STATE || (process.platform==='win32'
 ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData/Local'),'Codex-InfoBar')
 : path.join(os.homedir(),'Library/Application Support/Codex-InfoBar'));
let settings={};try{settings=JSON.parse(readFileSync(path.join(stateRoot,'settings.json'),'utf8'));}catch{}
export const port=Number(process.env.CODEX_INFOBAR_PORT || settings.CODEX_INFOBAR_PORT || 9341);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid CODEX_INFOBAR_PORT');
export async function powershell(script){
 const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); "+script,'utf16le').toString('base64')],{timeout:15000,maxBuffer:4*1024*1024,windowsHide:true});
 return stdout.replace(/^\uFEFF/,'').trim();
}
export function psLiteral(value){return "'"+String(value).replaceAll("'","''")+"'";}
export function windowsMain(records,executable){
 const key=p=>path.win32.normalize(p||'').toLowerCase();
 return records.filter(p=>key(p.command)===key(executable)&&!/(?:^|\s)--type(?:=|\s)/i.test(p.args||''));
}
export function validateWindowsListeners(listeners,records,executable){
 const mains=windowsMain(records,executable);
 if(mains.length!==1)throw new Error('Expected exactly one verified Codex main process');
 if(!listeners.length||listeners.some(l=>!['127.0.0.1','::1'].includes(l.address)||Number(l.pid)!==mains[0].pid))throw new Error('Debug listener must be owned by Codex and bound only to loopback');
}
export async function resolveApp(){
 if(process.platform==='darwin'){
  const candidates=process.env.CODEX_INFOBAR_APP?[process.env.CODEX_INFOBAR_APP]:['/Applications/Codex.app','/Applications/ChatGPT.app',path.join(os.homedir(),'Applications/Codex.app'),path.join(os.homedir(),'Applications/ChatGPT.app')];
  for(const app of candidates){try{
   const {stdout:id}=await run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',`${app}/Contents/Info.plist`]);
   if(id.trim()!=='com.openai.codex')continue;
   const {stdout:exe}=await run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleExecutable',`${app}/Contents/Info.plist`]);
   return {app,executable:`${app}/Contents/MacOS/${exe.trim()}`};
  }catch{}}
  throw new Error('Codex app not found; set CODEX_INFOBAR_APP to the .app path');
 }
 if(process.platform==='win32'){
  const value=await powershell("$p=Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1; if($p){@{root=$p.InstallLocation}|ConvertTo-Json -Compress}");
  const pkg=value?JSON.parse(value):null;
  if(!pkg)throw new Error('OpenAI.Codex Store package not found');
  const executable=process.env.CODEX_INFOBAR_APP || path.join(pkg.root,'app','ChatGPT.exe');
  if(!path.win32.resolve(executable).toLowerCase().startsWith(path.win32.resolve(pkg.root).toLowerCase()+'\\'))throw new Error('Executable must belong to installed OpenAI.Codex package');
  return {app:pkg.root,executable};
 }
 throw new Error('Codex-InfoBar supports macOS and Windows');
}
export async function processes(){
 if(process.platform==='win32'){
  const raw=await powershell("@(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={$_.ProcessId}},@{n='parent';e={$_.ParentProcessId}},@{n='command';e={$_.ExecutablePath}},@{n='args';e={$_.CommandLine}})|ConvertTo-Json -Compress");
  return raw?[].concat(JSON.parse(raw)):[];
 }
 const {stdout}=await run('/bin/ps',['-axo','pid=,ppid=,comm=']);
 return stdout.split('\n').flatMap(l=>{const m=l.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);return m?[{pid:Number(m[1]),parent:Number(m[2]),command:m[3]}]:[]});
}
export async function mainPid(app){
 const records=await processes();const matches=process.platform==='win32'?windowsMain(records,app.executable):records.filter(p=>p.command===app.executable);
 if(matches.length>1)throw new Error('Multiple Codex main processes; refusing restart');
 return matches[0]?.pid??null;
}
export async function listeners(debugPort){
 if(process.platform==='win32'){
  const raw=await powershell(`@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -eq ${Number(debugPort)} | Select-Object @{n='pid';e={$_.OwningProcess}},@{n='address';e={$_.LocalAddress}})|ConvertTo-Json -Compress`);
  return raw?[].concat(JSON.parse(raw)):[];
 }
 let stdout;
 try{({stdout}=await run('/usr/sbin/lsof',['-nP',`-iTCP:${debugPort}`,'-sTCP:LISTEN','-Fpn']));}
 catch(e){if(e.code===1)return [];throw e;}
 let pid;return stdout.split('\n').flatMap(l=>{if(l.startsWith('p'))pid=Number(l.slice(1));if(!l.startsWith('n'))return [];const address=l.slice(1);return [{pid,address:address.endsWith(':'+debugPort)?address.slice(0,-String(debugPort).length-1).replace(/^\[|\]$/g,''):address}];});
}
export async function requestQuit(app,pid){
 if(await mainPid(app)!==pid)return false;
 if(process.platform==='win32'){
  // CloseMainWindow is graceful; never Stop-Process -Force/taskkill /F.
  const result=await powershell(`$p=Get-Process -Id ${Number(pid)} -ErrorAction Stop; if($p.Path -ne ${psLiteral(app.executable)}){throw 'Process identity changed'}; $p.CloseMainWindow()|ConvertTo-Json -Compress`);
  return result==='true';
 }
 process.kill(pid,'SIGTERM');return true;
}
export async function launch(app,debugPort){
 const args=['--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${debugPort}`];
 if(process.platform==='darwin'){await run('/usr/bin/open',['-a',app.app,'--args',...args]);return;}
 await powershell(`Start-Process -FilePath ${psLiteral(app.executable)} -ArgumentList @(${args.map(psLiteral).join(',')})`);
}
