import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {stateRoot,resolveApp,processes,powershell,psLiteral,port} from './platform.mjs';
const run=promisify(execFile),label='local.codex.infobar.watcher';
const runtime=path.join(stateRoot,'runtime'),script=path.join(runtime,'src/watcher.mjs');
const source=fileURLToPath(new URL('../',import.meta.url));
const remove=process.argv.includes('--uninstall');
const plist=path.join(os.homedir(),'Library/LaunchAgents',label+'.plist');
const startup=process.platform==='win32'?path.join(process.env.APPDATA,'Microsoft/Windows/Start Menu/Programs/Startup/Codex-InfoBar.vbs'):null;
async function stop(){
 if(process.platform==='darwin'){
  const domain=`gui/${process.getuid()}`;
  try{await run('/bin/launchctl',['bootout',`${domain}/${label}`]);}catch{}
  for(let i=0;i<30;i++){try{await run('/bin/launchctl',['print',`${domain}/${label}`]);}catch{break;}await new Promise(r=>setTimeout(r,500));}
 }else if(process.platform==='win32'){
  // Send a cooperative stop file, rather than terminating unrelated Node jobs.
  await fs.mkdir(stateRoot,{recursive:true});await fs.writeFile(path.join(stateRoot,'stop'),'stop');
  for(let i=0;i<40;i++){try{await fs.access(path.join(stateRoot,'watcher-lock.json'));}catch{break;}await new Promise(r=>setTimeout(r,500));}
  try{await fs.access(path.join(stateRoot,'watcher-lock.json'));throw new Error('Watcher has not stopped; run doctor and retry.');}catch(e){if(e.code!=='ENOENT')throw e;}
 }else throw new Error('macOS and Windows only');
}
if(!remove)await resolveApp();
await stop();
if(remove){await fs.rm(process.platform==='win32'?startup:plist,{force:true});console.log('Startup service removed. Runtime/logs/cache retained at '+stateRoot);process.exit(0);}
await fs.mkdir(runtime,{recursive:true,mode:0o700});
await fs.cp(path.join(source,'src'),path.join(runtime,'src'),{recursive:true});
await fs.copyFile(path.join(source,'package.json'),path.join(runtime,'package.json'));
await fs.rm(path.join(stateRoot,'stop'),{force:true});
const config={CODEX_INFOBAR_PORT:String(port),...(process.env.CODEX_HOME?{CODEX_HOME:process.env.CODEX_HOME}:{}),...(process.env.CODEX_INFOBAR_APP?{CODEX_INFOBAR_APP:process.env.CODEX_INFOBAR_APP}:{})};
await fs.writeFile(path.join(stateRoot,'settings.json'),JSON.stringify(config,null,2),{mode:0o600});
if(process.platform==='darwin'){
 const xml=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 await fs.mkdir(path.dirname(plist),{recursive:true});
 await fs.writeFile(plist,`<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(script)}</string></array><key>EnvironmentVariables</key><dict><key>CODEX_INFOBAR_STATE</key><string>${xml(stateRoot)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>StandardOutPath</key><string>${xml(path.join(stateRoot,'service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(stateRoot,'service-error.log'))}</string></dict></plist>`,{mode:0o600});
 await run('/usr/bin/plutil',['-lint',plist]);await run('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,plist]);
}else{
 await fs.mkdir(path.dirname(startup),{recursive:true});
 const quote=s=>'"'+s.replaceAll('"','""')+'"';
 const command=`"${process.execPath}" "${script}"`;
 const vbs=`Set shell = CreateObject("WScript.Shell")\r\nshell.Environment("PROCESS")("CODEX_INFOBAR_STATE") = ${quote(stateRoot)}\r\nshell.Run ${quote(command)}, 0, False\r\n`;
 await fs.writeFile(startup,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(vbs,'utf16le')]));
 const child=spawn(process.execPath,[script],{detached:true,stdio:'ignore',windowsHide:true});child.unref();
}
console.log('Codex-InfoBar installed. Existing Codex is protected. Quit when work is saved, then click the original Codex icon and wait ~15–30 seconds. Logs: '+stateRoot);
