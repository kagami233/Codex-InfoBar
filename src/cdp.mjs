import {resolveApp,processes,listeners,validateWindowsListeners} from './platform.mjs';
import os from 'node:os';
import path from 'node:path';


export function verifyOwners(records, executable, helper) {
  const mains = records.filter(record => record.command === executable);
  if (mains.length !== 1) throw new Error('调试端口缺少唯一的 Codex 主进程。');
  const main = mains[0];
  // Codex's computer-use service inherits the listening descriptor. Only this
  // exact direct child is permitted, not arbitrary descendants or other apps.
  if (records.some(record => record !== main && !(record.command === helper && record.parent === main.pid))) {
    throw new Error('调试端口含未经验证的进程。');
  }
}

export function validSocket(raw, port) {
  const url = new URL(raw);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || Number(url.port) !== port || url.username || url.password) {
    throw new Error('拒绝非本机或端口不匹配的调试连接。');
  }
  return url.href;
}

export async function verifyEndpointOwner(port) {
  const app=await resolveApp();
  const sockets=await listeners(port);
  if(!sockets.length)throw new Error(`Debug port ${port} is closed; quit Codex, then run npm start.`);
  const records=await processes();
  if(process.platform==='win32'){validateWindowsListeners(sockets,records,app.executable);return;}
  if(sockets.some(s=>!['127.0.0.1','::1'].includes(s.address)))throw new Error('Debug listener must be loopback only');
  const pids=new Set(sockets.map(s=>s.pid));
  const owners=records.filter(r=>pids.has(r.pid));
  if(owners.length!==pids.size)throw new Error('Listener owner changed');
  verifyOwners(owners,app.executable,path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService'));
}

export async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`调试端口 HTTP ${response.status}`);
  return (await response.json()).filter(t => {
    if (t.type !== 'page' || !t.url?.startsWith('app://') || !t.webSocketDebuggerUrl) return false;
    try { validSocket(t.webSocketDebuggerUrl, port); return true; } catch { return false; }
  });
}

export class Cdp {
  constructor(target, port) {
    this.socket = new WebSocket(validSocket(target.webSocketDebuggerUrl, port));
    this.pending = new Map();
    this.id = 0;
    this.closed = false;
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('调试连接已关闭')); }
      this.pending.clear();
    });
  }
  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('调试连接超时')); }, 5000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); this.close(); reject(new Error('调试连接失败')); }, { once: true });
    });
    return this;
  }
  async evaluate(expression) {
    if (this.closed) throw new Error('调试连接已关闭');
    const id = ++this.id;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); const error = new Error('调试命令超时'); error.transient = true; reject(error); }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (result.exceptionDetails) throw new Error('状态条脚本执行失败');
    return result.result?.value;
  }
  close() { this.socket.close(); this.closed = true; }
}
