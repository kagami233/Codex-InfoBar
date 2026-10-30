import fs from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {verifyEndpointOwner} from './cdp.mjs';
import {WatchPolicy} from './watch-policy.mjs';
import {resolveApp,mainPid,listeners,processes,requestQuit,launch,stateRoot,port} from './platform.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await fs.mkdir(stateRoot,{recursive:true,mode:0o700});
const log=message=>fs.appendFile(path.join(stateRoot,'watcher.log'),`${new Date().toISOString()} ${message}\n`);
const lockPath=path.join(stateRoot,'watcher-lock.json');
// Prevent duplicate Startup/LaunchAgent/manual launch collectors.
let lock;
try{lock=await fs.open(lockPath,'wx',0o600);}catch(error){
 if(error.code!=='EEXIST')throw error;
 let old;try{old=JSON.parse(await fs.readFile(lockPath,'utf8'));}catch{throw new Error('Invalid watcher lock; run npm run doctor before removing it');}
 if((await processes()).some(p=>p.pid===old.pid))throw new Error('Watcher already running (or PID reused); run npm run doctor');
 await fs.rm(lockPath);lock=await fs.open(lockPath,'wx',0o600);
}
await lock.writeFile(JSON.stringify({pid:process.pid,script:fileURLToPath(import.meta.url)}));
let stopped=false,collector=null;
const logfd=openSync(path.join(stateRoot,'collector.log'),'a',0o600);
const stopPoll=setInterval(()=>{void fs.access(path.join(stateRoot,'stop')).then(()=>{stopped=true;collector?.kill('SIGTERM');}).catch(()=>{});},500);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopped=true;collector?.kill('SIGTERM');});
try{
 try{const settings=JSON.parse(await fs.readFile(path.join(stateRoot,'settings.json'),'utf8'));for(const k of ['CODEX_HOME','CODEX_INFOBAR_APP'])if(settings[k]&&!process.env[k])process.env[k]=settings[k];}catch{}
 let app=await resolveApp(),initial=await mainPid(app);
 if(process.argv.includes('--launch')&&!initial){await launch(app,port);for(let i=0;i<30&&!stopped;i++){initial=await mainPid(app);if(initial)break;await sleep(1000);}}
 const policy=new WatchPolicy(initial);let previous='';
 await log(`Watcher ready; existing process ${initial??'none'} protected. Port ${port}.`);
 function attach(){
  if(collector)return;
  collector=spawn(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'attach','--port',String(port),'--position','inside'],{cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:['ignore',logfd,logfd],windowsHide:true});
  collector.once('error',e=>{void log(`Collector: ${e.message}`);collector=null;});
  collector.once('exit',code=>{collector=null;void log(`Collector exited (${code})`);});
 }
 while(!stopped){
  try{await fs.access(path.join(stateRoot,'stop'));stopped=true;break;}catch{}
  try{
   app=await resolveApp();const pid=await mainPid(app);let ready=false;
   try{await verifyEndpointOwner(port);ready=true;}catch{}
   const action=policy.decide({pid,ready,occupied:(await listeners(port)).length>0});
   if(action!==previous){await log(`State: ${action}`);previous=action;}
   await fs.writeFile(path.join(stateRoot,'status.json'),JSON.stringify({observedAt:Date.now(),pid,action,collectorPid:collector?.pid??null}));
   if(action==='attach')attach();
   if(action==='restart'&&!stopped){
    if(!await requestQuit(app,pid)){await log('Graceful quit refused; quit Codex manually and run npm start.');continue;}
    for(let i=0;i<30&&!stopped&&await mainPid(app)===pid;i++)await sleep(1000);
    if(stopped)break;
    if(await mainPid(app)){await log('Codex still running; no forced termination.');continue;}
    await launch(app,port);
    for(let i=0;i<30&&!stopped;i++){
     policy.protect(await mainPid(app));
     try{await verifyEndpointOwner(port);attach();break;}catch{}
     await sleep(1000);
    }
    await log('Startup attempt ended; no repeated restart for this process.');
   }
  }catch(e){await log(`Check failed: ${e.message}`);}
  if(!stopped)await sleep(3000);
 }
}finally{
 clearInterval(stopPoll);
 if(collector){const child=collector;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),sleep(7000)]);}
 closeSync(logfd);await lock.close();await fs.rm(lockPath,{force:true});
}
