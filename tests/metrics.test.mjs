import test from "node:test";
import assert from "node:assert/strict";
import { parseRollout } from "../src/metrics.mjs";

const start = Date.parse("2026-10-29T18:00:00Z");
const e = (type, payload, seconds = 0) => JSON.stringify({ type, timestamp: new Date(start + seconds * 1000).toISOString(), payload });
const msg = (type, payload = {}, seconds = 0) => e("event_msg", { type, ...payload }, seconds);
const u = (input = 100, cached = 80, output = 20) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output });
const count = (last, total, seconds) => msg("token_count", { info: { last_token_usage: last, total_token_usage: total, model_context_window: 1000 } }, seconds);
const parse = (events, options = {}) => parseRollout(events.join("\n"), { threadId: "thread-a", now: start + 10000, ...options });

test("uses actual usage, exact turn totals, and wall time without double counting telemetry", () => {
  const result = parse([
    e("session_meta", { id: "thread-a" }), msg("task_started", { turn_id: "turn-a" }),
    e("turn_context", { model: "test-model" }),
    e("token_usage_record", { thread_id: "thread-a", turn_id: "turn-a", response_id: "r1", usage: u(), thread_token_usage: u(), turn_token_usage: u() }, 2),
    count(u(), u(), 2),
    e("token_usage_record", { thread_id: "thread-a", turn_id: "turn-a", response_id: "r2", usage: u(130, 100, 30), thread_token_usage: u(230, 180, 50), turn_token_usage: u(230, 180, 50) }, 4),
    count(u(130, 100, 30), u(230, 180, 50), 4),
  ]);
  assert.equal(result.averageOutputTps, 5);
  assert.equal(result.contextUsedTokens, 160);
  assert.equal(result.contextRemainingTokens, 840);
  assert.equal(result.lastCacheRatio, 100 / 130);
  assert.equal(result.compactLimitTokens, null);
  assert.equal(result.compactRemainingTokens, null);
  assert.equal(result.active, true);
});

test("completed turn speed freezes at completion, next turn restarts baseline", () => {
  const events = [msg("task_started", { turn_id: "a" }), count(u(), u(), 2), msg("task_complete", { turn_id: "a" }, 5)];
  assert.equal(parse(events, { now: start + 90000 }).averageOutputTps, 4);
  const next = parse([...events, msg("task_started", { turn_id: "b" }, 6), count(u(200, 100, 10), u(300, 180, 30), 8)]);
  assert.equal(next.averageOutputTps, 2.5);
});
test('different persisted and notification baselines do not invalidate exact turn speed', () => {
  const events = [msg('task_started', {turn_id:'a'}),
    e('token_usage_record', {turn_id:'a', response_id:'r1', usage:u(100,80,20), turn_token_usage:u(100,80,20), thread_token_usage:u(100,80,6500)}, 2),
    count(u(100,80,20),u(100,80,20),2.1),
    e('token_usage_record', {turn_id:'a', response_id:'r2', usage:u(100,80,30), turn_token_usage:u(200,160,50), thread_token_usage:u(200,160,6530)}, 4),
    count(u(100,80,30),u(200,160,50),4.1)];
  assert.equal(parse(events).averageOutputTps,5);
  assert.equal(parse(events).warning,undefined);
  assert.equal(parse([...events,msg('task_complete',{turn_id:'a'},5)], {now:start+90000}).averageOutputTps,10);
  const noExact = events.map(line => {const e=JSON.parse(line);delete e.payload.turn_token_usage;return JSON.stringify(e)});
  assert.equal(parse(noExact).averageOutputTps,5);
});
test('actual exact-turn counter rollback remains unavailable even if notifications increase', () => {
  const record = (output, seconds) => e('token_usage_record',{turn_id:'a',response_id:`r${seconds}`,usage:u(),turn_token_usage:u(100,80,output)},seconds);
  const result = parse([msg('task_started',{turn_id:'a'}),record(50,2),record(20,3),count(u(),u(),4)]);
  assert.equal(result.averageOutputTps,null);
  assert.match(result.warning,/回退/);
});

test("accepts the Unix-seconds started_at used by local rollout records", () => {
  const result = parse([msg("task_started", { started_at: start / 1000 }), count(u(), u(), 2)]);
  assert.equal(result.averageOutputTps, 2);
});

test("deduplicates compaction record and completion notification; unknown is not automatic", () => {
  const result = parse([
    count(u(), u(), 1),
    e("response_item", { type: "compaction", id: "internal" }, 2),
    msg("context_compacted", {}, 3), e("compacted", { window_id: "w1" }, 3.1),
    e("compacted", { window_id: "w1" }, 3.1),
    e("compacted", { window_id: "w2", trigger: "automatic" }, 8),
  ]);
  assert.equal(result.compactionCount, 2);
  assert.equal(result.automaticCompactionCount, null);
  assert.equal(result.contextUsedTokens, null);
  assert.match(result.warning, /等待/);
});

test("explicit compaction types and threshold remain distinct from context capacity", () => {
  const result = parse([
    e("compacted", { window_id: "w1", trigger: "manual" }, 1),
    e("compacted", { window_id: "w2", automatic: true }, 3),
    count(u(), u(), 4),
  ], { compactLimitTokens: 900, historyComplete: true });
  assert.equal(result.compactionCount, 2);
  assert.equal(result.automaticCompactionCount, 1);
  assert.equal(result.compactRemainingTokens, 780);
});

test("single paginated files report observed counts, never an unproven lifetime zero", () => {
  const result = parse([e("session_meta", { id: "thread-a", history_mode: "paginated" }), count(u(), u(), 1)]);
  assert.equal(result.compactionCount, 0);
  assert.equal(result.compactionCountScope, "observed");
  assert.equal(result.compactionHistoryComplete, false);
  assert.equal(result.automaticCompactionCount, null);
  const inherited = parse([e("compacted", { window_number: 0, window_id: "seed" })], { historyComplete: true });
  assert.equal(inherited.compactionCount, 0);
  assert.equal(inherited.compactionHistoryComplete, false);
});

test("body_after_prefix threshold cannot be compared with total request tokens", () => {
  const result = parse([count(u(), u(), 1)], { compactLimitTokens: 900, compactLimitScope: "body_after_prefix" });
  assert.equal(result.compactRemainingTokens, null);
  assert.match(result.warning, /窗口前缀/);
});

test("completion time metadata takes precedence over delayed log-write time", () => {
  const result = parse([msg("task_started"), count(u(), u(), 2), msg("task_complete", { completed_at: start / 1000 + 5 }, 8)]);
  assert.equal(result.averageOutputTps, 4);
  assert.equal(result.active, false);
});

test("partial JSONL, null usage and zero denominator do not produce false numbers", () => {
  const result = parse([msg("task_started"), count(u(0, 0, 0), u(0, 0, 0), 1), '{"type":']);
  assert.equal(result.lastCacheRatio, null);
  assert.equal(result.averageOutputTps, 0);
  assert.equal(result.warning, undefined);
  const empty = parse([msg("token_count", { info: null })]);
  assert.equal(empty.status, "unavailable");
  assert.equal(empty.contextUsedTokens, null);
  assert.equal(empty.averageOutputTps, null);
});

test("counter rollback and out-of-order events cannot inflate speed", () => {
  const result = parse([msg("task_started"), count(u(), u(), 2), count(u(100, 0, 5), u(100, 0, 5), 3), count(u(900, 900, 900), u(900, 900, 900), 1)]);
  assert.equal(result.averageOutputTps, null);
  assert.equal(result.contextUsedTokens, 105);
  assert.match(result.warning, /回退/);
});

test("rejects wrong file and excludes another thread's token usage", () => {
  assert.equal(parse([e("session_meta", { id: "wrong" })]).status, "unavailable");
  const result = parse([e("token_usage_record", { thread_id: "wrong", usage: u() }, 1)]);
  assert.equal(result.contextUsedTokens, null);
});

test("extracts actual account reset seconds even without token usage info", () => {
  const result = parse([msg("token_count", { info: null, rate_limits: {
    limit_id: "codex", limit_name: null,
    primary: { used_percent: 0, window_minutes: 10080, resets_at: 1793774140 },
    secondary: null, credits: { balance: "secret" }, accountId: "private",
  } }, 2)]);
  assert.deepEqual(result.usageResets, [{ limitId: "codex", limitName: null, window: "primary",
    windowMinutes: 10080, usedPercent: 0, resetsAt: 1793774140, observedAt: new Date(start + 2000).toISOString() }]);
  assert.equal(result.usageResetsUpdatedAt, new Date(start + 2000).toISOString());
  assert.equal(result.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(result.usageResets), /secret|private|credits/);
});

test("reset updates clear null windows, ignore older snapshots, and survive omitted fields", () => {
  const rate = (primary, secondary) => ({ limit_id: "codex", primary, secondary });
  const window = (seconds) => ({ resets_at: seconds, window_minutes: 300, used_percent: 50 });
  const events = [
    msg("token_count", { rate_limits: rate(window(1793774140), window(1793775140)) }, 1),
    msg("token_count", { rate_limits: rate(null, window(1793776140)) }, 3),
    msg("token_count", { rate_limits: rate(window(1793774140), null) }, 2),
    count(u(), u(), 4),
  ];
  const result = parse(events);
  assert.equal(result.usageResets.length, 1);
  assert.equal(result.usageResets[0].window, "secondary");
  assert.equal(result.usageResets[0].resetsAt, 1793776140);
  assert.deepEqual(parse([...events, msg("token_count", { rate_limits: null }, 5)]).usageResets, []);
});

test("supports named multi-bucket windows without assuming primary duration", () => {
  const result = parse([msg("token_count", { rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1793774140 },
      secondary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1793771140 } },
    other: { limitId: "other", limitName: "Other", primary: { resetsAt: 1793772140 } },
  }, rateLimits: { limitId: "legacy", primary: { resetsAt: 1793774140 } } }, 1)]);
  assert.deepEqual(result.usageResets.map(x => [x.limitId, x.window, x.windowMinutes]),
    [["codex", "primary", 10080], ["codex", "secondary", 300], ["other", "primary", null]]);
  assert.equal(result.usageResets[2].usedPercent, null);
});

test("invalid resets stay unknown and expired timestamps are never rolled forward", () => {
  for (const resets_at of [undefined, null, 0, -1, "1793774140", 1.5, 9000000000000]) {
    assert.deepEqual(parse([msg("token_count", { rate_limits: { primary: { resets_at } } })]).usageResets, []);
  }
  const expired = start / 1000 - 120;
  const good = msg("token_count", { rate_limits: { primary: { resets_at: expired } } }, 1);
  const malformed = msg("token_count", { rate_limits: "bad" }, 2);
  const wrong = msg("token_count", { thread_id: "wrong", rate_limits: null }, 3);
  const missingTimestamp = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: null } });
  const result = parse([good, malformed, wrong, missingTimestamp]);
  assert.equal(result.usageResets[0].resetsAt, expired);
  assert.equal(result.usageResetsUpdatedAt, new Date(start + 1000).toISOString());
  assert.deepEqual(parse([e("session_meta", { id: "wrong" }), good]).usageResets, []);
});

test('compaction calibration exports token metadata with model/window identity and explicit manual distinction',()=>{
 const data=parse([e('turn_context',{model:'model',cwd:'/test/project'}),count(u(170000,100000,2000),u(),1),e('compacted',{window_id:'w1',window_number:1,compaction_tokens_before:172000,trigger:'manual'},2)]);
 assert.equal(data.compactionCwd,'/test/project');
 assert.deepEqual(data.compactionSamples,[{tokens:172000,model:'model',contextWindow:1000,trigger:'manual'}]);
});
