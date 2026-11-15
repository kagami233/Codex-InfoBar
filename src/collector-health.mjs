import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const COLLECTOR_TIMEOUT_MS = 90000;
const positive = value => Number.isFinite(value) && value > 0;

// Only the collector's completed work advances this heartbeat. A timer inside
// that same process would conceal a stalled asynchronous operation.
export class CollectorHeartbeat {
  constructor({file = process.env.CODEX_INFOBAR_HEARTBEAT_FILE, token = process.env.CODEX_INFOBAR_HEARTBEAT_TOKEN, pid = process.pid, now = Date.now} = {}) {
    this.file = file;
    this.token = token;
    this.pid = pid;
    this.now = now;
    this.lastWrite = 0;
    this.summary = {};
  }

  async pulse(phase, summary = {}, force = false) {
    if (!this.file || !this.token) return;
    Object.assign(this.summary, summary);
    const now = this.now();
    if (!force && now - this.lastWrite < 2000) return;
    const report = {version:1, pid:this.pid, token:this.token, observedAt:now,
      phase:typeof phase === 'string' ? phase.slice(0,80) : 'unknown'};
    for (const key of ['expected', 'mounted', 'injections']) {
      report[key] = Number.isSafeInteger(this.summary[key]) && this.summary[key] >= 0 ? this.summary[key] : 0;
    }
    report.degradedSince = positive(this.summary.degradedSince) ? this.summary.degradedSince : null;
    const temporary = `${this.file}.${this.pid}.tmp`;
    await fs.mkdir(path.dirname(this.file), {recursive:true, mode:0o700});
    await fs.writeFile(temporary, JSON.stringify(report), {mode:0o600});
    await fs.rename(temporary, this.file);
    this.lastWrite = now;
  }
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = exited => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeout);
    child.once('exit', onExit);
  });
}

// The parent holds the exact ChildProcess it spawned. Heartbeat contents never
// select a PID to terminate, and every launch gets a distinct file and token.
export class CollectorSupervisor {
  constructor({stateRoot, start, log = () => {}, timeoutMs = COLLECTOR_TIMEOUT_MS, intervalMs = 3000, stopGraceMs = 7000, now = Date.now}) {
    this.stateRoot = stateRoot;
    this.start = start;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.stopGraceMs = stopGraceMs;
    this.now = now;
    this.child = null;
    this.enabled = false;
    this.closed = false;
    this.nextStartAt = 0;
    this.failures = 0;
    this.recoveries = 0;
    this.report = null;
    this.reason = 'idle';
    this.timer = setInterval(() => { void this.check().catch(error => this.note(`Collector health check: ${error.message}`)); }, intervalMs);
    this.timer.unref();
  }

  note(message) {
    void Promise.resolve(this.log(message)).catch(() => {});
  }

  ensureRunning() {
    if (this.closed) return;
    this.enabled = true;
    if (!this.child && !this.checkPromise && this.now() >= this.nextStartAt) this.launch();
  }

  pause() { this.enabled = false; }

  launch() {
    const token = randomUUID();
    const file = path.join(this.stateRoot, `collector-heartbeat-${token}.json`);
    this.startedAt = this.now();
    this.report = null;
    this.reason = 'starting';
    const child = this.start({
      CODEX_INFOBAR_HEARTBEAT_FILE:file,
      CODEX_INFOBAR_HEARTBEAT_TOKEN:token,
    });
    this.child = child;
    this.session = {file, token};
    const finish = () => {
      if (this.child !== child) return;
      this.child = null;
      this.failures++;
      this.nextStartAt = this.now() + Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5));
      this.reason = this.closed ? 'stopped' : 'backoff';
      void fs.rm(file, {force:true}).catch(() => {});
      if (child.pid) void fs.rm(`${file}.${child.pid}.tmp`, {force:true}).catch(() => {});
    };
    child.once('error', error => { this.note(`Collector launch: ${error.message}`); finish(); });
    child.once('exit', (code, signal) => {
      this.note(`Collector exited: pid=${child.pid}; code=${code}; signal=${signal ?? 'none'}.`);
      finish();
    });
  }

  check() {
    if (this.closed) return Promise.resolve();
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.inspect().finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  async inspect() {
    if (!this.child) {
      if (this.enabled && this.now() >= this.nextStartAt) this.launch();
      return;
    }
    const child = this.child;
    const session = this.session;
    let report = null;
    try {
      if ((await fs.stat(session.file)).size <= 8192) report = JSON.parse(await fs.readFile(session.file, 'utf8'));
    } catch {}
    if (this.child !== child) return;
    const now = this.now();
    const valid = report?.version === 1 && report.pid === child.pid && report.token === session.token &&
      positive(report.observedAt) && report.observedAt >= this.startedAt && report.observedAt <= now;
    if (valid) this.report = report;
    const lastProgress = valid ? report.observedAt : this.startedAt;
    const stale = now - lastProgress > this.timeoutMs;
    const degraded = valid && positive(report.degradedSince) && report.degradedSince >= this.startedAt &&
      report.degradedSince <= now && now - report.degradedSince > this.timeoutMs;
    this.reason = stale ? 'heartbeat-timeout' : degraded ? 'mount-timeout' : valid ? 'healthy' : 'starting';
    if (!stale && !degraded) {
      if (valid && now - this.startedAt > 30000 && !report.degradedSince) this.failures = 0;
      return;
    }
    this.recoveries++;
    this.note(`Collector recovery: ${this.reason}; pid=${child.pid}; phase=${report?.phase ?? 'unknown'}.`);
    await this.retire();
  }

  async retire() {
    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
    if (await waitForExit(child, this.stopGraceMs)) return;
    // Only this supervisor's still-running child can reach this fallback.
    if (this.child === child && child.exitCode === null && child.signalCode === null) {
      this.note(`Collector did not finish cleanup; retiring owned child ${child.pid}.`);
      child.kill('SIGKILL');
      await waitForExit(child, 2000);
    }
  }

  status() {
    return {pid:this.child?.pid ?? null, reason:this.reason, heartbeatAt:this.report?.observedAt ?? null,
      phase:this.report?.phase ?? null, expected:this.report?.expected ?? 0, mounted:this.report?.mounted ?? 0,
      recoveries:this.recoveries};
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    this.enabled = false;
    clearInterval(this.timer);
    this.stopPromise = (async () => { await this.checkPromise; await this.retire(); })();
    return this.stopPromise;
  }
}
