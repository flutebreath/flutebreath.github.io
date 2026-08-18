// Tracks a running estimate of the ambient "silence" level, so start/stop
// thresholds can sit a fixed margin above whatever the room and device
// actually sound like right now — instead of a fixed absolute dB guess that
// breaks the moment the mic's gain, the room, or handling noise differs from
// whatever the guess assumed.
//
// Only feed this samples while you believe nothing musical is happening
// (i.e. the detector is in its LISTENING state) — otherwise the note itself
// would drag its own floor upward.
export class NoiseFloorTracker {
  constructor({ initialDb = -60, fastAlpha = 0.2, slowAlpha = 0.03, settleMs = 1500 } = {}) {
    this.initialDb = initialDb;
    this.fastAlpha = fastAlpha; // quick convergence right after arming
    this.slowAlpha = slowAlpha; // gentle drift once settled, so it isn't jumpy
    this.settleMs = settleMs;
    this.floorDb = initialDb;
    this._startedAt = null;
  }

  // Call once when arming, so the tracker knows when the "settling" window began.
  begin(now) {
    this.floorDb = this.initialDb;
    this._startedAt = now;
  }

  reset() {
    this.floorDb = this.initialDb;
    this._startedAt = null;
  }

  update(levelDb, now) {
    const settling = this._startedAt !== null && now - this._startedAt < this.settleMs;
    const alpha = settling ? this.fastAlpha : this.slowAlpha;
    this.floorDb += alpha * (levelDb - this.floorDb);
  }
}
