import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRollout } from './metrics.mjs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const TELEMETRY = new Set(['session_meta', 'turn_context', 'compacted', 'context_compacted', 'token_usage_record', 'token_count', 'task_started', 'task_complete', 'task_completed', 'task_aborted', 'turn_aborted', 'account/rateLimits/updated']);
const FIELDS = ['id','type','thread_id','turn_id','response_id','model','started_at','completed_at','duration_ms','model_context_window','usage','thread_token_usage','turn_token_usage','info','rate_limits','rateLimits','rate_limits_by_limit_id','rateLimitsByLimitId','window_number','window_id','compaction_response_id','compaction_id','automatic','trigger','reason','mode'];

async function telemetryText(file, size) {
  const lines = [];
  let pending = '', dropping = false, retained = 0;
  function accept(line) {
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); } catch { lines.push('{invalid'); return; }
    const type = e.type === 'event_msg' ? e.payload?.type : e.type;
    if (!TELEMETRY.has(type) || !e.payload) return;
    const payload = Object.fromEntries(FIELDS.filter(k => Object.hasOwn(e.payload, k)).map(k => [k, e.payload[k]]));
    const text = JSON.stringify({type:e.type, timestamp:e.timestamp, payload});
    retained += Buffer.byteLength(text);
    if (retained > MAX_BYTES) throw new Error('统计事件本身超过 64 MiB，暂无法完整处理。');
    lines.push(text);
  }
  if (!size) return '';
  for await (const chunk of createReadStream(file, { encoding:'utf8', highWaterMark:65536, end:size-1 })) {
    let start = 0, end;
    while ((end = chunk.indexOf('\n', start)) !== -1) {
      const part = chunk.slice(start, end);
      if (!dropping && pending.length + part.length <= MAX_HEADER_BYTES) accept(pending + part);
      else lines.push(JSON.stringify({type:'hud_oversized_record',payload:{}}));
      pending = ''; dropping = false; start = end + 1;
    }
    if (!dropping) {
      pending += chunk.slice(start);
      if (pending.length > MAX_HEADER_BYTES) { pending = ''; dropping = true; }
    }
  }
  // A trailing partial JSONL write is ignored by the parser as before.
  if (pending) accept(pending);
  return lines.join('\n');
}
export function validateThreadId(value) {
  if (!UUID.test(value ?? '')) throw new Error('需要明确的聊天 UUID；不会自动选择最近活动聊天。');
  return value.toLowerCase();
}

export class RolloutReader {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), scanIntervalMs = 3000 } = {}) {
    this.root = path.join(codexHome, 'sessions');
    this.scanIntervalMs = scanIntervalMs;
    this.paths = new Map();
    this.headers = new Map();
    this.cache = new Map();
  }

  async metadata(file, stat) {
    const key = `${stat.mtimeMs}:${stat.size}`;
    const cached = this.headers.get(file);
    if (cached?.key === key) return cached.id;
    const handle = await fs.open(file, 'r');
    let id = null;
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_HEADER_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const newline = text.indexOf('\n');
      if (newline < 0 && stat.size > bytesRead) return null;
      const first = JSON.parse(newline >= 0 ? text.slice(0, newline) : text);
      if (first.type === 'session_meta' && typeof first.payload?.id === 'string') id = first.payload.id.toLowerCase();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    } finally {
      await handle.close();
    }
    this.headers.set(file, { key, id });
    return id;
  }

  async locate(threadId) {
    threadId = validateThreadId(threadId);
    const now = Date.now();
    let indexed = this.paths.get(threadId);
    if (!indexed || now - indexed.scannedAt >= this.scanIntervalMs) {
      const files = [];
      const name = new RegExp(`-${threadId}(?:_[0-9a-f-]{36})?\\.jsonl$`, 'i');
      for await (const entry of fs.glob(`*/*/*/rollout-*-${threadId}*.jsonl`, { cwd: this.root })) {
        if (name.test(path.basename(entry))) files.push(path.join(this.root, entry));
      }
      indexed = { files, scannedAt: now };
      this.paths.set(threadId, indexed);
    }
    const matches = [];
    for (const file of indexed.files) {
      let stat;
      try { stat = await fs.stat(file); } catch (error) {
        if (error.code === 'ENOENT') { this.paths.delete(threadId); continue; }
        throw error;
      }
      if (!stat.isFile() || await this.metadata(file, stat) !== threadId) continue;
      matches.push({ file, stat });
    }
    if (!matches.length) throw new Error('此聊天没有可读取的本机会话记录（远端聊天暂不支持）。');
    matches.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    if (matches.length > 1 && matches[0].stat.mtimeMs === matches[1].stat.mtimeMs) {
      throw new Error('同一聊天的多个记录片段更新时间相同，暂时无法确定当前片段。');
    }
    // Same-thread files can contain diverging sequences at identical ordinals.
    // Select the freshest validated fragment; do not merge branches as history.
    return matches[0].file;
  }

  async snapshot(threadId, options = {}) {
    threadId = validateThreadId(threadId);
    const file = await this.locate(threadId);
    const stat = await fs.stat(file);
    const key = `${file}:${stat.mtimeMs}:${stat.size}`;
    let cache = this.cache.get(threadId);
    if (!cache || cache.key !== key) {
      const text = await telemetryText(file, stat.size);
      cache = { key, text };
      this.cache.delete(threadId);
      this.cache.set(threadId, cache);
      // Keep multiple windows warm, with a shared bound on retained telemetry.
      let bytes = [...this.cache.values()].reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
      while (this.cache.size > 1 && (this.cache.size > 8 || bytes > MAX_BYTES)) {
        const oldest = this.cache.keys().next().value;
        bytes -= Buffer.byteLength(this.cache.get(oldest).text);
        this.cache.delete(oldest);
      }
    }
    return parseRollout(cache.text, { ...options, threadId, historyComplete: false });
  }
}
