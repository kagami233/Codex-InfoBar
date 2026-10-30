import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

// Run the actual attach orchestration with fake CDP/process boundaries; never connect to an app.
const cli = fs.readFileSync(new URL('../src/cli.mjs', import.meta.url), 'utf8');
const start = cli.indexOf('async function attach()');
const end = cli.lastIndexOf('\ntry {');
assert.ok(start >= 0 && end > start, 'attach entry point must be present');
const attachSource = cli.slice(start, end);

async function runAttach({ signalAt = 'update', failPosition = false, ownerFailure = false, initialRevision = null } = {}) {
  const handlers = {};
  const state = { installed: initialRevision !== null, revision: initialRevision, closed: false, installs: 0, removes: 0, evaluations: 0, peakEvaluations: 0, ownerChecks: 0, lists: 0 };
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
          return state.installed && state.revision === 'fixture-revision';
        }
        if (expression === 'INSTALL_RENDERER') {
          state.installed = true;
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
        if (expression.includes('.update(') && signalAt === 'update') handlers.SIGINT();
        return true;
      } finally { state.evaluations--; }
    }
    close() { this.closed = true; state.closed = true; }
  }
  const context = vm.createContext({
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
