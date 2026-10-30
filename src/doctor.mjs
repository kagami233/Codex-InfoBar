import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveApp,mainPid,stateRoot,port,processes,powershell} from './platform.mjs';
import {inspectWatcher} from './service-state.mjs';
import {verifyEndpointOwner,listTargets,Cdp} from './cdp.mjs';
import {windowsSessionFlag,runWindowsSession} from './windows-session.mjs';
if(process.platform==='win32'&&!process.argv.includes(windowsSessionFlag)){
 process.exitCode=await runWindowsSession(import.meta.url,process.argv.slice(2),{run:powershell});
}else{
console.log(JSON.stringify({platform:process.platform,node:process.version,stateRoot,port}));
try{const app=await resolveApp();console.log(JSON.stringify({app:app.app,executable:app.executable,pid:await mainPid(app)}));}catch(e){console.error(e.message);process.exitCode=1;}
try{
 const watcher=await inspectWatcher({stateRoot,allowedScripts:[path.join(stateRoot,'runtime/src/watcher.mjs'),fileURLToPath(new URL('./watcher.mjs',import.meta.url))],readProcesses:processes});
 console.log('Watcher:',JSON.stringify(watcher));
 if(!watcher.alive||!watcher.fresh){console.error('Watcher is not alive or its status is stale; service is not healthy');process.exitCode=1;}
}catch(error){console.error(`Watcher: ${error.message}`);process.exitCode=1;}
try{
 await verifyEndpointOwner(port);
 let mounted=false;
 for(const target of await listTargets(port)){
  const c=await new Cdp(target,port).open();try{const status=await c.evaluate('window.__CODEX_METRICS_HUD__?.getStatus() ?? null');console.log(JSON.stringify({target:target.id,status}));if(status?.mounted&&!status.removed&&!status.stale)mounted=true;}finally{c.close();}
 }
 if(!mounted){console.error('No fresh mounted chat component; auxiliary windows alone do not prove mounting');process.exitCode=1;}
}catch(e){console.error(e.message);process.exitCode=1;}
}
