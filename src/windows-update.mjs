import fs from 'node:fs/promises';
import path from 'node:path';

// Remember the last working package across watcher restarts and login.
export async function observeWindowsUpdate({stateRoot,app,action,processRecord,offer}) {
  const file = path.join(stateRoot, 'update-recovery.json');
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const current = path.basename(app.app);
  if (!/^OpenAI\.Codex_\d+(?:\.\d+){3}_\w+__2p2nqsd0c76g0$/i.test(current)) return;
  let next;
  if (action === 'attach' && current !== previous.working) {
    next = {working:current};
  } else if (action === 'needs-debug-launch' && processRecord?.args && previous.working &&
             current !== previous.working && current !== previous.offered) {
    await offer(processRecord.pid, current);
    next = {...previous, offered:current};
  }
  if (!next) return;
  const temporary = file + '.' + process.pid + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(next));
  await fs.rename(temporary, file);
}
