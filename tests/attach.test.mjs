import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {spawnSync} from 'node:child_process';

// Run the actual attach orchestration with fake CDP/process boundaries; never connect to an app.
const cli = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
const start = cli.indexOf('async function attach()');
const end = cli.lastIndexOf('\ntry {');
assert.ok(start >= 0 && end > start, 'attach entry point must be present');
const attachSource = cli.slice(start, end);

async function runAttach({ signalAt = 'update', failPosition = false, ownerFailure = false, initialRevision = null, initialHealth = true } = {}) {
  const handlers = {};
  const state = { installed: initialRevision !== null, revision: initialRevision, healthy:initialHealth, heartbeats:[], closed: false, installs: 0, removes: 0, evaluations: 0, peakEvaluations: 0, ownerChecks: 0, lists: 0 };
  class FakeCdp {
    closed = false;
    async open() {
      if (signalAt === 'open') handlers.SIGINT();
      return this;
    }
    async evaluate(expression) {
      if (this.closed) throw new Error('connection closed');
      state.evaluations++;
      state.peakEvaluations = Math.max(state.peakEvaluations, state.evaluations);
      try {
        if (expression.includes('?.remove()')) {
          state.installed = false;
          state.removes++;
          return true;
        }
        if (expression.startsWith('Boolean(')) {
          if (signalAt === 'ready') handlers.SIGINT();
          await Promise.resolve();
          return state.installed && state.revision === 'fixture-revision' && state.healthy;
        }
        if (expression === 'INSTALL_RENDERER') {
          state.installed = true;
          state.healthy = true;
          state.installs++;
          if (signalAt === 'install') handlers.SIGINT();
          await Promise.resolve();
          return {};
        }
        if (expression.includes('.rendererRevision =')) state.revision = 'fixture-revision';
        if (expression.includes('.setPosition(') && failPosition) {
          handlers.SIGINT();
          throw new Error('position script failed');
        }
        if (expression.includes('.getThreadId()')) return '01234567-89ab-cdef-0123-456789abcdef';
        if (expression.includes('checkHealth?.()')) return {expected:true,mounted:state.installed,healthy:state.healthy};
        if (expression.includes('.update(') && signalAt === 'update') handlers.SIGINT();
        return true;
      } finally { state.evaluations--; }
    }
    close() { this.closed = true; state.closed = true; }
  }
  const context = vm.createContext({
    CollectorHeartbeat: class { async pulse(phase, summary) { state.heartbeats.push({phase,...summary}); } },
    SnapshotCache: class { async load() { return new Map(); } async save() {} },
    options: { port: 9341, position: 'above' }, renderer: 'INSTALL_RENDERER', rendererRevision: 'fixture-revision', Cdp: FakeCdp,
    verifyEndpointOwner: async () => {
      state.ownerChecks++;
      if (ownerFailure && state.ownerChecks === 3) throw new Error('owner changed');
    },
    listTargets: async () => { state.lists++; return [{ id: 'main-window' }]; },
    snapshot: async (threadId) => ({ threadId, status: 'ok' }),
    process: { once: (name, handler) => { handlers[name] = handler; } },
    console: { log() {}, error() {} },
    setTimeout: (callback) => queueMicrotask(callback),
  });
  let error = null;
  try { await vm.runInContext(`${attachSource}\nattach()`, context); } catch (caught) { error = caught; }
  return { ...state, error };
}

test('stop during connection or readiness does not install a renderer', async () => {
  for (const signalAt of ['open', 'ready']) {
    const result = await runAttach({ signalAt });
    assert.equal(result.installs, 0);
    assert.equal(result.closed, true);
    assert.equal(result.installed, false);
    assert.equal(result.removes, 1);
  }
});

test('stop during renderer installation waits for the operation before one cleanup', async () => {
  const result = await runAttach({ signalAt: 'install' });
  assert.equal(result.installs, 1);
  assert.equal(result.removes, 1);
  assert.equal(result.peakEvaluations, 1, 'cleanup must not overlap an in-flight evaluation');
  assert.equal(result.installed, false);
  assert.equal(result.closed, true);
});

test('owner changes stop discovery and clean up the prior client', async () => {
  const result = await runAttach({ signalAt: null, ownerFailure: true });
  assert.equal(result.error?.message, 'owner changed');
  assert.equal(result.lists, 1);
  assert.equal(result.removes, 1);
  assert.equal(result.installed, false);
  assert.equal(result.closed, true);
});

test('a script error after injection removes the renderer before losing the client', async () => {
  const result = await runAttach({ failPosition: true });
  assert.equal(result.installs, 1);
  assert.equal(result.removes, 1);
  assert.equal(result.installed, false);
  assert.equal(result.closed, true);
});

test('source updates replace an older renderer while the matching revision is retained', async () => {
  const old = await runAttach({ initialRevision: 'previous-revision' });
  assert.equal(old.installs, 1);
  assert.equal(old.revision, 'fixture-revision');
  const current = await runAttach({ initialRevision: 'fixture-revision' });
  assert.equal(current.installs, 0);
});

test('an unhealthy mounted component is replaced even when its source revision matches', async () => {
  const result = await runAttach({initialRevision:'fixture-revision', initialHealth:false});
  assert.equal(result.installs,1);
  assert.equal(result.healthy,true);
  assert.equal(result.heartbeats[0].phase,'starting');
  assert.ok(result.heartbeats.some(item=>item.mounted===1));
  assert.equal(result.heartbeats.at(-1).phase,'stopped');
});

test('completed collectors exit after cleanup even when a connection keeps the event loop alive', () => {
  for (const fail of [false, true]) {
    const script = `
      const mode = 'attach';
      // Model a connection whose close handshake never completes.
      setInterval(() => {}, 10000);
      async function attach() {
        try { if (${fail}) throw new Error('owner changed'); }
        finally {
          await new Promise(resolve => setTimeout(resolve, 10));
          process.stdout.write('cleanup saved cache\\n');
        }
      }
      ${cli.slice(end)}
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding:'utf8', timeout:3000,
    });
    assert.equal(result.error, undefined, 'collector must exit so the watcher can replace it');
    assert.equal(result.status, fail ? 1 : 0);
    assert.equal(result.stdout, 'cleanup saved cache\n');
    if (fail) assert.match(result.stderr, /owner changed/);
  }
});
