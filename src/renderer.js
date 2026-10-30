(() => {
  "use strict";
  const KEY = "__CODEX_METRICS_HUD__";
  const HOST_ID = "codex-metrics-hud";
  const EXPIRY_MS = 30000;
  const ACCOUNT_EXPIRY_MS = 90000;
  const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
  const ROUTE = new RegExp(`^/(?:local|threads|hotkey-window/thread)/${UUID}/?$`, "i");
  window[KEY]?.remove?.();

  let snapshot = null;
  let accountSnapshot = null;
  let receivedAt = 0;
  let collectorAt = 0;
  let position = "inside";
  let removed = false;
  let mounted = false;
  let lastRoute = null;
  let lastView = "";
  const snapshots = new Map();
  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("data-codex-metrics-hud", "true");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { display:block; min-width:0; max-width:100%; margin:6px 0;
      flex:0 0 auto; box-sizing:border-box; color:var(--color-token-text-secondary, #a6a6a6);
      font:11px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    :host([hidden]) { display:none !important; }
    .bar { display:flex; flex-wrap:nowrap; align-items:center; gap:3px 14px; padding:5px 10px;
      border:1px solid color-mix(in srgb,currentColor 15%,transparent); border-radius:9px;
      background:color-mix(in srgb,currentColor 3%,transparent); min-width:0; overflow-x:auto; }
    .metric { display:inline-flex; align-items:center; flex:0 0 auto; min-height:26px; gap:6px; white-space:nowrap; line-height:normal; }
    .value { display:inline-flex; align-items:center; line-height:normal; min-height:16px; }
    .icon { display:block; width:14px; height:14px; flex:0 0 14px; opacity:.85; }
    .metric:hover .icon { opacity:1; }
    .icon.quota-ring { opacity:1; width:26px; height:26px; flex-basis:26px; }
    .quota-wrap { position:relative; display:inline-grid; place-items:center; width:26px; height:26px; flex:0 0 26px; }
    .quota-label { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:10.4px; line-height:normal; pointer-events:none; }
    .quota-track { stroke:currentColor; opacity:.24; }
    .quota-fill { stroke:var(--codex-hud-quota-color, #9be8c2); }
    .quota-unknown { opacity:.5; }
    .reset-card { color:var(--codex-hud-card-color, #e9c77b); opacity:1; }
    .value, .quota-label { color:var(--color-token-text-primary, inherit); font-variant-numeric:tabular-nums; font-weight:500; }
    @media(max-width:600px) { .bar { gap:3px 10px; padding:4px 8px; } }
  `;
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "status");
  bar.setAttribute("aria-live", "off");
  bar.setAttribute("aria-label", "Codex 会话统计");
  shadow.append(style, bar);

  function composerThread(composer) {
    if (!composer) return null;
    const key = Object.getOwnPropertyNames(composer).find(key => key.startsWith('__reactFiber$'));
    let fiber = key && composer[key];
    if (!fiber) return null;
    // DOM nodes can retain the previous React fiber after a commit. Follow the
    // mounted root's child links, not an old fiber's props or its alternate.
    const ancestors = new Set();
    let root;
    for (let depth = 0; fiber && depth < 512; depth++, fiber = fiber.return) {
      ancestors.add(fiber);
      if (fiber.alternate) ancestors.add(fiber.alternate);
      root = fiber;
    }
    const current = root?.stateNode?.current;
    if (!current || !ancestors.has(current)) return null;
    const pending = [{ fiber: current, parent: null }];
    let budget = 4096;
    while (pending.length && budget-- > 0) {
      const item = pending.pop();
      if (item.fiber.stateNode === composer) {
        let emptyConversation = false;
        for (let cursor = item; cursor; cursor = cursor.parent) {
          const props = cursor.fiber.memoizedProps;
          if (props && Object.prototype.hasOwnProperty.call(props, 'conversationId') && props.conversationId === null) {
            if (typeof props.hostId === 'string' && props.hostId !== 'local') return {id:null,draft:false};
            emptyConversation = true;
          }
          if (typeof props?.conversationId !== 'string' || typeof props?.hostId !== 'string') continue;
          const id = new RegExp(`^${UUID}$`, 'i').exec(props.conversationId)?.[1]?.toLowerCase();
          return { id: props.hostId === 'local' ? id ?? null : null };
        }
        return emptyConversation ? {id:null,draft:true} : null;
      }
      for (let child = item.fiber.child; child && budget-- > 0; child = child.sibling) {
        if (ancestors.has(child)) pending.push({ fiber: child, parent: item });
      }
    }
    return null;
  }

  function getThreadId() {
    try {
      const url = new URL(window.location.href);
      const path = url.hash.startsWith("#/") ? url.hash.slice(1).split("?")[0] : url.pathname;
      const direct = ROUTE.exec(path)?.[1]?.toLowerCase();
      if (direct) return direct;
      if (url.protocol !== 'app:' || !['/index.html', '/detached-window.html'].includes(path)) return null;
      // New native chats keep client-new-thread sidebar keys after the first
      // response. The mounted composer already has the real rollout UUID.
      const thread = composerThread(findComposer());
      if (thread) return thread.id;
      // Native desktop uses an in-memory router. The active (not selected)
      // sidebar row carries an explicit thread key and host identity.
      const initial = url.searchParams.get('initialRoute');
      if (initial && !ROUTE.test(initial.split('?')[0])) return null;
      const rows = Array.from(document.querySelectorAll('[data-app-action-sidebar-thread-active="true"]'));
      if (!rows.length) return null;
      const ids = new Set();
      for (const row of rows) {
        if (row.getAttribute('data-app-action-sidebar-thread-host-id') !== 'local') return null;
        const key = row.getAttribute('data-app-action-sidebar-thread-id');
        const id = /^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(key ?? '')?.[1];
        if (!id) return null;
        ids.add(id.toLowerCase());
      }
      return ids.size === 1 ? Array.from(ids)[0] : null;
    } catch { return null; }
  }

  function isNewConversation(composer) {
    try {
      const url = new URL(window.location.href);
      if (url.protocol !== 'app:' || !['/index.html','/detached-window.html'].includes(url.pathname)) return false;
      const initial = url.searchParams.get('initialRoute')?.split('?')[0];
      if (['/avatar-overlay','/spotlight','/global-dictation'].includes(initial)) return false;
      return composerThread(composer)?.draft === true;
    } catch { return false; }
  }

  function visible(node) {
    if (!node || node === host || node.closest?.(`#${HOST_ID}`)) return false;
    if (node.closest('[hidden], [aria-hidden="true"]')) return false;
    const bounds = node.getBoundingClientRect();
    const computed = getComputedStyle(node);
    return bounds.width >= 180 && bounds.height > 0 && computed.display !== "none" &&
      computed.visibility !== "hidden" && bounds.bottom > 0 && bounds.top < innerHeight;
  }

  function findComposer() {
    for (const node of document.querySelectorAll('[data-composer-body]')) {
      if (visible(node)) return node;
    }
    for (const node of document.querySelectorAll(".composer-surface-chrome")) {
      if (visible(node)) return node;
    }
    for (const editor of document.querySelectorAll('.ProseMirror[contenteditable="true"], [role="textbox"][contenteditable="true"], textarea')) {
      if (!visible(editor)) continue;
      const composer = editor.closest('[data-testid*="composer"], [data-composer], form');
      if (visible(composer)) return composer;
    }
    return null;
  }

  function numeric(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }
  function tokens(value) {
    if (!numeric(value)) return "—";
    if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return String(Math.round(value));
  }
  function resetWindows() {
    const source = freshAccount() && Array.isArray(accountSnapshot.usageResets)
      ? accountSnapshot.usageResets : snapshot?.usageResets;
    return (Array.isArray(source) ? source : []).filter(window =>
      numeric(window.resetsAt) && window.resetsAt > 0 && window.resetsAt * 1000 <= 8640000000000000);
  }
  function freshAccount() {
    const age = Date.now() - accountSnapshot?.observedAt;
    return Number.isFinite(age) && age >= 0 && age <= (accountSnapshot?.cached ? 7 * 86400000 : ACCOUNT_EXPIRY_MS);
  }
  function deadline(window) {
    // Reset cards apply to Codex quota; unrelated named buckets must not inherit them.
    const eligible = window.limitId === "codex" ||
      (window.limitId == null && (window.limitName == null || window.limitName === "codex"));
    const cards = freshAccount() && eligible && Array.isArray(accountSnapshot.resetCards)
      ? accountSnapshot.resetCards : [];
    const expiresAt = cards.map(card => card.expiresAt).filter(value =>
      Number.isSafeInteger(value) && value * 1000 > Date.now() && value < window.resetsAt).sort((a, b) => a - b)[0];
    return { at: expiresAt ?? window.resetsAt, card: expiresAt !== undefined };
  }
  function resetCountdown(resetsAt) {
    const milliseconds = resetsAt * 1000 - Date.now();
    if (milliseconds <= 0) return "等待更新";
    // Round up so a positive remainder never suggests a reset already happened.
    const minutes = Math.ceil(milliseconds / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    return `${days}天 ${String(hours).padStart(2, "0")}时 ${String(minutes % 60).padStart(2, "0")}分`;
  }
  function windowLabel(window) {
    const minutes = window.windowMinutes;
    if (!numeric(minutes) || !minutes) return window.window === "secondary" ? "窗口 2" : "窗口 1";
    if (minutes % 1440 === 0) return `${minutes / 1440}天窗口`;
    if (minutes % 60 === 0) return `${minutes / 60}小时窗口`;
    return `${minutes}分钟窗口`;
  }
  function resetDisplay() {
    const windows = resetWindows();
    const multipleBuckets = new Set(windows.map(window => window.limitId)).size > 1;
    return windows.length ? windows.map(window => {
      const selected = deadline(window);
      return `${multipleBuckets ? `${window.limitName || window.limitId || "用量"} ` : ""}${windows.length > 1 ? `${windowLabel(window)} ` : ""}${resetCountdown(selected.at)}:${selected.card}`;
    }).join(" / ") : "—";
  }
  function resetMetric(stale = false) {
    const windows = stale ? [] : resetWindows();
    if (!windows.length) {
      metric("reset", "用量重置", "—", "当前会话尚未提供可靠的账户用量重置时间和剩余额度。虚线圆环表示未知。");
      return;
    }
    const multipleBuckets = new Set(windows.map(window => window.limitId)).size > 1;
    const clock = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    for (const window of windows) {
      const bucket = window.limitName || window.limitId;
      const current = window.resetsAt * 1000 > Date.now();
      const remaining = current && numeric(window.usedPercent)
        ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null;
      const quota = remaining !== null ? `剩余 ${Math.round(remaining * 10) / 10}%` : current ? "剩余额度未知" : "剩余额度等待更新";
      const used = numeric(window.usedPercent) ? `；上次记录已用 ${window.usedPercent}%` : "";
      const observedAt = Date.parse(window.observedAt);
      const observed = Number.isFinite(observedAt) ? `；记录时间 ${clock.format(observedAt)}（北京时间）` : "";
      const cached = accountSnapshot?.cached && Date.now() - accountSnapshot.observedAt > ACCOUNT_EXPIRY_MS
        ? `；账户缓存，采集于 ${clock.format(accountSnapshot.observedAt)}（北京时间），等待后台更新` : '';
      const detail = `${bucket ? `${bucket} · ` : ""}${windowLabel(window)}：${clock.format(window.resetsAt * 1000)}（北京时间）${used}${observed}${cached}`;
      const selected = deadline(window);
      const value = `${multipleBuckets ? `${bucket || "用量"} ` : ""}${windows.length > 1 ? `${windowLabel(window)} ` : ""}${resetCountdown(selected.at)}`;
      const cardDetail = selected.card ? `倒计时为最近可用重置卡到期时间：${clock.format(selected.at * 1000)}（北京时间）；早于本周期自然重置。卡片到期不会自动重置额度。\n` : "";
      metric("reset", selected.card ? "重置卡到期" : "用量重置", value,
        `${cardDetail}${quota}。用量从顶部顺时针消耗，亮色圆环表示剩余额度，暗色表示已用；虚线表示未知或等待更新。\n自然重置 ${detail}\n账户额度按最近记录显示；到点后等待新记录确认，不代表已完成重置。`, remaining, selected.card);
    }
  }
  const icons = {
    speed: ["M3 13a9 9 0 0 1 18 0", "M12 13l4-4M6 18h12"],
    cache: ["M20 6c0 2.2-3.6 4-8 4S4 8.2 4 6s3.6-4 8-4 8 1.8 8 4Z", "M4 6v12c0 2.2 3.6 4 8 4s8-1.8 8-4V6", "M4 12c0 2.2 3.6 4 8 4s8-1.8 8-4"],
    compact: ["M12 2v6m-3-3 3 3 3-3", "M12 22v-6m-3 3 3-3 3 3", "M5 12h14"],
    context: ["m12 3-9 5 9 5 9-5-9-5Z", "m3 12 9 5 9-5", "m3 16 9 5 9-5"],
    budget: ["M4 3v6l4-3-4-3Z", "M20 3v6l-4-3 4-3Z", "M4 15v6l4-3-4-3Z", "M20 15v6l-4-3 4-3Z", "M9 12h6"],
  };
  function metric(iconName, label, value, tooltip, remainingPercent = null, card = false) {
    const item = document.createElement("span");
    item.className = "metric";
    const hoverNames = { speed:'平均token输出速度', cache:'命中缓存', compact:'压缩次数', context:'上下文余量', budget:'剩余压缩余量' };
    item.title = iconName === 'reset'
      ? `套餐剩余：${remainingPercent === null ? '—' : Math.round(remainingPercent) + '%'}；${card ? '重置卡到期时间' : '重置剩余时间'}：${value}`
      : `${hoverNames[iconName] ?? label}：${value}`;
    item.setAttribute("role", "group");
    const quotaLabel = iconName === "reset" ? `；${remainingPercent !== null ? `剩余 ${Math.round(remainingPercent * 10) / 10}%` : "剩余额度未知"}` : "";
    item.setAttribute("aria-label", `${label}：${value}${quotaLabel}`);
    item.setAttribute("data-metric", iconName);
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({ class: "icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) {
      icon.setAttribute(name, value);
    }
    if (iconName === "reset") {
      icon.setAttribute("class", "icon quota-ring");
      icon.setAttribute("stroke-width", "1.8");
      icon.setAttribute("stroke-linecap", "butt");
      const circle = (attributes) => {
        const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        for (const [name, value] of Object.entries({ cx: "12", cy: "12", r: "9", pathLength: "100", ...attributes })) node.setAttribute(name, value);
        icon.appendChild(node);
      };
      circle(remainingPercent === null
        ? { class: "quota-track quota-unknown", "stroke-dasharray": "3 4" }
        : { class: "quota-track" });
      if (remainingPercent > 0) circle({
        class: "quota-fill", "stroke-dasharray": `${remainingPercent} ${100 - remainingPercent}`,
        "stroke-dashoffset": String(-(100 - remainingPercent)),
        transform: "rotate(-90 12 12)",
      });
    } else {
      for (const shape of icons[iconName]) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", shape);
        icon.appendChild(path);
      }
    }
    const number = document.createElement("span");
    number.className = "value";
    number.textContent = value;
    if (iconName === 'reset') {
      const wrap = document.createElement('span');
      wrap.className = 'quota-wrap';
      wrap.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.setAttribute('class', 'quota-label');
      label.textContent = remainingPercent === null ? '—' : String(Math.round(remainingPercent));
      wrap.append(icon, label);
      item.append(wrap, number);
    } else item.append(icon, number);
    if (card) {
      const badge = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (const [name, value] of Object.entries({ class: "icon reset-card", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) badge.setAttribute(name, value);
      for (const shape of ["M20 9V5a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M2 7h18", "M22 16a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z", "M16 13v3l2 1"]) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", shape);
        badge.appendChild(path);
      }
      item.appendChild(badge);
    }
    bar.appendChild(item);
  }
  function render(stale, cached = false) {
    const view = JSON.stringify([snapshot, stale, cached, freshAccount() ? accountSnapshot : null, resetDisplay()]);
    if (view === lastView) return;
    lastView = view;
    bar.replaceChildren();
    bar.title = "";
    const values = stale || snapshot.status !== "ok" ? {} : snapshot;
    metric("speed", "平均输出", numeric(values.averageOutputTps) ? `${values.averageOutputTps.toFixed(1)} tok/s` : "—",
      "输出 token ÷ 回合耗时，包含等待与工具执行；不代表模型实时生成速度。");
    const ratio = values.lastCacheRatio;
    metric("cache", "缓存", numeric(ratio) && ratio <= 1 ? `${(ratio * 100).toFixed(1)}%` : "—",
      "最近一次用量记录的缓存输入 token ÷ 输入 token；不是请求成功率或整段会话平均值。");
    const compactCount = numeric(values.compactionCount) ? `${Math.round(values.compactionCount)}次` : "—";
    const partialHistory = values.historyComplete === false;
    metric("compact", "压缩次数", compactCount,
      `包含手动和自动压缩，按完成事件去重。${partialHistory ? "当前可读历史可能不完整，此处仅为已记录次数。" : ""}`);
    metric("context", "上下文余量", numeric(values.contextRemainingTokens) ? `${tokens(values.contextRemainingTokens)} tok` : "—",
      `最近记录的上下文占用 ${tokens(values.contextUsedTokens)} / ${tokens(values.contextWindowTokens)} tok；上下文上限不等于压缩阈值。`);
    const reference = values.compactReference;
    if (reference?.kind === 'model-default-reference' && numeric(reference.remaining) && numeric(reference.remainingPercent)) {
      metric('budget', '默认压缩参考余量', `≈${reference.remainingPercent.toFixed(0)}%`,
        `参考剩余 ${tokens(reference.remaining)} tok（${Math.round(reference.remaining).toLocaleString()} tokens）。估算：按模型目录的默认压缩参考线 ${tokens(reference.limit)} tok 减去最近上下文占用；百分比为参考线剩余比例。不是当前会话最终生效阈值。自定义阈值、body_after_prefix 计量、回合结束策略或额外工具输出都可能提前或推迟压缩。到 0 也不表示必定立即压缩。`);
    } else if (snapshot.draft) {
      metric('budget', '剩余压缩余量', '—', '尚未开始对话');
    }
    resetMetric(stale);
  }

  function refresh() {
    if (removed) return;
    const threadId = getThreadId();
    const composer = findComposer();
    const draft = !threadId && isNewConversation(composer);
    if (threadId !== lastRoute) {
      const cached = snapshots.get(threadId);
      snapshot = cached?.snapshot ?? (threadId ? { threadId, status: 'unavailable' } : null);
      receivedAt = cached?.receivedAt ?? Date.now();
      lastRoute = threadId;
    }
    if (draft) {
      // No rollout exists yet. Keep account data, clear all per-chat values.
      snapshot = {threadId:null,status:'unavailable',draft:true};
      receivedAt = Date.now();
    }
    if (!threadId && !draft) {
      host.remove();
      mounted = false;
      return;
    }
    if (!composer?.parentElement) {
      // Occluded/background windows may temporarily have no measurable layout.
      // Keep their own node and data; never borrow another window's snapshot.
      if (document.hidden && host.isConnected) return;
      host.remove();
      mounted = false;
      return;
    }
    if (position === "inside") {
      if (host.parentElement !== composer) composer.appendChild(host);
    } else if (position === "below") {
      if (host.previousElementSibling !== composer) composer.after(host);
    } else if (host.nextElementSibling !== composer) {
      composer.before(host);
    }
    mounted = true;
    const old = Date.now() - receivedAt > EXPIRY_MS;
    render(old && Date.now() - collectorAt > EXPIRY_MS, old && Date.now() - collectorAt <= EXPIRY_MS);
  }

  const timer = setInterval(refresh, 500);
  // React replaces composer containers on navigation. Reattach the same node
  // immediately instead of waiting for the next telemetry poll.
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(refresh) : null;
  observer?.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-app-action-sidebar-thread-active', 'data-app-action-sidebar-thread-id', 'data-app-action-sidebar-thread-host-id'] });
  window.addEventListener("popstate", refresh);
  window.addEventListener("hashchange", refresh);
  window.addEventListener("focus", refresh);
  const api = {
    version: "0.1.0",
    getThreadId,
    primeSnapshots(entries) {
      if (removed || !Array.isArray(entries)) return false;
      collectorAt = Date.now();
      for (const entry of entries.slice(-64)) {
        const id = entry?.snapshot?.threadId?.toLowerCase?.();
        if (!id || !new RegExp(`^${UUID}$`, 'i').test(id) || !numeric(entry.receivedAt) || entry.receivedAt > Date.now()) continue;
        if ((snapshots.get(id)?.receivedAt ?? -1) > entry.receivedAt) continue;
        snapshots.delete(id);
        snapshots.set(id, { snapshot: { ...entry.snapshot }, receivedAt: entry.receivedAt });
        if (id === getThreadId()) { snapshot = { ...entry.snapshot }; receivedAt = entry.receivedAt; }
      }
      while (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value);
      refresh();
      return true;
    },
    updateAccount(value) {
      if (removed) return false;
      accountSnapshot = value && numeric(value.observedAt) ? value : null;
      refresh();
      return true;
    },
    update(value) {
      if (removed) return false;
      if (!value || typeof value !== "object" || typeof value.threadId !== "string") return false;
      if (value.threadId.toLowerCase() !== getThreadId()) {
        refresh();
        return false;
      }
      snapshot = { ...value };
      receivedAt = Date.now();
      collectorAt = receivedAt;
      const id = value.threadId.toLowerCase();
      snapshots.delete(id);
      snapshots.set(id, { snapshot, receivedAt });
      if (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value);
      refresh();
      return mounted;
    },
    setPosition(value) {
      if (!["above", "inside", "below"].includes(value)) return false;
      position = value;
      refresh();
      return true;
    },
    getStatus() {
      return { mounted, threadId: getThreadId(), position, stale: Boolean(snapshot && Date.now() - receivedAt > EXPIRY_MS), removed, instanceId, newConversation: Boolean(snapshot?.draft) };
    },
    remove() {
      removed = true;
      window.__CODEX_METRICS_ACCOUNT__?.remove?.();
      clearInterval(timer);
      observer?.disconnect();
      snapshots.clear();
      window.removeEventListener("popstate", refresh);
      window.removeEventListener("hashchange", refresh);
      window.removeEventListener("focus", refresh);
      host.remove();
      snapshot = null;
      accountSnapshot = null;
      mounted = false;
      if (window[KEY] === api) delete window[KEY];
      return true;
    },
  };
  window[KEY] = api;
  refresh();
  return api.getStatus();
})();
