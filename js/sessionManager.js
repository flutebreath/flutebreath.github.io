// Tracks attempts across sessions, persisted to localStorage so a page
// reload doesn't lose practice history. No account, no server — this never
// leaves the browser.
const STORAGE_KEY = "flute-breath-timer:attempts:v1";

function loadAttempts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a) => a && typeof a.id === "string" && typeof a.durationMs === "number" && typeof a.at === "number")
      .map((a) => ({ ...a, levels: Array.isArray(a.levels) ? a.levels : [] }));
  } catch {
    return [];
  }
}

function saveAttempts(attempts) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(attempts));
  } catch {
    // Private browsing, storage disabled, or quota exceeded — the session
    // still works in memory, it just won't survive a reload.
  }
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SessionManager {
  constructor() {
    this.attempts = loadAttempts();
  }

  // levels: rounded dB samples taken through the note, for the blow-consistency graph.
  addAttempt(durationMs, levels = []) {
    const attempt = { id: makeId(), durationMs, at: Date.now(), levels };
    this.attempts.push(attempt);
    saveAttempts(this.attempts);
    return attempt;
  }

  removeAttempt(id) {
    this.attempts = this.attempts.filter((a) => a.id !== id);
    saveAttempts(this.attempts);
  }

  reset() {
    this.attempts = [];
    saveAttempts(this.attempts);
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
