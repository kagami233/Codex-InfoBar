import net from 'node:net';

export async function unusedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function selectDebugPort({preferred, fixed, listeners, verify, allocate = unusedLoopbackPort}) {
  if (!(await listeners(preferred)).length) return preferred;
  try { await verify(preferred); return preferred; } catch {}
  if (fixed) throw new Error(`Configured debug port ${preferred} is occupied by an unverified listener; choose another CODEX_INFOBAR_PORT`);
  const port = await allocate();
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || (await listeners(port)).length) throw new Error('No unused loopback debug port available');
  return port;
}
