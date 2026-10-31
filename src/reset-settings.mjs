import {verifyEndpointOwner,listTargets,Cdp} from './cdp.mjs';

const [action='status',flag,rawPort] = process.argv.slice(2);
const port = Number(rawPort ?? process.env.CODEX_INFOBAR_PORT ?? 9341);
if (!['on','off','status'].includes(action) || (flag && flag !== '--port') ||
    (flag && !rawPort) || !Number.isInteger(port) || port < 1024 || port > 65535 || process.argv.length > 5) {
  throw new Error('Usage: node src/reset-settings.mjs on|off|status [--port 9341]');
}
await verifyEndpointOwner(port);
let found = false;
for (const target of await listTargets(port)) {
  const client = await new Cdp(target,port).open();
  try {
    const status = await client.evaluate(`(()=>{
      const api=window.__CODEX_METRICS_ACCOUNT__;
      if(!api?.getStatus().cacheEnabled || !window.__CODEX_METRICS_HUD__?.getStatus().mounted) return null;
      const ok=${action==='status' ? 'true' : `api.setAutoResetEnabled(${action==='on'})`};
      const state=api.getStatus();
      return {ok,enabled:state.autoResetEnabled,state:state.autoResetState};
    })()`);
    if (!status) continue;
    if (!status.ok) throw new Error('Could not save setting: verified account, local storage and Web Locks are required.');
    console.log(`Expiring-card auto reset: ${status.enabled?'ON':'OFF'} (${status.state}).`);
    found = true;
    break;
  } finally {client.close();}
}
if (!found) throw new Error('No mounted InfoBar with a verified local account found. Open a local chat, wait for account data, then retry.');
