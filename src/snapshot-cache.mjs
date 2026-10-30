import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {stateRoot} from './platform.mjs';

const MAX_BYTES = 1024 * 1024;
const MAX_AGE = 7 * 86400000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBERS = ['averageOutputTps','lastCacheRatio','compactionCount','contextUsedTokens','contextWindowTokens','contextRemainingTokens'];
function clean(entry, now) {
  const value = entry?.snapshot, at = entry?.receivedAt;
  if (!value || typeof value.threadId !== 'string' || !UUID.test(value.threadId) || value.status !== 'ok' ||
      !Number.isFinite(at) || at <= 0 || at > now || now - at > MAX_AGE) return null;
  const snapshot = { threadId:value.threadId.toLowerCase(), status:'ok', source:'local-rollout',
    historyComplete:value.historyComplete === true, active:false };
  for (const key of NUMBERS) snapshot[key] = Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : null;
  if(typeof value.model==='string')snapshot.model=value.model.slice(0,100);
  snapshot.compactionSamples=Array.isArray(value.compactionSamples)?value.compactionSamples.slice(-8).filter(x=>typeof x.model==='string'&&Number.isFinite(x.tokens)&&x.tokens>0&&Number.isFinite(x.contextWindow)&&x.contextWindow>0).map(x=>({model:x.model.slice(0,100),tokens:x.tokens,contextWindow:x.contextWindow,trigger:['auto','manual'].includes(x.trigger)?x.trigger:'unknown'})):[];
  const r=value.compactReference;
  if(r?.kind==='calibrated-compaction-estimate'&&['limit','remaining','remainingPercent','reserve','sampleCount'].every(k=>Number.isFinite(r[k])&&r[k]>=0))snapshot.compactReference={kind:r.kind,limit:r.limit,remaining:r.remaining,remainingPercent:r.remainingPercent,reserve:r.reserve,sampleCount:r.sampleCount,source:typeof r.source==='string'?r.source.slice(0,80):'unknown'};
  // Account limits/cards are deliberately reread from the signed-in client.
  return { snapshot, receivedAt:at };
}
export class SnapshotCache {
  constructor({file = path.join(stateRoot,'snapshot-cache.json'), now = Date.now} = {}) {
    this.file = file; this.now = now; this.lastSave = null;
  }
  async load() {
    try {
      if ((await fs.stat(this.file)).size > MAX_BYTES) return new Map();
      const data = JSON.parse(await fs.readFile(this.file,'utf8'));
      if (data.version !== 1 || !Array.isArray(data.entries)) return new Map();
      return new Map(data.entries.slice(-64).map(e => clean(e,this.now())).filter(Boolean).map(e=>[e.snapshot.threadId,e]));
    } catch { return new Map(); }
  }
  async save(entries, force = false) {
    const now = this.now();
    if (!force && this.lastSave !== null && now - this.lastSave < 5000) return;
    const values = [...entries.values()].slice(-64).map(e=>clean(e,now)).filter(Boolean);
    const text = JSON.stringify({version:1,entries:values});
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('状态缓存超出大小限制');
    await fs.mkdir(path.dirname(this.file), {recursive:true,mode:0o700});
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary,text,{mode:0o600,flag:'wx'});
      await fs.rename(temporary,this.file);
      this.lastSave = now;
    } finally { await fs.rm(temporary,{force:true}); }
  }
}
