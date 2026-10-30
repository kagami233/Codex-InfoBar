import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveApp,mainPid,stateRoot,port} from './platform.mjs';
import {verifyEndpointOwner,listTargets,Cdp} from './cdp.mjs';
console.log(JSON.stringify({platform:process.platform,node:process.version,stateRoot,port}));
try{const app=await resolveApp();console.log(JSON.stringify({app:app.app,executable:app.executable,pid:await mainPid(app)}));}catch(e){console.error(e.message);process.exitCode=1;}
try{console.log('Watcher:',await fs.readFile(path.join(stateRoot,'status.json'),'utf8'));}catch{console.log('Watcher: no status yet');}
try{
 await verifyEndpointOwner(port);
 for(const target of await listTargets(port)){
  const c=await new Cdp(target,port).open();try{console.log(JSON.stringify({target:target.id,status:await c.evaluate('window.__CODEX_METRICS_HUD__?.getStatus() ?? null')}));}finally{c.close();}
 }
}catch(e){console.error(e.message);process.exitCode=1;}
