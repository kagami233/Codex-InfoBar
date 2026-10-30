import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {stateRoot,resolveApp,processes,powershell,port,fixedPort,listeners} from './platform.mjs';
import {startWindowsDetached,retireWindowsWatcher} from './windows-native.mjs';
import {stopWatcher,inspectWatcher} from './service-state.mjs';
import {selectDebugPort} from './debug-port.mjs';
import {verifyEndpointOwner} from './cdp.mjs';
import {windowsSessionFlag,windowsEnvironment,runWindowsSession} from './windows-session.mjs';
import {syncWindowsShortcuts,restoreWindowsShortcuts} from './windows-shortcuts.mjs';
if(process.platform==='win32'&&!process.argv.includes(windowsSessionFlag)){
 process.exitCode=await runWindowsSession(import.meta.url,process.argv.slice(2),{run:powershell});
}else{
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<17))throw new Error('Node.js 22.17 or newer is required');
const run=promisify(execFile),label='local.codex.infobar.watcher';
const runtime=path.join(stateRoot,'runtime'),script=path.join(runtime,'src/watcher.mjs');
const source=fileURLToPath(new URL('../',import.meta.url));
const allowedScripts=[script,path.join(source,'src/watcher.mjs')];
let priorSettings={};try{priorSettings=JSON.parse(await fs.readFile(path.join(stateRoot,'settings.json'),'utf8'));}catch{}
const remove=process.argv.includes('--uninstall');
const plist=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');
const startup=process.platform==='win32'?path.join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Startup/Codex-InfoBar.vbs'):null;
async function stop(){
 if(process.platform==='darwin'){
  const domain=`gui/${process.getuid()}`;
  try{await run('/bin/launchctl',['bootout',`${domain}/${label}`]);}catch{}
  for(let i=0;i<30;i++){try{await run('/bin/launchctl',['print',`${domain}/${label}`]);}catch{break;}await new Promise(r=>setTimeout(r,500));}
 }else if(process.platform==='win32'){
  await stopWatcher({stateRoot,allowedScripts,readProcesses:processes,retire:async(owner,lock)=>{
   console.log(`Retiring unresponsive InfoBar watcher ${owner.pid}; Codex and unrelated processes are not terminated.`);
   await retireWindowsWatcher(owner,lock,powershell);
  }});
 }else throw new Error('macOS and Windows only');
}
if(!remove)await resolveApp();
await stop();
if(remove){if(process.platform==='win32')await restoreWindowsShortcuts({stateRoot,run:powershell});await fs.rm(process.platform==='win32'?startup:plist,{force:true});console.log('Startup service removed. Runtime/logs/cache retained at '+stateRoot);}
else{
await fs.mkdir(runtime,{recursive:true,mode:0o700});
await fs.cp(path.join(source,'src'),path.join(runtime,'src'),{recursive:true});
await fs.copyFile(path.join(source,'package.json'),path.join(runtime,'package.json'));
await fs.rm(path.join(stateRoot,'stop'),{force:true});
const selectedPort=process.platform==='win32'?await selectDebugPort({preferred:port,fixed:fixedPort,listeners,verify:verifyEndpointOwner}):port;
if(selectedPort!==port)console.log(`Debug port ${port} is occupied; using unused loopback port ${selectedPort}. No listener was stopped.`);
const config={CODEX_INFOBAR_PORT:String(selectedPort),portMode:fixedPort?'fixed':'auto'};
for(const key of ['CODEX_HOME','CODEX_INFOBAR_APP'])if(process.env[key]||priorSettings[key])config[key]=process.env[key]||priorSettings[key];
await fs.writeFile(path.join(stateRoot,'settings.json'),JSON.stringify(config,null,2),{mode:0o600});
if(process.platform==='darwin'){
 const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 await fs.mkdir(path.dirname(plist),{recursive:true});
 await fs.writeFile(plist,`<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(script)}</string></array><key>EnvironmentVariables</key><dict><key>CODEX_INFOBAR_STATE</key><string>${xml(stateRoot)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(path.join(stateRoot,'service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(stateRoot,'service-error.log'))}</string></dict></plist>`,{mode:0o600});
 await run('/usr/bin/plutil',['-lint',plist]);await run('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,plist]);
}else{
 const links=await syncWindowsShortcuts({app:await resolveApp(),port:selectedPort,stateRoot,run:powershell});
 console.log(`Windows launch shortcuts updated: ${JSON.stringify(links.updated)}; custom/edited links skipped: ${JSON.stringify(links.skipped)}.`);
 console.log(`Taskbar launch target ready: ${links.launcher}`);
 await fs.mkdir(path.dirname(startup),{recursive:true});
 const quote=s=>'"'+s.replaceAll('"','""')+'"';
 const command=`"${process.execPath}" "${script}"`;
 const vbs=`Set shell = CreateObject("WScript.Shell")\r\nshell.Environment("PROCESS")("CODEX_INFOBAR_STATE") = ${quote(stateRoot)}\r\nshell.Run ${quote(command)}, 0, False\r\n`;
 await fs.writeFile(startup,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(vbs,'utf16le')]));
 const environment=windowsEnvironment({CODEX_INFOBAR_STATE:stateRoot});
 const pid=await startWindowsDetached(process.execPath,[script],{cwd:runtime,env:environment,run:powershell});
 const deadline=Date.now()+30000;let ready=false;
 while(Date.now()<deadline){
  const state=await inspectWatcher({stateRoot,allowedScripts,readProcesses:processes});
  if(state.alive&&state.fresh&&state.lock.pid===pid){ready=true;console.log(`Independent watcher ${pid} ready (${state.status.action}); loopback debug port ${selectedPort}.`);break;}
  if(!(await processes()).some(record=>record.pid===pid))break;
  await new Promise(r=>setTimeout(r,500));
 }
 if(!ready)throw new Error(`Startup entry was written, but watcher ${pid} did not become ready. See ${path.join(stateRoot,'watcher-error.log')} and run npm run doctor. Installation is incomplete.`);
}
console.log(process.platform==='win32'?'Codex-InfoBar installed. Existing Codex is protected. Updated Windows shortcuts launch with debugging directly. A Store taskbar pin must be replaced with the updated shortcut once; the watcher never closes Windows Codex to enable debugging. Logs: '+stateRoot:'Codex-InfoBar installed. Existing Codex is protected. Quit when work is saved, then click the original Codex icon and wait ~15–30 seconds. Logs: '+stateRoot);
}
}
