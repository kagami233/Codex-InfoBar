import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { createHash } from 'node:crypto';

const source = fs.readFileSync(new URL("../src/account-source.js", import.meta.url), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const START = 1793300000000;
const EXPIRY = 1793300992;

function environment({ supported = true, send = () => undefined, storage = null, locks = null } = {}) {
  let now = START;
  let serial = 0;
  const timers = new Map();
  const listeners = new Set();
  const requests = [];
  const updates = [];
  const window = {
    localStorage: storage,
    navigator: {locks},
    __CODEX_METRICS_HUD__: { updateAccount: value => updates.push(clone(value)) },
    addEventListener: (name, listener) => { assert.equal(name, "message"); listeners.add(listener); },
    removeEventListener: (name, listener) => { assert.equal(name, "message"); listeners.delete(listener); },
  };
  if (supported) window.electronBridge = {
    sendMessageFromView: value => { requests.push(clone(value)); return send(value); },
  };
  const schedule = (callback, delay, repeat = false) => {
    const id = ++serial;
    timers.set(id, { callback, at: now + delay, delay, repeat });
    return id;
  };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    window, Date: Clock, TextEncoder, crypto: { randomUUID: () => `test-${++serial}`, ...(storage ? {subtle:{digest:async (_,bytes)=>createHash('sha256').update(bytes).digest()}} : {}) },
    setTimeout: (callback, delay) => schedule(callback, delay),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
  });
  const execute = () => vm.runInContext(source, context);
  execute();
  return {
    window, requests, updates, listeners, timers, execute,
    get api() { return window.__CODEX_METRICS_ACCOUNT__; },
    get last() { return updates.at(-1); },
    respond(result, { id = requests.at(-1)?.request.id, hostId = "local", error, type = "mcp-response" } = {}) {
      for (const listener of [...listeners]) listener({ data: { type, hostId, message: { id, result, error } } });
    },
    notify(method, hostId = "local") {
      for (const listener of [...listeners]) listener({ data: { type: "mcp-notification", hostId, method, params: {} } });
    },
    tick(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.repeat) timer.at += timer.delay;
        else timers.delete(id);
        timer.callback();
      }
      now = target;
    },
  };
}

const card = (overrides = {}) => ({ status: "available", resetType: "codexRateLimits", expiresAt: EXPIRY, ...overrides });
const quota = { primary: { usedPercent: 62, windowDurationMins: 10080, resetsAt: 1793774140 }, secondary: null };
const flush = () => new Promise(resolve => setImmediate(resolve));
const identity = {account:{type:'chatgpt',email:'private@example.test'},workspaceRouting:{chatgptAccountId:'workspace-private'}};
function autoTools() {
  const map = new Map(), held = new Set();
  return {map, storage:{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)},
    locks:{async request(key,options,fn){
      assert.equal(options.ifAvailable,true);
      if (held.has(key)) return fn(null);
      held.add(key); try { return await fn({name:key}); } finally { held.delete(key); }
    }}};
}
async function identifyAuto(env) {
  env.respond(identity,{id:env.requests.findLast(r=>r.request.method==='account/read').request.id});
  await flush();
}
const nearCard = (overrides={}) => card({id:'private-card-id',expiresAt:START/1000+55,...overrides});
const consume = env => env.requests.filter(r=>r.request.method==='account/rateLimitResetCredit/consume');
async function reachConsume(env,cards=[nearCard()]) {
  env.respond({rateLimits:quota,rateLimitResetCredits:{credits:cards}});
  await flush();
  const auth=env.requests.at(-1);
  assert.equal(auth.request.method,'account/read');
  env.respond(identity,{id:auth.request.id}); await flush();
  assert.equal(env.requests.at(-1).request.method,'account/rateLimits/read');
  env.respond({rateLimitResetCredits:{credits:cards}}); await flush();
}

test('expiring reset is opt-in, fresh, scoped, and terminal outcomes never spend a second card', async () => {
  const tools=autoTools(),env=environment(tools);
  await identifyAuto(env);
  env.respond({rateLimits:quota,rateLimitResetCredits:{credits:[nearCard()]}}); await flush();
  assert.equal(consume(env).length,0);
  assert.equal(env.api.setAutoResetEnabled(true),true);
  await reachConsume(env);
  assert.equal(consume(env).length,1);
  assert.deepEqual(consume(env)[0].request.params,{idempotencyKey:consume(env)[0].request.params.idempotencyKey,creditId:'private-card-id'});
  env.respond({outcome:'reset'}); await flush();
  assert.equal(env.api.getStatus().autoResetState,'reset');
  assert.doesNotMatch([...tools.map.values()].join(''),/private-card-id|private@example|workspace-private/);
  await reachConsume(env,[nearCard({id:'another-card'})]);
  assert.equal(consume(env).length,1,'no second card within one minute');
  env.api.remove();
});

test('two windows share a lock and durable idempotency across timeout and reinjection', async () => {
  const tools=autoTools(),a=environment(tools),b=environment(tools);
  await identifyAuto(a);await identifyAuto(b);
  a.respond({rateLimitResetCredits:{credits:[]}});b.respond({rateLimitResetCredits:{credits:[]}});
  a.api.setAutoResetEnabled(true);b.api.setAutoResetEnabled(true);
  a.respond({rateLimitResetCredits:{credits:[nearCard()]}});
  b.respond({rateLimitResetCredits:{credits:[nearCard()]}});await flush();
  assert.equal(b.requests.at(-1).request.method,'account/rateLimits/read','contending window sent no identity or consume');
  a.respond(identity);await flush();a.respond({rateLimitResetCredits:{credits:[nearCard()]}});await flush();
  const first=consume(a)[0].request.params;
  a.tick(10000);await flush();
  a.api.remove();
  b.tick(10000); // adopt a comparable clock; polling may start a rate read
  b.api.refresh();
  await reachConsume(b);
  assert.equal(consume(b).length,1);
  assert.deepEqual(consume(b)[0].request.params,first,'same card and same logical request after uncertain timeout');
  b.respond({outcome:'alreadyRedeemed'});await flush();
  b.api.remove();
});

test('expired, far-away, wrong-type and missing-id cards cannot trigger a reset', async () => {
  const env=environment(autoTools());await identifyAuto(env);
  env.respond({rateLimitResetCredits:{credits:[]}});env.api.setAutoResetEnabled(true);
  for (const c of [nearCard({expiresAt:START/1000}),nearCard({expiresAt:START/1000+61}),nearCard({id:null}),nearCard({resetType:'other'}),nearCard({status:'redeemed'})]) {
    env.respond({rateLimitResetCredits:{credits:[c]}});await flush();env.api.refresh();
  }
  assert.equal(consume(env).length,0);env.api.remove();
});

test('account changes and disable during verification cancel redemption', async () => {
  for (const change of ['account','disable','identity']) {
    const env=environment(autoTools());await identifyAuto(env);
    env.respond({rateLimitResetCredits:{credits:[]}});env.api.setAutoResetEnabled(true);
    env.respond({rateLimitResetCredits:{credits:[nearCard()]}});await flush();
    const id=env.requests.at(-1).request.id;
    if(change==='account')env.notify('account/updated');
    if(change==='disable')env.api.setAutoResetEnabled(false);
    env.respond(change==='identity'?{...identity,workspaceRouting:{chatgptAccountId:'different'}}:identity,{id});await flush();
    assert.equal(consume(env).length,0);env.api.remove();
  }
});

test('native permission denial retries only the same request, with bounded attempts', async () => {
  const env=environment(autoTools());await identifyAuto(env);
  env.respond({rateLimitResetCredits:{credits:[]}});env.api.setAutoResetEnabled(true);
  let key;
  for(let i=0;i<4;i++) {
    if(i) {env.tick(10000);env.api.refresh();}
    await reachConsume(env);
    assert.equal(consume(env).length,Math.min(i+1,3));
    if(i<3){key??=consume(env).at(-1).request.params.idempotencyKey;assert.equal(consume(env).at(-1).request.params.idempotencyKey,key);
      env.respond(null,{error:{message:'Usage resets are disabled in settings.'}});await flush();}
  }
  assert.equal(env.api.getStatus().autoResetState,'unconfirmed-or-not-permitted');env.api.remove();
});

test('storage failures and unavailable cross-window locking fail closed', async () => {
  const tools=autoTools();const env=environment({...tools,locks:null});await identifyAuto(env);
  assert.equal(env.api.setAutoResetEnabled(true),false);env.api.remove();
  const second=environment(tools);await identifyAuto(second);
  second.respond({rateLimitResetCredits:{credits:[]}});second.api.setAutoResetEnabled(true);
  tools.storage.setItem=(k,v)=>{if(k.includes('reset-attempts'))throw new Error('full');tools.map.set(k,v);};
  await reachConsume(second);
  assert.equal(consume(second).length,0);assert.equal(second.api.getStatus().autoResetState,'storage-error');second.api.remove();
});

test('restart restores the opt-in but cached cards only schedule fresh verification', async () => {
  const tools=autoTools(),first=environment(tools);await identifyAuto(first);
  first.respond({rateLimitResetCredits:{credits:[nearCard({expiresAt:START/1000+85})]}});
  first.api.setAutoResetEnabled(true);first.api.remove();
  const second=environment(tools);await identifyAuto(second);
  assert.equal(second.api.getStatus().autoResetEnabled,true);
  assert.equal(second.last.cached,true);
  second.tick(30000);await flush();
  assert.equal(consume(second).length,0,'cache never authorizes a redemption');
  await reachConsume(second,[nearCard({expiresAt:START/1000+85})]);
  assert.equal(consume(second).length,1,'fresh card is now in the last minute');
  second.respond({outcome:'nothingToReset'});await flush();
  assert.equal(second.api.getStatus().autoResetState,'nothingToReset');second.api.remove();
});

test("source is inert without the native bridge and only sends a read request when supported", () => {
  const unsupported = environment({ supported: false });
  assert.equal(unsupported.api.getStatus().state, "unsupported");
  assert.equal(unsupported.timers.size, 0);
  assert.equal(unsupported.listeners.size, 0);
  const env = environment();
  assert.equal(env.requests.length, 1);
  assert.deepEqual(env.requests[0], {
    type: "mcp-request", hostId: "local",
    request: { id: env.requests[0].request.id, method: "account/rateLimits/read", params: {} },
    timeoutMs: 10000,
  });
  assert.equal(env.api.refresh(), false);
  assert.equal(env.requests.length, 1);
});

test("normalizes only usable card expiries and safe window telemetry without account or card identifiers", () => {
  const env = environment();
  env.respond({
    accountId: "private-account", rateLimits: { ...quota, limitId: "fallback" },
    rateLimitsByLimitId: { codex: quota },
    rateLimitResetCredits: { availableCount: 100, credits: [
      card({ id: "private-card", description: "private-text" }), card(), card({ expiresAt: EXPIRY + 60 }),
      card({ status: "redeemed" }), card({ resetType: "other" }), card({ expiresAt: null }),
      card({ expiresAt: -1 }), card({ expiresAt: "1793300992" }), card({ expiresAt: 1.5 }),
      card({ expiresAt: Infinity }), card({ expiresAt: 8640000000001 }), null,
    ] },
  });
  assert.deepEqual(env.last, {
    observedAt: START, resetCards: [{ expiresAt: EXPIRY }, { expiresAt: EXPIRY + 60 }],
    usageResets: [{ limitId: "codex", limitName: null, window: "primary", windowMinutes: 10080,
      usedPercent: 62, resetsAt: 1793774140, observedAt: new Date(START).toISOString() }],
  });
  assert.doesNotMatch(JSON.stringify(env.last), /private|availableCount|fallback/);
  assert.equal(env.api.getStatus().state, "ready");
});

test("missing card details stay unknown while empty arrays explicitly clear cards and windows", () => {
  const env = environment();
  for (const details of [undefined, null, { availableCount: 2, credits: null }, { availableCount: 2 }]) {
    env.respond({ rateLimits: quota, ...(details === undefined ? {} : { rateLimitResetCredits: details }) });
    assert.equal(env.last.resetCards, null);
    assert.equal(env.last.usageResets.length, 1);
    env.api.refresh();
  }
  env.respond({ rateLimitsByLimitId: {}, rateLimits: quota, rateLimitResetCredits: { credits: [] } });
  assert.deepEqual(env.last, { observedAt: START, resetCards: [], usageResets: [] });
  env.api.refresh();
  env.respond({});
  assert.deepEqual(env.last, { observedAt: START, resetCards: null, usageResets: null });
  assert.equal(env.api.getStatus().state, "unknown");
  env.api.refresh();
  env.respond({ rateLimits: null });
  assert.deepEqual(env.last.usageResets, []);
});

test("response correlation, failures and timeouts prevent stale cards from surviving", async () => {
  const env = environment();
  const data = { rateLimitResetCredits: { credits: [card()] } };
  env.respond(data, { hostId: "remote" });
  env.respond(data, { id: "other-request" });
  env.respond(data, { type: "mcp-notification" });
  assert.equal(env.updates.length, 0);
  env.respond(data);
  assert.equal(env.last.resetCards.length, 1);
  env.api.refresh();
  const expiredId = env.requests.at(-1).request.id;
  env.tick(10000);
  assert.equal(env.last, null);
  assert.equal(env.api.getStatus().state, "error");
  env.respond(data, { id: expiredId });
  assert.equal(env.last, null);
  env.tick(50000);
  assert.equal(env.requests.length, 3);
  env.respond(data, { error: { code: -1 } });
  assert.equal(env.last, null);
  const rejected = environment({ send: () => Promise.reject(new Error("disconnected")) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rejected.last, null);
  assert.equal(rejected.api.getStatus().pending, false);
  const thrown = environment({ send: () => { throw new Error("missing bridge"); } });
  assert.equal(thrown.last, null);
  assert.equal(thrown.api.getStatus().pending, false);
});

test("reinjection and removal retire listeners, timers and late results", () => {
  const env = environment();
  const old = env.api;
  const oldId = env.requests[0].request.id;
  env.execute();
  assert.equal(old.getStatus().removed, true);
  assert.equal(env.listeners.size, 1);
  assert.equal(env.timers.size, 2);
  assert.equal(env.last, null);
  env.respond({ rateLimitResetCredits: { credits: [card()] } }, { id: oldId });
  assert.equal(env.last, null);
  env.respond({ rateLimitResetCredits: { credits: [] } });
  assert.deepEqual(env.last.resetCards, []);
  const current = env.api;
  assert.equal(current.remove(), true);
  assert.equal(current.remove(), false);
  assert.equal(env.last, null);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.timers.size, 0);
  assert.equal(env.window.__CODEX_METRICS_ACCOUNT__, undefined);
  env.tick(120000);
  assert.equal(env.requests.length, 2);
});

test("local account notifications clear data and retire prior account responses before refreshing", () => {
  const env = environment();
  const previous = { rateLimitResetCredits: { credits: [card()] } };
  env.respond(previous);
  env.api.refresh();
  const oldId = env.requests.at(-1).request.id;
  env.notify("account/updated", "remote");
  env.notify("account/rateLimits/updated");
  assert.equal(env.requests.length, 2);
  assert.deepEqual(env.last.resetCards, [{ expiresAt: EXPIRY }]);

  env.notify("account/updated");
  assert.equal(env.last, null);
  assert.equal(env.api.getStatus().lastSuccessAt, null);
  assert.equal(env.requests.length, 3);
  assert.equal(env.timers.size, 2, "the prior request's timeout is retired");
  env.respond(previous, { id: oldId });
  env.respond(null, { id: oldId, error: { code: -1 } });
  assert.equal(env.last, null);
  assert.equal(env.api.getStatus().pending, true);
  env.respond({ rateLimitResetCredits: { credits: [card({ expiresAt: EXPIRY + 60 })] } });
  assert.deepEqual(env.last.resetCards, [{ expiresAt: EXPIRY + 60 }]);

  env.notify("account/login/completed");
  assert.equal(env.last, null);
  assert.equal(env.requests.length, 4);
  env.respond({ rateLimitResetCredits: { credits: [] } });
  assert.deepEqual(env.last.resetCards, []);
  assert.equal(env.api.getStatus().pending, false);
});

test('account cache survives reinjection, is scoped to verified workspace, and clears on account change', async () => {
  const map=new Map();
  const storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
  const identity={account:{email:'private@example.test'},workspaceRouting:{chatgptAccountId:'workspace-private'}};
  const identify=async (env,value=identity)=>{
    const req=env.requests.findLast(r=>r.request.method==='account/read');
    env.respond(value,{id:req.request.id});
    await new Promise(resolve=>setImmediate(resolve));
  };
  const first=environment({storage});
  await identify(first);
  first.respond({rateLimits:quota,rateLimitResetCredits:{credits:[card()]}});
  assert.equal(first.api.getStatus().cacheEnabled,true);
  assert.equal(map.size,1);
  assert.doesNotMatch([...map.values()][0],/private@example|workspace-private/);
  first.api.remove();
  const second=environment({storage});
  assert.equal(second.last,undefined, 'no cache until local identity is verified');
  await identify(second);
  assert.equal(second.last.cached,true);
  assert.equal(second.last.observedAt,START);
  assert.equal(second.last.usageResets[0].usedPercent,62);
  second.tick(10000);
  assert.equal(second.last.cached,true,'timeout retains verified cache');
  second.notify('account/updated');
  assert.equal(map.size,0);
  assert.equal(second.last,null);
  const other=environment({storage});
  await identify(other,{account:{email:'other'},workspaceRouting:{chatgptAccountId:'other'}});
  assert.equal(other.last,undefined);
});
