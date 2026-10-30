import fs from 'node:fs/promises';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { RolloutReader, validateThreadId } from './reader.mjs';
import { Cdp, listTargets, verifyEndpointOwner } from './cdp.mjs';
import { SnapshotCache } from './snapshot-cache.mjs';
import { addCompactReference } from './compact-reference.mjs';

const here = new URL('.', import.meta.url);
const args = process.argv.slice(2);
const mode = args.shift() || 'preview';
const options = { thread: process.env.CODEX_THREAD_ID, port: 9341, position: 'inside' };
while (args.length) {
  const key = args.shift();
  if (!['--thread','--port','--position','--account-snapshot'].includes(key) || !args.length) throw new Error(`未知参数 ${key}`);
  options[key.slice(2)] = args.shift();
}
options.port = Number(options.port);
if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('端口必须介于 1024–65535。');
if (!['above','below','inside'].includes(options.position)) throw new Error('不支持的显示位置。');
if (options['account-snapshot'] && mode !== 'preview') throw new Error('--account-snapshot 仅用于预览；原生客户端直接读取当前账户。');
const reader = new RolloutReader();
const renderer = (await Promise.all(['renderer.js', 'account-source.js'].map(file => fs.readFile(new URL(file, here), 'utf8')))).join('\n;\n');
const missing = (threadId, error) => ({ threadId, status: 'unavailable', source: 'local-rollout', warning: error.message });
async function snapshot(threadId) {
  try { return await addCompactReference(await reader.snapshot(threadId)); } catch (error) { return missing(threadId,error); }
}

async function previewAccountSnapshot() {
  if (!options['account-snapshot']) return null;
  try {
    const stat = await fs.stat(options['account-snapshot']);
    if (!stat.isFile() || stat.size > 32768) return null;
    const value = JSON.parse(await fs.readFile(options['account-snapshot'], 'utf8'));
    // A deliberately supplied preview snapshot is short-lived and contains no identifiers or credentials.
    if (!Number.isFinite(value.observedAt)) return null;
    return {
      observedAt: value.observedAt,
      resetCards: Array.isArray(value.resetCards) ? value.resetCards.map(card => ({ expiresAt: card?.expiresAt })) : null,
      usageResets: Array.isArray(value.usageResets) ? value.usageResets.map(window => Object.fromEntries(
        ['limitId','limitName','window','windowMinutes','usedPercent','resetsAt','observedAt'].map(key => [key, window?.[key]]))) : null,
    };
  } catch { return null; }
}

async function preview() {
  const id = validateThreadId(options.thread);
  const secret = randomBytes(24).toString('hex');
  const prefix = `/${secret}/`;
  let html = await fs.readFile(new URL('preview.html', here), 'utf8');
  // A genuine supported route lets preview exercise the same route isolation.
  html = html.replace('<script src="./renderer.js">', `<script>history.replaceState(null,'','/threads/${id}?key=${secret}');</script><script src="${prefix}renderer.js">`)
    .replace("fetch('./metrics'", `fetch('${prefix}metrics'`);
  const server = http.createServer(async (req,res) => {
    const address = server.address();
    if (req.headers.host !== `127.0.0.1:${address.port}` || req.method !== 'GET' || (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${address.port}`)) {
      res.writeHead(403);res.end();return;
    }
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const url = new URL(req.url, `http://127.0.0.1:${address.port}`);
    if (url.pathname === `${prefix}metrics`) {
      const data = await snapshot(id);
      data.accountUsage = await previewAccountSnapshot();
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(data));
    } else if (url.pathname === `${prefix}renderer.js`) {
      res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(renderer);
    } else if (url.pathname === prefix || (url.pathname === `/threads/${id}` && url.searchParams.get('key') === secret)) {
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
    } else { res.writeHead(404);res.end(); }
  });
  await new Promise((resolve,reject) => {
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  console.log(`预览：http://127.0.0.1:${server.address().port}${prefix}`);
  console.log('按 Ctrl+C 关闭预览服务。');
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => { server.close();server.closeAllConnections(); });
}

async function attach() {
  await verifyEndpointOwner(options.port);
  const clients = new Map();
  const diskCache = new SnapshotCache();
  const sharedSnapshots = await diskCache.load();
  console.log(`已恢复 ${sharedSnapshots.size} 个聊天的本地统计缓存。`);
  let stopping = false;
  let lastIssue = '';
  async function cleanup() {
    stopping = true;
    for (const client of clients.values()) {
      try { await client.evaluate('window.__CODEX_METRICS_HUD__?.remove()'); } catch {}
      client.close();
    }
    clients.clear();
    try { await diskCache.save(sharedSnapshots, true); } catch (error) { console.error(`状态缓存保存失败：${error.message}`); }
  }
  // Finish the current operation, then clean up exactly once in finally.
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => { stopping = true; });
  console.log('已连接本机客户端；按 Ctrl+C 移除状态条并停止采集。');
  try {
    while (!stopping) {
      // Ownership failures are fatal, including when a closed port is reused.
      await verifyEndpointOwner(options.port);
      try {
        const targets = await listTargets(options.port);
        const present = new Set(targets.map(t => t.id));
        for (const [id,client] of clients) if (!present.has(id) || client.closed) { client.close(); clients.delete(id); }
        for (const target of targets) {
          if (stopping) break;
          let client = clients.get(target.id);
          if (!client) {
            client = await new Cdp(target, options.port).open();
            clients.set(target.id,client);
          }
          if (stopping) break;
          try {
            let ready = await client.evaluate('Boolean(window.__CODEX_METRICS_HUD__)');
            if (stopping) break;
            if (!ready) {
              await client.evaluate(renderer);
              await client.evaluate(`window.__CODEX_METRICS_HUD__.setPosition(${JSON.stringify(options.position)})`);
              if (sharedSnapshots.size) await client.evaluate(`window.__CODEX_METRICS_HUD__.primeSnapshots(${JSON.stringify([...sharedSnapshots.values()])})`);
            }
            const id = await client.evaluate('window.__CODEX_METRICS_HUD__.getThreadId()');
            if (id) {
              const data = await snapshot(id);
              sharedSnapshots.delete(id);
              sharedSnapshots.set(id, { snapshot: data, receivedAt: Date.now() });
              if (sharedSnapshots.size > 64) sharedSnapshots.delete(sharedSnapshots.keys().next().value);
              await client.evaluate(`window.__CODEX_METRICS_HUD__.update(${JSON.stringify(data)})`);
            }
          } catch (error) {
            // A background renderer can pause CDP responses. Keep its HUD;
            // reconnect on the next pass without reinjecting it.
            if (!error.transient) {
              try { await client.evaluate('window.__CODEX_METRICS_HUD__?.remove()'); } catch {}
            }
            client.close();clients.delete(target.id);
            if (lastIssue !== error.message) console.error(error.message);
            lastIssue = error.message;
          }
        }
        // Warm every window with the same bounded, thread-keyed cache, including
        // chats previously visited in another window. Preserve sample timestamps.
        if (!stopping && sharedSnapshots.size) {
          const entries = JSON.stringify([...sharedSnapshots.values()]);
          await Promise.allSettled([...clients.values()].map(client =>
            client.evaluate(`window.__CODEX_METRICS_HUD__?.primeSnapshots(${entries})`)));
        }
        lastIssue = '';
        try { await diskCache.save(sharedSnapshots); } catch (error) { console.error(`状态缓存保存失败：${error.message}`); }
      } catch (error) {
        if (lastIssue !== error.message) console.error(error.message);
        lastIssue = error.message;
      }
      if (!stopping) await new Promise(resolve => setTimeout(resolve,2000));
    }
  } finally { await cleanup(); }
}

try {
  if (mode === 'snapshot') console.log(JSON.stringify(await snapshot(validateThreadId(options.thread)),null,2));
  else if (mode === 'preview') await preview();
  else if (mode === 'attach') await attach();
  else throw new Error('用法：node src/cli.mjs preview|snapshot|attach [--thread UUID] [--position above|below|inside] [--port 9341]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
