// Saved sargam phrases (ordered lists of swaras) the user builds once and
// reuses for practice — e.g. "Ma Ga Re Ga". Persisted to localStorage, same
// pattern as attempt history: nothing leaves the browser.
const STORAGE_KEY = "flute-breath-timer:sequences:v1";

function loadSequences() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s) =>
        s &&
        typeof s.id === "string" &&
        typeof s.name === "string" &&
        Array.isArray(s.swaraSemitones) &&
        s.swaraSemitones.length > 0
    );
  } catch {
    return [];
  }
}

function saveSequences(sequences) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sequences));
  } catch {
    // Private browsing, storage disabled, or quota exceeded — still works
    // for the current session, just won't survive a reload.
  }
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SequenceLibrary {
  constructor() {
    this.sequences = loadSequences();
  }

  add(name, swaraSemitones) {
    const sequence = { id: makeId(), name, swaraSemitones: [...swaraSemitones], createdAt: Date.now() };
    this.sequences.push(sequence);
    saveSequences(this.sequences);
    return sequence;
  }

  remove(id) {
    this.sequences = this.sequences.filter((s) => s.id !== id);
    saveSequences(this.sequences);
  }
}
