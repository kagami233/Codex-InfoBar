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
  // Separate, explicit InfoBar opt-in. The native consume RPC independently
  // enforces the user's read-only "Allow Codex to use resets" setting.
  const AUTO_KEY = 'codex-infobar.auto-reset.v1:';
  const JOURNAL_KEY = 'codex-infobar.reset-attempts.v1:';
  let autoInterval = null, autoBusy = false, autoState = 'disabled';
  let liveCards = [], autoRequests = new Map();
  const storage = (() => { try { return window.localStorage ?? null; } catch { return null; } })();
  const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
  function autoEnabled() {
    try { return Boolean(scope && storage?.getItem(AUTO_KEY + scope) === 'true'); } catch { return false; }
  }
  function syncAutoTimer() {
    if (autoInterval !== null) clearInterval(autoInterval);
    autoInterval = null;
    autoState = autoEnabled() ? 'watching' : 'disabled';
    if (autoEnabled() && !removed) autoInterval = setInterval(tickAutoReset, 5000);
  }
  function tickAutoReset() {
    if (removed || !autoEnabled() || (lastAttemptAt !== null && Date.now() - lastAttemptAt < 5000)) return;
    // Absolute expiry also works after waking from sleep. Cached cards only
    // schedule a fresh read; they can never authorize a redemption.
    const cards = liveCards.length ? liveCards : latest?.resetCards ?? [];
    if (cards.some(c => c.expiresAt * 1000 > Date.now() && c.expiresAt * 1000 - Date.now() <= 90000)) refresh();
  }
  function autoRpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = `codex-infobar-reset:${crypto.randomUUID()}`;
      const fail = () => { autoRequests.delete(id); reject(new Error('unconfirmed')); };
      const timer = setTimeout(fail, TIMEOUT_MS);
      autoRequests.set(id, { resolve, reject, timer });
      try {
        Promise.resolve(window.electronBridge.sendMessageFromView({type:'mcp-request', hostId:'local',
          request:{id,method,params}, timeoutMs:TIMEOUT_MS})).catch(() => { clearTimeout(timer); fail(); });
      } catch { clearTimeout(timer); fail(); }
    });
  }
  function rawCards(result) {
    return (Array.isArray(result?.rateLimitResetCredits?.credits) ? result.rateLimitResetCredits.credits : [])
      .filter(c => record(c) && c.status === 'available' && c.resetType === 'codexRateLimits' &&
        typeof c.id === 'string' && c.id.length > 0 && c.id.length <= 512 && seconds(c.expiresAt))
      .map(c => ({id:c.id, expiresAt:c.expiresAt}));
  }
  function retireAutoRequests() {
    for (const request of autoRequests.values()) { clearTimeout(request.timer); request.reject(new Error('retired')); }
    autoRequests.clear();
  }
  async function maybeAutoReset() {
    if (removed || autoBusy || !autoEnabled() || !crypto.subtle || typeof window.navigator?.locks?.request !== 'function') return;
    if (!liveCards.some(c => c.expiresAt * 1000 > Date.now() && c.expiresAt * 1000 - Date.now() <= 60000)) return;
    const accountScope = scope, epoch = generation;
    const active = () => !removed && generation === epoch && scope === accountScope && autoEnabled();
    autoBusy = true;
    try {
      // One lock across every chat/window and collector sharing this app origin.
      await window.navigator.locks.request('codex-infobar-reset:' + accountScope, {ifAvailable:true}, async lock => {
        if (!lock || !active()) return;
        const identity = await autoRpc('account/read', {refreshToken:false});
        if (!active() || identity?.account?.type !== 'chatgpt' || typeof identity.account.email !== 'string' ||
            typeof identity?.workspaceRouting?.chatgptAccountId !== 'string') return;
        const verified = await digest(JSON.stringify([identity.account.email,identity.workspaceRouting.chatgptAccountId]));
        if (!active() || verified !== accountScope) return;
        const fresh = await autoRpc('account/rateLimits/read', {});
        if (!active()) return;
        const card = rawCards(fresh).filter(c => c.expiresAt * 1000 > Date.now() && c.expiresAt * 1000 - Date.now() <= 60000)
          .sort((a,b) => a.expiresAt - b.expiresAt)[0];
        if (!card) return;
        const hash = await digest(card.id);
        if (!active()) return;
        const key = JOURNAL_KEY + accountScope;
        let journal;
        try { const raw = storage.getItem(key); journal = raw ? JSON.parse(raw) : {}; } catch { autoState = 'storage-error'; return; }
        if (!record(journal)) { autoState = 'storage-error'; return; }
        // Refuse an oversized/corrupt journal instead of forgetting a possibly
        // successful attempt and creating another idempotency key.
        if (Object.keys(journal).length > 200) { autoState = 'storage-error'; return; }
        if (Object.entries(journal).some(([id, attempt]) => id !== hash && numeric(attempt?.lastAttemptAt) && Date.now() - attempt.lastAttemptAt < 60000)) return;
        for (const [id, attempt] of Object.entries(journal)) if (seconds(attempt?.expiresAt) && attempt.expiresAt * 1000 < Date.now()) delete journal[id];
        const old = journal[hash];
        if (old && (!record(old) || typeof old.key !== 'string' || !numeric(old.lastAttemptAt) || !Number.isInteger(old.attempts))) {
          autoState = 'storage-error'; return;
        }
        if (old?.terminal || old?.attempts >= 3 || (old && Date.now() - old.lastAttemptAt < 10000)) return;
        const attempt = {key:old?.key ?? crypto.randomUUID(), expiresAt:card.expiresAt,
          lastAttemptAt:Date.now(), attempts:(old?.attempts ?? 0) + 1, terminal:false};
        journal[hash] = attempt;
        const save = () => { const raw = JSON.stringify(journal); storage.setItem(key,raw); if (storage.getItem(key) !== raw) throw new Error('storage'); };
        try { save(); } catch { autoState = 'storage-error'; return; }
        if (!active() || card.expiresAt * 1000 <= Date.now()) return;
        autoState = 'submitting';
        // Never call the HTTP checkout/consume endpoint or modify the setting.
        // The native main process rejects this RPC when permission is disabled.
        const result = await autoRpc('account/rateLimitResetCredit/consume', {idempotencyKey:attempt.key,creditId:card.id});
        if (['reset','alreadyRedeemed','nothingToReset','noCredit'].includes(result?.outcome)) {
          attempt.terminal = true;
          try { save(); } catch {} // Previously saved key still makes a retry idempotent.
          autoState = result.outcome;
        } else autoState = 'unconfirmed';
        if (active()) refresh();
      });
    } catch { autoState = 'unconfirmed-or-not-permitted'; }
    finally { autoBusy = false; }
  }
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
    syncAutoTimer();
    void maybeAutoReset();
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
    liveCards = rawCards(result);
    persist();
    publish(scope ? {...latest,cached:true} : latest);
    void maybeAutoReset();
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
      retireAutoRequests(); liveCards = [];
      if (identityPending) clearTimeout(identityPending.timer);
      identityPending = null; scope = null; latest = null;
      syncAutoTimer();
      try { storage?.removeItem(CACHE_KEY); } catch {}
      publish(null);
      readIdentity();
      refresh();
      return;
    }
    if (data.type !== "mcp-response" || !record(data.message)) return;
    const message = data.message;
    if (autoRequests.has(message.id)) {
      const request = autoRequests.get(message.id);
      clearTimeout(request.timer); autoRequests.delete(message.id);
      if (message.error) request.reject(new Error('native-rejected'));
      else request.resolve(message.result);
      return;
    }
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
    tickAutoReset,
    setAutoResetEnabled(enabled) {
      if (typeof enabled !== 'boolean' || !scope || !storage || !crypto.subtle || typeof window.navigator?.locks?.request !== 'function') return false;
      try {
        storage.setItem(AUTO_KEY + scope, String(enabled));
        if (storage.getItem(AUTO_KEY + scope) !== String(enabled)) return false;
      } catch { return false; }
      syncAutoTimer();
      if (enabled) refresh();
      return true;
    },
    getStatus() {
      return { state, removed, pending: pending !== null, lastAttemptAt, lastSuccessAt, cacheEnabled:Boolean(scope), cacheObservedAt:latest?.observedAt ?? null,
        autoResetEnabled:autoEnabled(), autoResetState:autoState };
    },
    remove() {
      if (removed) return false;
      removed = true;
      generation++;
      retireAutoRequests(); liveCards = [];
      if (identityPending) clearTimeout(identityPending.timer);
      if (interval !== null) clearInterval(interval);
      if (autoInterval !== null) clearInterval(autoInterval);
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
