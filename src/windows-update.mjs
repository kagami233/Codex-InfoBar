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
  if (action === 'attach' && current !== previous.working) {
    const temporary = file + '.' + process.pid + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({working:current}));
    await fs.rename(temporary, file);
  } else if (action === 'needs-debug-launch' && processRecord?.args && previous.working &&
             current !== previous.working && current !== previous.offered) {
    try {
      await fs.access(path.join(stateRoot, 'update-prompts', current));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // Only the launcher can confirm that the live process passed its checks
    // and that the prompt is about to be shown.
    await offer(processRecord.pid, current);
  }
}
