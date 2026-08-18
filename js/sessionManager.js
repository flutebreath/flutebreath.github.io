// Tracks attempts for the current practice session (in memory only — nothing
// persists across a page reload in V1).
export class SessionManager {
  constructor() {
    this.attempts = [];
  }

  addAttempt(durationMs) {
    const attempt = { durationMs, at: Date.now() };
    this.attempts.push(attempt);
    return attempt;
  }

  reset() {
    this.attempts = [];
  }

  count() {
    return this.attempts.length;
  }

  bestMs() {
    if (this.attempts.length === 0) return null;
    return Math.max(...this.attempts.map((a) => a.durationMs));
  }

  averageMs() {
    if (this.attempts.length === 0) return null;
    const total = this.attempts.reduce((sum, a) => sum + a.durationMs, 0);
    return total / this.attempts.length;
  }
}
