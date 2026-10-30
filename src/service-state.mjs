import fs from 'node:fs/promises';
import path from 'node:path';

const normalized = value => process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
export function watcherOwner(lock, records, allowedScripts) {
  if (!Number.isInteger(lock?.pid) || lock.pid < 1 || typeof lock.script !== 'string' || !allowedScripts.some(script => normalized(script) === normalized(lock.script))) throw new Error('Invalid watcher lock identity');
  const record = records.find(record => record.pid === lock.pid);
  if (!record) return null;
  if (typeof record.command !== 'string' || typeof record.args !== 'string') {
    const error=new Error('Cannot verify watcher process identity');error.code='WATCHER_IDENTITY_UNAVAILABLE';throw error;
  }
  const script = lock.script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^node(?:\.exe)?$/i.test(path.basename(record.command)) && new RegExp(`(?:^|\\s)(?:"${script}"|${script})(?=\\s|$)`, process.platform==='win32'?'i':'').test(record.args) ? record : null;
}

export async function stopWatcher({stateRoot, allowedScripts, readProcesses, retire, timeout = 25000, interval = 500}) {
  await fs.mkdir(stateRoot, {recursive: true});
  await fs.writeFile(path.join(stateRoot, 'stop'), 'stop');
  const lockPath = path.join(stateRoot, 'watcher-lock.json');
  let deadline = Date.now() + timeout, retired=false;
  for (;;) {
    let raw;
    try { raw = await fs.readFile(lockPath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let owner;
    try{owner=watcherOwner(JSON.parse(raw), await readProcesses(), allowedScripts);}
    catch(error){
      // CIM can retain an exiting process briefly with null path/command fields.
      // Wait for it to disappear; never infer ownership or terminate it.
      if(error.code!=='WATCHER_IDENTITY_UNAVAILABLE'||Date.now()>=deadline)throw error;
      await new Promise(resolve=>setTimeout(resolve,interval));continue;
    }
    if (!owner) {
      // Recheck after the process query so an exiting/replaced owner cannot have
      // a newly acquired lock deleted by the installer.
      try { if (await fs.readFile(lockPath, 'utf8') === raw) await fs.rm(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else if (Date.now() >= deadline) {
      if(!retired&&retire){await retire(owner,JSON.parse(raw));retired=true;deadline=Date.now()+5000;}
      else throw new Error(`Watcher ${owner.pid} did not stop; Codex was not terminated. Run npm run doctor.`);
    } else await new Promise(resolve => setTimeout(resolve, interval));
  }
}

export async function inspectWatcher({stateRoot, allowedScripts, readProcesses, now}) {
  let lock, status;
  try { lock = JSON.parse(await fs.readFile(path.join(stateRoot, 'watcher-lock.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {alive: false, fresh: false, reason: 'No watcher lock'}; throw error; }
  const owner = watcherOwner(lock, await readProcesses(), allowedScripts);
  if (!owner) return {alive: false, fresh: false, reason: 'Stale watcher lock', lock};
  try { status = JSON.parse(await fs.readFile(path.join(stateRoot, 'status.json'), 'utf8')); } catch {}
  const checkedAt=now??Date.now();
  const fresh = status?.watcherPid === owner.pid && Number.isFinite(status.observedAt) && checkedAt >= status.observedAt && checkedAt - status.observedAt < 60000;
  return {alive: true, fresh, lock, status};
}
