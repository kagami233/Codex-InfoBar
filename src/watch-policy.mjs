// Pure policy: never restart the process present when the service starts.
export class WatchPolicy {
  constructor(initialPid, now = Date.now()) {
    this.ignoredPid = initialPid;
    this.pid = initialPid;
    this.seenAt = now;
    this.attempted = new Set();
    this.lastRestart = -Infinity;
  }
  decide({ pid, ready, occupied, debugRequested, autoRestart = true, now = Date.now() }) {
    if (!pid) { this.pid = null; this.ignoredPid = null; return 'idle'; }
    if (pid !== this.pid) { this.pid = pid; this.seenAt = now; }
    // A verified successful handoff ends the failure cooldown. A later user
    // launch is a new session, even if it happens within ten minutes.
    if (ready) { this.lastRestart = -Infinity; return 'attach'; }
    if (debugRequested) return now - this.seenAt < 60000 ? 'debug-starting' : 'debug-unavailable';
    if (!autoRestart) return 'needs-debug-launch';
    if (pid === this.ignoredPid) return 'existing';
    if (occupied) return 'port-conflict';
    if (this.attempted.has(pid)) return 'failed';
    if (now - this.seenAt < 15000 || now - this.lastRestart < 600000) return 'waiting';
    this.attempted.add(pid);
    this.lastRestart = now;
    return 'restart';
  }
  protect(pid) { if (pid) this.attempted.add(pid); }
}
