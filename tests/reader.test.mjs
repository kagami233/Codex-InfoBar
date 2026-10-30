import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RolloutReader } from '../src/reader.mjs';

const id = '11111111-2222-3333-4444-555555555555';
const other = '66666666-7777-8888-9999-000000000000';
const suffix = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const data = (thread, compactions = 0, tokens = 100) => [
  { type: 'session_meta', ordinal: 0, payload: { id: thread, history_mode: 'paginated' } },
  ...Array.from({ length: compactions }, (_, i) => ({ type: 'compacted', payload: { window_id: `window-${i}`, window_number: i + 1 } })),
  { type: 'event_msg', timestamp: '2026-10-30T00:00:00Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: tokens, output_tokens: 10, cached_input_tokens: 80, total_tokens: tokens + 10 }, model_context_window: 1000 } } },
].map(JSON.stringify).join('\n') + '\n';
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-metrics-reader-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, 'sessions/2026/10/30');
  await fs.mkdir(dir, { recursive: true });
  return { home, dir };
}
async function write(dir, name, text, age) {
  const file = path.join(dir, name);
  await fs.writeFile(file, text);
  const timestamp = new Date(Date.now() - age);
  await fs.utimes(file, timestamp, timestamp);
  return file;
}

test('reads newest same-thread suffix fragment and labels counts as observed', async (t) => {
  const { home, dir } = await fixture(t);
  await write(dir, `rollout-2026-10-30T00-00-00-${id}.jsonl`, data(id), 10000);
  const latest = await write(dir, `rollout-2026-10-30T00-01-00-${id}_${suffix}.jsonl`, data(id, 2, 200), 5000);
  const reader = new RolloutReader({ codexHome: home });
  assert.equal(await reader.locate(id), latest);
  const snapshot = await reader.snapshot(id, { historyComplete: true });
  assert.equal(snapshot.compactionCount, 2);
  assert.equal(snapshot.contextUsedTokens, 210);
  assert.equal(snapshot.historyComplete, false);
  assert.equal(snapshot.compactionCountScope, 'observed');
});

test('filename match never substitutes for session metadata identity', async (t) => {
  const { home, dir } = await fixture(t);
  const valid = await write(dir, `rollout-2026-10-30T00-00-00-${id}.jsonl`, data(id), 10000);
  await write(dir, `rollout-2026-10-30T00-01-00-${id}_${suffix}.jsonl`, data(other, 9), 5000);
  const reader = new RolloutReader({ codexHome: home });
  assert.equal(await reader.locate(id), valid);
  assert.equal((await reader.snapshot(id)).compactionCount, 0);
  await assert.rejects(reader.snapshot('../escape'), /UUID/);
});

test('refreshes changed files and discovers new fragments without restarting', async (t) => {
  const { home, dir } = await fixture(t);
  const base = await write(dir, `rollout-2026-10-30T00-00-00-${id}.jsonl`, data(id), 20000);
  const reader = new RolloutReader({ codexHome: home, scanIntervalMs: 0 });
  assert.equal((await reader.snapshot(id)).contextUsedTokens, 110);
  await fs.writeFile(base, data(id, 0, 300));
  assert.equal((await reader.snapshot(id)).contextUsedTokens, 310);
  await fs.utimes(base, new Date(Date.now() - 10000), new Date(Date.now() - 10000));
  await write(dir, `rollout-2026-10-30T00-01-00-${id}_${suffix}.jsonl`, data(id, 1, 500), 1000);
  assert.equal((await reader.snapshot(id)).contextUsedTokens, 510);
});

test('large chat bodies and older fragments do not block selected telemetry', async (t) => {
  const { home, dir } = await fixture(t);
  const base = await write(dir, `rollout-2026-10-30T00-00-00-${id}.jsonl`, data(id), 10000);
  const fragment = await write(dir, `rollout-2026-10-30T00-01-00-${id}_${suffix}.jsonl`, data(id), 5000);
  await fs.truncate(base, 33 * 1024 * 1024);
  await fs.truncate(fragment, 70 * 1024 * 1024);
  await fs.appendFile(fragment, '\n' + data(id, 2, 500));
  const reader = new RolloutReader({ codexHome: home });
  const snapshot = await reader.snapshot(id);
  assert.equal(snapshot.status, 'ok');
  assert.equal(snapshot.contextUsedTokens, 510);
  assert.equal(snapshot.compactionCount, 2);
  assert.ok(reader.cache.get(id).text.length < 10000);
});

test('compaction learning reads only numeric usage metadata, excluding summary and replacement content',async t=>{
 const {home,dir}=await fixture(t);
 const text=data(id)+JSON.stringify({type:'compacted',payload:{window_number:1,window_id:'sample',message:'private summary',latest_token_usage_record:{usage:{total_tokens:900,input_tokens:800,output_tokens:100},private:'secret'},replacement_history:['private content']}})+'\n';
 await write(dir,`rollout-2026-10-30T00-00-00-${id}.jsonl`,text,0);
 const reader=new RolloutReader({codexHome:home});const s=await reader.snapshot(id);
 assert.equal(s.compactionSamples[0].tokens,900);
 assert.doesNotMatch(reader.cache.get(id).text,/private summary|private content|secret/);
});
