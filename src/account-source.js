(() => {
  "use strict";
  const KEY = "__CODEX_METRICS_ACCOUNT__";
  const POLL_MS = 60000;
  const TIMEOUT_MS = 10000;
  const MAX_SECONDS = 8640000000000;
  window[KEY]?.remove?.();

  const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const field = (value, snake, camel) => own(value, snake) ? value[snake] : value[camel];
  const numeric = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const seconds = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_SECONDS;
  let removed = false;
  let pending = null;
  let interval = null;
  let listening = false;
  let state = "unsupported";
  let lastAttemptAt = null;
  let lastSuccessAt = null;
  const CACHE_KEY = 'codex-metrics-hud.account-cache.v1';
  const CACHE_AGE = 7 * 86400000;
  let scope = null, identityPending = null, generation = 0, latest = null;
  const storage = (() => { try { return window.localStorage ?? null; } catch { return null; } })();
  function validCache(value) {
    if (!record(value) || !numeric(value.observedAt) || value.observedAt > Date.now() || Date.now() - value.observedAt > CACHE_AGE) return null;
    return { observedAt:value.observedAt, cached:true,
      resetCards:Array.isArray(value.resetCards) ? value.resetCards.slice(0,100).filter(c=>seconds(c?.expiresAt)).map(c=>({expiresAt:c.expiresAt})) : null,
      usageResets:Array.isArray(value.usageResets) ? value.usageResets.slice(0,20).filter(w=>record(w)&&seconds(w.resetsAt)).map(w=>({
        limitId:typeof w.limitId==='string'?w.limitId.slice(0,100):null, limitName:typeof w.limitName==='string'?w.limitName.slice(0,100):null,
        window:w.window==='secondary'?'secondary':'primary',windowMinutes:numeric(w.windowMinutes)?w.windowMinutes:null,
        usedPercent:numeric(w.usedPercent)&&w.usedPercent<=100?w.usedPercent:null,resetsAt:w.resetsAt,
      })) : null };
  }
  function persist() {
    if (!scope || !latest || !storage) return;
    try { storage.setItem(CACHE_KEY, JSON.stringify({version:1,scope,value:validCache(latest)})); } catch {}
  }
  async function identityResult(result, epoch) {
    const workspace = result?.workspaceRouting?.chatgptAccountId;
    const email = result?.account?.email;
    if (typeof workspace !== 'string' || typeof email !== 'string' || !crypto.subtle) return;
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([email,workspace])));
    if (removed || epoch !== generation) return;
    scope = Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
    if (latest) { persist(); publish({...latest,cached:true}); return; }
    try {
      const raw = storage?.getItem(CACHE_KEY);
      const entry = raw && raw.length < 32768 ? JSON.parse(raw) : null;
      if (entry?.version !== 1 || entry.scope !== scope) return;
      latest = validCache(entry.value);
      if (latest) { state = 'cached'; publish(latest); }
    } catch {}
  }
  function readIdentity() {
    if (!storage || !crypto.subtle || identityPending || removed) return;
    const id = `codex-metrics-identity:${crypto.randomUUID()}`;
    const epoch = generation;
    identityPending = {id,epoch,timer:setTimeout(()=>{identityPending=null;},TIMEOUT_MS)};
    try {
      Promise.resolve(window.electronBridge.sendMessageFromView({type:'mcp-request',hostId:'local',
        request:{id,method:'account/read',params:{refreshToken:false}},timeoutMs:TIMEOUT_MS})).catch(()=>{});
    } catch { clearTimeout(identityPending.timer); identityPending=null; }
  }

  function publish(value) {
    window.__CODEX_METRICS_HUD__?.updateAccount?.(value);
  }

  function resetCards(result) {
    const details = result.rateLimitResetCredits;
    if (!record(details) || !Array.isArray(details.credits)) return null;
    return [...new Set(details.credits.filter(credit => record(credit) &&
      credit.status === "available" && credit.resetType === "codexRateLimits" &&
      seconds(credit.expiresAt)).map(credit => credit.expiresAt))]
      .sort((a, b) => a - b).map(expiresAt => ({ expiresAt }));
  }

  function bucketWindows(bucket, observedAt, mapId = null) {
    const id = field(bucket, "limit_id", "limitId");
    const name = field(bucket, "limit_name", "limitName");
    if (mapId && typeof id === "string" && id !== mapId) return [];
    return ["primary", "secondary"].flatMap(window => {
      const item = bucket[window];
      if (!record(item)) return [];
      const resetsAt = field(item, "resets_at", "resetsAt");
      if (!seconds(resetsAt)) return [];
      const minutes = field(item, "window_minutes", "windowDurationMins");
      const used = field(item, "used_percent", "usedPercent");
      return [{
        limitId: mapId ?? (typeof id === "string" ? id : null),
        limitName: typeof name === "string" ? name : null,
        window, windowMinutes: numeric(minutes) && minutes > 0 ? minutes : null,
        usedPercent: numeric(used) ? used : null, resetsAt, observedAt,
      }];
    });
  }

  function usageResets(result, observedAt) {
    const mapKey = ["rate_limits_by_limit_id", "rateLimitsByLimitId"].find(key => own(result, key));
    const map = mapKey ? result[mapKey] : null;
    if (record(map)) {
      return Object.entries(map).flatMap(([id, bucket]) => record(bucket) ? bucketWindows(bucket, observedAt, id) : []);
    }
    const key = ["rate_limits", "rateLimits"].find(key => own(result, key));
    if (!key) return null;
    const bucket = result[key];
    if (bucket === null) return [];
    if (!record(bucket) || !["primary", "secondary"].some(window => own(bucket, window))) return null;
    return bucketWindows(bucket, observedAt);
  }

  function finish(id, result, failed = false) {
    if (removed || pending?.id !== id) return;
    clearTimeout(pending.timer);
    pending = null;
    if (failed || !record(result)) {
      state = "error";
      publish(scope ? validCache(latest) : null);
      return;
    }
    const observedAt = Date.now();
    const cards = resetCards(result);
    const resets = usageResets(result, new Date(observedAt).toISOString());
    state = cards === null && resets === null ? "unknown" : "ready";
    lastSuccessAt = observedAt;
    latest = { observedAt, resetCards: cards, usageResets: resets };
    persist();
    publish(scope ? {...latest,cached:true} : latest);
  }

  function onMessage(event) {
    const data = event.data;
    if (removed || !record(data) || data.hostId !== "local") return;
    if (data.type === "mcp-notification" && ["account/updated", "account/login/completed"].includes(data.method)) {
      // An old account's pending response must never repopulate the new account.
      if (pending !== null) clearTimeout(pending.timer);
      pending = null;
      lastSuccessAt = null;
      generation++;
      if (identityPending) clearTimeout(identityPending.timer);
      identityPending = null; scope = null; latest = null;
      try { storage?.removeItem(CACHE_KEY); } catch {}
      publish(null);
      readIdentity();
      refresh();
      return;
    }
    if (data.type !== "mcp-response" || !record(data.message)) return;
    const message = data.message;
    if (message.id === identityPending?.id) {
      const request = identityPending;
      clearTimeout(request.timer); identityPending = null;
      if (!message.error) void identityResult(message.result, request.epoch).catch(()=>{});
      return;
    }
    if (message.id !== pending?.id) return;
    finish(message.id, message.result, message.error != null);
  }

  function refresh() {
    if (removed || !listening || pending) return false;
    const bridge = window.electronBridge;
    if (typeof bridge?.sendMessageFromView !== "function") {
      state = "unsupported";
      publish(null);
      return false;
    }
    if (!scope) readIdentity();
    const id = `codex-metrics-hud:${crypto.randomUUID()}`;
    lastAttemptAt = Date.now();
    state = "loading";
    pending = { id, timer: setTimeout(() => finish(id, null, true), TIMEOUT_MS) };
    try {
      // This is the same read-only RPC as the client's get_usage_limits tool.
      const sent = bridge.sendMessageFromView({
        type: "mcp-request", hostId: "local",
        request: { id, method: "account/rateLimits/read", params: {} },
        timeoutMs: TIMEOUT_MS,
      });
      Promise.resolve(sent).catch(() => finish(id, null, true));
    } catch {
      finish(id, null, true);
    }
    return true;
  }

  const api = {
    version: "0.1.0",
    refresh,
    getStatus() {
      return { state, removed, pending: pending !== null, lastAttemptAt, lastSuccessAt, cacheEnabled:Boolean(scope), cacheObservedAt:latest?.observedAt ?? null };
    },
    remove() {
      if (removed) return false;
      removed = true;
      generation++;
      if (identityPending) clearTimeout(identityPending.timer);
      if (interval !== null) clearInterval(interval);
      if (pending !== null) clearTimeout(pending.timer);
      pending = null;
      if (listening) window.removeEventListener("message", onMessage);
      if (window[KEY] === api) delete window[KEY];
      publish(null);
      return true;
    },
  };
  window[KEY] = api;
  if (typeof window.electronBridge?.sendMessageFromView === "function") {
    window.addEventListener("message", onMessage);
    listening = true;
    interval = setInterval(refresh, POLL_MS);
    refresh();
  }
})();
