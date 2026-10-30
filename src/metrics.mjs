// Only telemetry is returned; prompts, tool arguments and response text stay local.
const number = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const time = (value) => {
  // task_started.started_at is Unix seconds; JSONL timestamp is ISO 8601.
  const result = typeof value === "number"
    ? (value >= 1e9 && value < 1e11 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(result) ? result : null;
};
const usage = (value) => value && typeof value === "object" ? value : null;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const field = (value, snake, camel) => own(value, snake) ? value[snake] : value[camel];
const record = (value) => value && typeof value === "object" && !Array.isArray(value);

function resetWindows(bucket, observedAt, mapId = null) {
  const id = field(bucket, "limit_id", "limitId");
  const name = field(bucket, "limit_name", "limitName");
  // A keyed bucket must not silently substitute another bucket's identity.
  if (mapId && typeof id === "string" && id !== mapId) return [];
  const result = [];
  for (const window of ["primary", "secondary"]) {
    const item = bucket[window];
    if (!record(item)) continue;
    const resetsAt = field(item, "resets_at", "resetsAt");
    if (!Number.isSafeInteger(resetsAt) || resetsAt <= 0 || resetsAt > 8640000000000) continue;
    const minutes = field(item, "window_minutes", "windowDurationMins");
    result.push({
      limitId: mapId ?? (typeof id === "string" ? id : null),
      limitName: typeof name === "string" ? name : null,
      window, windowMinutes: number(minutes) > 0 ? minutes : null,
      usedPercent: number(field(item, "used_percent", "usedPercent")),
      resetsAt, observedAt,
    });
  }
  return result;
}

function readUsageResets(payload, stamp) {
  if (stamp === null) return undefined;
  const observedAt = new Date(stamp).toISOString();
  const mapKey = ["rate_limits_by_limit_id", "rateLimitsByLimitId"].find(key => own(payload, key));
  const map = mapKey ? payload[mapKey] : null;
  if (record(map)) {
    return Object.entries(map).flatMap(([id, bucket]) => record(bucket) ? resetWindows(bucket, observedAt, id) : []);
  }
  const key = ["rate_limits", "rateLimits"].find(key => own(payload, key));
  if (!key) return undefined;
  const bucket = payload[key];
  if (bucket === null) return [];
  if (!record(bucket) || !["primary", "secondary"].some(window => own(bucket, window))) return undefined;
  return resetWindows(bucket, observedAt);
}
const trigger = (payload) => {
  if (typeof payload.automatic === "boolean") return payload.automatic ? "auto" : "manual";
  const value = payload.trigger ?? payload.reason ?? payload.mode;
  if (["auto", "automatic", "auto_compact"].includes(value)) return "auto";
  if (["manual", "user", "user_requested"].includes(value)) return "manual";
  return "unknown";
};

/** Parse a complete rollout snapshot, tolerating an incomplete final JSONL write.
 * averageOutputTps is output tokens / turn wall time, including tools and waits.
 * Context is the latest reported request size, not a live measurement.
 */
export function parseRollout(text, {
  threadId = null, now = Date.now(), compactLimitTokens = null,
  compactLimitScope = "total", historyComplete = false,
} = {}) {
  let model = null;
  let compactionCwd = null, growthBaseline = null, usageModel = null, usageWindow = null;
  const recentContextGrowth = [];
  let updatedAt = null;
  let latestUsageAt = -Infinity;
  let latestResetsAt = -Infinity;
  let usageResets = [];
  let usageResetsUpdatedAt = null;
  let last = null;
  let contextWindow = null;
  const cumulativeOutput = new Map();
  let current = null;
  let malformed = false;
  let skippedOversized = false;
  let compactionAfterUsage = false;
  let inheritedCompactionSnapshot = false;
  const responseIds = new Set();
  const completions = [];

  const unavailable = (warning) => ({
    threadId, model, updatedAt: null, lastCacheRatio: null,
    usageResets: [], usageResetsUpdatedAt: null,
    contextUsedTokens: null, contextWindowTokens: null, contextRemainingTokens: null,
    compactLimitTokens: number(compactLimitTokens), compactRemainingTokens: null,
    compactionCount: 0, historyComplete: false, compactionHistoryComplete: false, compactionCountScope: "observed",
    automaticCompactionCount: null, automaticCompactionCountKnown: 0,
    unknownCompactionCount: 0, averageOutputTps: null,
    active: false, status: "unavailable", source: "local-rollout", warning,
  });

  const lines = String(text).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch {
      if (index !== lines.length - 1) malformed = true;
      continue;
    }
    const p = event?.payload;
    if (!p || typeof p !== "object") continue;
    if (event.type === "hud_oversized_record") { skippedOversized = true; continue; }
    const stamp = time(event.timestamp);
    if (event.type === "session_meta") {
      if (threadId && p.id && p.id !== threadId) return unavailable("会话 ID 不匹配");
      threadId ??= p.id ?? null;
      if (typeof p.cwd==='string') compactionCwd=p.cwd;
    }
    if (p.thread_id && threadId && p.thread_id !== threadId) continue;
    const type = event.type === "event_msg" ? p.type : event.type;
    if (["token_count", "account/rateLimits/updated"].includes(type) && stamp !== null && stamp >= latestResetsAt) {
      const resets = readUsageResets(p, stamp);
      if (resets !== undefined) {
        usageResets = resets;
        latestResetsAt = stamp;
        usageResetsUpdatedAt = new Date(stamp).toISOString();
      }
    }
    if (type === "turn_context") {
      if (typeof p.model === 'string' && p.model !== model) { model=p.model; growthBaseline=null; recentContextGrowth.length=0; }
      if (typeof p.cwd==='string') compactionCwd=p.cwd;
      continue;
    }
    if (type === "task_started") {
      // Replayed start events must not reset the same turn's accumulated output.
      if (current && p.turn_id && current.id === p.turn_id) continue;
      current = {
        id: p.turn_id ?? null, start: time(p.started_at) ?? stamp, end: null,
        recordOutput: null, recordInvalid: false,
        totals: new Map([...cumulativeOutput].map(([source, previousTotal]) => [source, { previousTotal, output: 0, hasOutput: false, invalid: false }])),
      };
      contextWindow = number(p.model_context_window) ?? contextWindow;
      continue;
    }
    if (["task_complete", "task_completed", "task_aborted", "turn_aborted"].includes(type)) {
      if (current && (!p.turn_id || !current.id || p.turn_id === current.id)) {
        current.end = time(p.completed_at) ?? (
          current.start !== null && number(p.duration_ms) !== null
            ? current.start + p.duration_ms : stamp ?? time(now));
      }
      continue;
    }
    if (type === "compacted" || type === "context_compacted") {
      // A fork/import can begin with a carried summary at window 0. It proves
      // prior context exists, not a compaction completed in this observed run.
      if (type === "compacted" && p.window_number === 0 && !current) {
        inheritedCompactionSnapshot = true;
        compactionAfterUsage = true;
        continue;
      }
      completions.push({
        canonical: type === "compacted", at: stamp, turn: p.turn_id ?? null,
        id: p.compaction_response_id ?? p.compaction_id ?? p.window_id ?? null,
        trigger: trigger(p),
        tokens: number(p.compaction_tokens_before), model:usageModel ?? model, contextWindow:usageWindow ?? contextWindow,

      });
      compactionAfterUsage = true; growthBaseline=null; recentContextGrowth.length=0;
      continue;
    }
    let lastUsage = null;
    let totalUsage = null;
    let turnUsage = null;
    if (type === "token_usage_record") {
      if (p.response_id && responseIds.has(p.response_id)) continue;
      if (p.response_id) responseIds.add(p.response_id);
      lastUsage = usage(p.usage);
      totalUsage = usage(p.thread_token_usage);
      if (current && (!p.turn_id || !current.id || p.turn_id === current.id)) turnUsage = usage(p.turn_token_usage);
    } else if (type === "token_count") {
      const info = p.info;
      if (!info) continue;
      lastUsage = usage(info.last_token_usage);
      totalUsage = usage(info.total_token_usage);
      contextWindow = number(info.model_context_window) ?? contextWindow;
    } else continue;

    // Ignore out-of-order telemetry instead of overwriting newer snapshots.
    if (stamp !== null && stamp < latestUsageAt) continue;
    if (stamp !== null) {
      latestUsageAt = stamp;
      updatedAt = new Date(stamp).toISOString();
    }
    if (lastUsage) {
      const used=number(lastUsage.total_tokens);
      if(used!==null&&growthBaseline!==null&&used>growthBaseline){recentContextGrowth.push(used-growthBaseline);if(recentContextGrowth.length>12)recentContextGrowth.shift();}
      if(used!==null)growthBaseline=used;
      last = lastUsage; compactionAfterUsage = false; usageModel=model; usageWindow=contextWindow;
    }
    const totalOutput = number(totalUsage?.output_tokens);
    if (current) {
      const recordOutput = number(turnUsage?.output_tokens);
      if (recordOutput !== null) {
        if (current.recordOutput !== null && recordOutput < current.recordOutput) {
          current.recordInvalid = true;
        }
        current.recordOutput = recordOutput;
      }
      if (totalOutput !== null) {
        // Persisted records and legacy notifications can have different cumulative
        // baselines. Never subtract one stream from the other or add both.
        const counter = current.totals.get(type) ?? { previousTotal: null, output: 0, hasOutput: false, invalid: false };
        if (counter.previousTotal !== null) {
          const delta = totalOutput - counter.previousTotal;
          if (delta < 0) counter.invalid = true;
          else counter.output += delta;
        } else {
          counter.output += number(lastUsage?.output_tokens) ?? 0;
        }
        counter.previousTotal = totalOutput;
        counter.hasOutput = true;
        current.totals.set(type, counter);
      }
    }
    if (totalOutput !== null) cumulativeOutput.set(type, totalOutput);
  }

  // Prefer persisted completions. Notifications have different IDs and no
  // reliable linkage, so combining the two streams would require guessing.
  // Only notification-only legacy logs use context_compacted for the count.
  // Never count response_item.compaction (an internal model response).
  const unique = [];
  const hasPersistedCompletions = completions.some((item) => item.canonical);
  for (const item of completions.filter((item) => !hasPersistedCompletions || item.canonical)) {
    const match = unique.find((other) =>
      (item.id && other.id && item.id === other.id) ||
      (!item.id && !other.id && item.at !== null && other.at !== null && item.at === other.at));
    if (match) {
      if (match.trigger === "unknown") match.trigger = item.trigger;
    } else unique.push({ ...item });
  }
  const used = compactionAfterUsage ? null : number(last?.total_tokens) ?? (
    number(last?.input_tokens) !== null && number(last?.output_tokens) !== null
      ? last.input_tokens + last.output_tokens : null);
  const input = number(last?.input_tokens);
  const cached = number(last?.cached_input_tokens);
  const cacheRatio = input > 0 && cached !== null && cached <= input ? cached / input : null;
  const limit = number(compactLimitTokens);
  const elapsed = current?.start !== null && current?.start !== undefined
    ? ((current.end ?? time(now)) - current.start) / 1000 : null;
  const fallback = current?.totals.get('token_count') ?? current?.totals.get('token_usage_record');
  const exact = current?.recordOutput != null;
  const invalidSpeed = exact ? current.recordInvalid : Boolean(fallback?.invalid);
  const output = exact ? current.recordOutput : fallback?.hasOutput ? fallback.output : null;
  const average = output !== null && !invalidSpeed && elapsed > 0 ? output / elapsed : null;
  const warnings = [];
  if (skippedOversized) warnings.push("已跳过超大记录，压缩次数仅为可读取部分");
  if (malformed) warnings.push("已忽略损坏的记录");
  if (invalidSpeed) warnings.push("用量计数回退，速度暂不可用");
  if (compactionAfterUsage) warnings.push("已压缩，等待新的上下文用量");
  const completeHistory = Boolean(historyComplete && !malformed && !skippedOversized && !inheritedCompactionSnapshot);
  const unknownCompactionCount = unique.filter((item) => item.trigger === "unknown").length;
  const automaticCompactionCountKnown = unique.filter((item) => item.trigger === "auto").length;
  if (compactLimitScope === "body_after_prefix" && limit !== null) warnings.push("压缩阈值按窗口前缀之后的增长计算，余量未知");
  return {
    threadId, model, updatedAt, lastCacheRatio: cacheRatio,
    compactionCwd, recentContextGrowth,
    compactionSamples: unique.filter(x=>x.tokens>0).slice(-8).map(x=>({tokens:x.tokens,model:x.model,contextWindow:x.contextWindow,trigger:x.trigger})),
    usageResets, usageResetsUpdatedAt,
    contextUsedTokens: used, contextWindowTokens: contextWindow,
    contextRemainingTokens: used !== null && contextWindow !== null ? Math.max(0, contextWindow - used) : null,
    compactLimitTokens: limit,
    compactRemainingTokens: compactLimitScope === "total" && used !== null && limit !== null ? Math.max(0, limit - used) : null,
    compactionCount: unique.length,
    historyComplete: completeHistory,
    compactionHistoryComplete: completeHistory,
    compactionCountScope: completeHistory ? "complete" : "observed",
    automaticCompactionCount: completeHistory && !unknownCompactionCount ? automaticCompactionCountKnown : null,
    automaticCompactionCountKnown, unknownCompactionCount,
    averageOutputTps: average, active: Boolean(current && current.end === null),
    status: last ? "ok" : "unavailable", source: "local-rollout",
    ...(warnings.length ? { warning: warnings.join("；") } : {}),
  };
}
