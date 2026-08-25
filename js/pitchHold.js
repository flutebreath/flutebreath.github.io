// Smooths the live pitch display against brief detection dropouts. A real
// sustained acoustic tone (breath noise, natural micro-fluctuations) will
// occasionally produce a frame the pitch detector honestly can't lock onto
// with confidence — that's normal and expected, not a sign anything is
// wrong. Reacting to every single miss makes the UI flicker distractingly
// between a reading and "no pitch detected" throughout an otherwise solid
// note. This holds the last confident reading for a short grace period
// before falling back — the same asymmetric-hysteresis idea already used
// for start/stop detection (quick to confirm a hit, slower to confirm it's
// really gone), just applied to the pitch readout instead of the timer.
export class PitchHoldTracker {
  constructor({ holdMs = 300 } = {}) {
    this.holdMs = holdMs;
    this.lastConfidentAt = null;
  }

  reset() {
    this.lastConfidentAt = null;
  }

  markHit(now) {
    this.lastConfidentAt = now;
  }

  // Call on a miss. Returns true if the UI should now switch to showing
  // "no pitch" (the hold window has elapsed, or there was never a hit this
  // note), false if it should keep showing whatever it last showed.
  shouldShowNoPitch(now) {
    if (this.lastConfidentAt === null) return true;
    return now - this.lastConfidentAt >= this.holdMs;
  }
}
