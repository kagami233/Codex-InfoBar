import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/renderer.js", import.meta.url), "utf8");
const THREAD = "01234567-89ab-cdef-0123-456789abcdef";
const OTHER = "11234567-89ab-cdef-0123-456789abcdef";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.parentElement = null; this.attributes = {}; this.textContent = ""; this.style = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  attachShadow() { this.shadowRoot = new Element("shadow"); return this.shadowRoot; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { node.remove(); this.children.push(node); node.parentElement = this; return node; }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
  remove() { if (this.parentElement) { const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this), 1); this.parentElement = null; } }
  before(node) { this.insert(node, 0); }
  after(node) { this.insert(node, 1); }
  insert(node, offset) { const parent = this.parentElement; node.remove(); parent.children.splice(parent.children.indexOf(this) + offset, 0, node); node.parentElement = parent; }
  get nextElementSibling() { const nodes = this.parentElement?.children ?? []; return nodes[nodes.indexOf(this) + 1] ?? null; }
  get previousElementSibling() { const nodes = this.parentElement?.children ?? []; return nodes[nodes.indexOf(this) - 1] ?? null; }
  get lastElementChild() { return this.children.at(-1); }
  get isConnected() { return this.parentElement !== null; }
  closest() { return null; }
  getBoundingClientRect() { return { width: 700, height: 100, top: 500, bottom: 600 }; }
  content() { return this.textContent + this.children.map((child) => child.content()).join(""); }
}

function environment(path = `/local/${THREAD}`) {
  let now = 1000;
  const timers = new Map();
  const listeners = new Map();
  const parent = new Element("main");
  const composer = new Element("composer");
  parent.appendChild(composer);
  const nodes = [];
  let composerVisible = true;
  let activeRows = [];
  let modernComposer = false;
  const window = {
    location: { href: `app://-/` + path.replace(/^\//, "") },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const document = {
    createElement(tag) { const node = new Element(tag); nodes.push(node); return node; },
    createElementNS(namespace, tag) { return this.createElement(tag); },
    querySelectorAll(selector) { return selector === '[data-app-action-sidebar-thread-active="true"]' ? activeRows : composerVisible && selector === (modernComposer ? '[data-composer-body]' : '.composer-surface-chrome') ? [composer] : []; },
  };
  const context = vm.createContext({
    window, document, URL, innerHeight: 900,
    getComputedStyle() { return { display: "block", visibility: "visible" }; },
    Date: { now: () => now, parse: Date.parse },
    setInterval(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  const execute = () => vm.runInContext(source, context);
  execute();
  return {
    window, parent, composer, timers, listeners, execute,
    get api() { return window.__CODEX_METRICS_HUD__; },
    get host() { return nodes.filter((node) => node.id === "codex-metrics-hud").at(-1); },
    navigate(next) { window.location.href = `app://-${next}`; for (const callback of timers.values()) callback(); },
    tick(ms) { now += ms; for (const callback of timers.values()) callback(); },
    hideComposer() { composerVisible = false; for (const callback of timers.values()) callback(); },
    setActive(rows) { activeRows = rows.map(([id, host]) => { const row = new Element('row'); row.setAttribute('data-app-action-sidebar-thread-id', id); row.setAttribute('data-app-action-sidebar-thread-host-id', host); return row; }); this.tick(1); },
    useModernComposer() { modernComposer = true; this.tick(1); },
    setNativeThread(id, host = 'local', staleId = THREAD) {
      const current = { stateNode: composer }, stale = { stateNode: composer };
      current.alternate = stale; stale.alternate = current;
      let a = current, b = stale;
      // Native composer providers sit deep below the application root.
      for (let depth = 0; depth < 200; depth++) {
        const p = { child: a }, q = { child: b };
        p.alternate = q; q.alternate = p; a.return = p; b.return = q;
        if (depth === 10) { p.memoizedProps = { conversationId: id, hostId: host }; q.memoizedProps = { conversationId: staleId, hostId: 'local' }; }
        a = p; b = q;
      }
      a.stateNode = b.stateNode = { current: a };
      composer.__reactFiber$test = stale;
      this.tick(1);
    },
    background() { document.hidden = true; composerVisible = false; this.tick(1); },
    foreground() { document.hidden = false; composerVisible = true; this.tick(1); },
  };
}

function snapshot(overrides = {}) {
  return { threadId: THREAD, status: "ok", source: "local-rollout", active: true,
    averageOutputTps: 12.25, lastCacheRatio: 0.75, compactionCount: 2,
    automaticCompactionCount: null, contextRemainingTokens: 10000, compactLimitTokens: null,
    ...overrides };
}

test("only explicit local chat routes yield a thread ID", () => {
  const env = environment();
  assert.equal(env.api.getThreadId(), THREAD);
  for (const path of ["/", `/remote/${THREAD}`, `/settings/${THREAD}`, `/local/${THREAD}/extra`]) {
    env.navigate(path);
    assert.equal(env.api.getThreadId(), null);
  }
  env.navigate(`/hotkey-window/thread/${THREAD}`);
  assert.equal(env.api.getThreadId(), THREAD);
});
test('native memory routing requires a unique explicitly active local chat and clears on switching', () => {
  const env = environment('/index.html');
  assert.equal(env.api.getThreadId(), null);
  env.setActive([[`local:${THREAD}`, 'local']]);
  assert.equal(env.api.getThreadId(), THREAD);
  env.useModernComposer();
  env.api.update(snapshot());
  assert.equal(env.api.getStatus().mounted, true);
  env.setActive([[`local:${OTHER}`, 'local']]);
  assert.equal(env.api.getStatus().mounted, true);
  assert.doesNotMatch(env.host.shadowRoot.content(), /12\.3 tok\/s/);
  for (const rows of [[], [[`local:${THREAD}`, 'remote']], [[`cloud:${THREAD}`, 'local']], [[`local:${THREAD}`, 'local'], [`local:${OTHER}`, 'local']]]) {
    env.setActive(rows);
    assert.equal(env.api.getThreadId(), null);
  }
  env.setActive([[`local:${THREAD}`, 'local']]);
  env.navigate('/index.html?initialRoute=%2Fspotlight');
  assert.equal(env.api.getThreadId(), null);
});

test('new native chats use the real composer UUID despite temporary sidebar keys', () => {
  const env = environment('/index.html');
  env.setActive([[`local:client-new-thread:${THREAD}`, 'local']]);
  assert.equal(env.api.getStatus().mounted, false, 'reproduces the previous sidebar-only failure');
  env.setNativeThread(OTHER);
  assert.equal(env.api.getThreadId(), OTHER);
  assert.equal(env.api.getStatus().mounted, true);
  assert.equal(env.api.update(snapshot()), false, 'the temporary or previous UUID must not supply metrics');
  env.api.update(snapshot({ threadId: OTHER, averageOutputTps: 73 }));
  assert.match(env.host.shadowRoot.content(), /73\.0 tok\/s/);
  env.setNativeThread(THREAD, 'local', OTHER);
  assert.equal(env.api.getThreadId(), THREAD, 'read the committed tree, never stale alternate props');
  assert.doesNotMatch(env.host.shadowRoot.content(), /73\.0 tok\/s/);
});

test('composer identity works without a sidebar in native windows and fails closed for remote or invalid IDs', () => {
  const env = environment('/detached-window.html?initialRoute=%2Fdetached-window');
  env.setNativeThread(OTHER);
  assert.equal(env.api.getThreadId(), OTHER);
  assert.equal(env.api.getStatus().mounted, true);
  for (const [id, host] of [[OTHER, 'remote'], [`client-new-thread:${OTHER}`, 'local'], ['../auth.json', 'local']]) {
    env.setNativeThread(id, host);
    assert.equal(env.api.getThreadId(), null);
    assert.equal(env.api.getStatus().mounted, false);
  }
});

test("matching snapshots mount inside composer by default; position changes and cleanup are reversible", () => {
  const env = environment();
  assert.equal(env.api.update(snapshot()), true);
  assert.equal(env.host.parentElement, env.composer);
  assert.equal(env.api.getStatus().position, "inside");
  assert.equal(env.api.setPosition("above"), true);
  assert.equal(env.host.nextElementSibling, env.composer);
  assert.equal(env.api.setPosition("below"), true);
  assert.equal(env.host.previousElementSibling, env.composer);
  assert.equal(env.api.setPosition("inside"), true);
  assert.equal(env.host.parentElement, env.composer);
  assert.equal(env.api.setPosition("elsewhere"), false);
  assert.equal(env.api.remove(), true);
  assert.equal(env.host.parentElement, null);
  assert.equal(env.timers.size, 0);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.window.__CODEX_METRICS_HUD__, undefined);
});
test('each window keeps its own instance and cached chat metrics across navigation and backgrounding', () => {
  const a = environment(), b = environment(`/local/${OTHER}`);
  a.api.update(snapshot());
  b.api.update(snapshot({threadId:OTHER, averageOutputTps:99}));
  const original = a.host, instance = a.api.getStatus().instanceId;
  a.navigate(`/local/${OTHER}`);
  assert.equal(a.host, original);
  assert.doesNotMatch(a.host.shadowRoot.content(), /12\.3 tok\/s|99\.0 tok\/s/);
  a.api.update(snapshot({threadId:OTHER, averageOutputTps:21}));
  a.navigate(`/local/${THREAD}`);
  assert.match(a.host.shadowRoot.content(), /12\.3 tok\/s/);
  assert.match(b.host.shadowRoot.content(), /99\.0 tok\/s/);
  a.background();
  assert.equal(a.host.parentElement, a.composer);
  a.foreground();
  assert.equal(a.api.getStatus().instanceId, instance);
  assert.equal(a.host, original);
  a.tick(30001);
  a.navigate(`/local/${OTHER}`);
  assert.doesNotMatch(a.host.shadowRoot.content(), /21\.0 tok\/s/);
});
test('shared prewarmed snapshots render immediately on switch without another update', () => {
  const env = environment();
  const node = env.host;
  env.api.primeSnapshots([
    {snapshot:snapshot(),receivedAt:1000},
    {snapshot:snapshot({threadId:OTHER,averageOutputTps:73}),receivedAt:1000},
  ]);
  env.navigate(`/local/${OTHER}`);
  assert.equal(env.host, node);
  assert.match(env.host.shadowRoot.content(), /73\.0 tok\/s/);
  env.tick(31000);
  env.api.primeSnapshots([{snapshot:snapshot({threadId:OTHER,averageOutputTps:73}),receivedAt:1000}]);
  assert.match(env.host.shadowRoot.content(), /73\.0 tok\/s/);
  assert.equal(env.host.shadowRoot.children[1].title, "");
  assert.equal(env.api.getStatus().stale,true, 'cache retains original timestamp');
  env.tick(31000);
  assert.doesNotMatch(env.host.shadowRoot.content(), /73\.0 tok\/s/);
});

test("routes, unavailable composers and stale snapshots never display old numbers", () => {
  const env = environment();
  env.api.update(snapshot());
  env.navigate(`/local/${OTHER}`);
  assert.equal(env.api.getStatus().mounted, true);
  assert.doesNotMatch(env.host.shadowRoot.content(), /12\.3 tok\/s/);
  assert.equal(env.api.update(snapshot()), false);
  env.navigate(`/local/${THREAD}`);
  assert.equal(env.api.getStatus().mounted, true);
  assert.match(env.host.shadowRoot.content(), /12\.3 tok\/s/);
  env.api.update(snapshot());
  env.tick(30001);
  assert.doesNotMatch(env.host.shadowRoot.content(), /数据已过期/);
  const bar = env.host.shadowRoot.children[1];
  assert.equal(bar.title, "");
  assert.equal(bar.children.length, 6);
  assert.ok(bar.children.every(node => node.children[1].content() === "—" && node.title.endsWith("：—")));
  assert.doesNotMatch(env.host.shadowRoot.content(), /12\.3 tok\/s/);
  env.api.update(snapshot());
  env.hideComposer();
  assert.equal(env.api.getStatus().mounted, false);
});

test("unknown metrics stay unknown and strings are inserted only as text", () => {
  const env = environment();
  env.api.update(snapshot({ warning: "<img src=x onerror=alert(1)>" }));
  const text = env.host.shadowRoot.content();
  assert.match(text, /2次/);
  assert.doesNotMatch(text, /自动压缩暂无法识别/);
  assert.doesNotMatch(text, /压缩阈值|压缩余量|本地统计|本轮统计/);
  assert.doesNotMatch(text, /<img src=x onerror=alert\(1\)>/);
  assert.match(text, /75\.0%/);
  const metrics = env.host.shadowRoot.children[1].children.filter(node => node.className === "metric");
  assert.equal(metrics.length, 6);
  assert.ok(metrics.every(node => (node.children[0].tag === "svg" || node.children[0].children[0]?.tag === "svg") && node.attributes["aria-label"] && node.title));
  assert.ok(metrics.every(node => !node.title.includes("<img")));
  assert.equal(env.host.shadowRoot.children[1].children.length, 6);
  assert.doesNotMatch(text, /平均输出|缓存|上下文余量/);
  assert.equal(env.host.shadowRoot.children.some((node) => node.tag === "img"), false);
  env.api.update(snapshot({ status: "unavailable", warning: "等待记录" }));
  assert.doesNotMatch(env.host.shadowRoot.content(), /统计暂不可用|等待记录/);
  assert.equal(env.host.shadowRoot.children[1].title, "");
  assert.equal(env.host.shadowRoot.children[1].children.length, 6);
  assert.doesNotMatch(env.host.shadowRoot.content(), /75\.0%/);
});

test("quota reset uses days hours minutes and counts down without a new snapshot", () => {
  const env = environment();
  const resetsAt = (1000 + (2 * 1440 + 3 * 60 + 4) * 60000) / 1000;
  const data = snapshot({ usageResets: [{ limitId: "codex", window: "primary", windowMinutes: 10080, resetsAt }] });
  env.api.update(data);
  const reset = () => env.host.shadowRoot.children[1].children.find(node => node.attributes["data-metric"] === "reset");
  assert.equal(reset().children[1].content(), "2天 03时 04分");
  // Keep collector alive, then cross a countdown boundary without another push.
  env.tick(20000); env.api.update(data);
  env.tick(20000); env.api.update(data);
  env.tick(20000);
  assert.equal(reset().children[1].content(), "2天 03时 03分");
  assert.match(reset().title, /重置剩余时间/);
  assert.doesNotMatch(reset().title, /北京时间/);
});

test("quota reset distinguishes expired, missing and multiple windows", () => {
  const env = environment();
  const resets = [
    { window: "primary", windowMinutes: 300, resetsAt: 2 },
    { window: "secondary", windowMinutes: 10080, resetsAt: 86401 },
  ];
  const reset = () => env.host.shadowRoot.children[1].children.find(node => node.attributes["data-metric"] === "reset");
  env.api.update(snapshot({ usageResets: resets }));
  const resetsShown = env.host.shadowRoot.children[1].children.filter(node => node.attributes["data-metric"] === "reset");
  assert.equal(resetsShown.length, 2);
  assert.equal(resetsShown[0].children[1].content(), "5小时窗口 0天 00时 01分");
  assert.equal(resetsShown[1].children[1].content(), "7天窗口 1天 00时 00分");
  env.tick(1000);
  assert.match(reset().children[1].content(), /^5小时窗口 等待更新/);
  env.api.update(snapshot({ usageResets: [{ resetsAt: null }, { resetsAt: -1 }, { resetsAt: Infinity }] }));
  assert.equal(reset().children[1].content(), "—");
  env.api.update(snapshot({ status: "unavailable", usageResets: resets }));
  assert.match(reset().children[1].content(), /等待更新/);
});

test("quota ring highlights remaining usage and keeps unknown or expired data neutral", () => {
  const env = environment();
  const reset = () => env.host.shadowRoot.children[1].children.find(node => node.attributes["data-metric"] === "reset");
  const update = (usedPercent, resetsAt = 1000) => env.api.update(snapshot({ usageResets: [{
    limitId: "codex", window: "primary", windowMinutes: 10080, usedPercent, resetsAt,
  }] }));
  const fill = () => reset().children[0].children[0].children.find(node => node.attributes.class === "quota-fill");
  update(25);
  assert.equal(fill().attributes["stroke-dasharray"], "75 25");
  assert.equal(fill().attributes["stroke-dashoffset"], "-25");
  assert.equal(fill().attributes.transform, "rotate(-90 12 12)");
  assert.match(reset().attributes["aria-label"], /剩余 75%/);
  // At half used, the consumed clockwise arc is on the right and the remaining arc is on the left.
  update(50);
  assert.equal(fill().attributes["stroke-dasharray"], "50 50");
  assert.equal(fill().attributes["stroke-dashoffset"], "-50");
  update(0);
  assert.equal(fill().attributes["stroke-dasharray"], "100 0");
  assert.equal(fill().attributes["stroke-dashoffset"], "0");
  for (const used of [100, 110]) {
    update(used);
    assert.equal(fill(), undefined);
    assert.match(reset().title, /套餐剩余：0%；/);
    assert.equal(reset().children[0].children[0].children[0].attributes["stroke-dasharray"], undefined);
  }
  for (const used of [null, NaN, Infinity]) {
    update(used);
    assert.equal(fill(), undefined);
    assert.equal(reset().children[0].children[0].children[0].attributes["stroke-dasharray"], "3 4");
  }
  update(25, 1);
  assert.equal(reset().children[1].content(), "等待更新");
  assert.equal(fill(), undefined);
  assert.match(reset().title, /套餐剩余：—；重置剩余时间：等待更新/);
});

test("reinjection removes old lifecycle resources", () => {
  const env = environment();
  const previous = env.api;
  env.api.update(snapshot());
  env.execute();
  assert.notEqual(env.api, previous);
  assert.equal(previous.getStatus().removed, true);
  assert.equal(env.timers.size, 1);
  assert.equal(env.listeners.size, 3);
});

test("earlier available reset card replaces only the countdown and adds a trailing time-card icon", () => {
  const env = environment();
  const data = snapshot({ usageResets: [{ limitId: "codex", resetsAt: 86401, usedPercent: 60 }] });
  env.api.update(data);
  const reset = () => env.host.shadowRoot.children[1].children.find(node => node.attributes["data-metric"] === "reset");
  env.api.updateAccount({ observedAt: 1000, resetCards: [{ expiresAt: 600 }, { expiresAt: 301 }] });
  assert.equal(reset().children[1].content(), "0天 00时 05分");
  assert.equal(reset().children.length, 3);
  assert.equal(reset().children[2].attributes.class, "icon reset-card");
  assert.match(reset().attributes["aria-label"], /^重置卡到期：.*剩余 40%/);
  assert.match(reset().title, /重置卡到期时间：0天 00时 05分/);
  const fill = reset().children[0].children[0].children.find(node => node.attributes.class === "quota-fill");
  assert.equal(fill.attributes["stroke-dasharray"], "40 60");
  assert.equal(fill.attributes["stroke-dashoffset"], "-60");
  assert.equal(env.host.shadowRoot.children[1].children.length, 6);
  for (const cards of [[], null, [{ expiresAt: 86401 }], [{ expiresAt: 86402 }], [{ expiresAt: 1 }]]) {
    env.api.updateAccount({ observedAt: 1000, resetCards: cards });
    assert.equal(reset().children[1].content(), "1天 00时 00分");
    assert.equal(reset().children.length, 2);
  }
});

test("card expiration, account freshness and fresh quota changes update the selected deadline", () => {
  const env = environment();
  const data = snapshot({ usageResets: [{ limitId: "codex", resetsAt: 86401, usedPercent: 60 }] });
  env.api.update(data);
  const reset = () => env.host.shadowRoot.children[1].children.find(node => node.attributes["data-metric"] === "reset");
  env.api.updateAccount({ observedAt: 1000, resetCards: [{ expiresAt: 2 }, { expiresAt: 61 }] });
  assert.equal(reset().children.length, 3);
  env.tick(1000);
  assert.equal(reset().children[1].content(), "0天 00时 01分");
  env.tick(59000); env.api.update(data);
  assert.equal(reset().children.length, 2);
  env.api.updateAccount({ observedAt: 61000, resetCards: [{ expiresAt: 601 }], usageResets: [{ limitId: "codex", resetsAt: 121, usedPercent: 0 }] });
  assert.equal(reset().children[1].content(), "0天 00时 01分");
  assert.equal(reset().children.length, 2, "natural reset is earlier than card expiry after a quota change");
  env.tick(90001); env.api.update(data);
  assert.equal(reset().children.length, 2);
  assert.match(reset().attributes["aria-label"], /剩余 40%/);
  env.api.updateAccount(null);
  assert.equal(reset().children.length, 2);
  env.api.updateAccount({ observedAt: 151001, resetCards: [{ expiresAt: 601 }] });
  env.api.update(snapshot({ usageResets: [{ limitId: "other", resetsAt: 86401, usedPercent: 20 }] }));
  assert.equal(reset().children.length, 2, "Codex cards must not replace unrelated bucket countdowns");
  env.api.update(snapshot({ usageResets: [{ limitId: null, limitName: "Other", resetsAt: 86401, usedPercent: 20 }] }));
  assert.equal(reset().children.length, 2, "a named non-Codex legacy bucket is not eligible");
});

test("compaction count includes manual and automatic records and labels incomplete history", () => {
  const env = environment();
  env.api.update(snapshot({ compactionCount: 7, automaticCompactionCount: 2, historyComplete: false }));
  const text = env.host.shadowRoot.content();
  assert.match(text, /7次/);
  assert.doesNotMatch(text, /已记录/);
  assert.doesNotMatch(text, /自动压缩2 次/);
  const bar = env.host.shadowRoot.children[1];
  const count = bar.children.find((node) => node.attributes["data-metric"] === "compact");
  assert.equal(count.attributes["aria-label"], "压缩次数：7次");
  assert.equal(count.title, "压缩次数：7次");
  assert.doesNotMatch(count.title, /历史/);
  env.api.update(snapshot({ compactionCount: null, historyComplete: false }));
  assert.equal(env.host.shadowRoot.children[1].children.find(node => node.attributes["data-metric"] === "compact").content(), "—");
  assert.doesNotMatch(env.host.shadowRoot.content(), /已记录 —/);
});

test('persisted account countdown advances with wall clock, expires correctly, and fresh data replaces it', () => {
  const env=environment();env.api.update(snapshot());
  const reset=()=>env.host.shadowRoot.children[1].children.find(n=>n.attributes['data-metric']==='reset');
  env.api.updateAccount({observedAt:1000,cached:true,usageResets:[{limitId:'codex',usedPercent:70,resetsAt:601}],resetCards:[{expiresAt:301}]});
  assert.equal(reset().children[1].content(),'0天 00时 05分');
  env.tick(120000);env.api.update(snapshot());
  assert.equal(reset().children[1].content(),'0天 00时 03分');
  assert.match(reset().title,/套餐剩余：30%；/);
  env.tick(180000);env.api.update(snapshot());
  assert.equal(reset().children.length,2,'expired card removed');
  assert.equal(reset().children[1].content(),'0天 00时 05分');
  env.tick(300000);env.api.update(snapshot());
  assert.equal(reset().children[1].content(),'等待更新');
  env.api.updateAccount({observedAt:601000,usageResets:[{limitId:'codex',usedPercent:10,resetsAt:1201}],resetCards:[]});
  assert.equal(reset().children[1].content(),'0天 00时 10分');
  assert.match(reset().attributes['aria-label'],/剩余 90%/);
  assert.doesNotMatch(reset().title,/账户缓存/);
});

test('ring prints remaining percentage and ignores historical model-default compaction estimates',()=>{
  const env=environment();
  env.api.update(snapshot({usageResets:[{limitId:'codex',resetsAt:86401,usedPercent:76}],compactReference:{kind:'model-default-reference',limit:244800,remaining:44800,remainingPercent:18.3}}));
  const metrics=env.host.shadowRoot.children[1].children;
  const wrap=metrics.find(n=>n.attributes['data-metric']==='reset').children[0];
  const ring=wrap.children[0];
  assert.equal(wrap.children.find(n=>n.attributes.class==='quota-label').textContent,'24');
  assert.equal(ring.children.find(n=>n.attributes.class==='quota-fill').attributes['stroke-dashoffset'],'-76');
  const budget=metrics.find(n=>n.attributes['data-metric']==='budget');
  assert.equal(budget.children[1].textContent,'—');
  assert.equal(budget.title,'剩余压缩余量：—');
  assert.doesNotMatch(budget.title,/tok/);
});

test('hover text contains only the requested name and current display value',()=>{
 const env=environment();env.api.update(snapshot({compactionCount:7,usageResets:[{limitId:'codex',resetsAt:301,usedPercent:78}],compactReference:{kind:'model-default-reference',limit:100,remaining:13,remainingPercent:13}}));
 const expected={speed:'平均token输出速度：12.3 tok/s',cache:'命中缓存：75.0%',compact:'压缩次数：7次',context:'上下文余量：10.0k tok',budget:'剩余压缩余量：—',reset:'套餐剩余：22%；重置剩余时间：0天 00时 05分'};
 for(const item of env.host.shadowRoot.children[1].children)assert.equal(item.title,expected[item.attributes['data-metric']]);
});


test('empty native composer shows account quota before a real chat ID exists',()=>{
 const env=environment('/index.html');
 env.setNativeThread(null,null);
 assert.equal(env.api.getThreadId(),null);
 assert.equal(env.api.getStatus().mounted,true);
 assert.equal(env.api.getStatus().newConversation,true);
 assert.equal(env.host.shadowRoot.children[1].children.length,6);
 env.api.updateAccount({observedAt:1000,usageResets:[{limitId:'codex',resetsAt:301,usedPercent:78}],resetCards:[]});
 const items=env.host.shadowRoot.children[1].children;
 assert.ok(items.filter(n=>n.attributes['data-metric']!=='reset').every(n=>n.children[1].textContent==='—'));
 assert.equal(items.find(n=>n.attributes['data-metric']==='reset').title,'套餐剩余：22%；重置剩余时间：0天 00时 05分');
 env.setNativeThread(OTHER);
 assert.equal(env.api.getThreadId(),OTHER);
 assert.equal(env.api.update(snapshot({threadId:OTHER,averageOutputTps:73})),true);
 assert.match(env.host.shadowRoot.content(),/73\.0 tok\/s/);
 env.setNativeThread(null,null,OTHER);
 assert.equal(env.api.getStatus().newConversation,true);
 assert.doesNotMatch(env.host.shadowRoot.content(),/73\.0 tok\/s/);
 assert.equal(env.api.update(snapshot({threadId:OTHER})),false);
});

test('blank remote and auxiliary composers do not qualify as new local chats',()=>{
 const env=environment('/index.html');
 env.setNativeThread(null,'remote');
 assert.equal(env.api.getStatus().mounted,false);
 env.navigate('/index.html?initialRoute=%2Fspotlight');
 env.setNativeThread(null,null);
 assert.equal(env.api.getStatus().mounted,false);
});
