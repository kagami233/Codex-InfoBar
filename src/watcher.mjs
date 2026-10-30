import fs from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {verifyEndpointOwner} from './cdp.mjs';
import {WatchPolicy} from './watch-policy.mjs';
import {selectDebugPort} from './debug-port.mjs';
import {watcherOwner} from './service-state.mjs';
import {syncWindowsShortcuts} from './windows-shortcuts.mjs';
import {resolveApp,mainPid,mainProcess,requestedDebugPort,listeners,processes,requestQuit,launch,stateRoot,port,fixedPort,setDebugPort,powershell} from './platform.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
await fs.mkdir(stateRoot,{recursive:true,mode:0o700});
const log=message=>fs.appendFile(path.join(stateRoot,'watcher.log'),`${new Date().toISOString()} ${message}\n`);
const lockPath=path.join(stateRoot,'watcher-lock.json');
// Prevent duplicate Startup/LaunchAgent/manual launch collectors.
let lock;
try{lock=await fs.open(lockPath,'wx',0o600);}catch(error){
 if(error.code!=='EEXIST')throw error;
 let old;try{old=JSON.parse(await fs.readFile(lockPath,'utf8'));}catch{throw new Error('Invalid watcher lock; run npm run doctor before removing it');}
 const allowed=[fileURLToPath(import.meta.url),path.join(stateRoot,'runtime/src/watcher.mjs')];
 if(watcherOwner(old,await processes(),allowed))throw new Error('Watcher already running; run npm run doctor');
 if(JSON.stringify(old)!==JSON.stringify(JSON.parse(await fs.readFile(lockPath,'utf8'))))throw new Error('Watcher lock changed; retry after npm run doctor');
 await fs.rm(lockPath);lock=await fs.open(lockPath,'wx',0o600);
}
await lock.writeFile(JSON.stringify({pid:process.pid,script:fileURLToPath(import.meta.url)}));
let stopped=false,collector=null,lastError=null,phase=null;
const status=async(pid,action)=>{
 const temporary=path.join(stateRoot,`status.${process.pid}.tmp`);
 await fs.writeFile(temporary,JSON.stringify({observedAt:Date.now(),watcherPid:process.pid,pid,action,phase,debugPort:port,collectorPid:collector?.pid??null,lastError}));
 await fs.rename(temporary,path.join(stateRoot,'status.json'));
};
const logfd=openSync(path.join(stateRoot,'collector.log'),'a',0o600);
const stopPoll=setInterval(()=>{void fs.access(path.join(stateRoot,'stop')).then(()=>{stopped=true;collector?.kill('SIGTERM');}).catch(()=>{});},500);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopped=true;collector?.kill('SIGTERM');});
try{
 try{const settings=JSON.parse(await fs.readFile(path.join(stateRoot,'settings.json'),'utf8'));for(const k of ['CODEX_HOME','CODEX_INFOBAR_APP'])if(settings[k]&&!process.env[k])process.env[k]=settings[k];}catch{}
 let app=await resolveApp(),initial=await mainPid(app);
 if(process.argv.includes('--launch')&&!initial){await launch(app,port);for(let i=0;i<30&&!stopped;i++){initial=await mainPid(app);if(initial)break;await sleep(1000);}}
 const policy=new WatchPolicy(initial);let previous='';
 let shortcutIdentity='';
 await log(`Watcher ${process.pid} ready; existing process ${initial??'none'} protected. Port ${port}.`);
 function attach(){
  if(collector)return;
  collector=spawn(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'attach','--port',String(port),'--position','inside'],{cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:['ignore',logfd,logfd],windowsHide:true});
  collector.once('error',e=>{lastError=e.message;void log(`Collector: ${e.message}`);collector=null;});
  collector.once('exit',code=>{collector=null;void log(`Collector exited (${code})`);});
 }
 while(!stopped){
  try{await fs.access(path.join(stateRoot,'stop'));stopped=true;break;}catch{}
  let pid=null;
  try{
   app=await resolveApp();const processRecord=await mainProcess(app);pid=processRecord?.pid??null;let ready=false;
   const debugRequested=Boolean(requestedDebugPort(processRecord?.args));
   try{await verifyEndpointOwner(port);ready=true;}catch{}
   let occupied=(await listeners(port)).length>0;
   if(process.platform==='win32'&&occupied&&!ready&&!fixedPort&&!debugRequested){
    const next=await selectDebugPort({preferred:port,fixed:false,listeners,verify:verifyEndpointOwner});
    if(next!==port){const prior=port;await setDebugPort(next);await log(`Port ${prior} has an unverified/stale listener; using unused loopback port ${port}. No listener was stopped.`);occupied=false;}
   }
   if(process.platform==='win32'&&shortcutIdentity!==`${app.executable}:${port}`){
    try{const links=await syncWindowsShortcuts({app,port,stateRoot,run:powershell});
     await log(`Shortcut launch parameters ready; updated ${links.updated.length}, custom/edited links skipped ${links.skipped.length}.`);
    }catch(error){await log(`Shortcut update failed; collector remains available: ${error.message}`);}
    shortcutIdentity=`${app.executable}:${port}`;
   }
   const action=policy.decide({pid,ready,occupied,debugRequested,autoRestart:process.platform!=='win32'});
   if(action!==previous){await log(`State: ${action}; pid=${pid??'none'}; debugRequested=${debugRequested}`);previous=action;}
   phase=null;
   if(action==='attach'){attach();lastError=null;}
   await status(pid,action);
   if(action==='restart'&&!stopped){
    phase='graceful-quit';await status(pid,action);
    if(!await requestQuit(app,pid))throw new Error('Graceful quit refused; no forced termination attempted');
    const quitDeadline=Date.now()+30000;
    while(!stopped&&await mainPid(app)===pid&&Date.now()<quitDeadline){await status(pid,action);await sleep(1000);}
    if(stopped)break;
    if(await mainPid(app))throw new Error('Codex is still running after graceful shutdown; no forced termination attempted');
    phase='launch-debug';await status(null,action);
    await launch(app,port);
    let attached=false;
    for(let i=0;i<30&&!stopped;i++){
     const launched=await mainPid(app);policy.protect(launched);
     try{await verifyEndpointOwner(port);attach();attached=true;await status(launched,'attach');break;}catch{}
     await status(launched,action);await sleep(1000);
    }
    if(!attached&&!stopped)throw new Error(`Codex did not expose verified loopback debug port ${port}`);
    await log('Startup attempt ended; no repeated restart for this process.');
   }
  }catch(e){lastError=e.message;await log(`Check failed: ${e.message}`);await status(pid,'failed');}
  if(!stopped)await sleep(3000);
 }
}finally{
 clearInterval(stopPoll);
 if(collector){const child=collector;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),sleep(7000)]);}
 closeSync(logfd);await lock.close();await fs.rm(lockPath,{force:true});
}
}
await main().catch(async error=>{
 try{await fs.appendFile(path.join(stateRoot,'watcher-error.log'),`${new Date().toISOString()} ${error.stack??error}\n`);}catch{}
 console.error(error);process.exitCode=1;
});
