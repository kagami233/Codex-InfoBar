// Pure policy: never restart the process present when the service starts.
export class WatchPolicy {
  constructor(initialPid, now = Date.now()) {
    this.ignoredPid = initialPid;
    this.pid = initialPid;
    this.seenAt = now;
    this.attempted = new Set();
    this.lastRestart = -Infinity;
  }
  decide({ pid, ready, occupied, now = Date.now() }) {
    if (!pid) { this.pid = null; this.ignoredPid = null; return 'idle'; }
    if (pid !== this.pid) { this.pid = pid; this.seenAt = now; }
    if (ready) return 'attach';
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
