// High-resolution duration measurement. Deliberately does not use setInterval
// to accumulate time — the source of truth is always a performance.now() delta.
export class SustainTimer {
  constructor() {
    this.startedAt = null;
  }

  start(now = performance.now()) {
    this.startedAt = now;
  }

  // Elapsed time in ms since start(), or 0 if not running.
  elapsedMs(now = performance.now()) {
    if (this.startedAt === null) return 0;
    return now - this.startedAt;
  }

  // Stops and returns the final duration in ms.
  stop(now = performance.now()) {
    const duration = this.elapsedMs(now);
    this.startedAt = null;
    return duration;
  }

  isRunning() {
    return this.startedAt !== null;
  }
}

export function formatDuration(ms) {
  const seconds = Math.max(0, ms) / 1000;
  return seconds.toFixed(2).padStart(5, "0");
}
