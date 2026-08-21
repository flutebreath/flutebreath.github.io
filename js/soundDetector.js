// Decides whether a flute note has started or stopped, using two thresholds
// (hysteresis) plus confirmation windows so brief noises and breath dips
// don't cause false starts/stops. Pure state machine — no DOM, no audio APIs.
export const DetectorState = Object.freeze({
  LISTENING: "LISTENING", // waiting for sound to cross the start threshold
  CONFIRM_START: "CONFIRM_START", // sound is loud enough, confirming it isn't a blip
  TIMING: "TIMING", // note confirmed, timer running
  CONFIRM_STOP: "CONFIRM_STOP", // sound dropped, confirming it isn't a brief dip
});

export class SoundDetector {
  constructor({
    startThresholdDb = -40,
    stopThresholdDb = -48,
    startConfirmMs = 80,
    stopConfirmMs = 250,
    // Fallback stop condition, independent of the (possibly stale) absolute
    // stopThresholdDb: if the level drops this many dB below THIS note's own
    // peak, that counts as quiet too. Covers the case where ambient noise
    // rises mid-note (a fan speeding up, traffic, etc.) — the room can only
    // be re-measured while LISTENING, so a long note can outlast how
    // current that measurement still is. A genuine flute note is normally
    // far louder than whatever crept in behind it, so this stays reliable
    // without needing to know the absolute noise floor at all.
    relativeStopDropDb = 15,
    onStart = () => {},
    onStop = () => {},
  } = {}) {
    this.startThresholdDb = startThresholdDb;
    this.stopThresholdDb = stopThresholdDb;
    this.startConfirmMs = startConfirmMs;
    this.stopConfirmMs = stopConfirmMs;
    this.relativeStopDropDb = relativeStopDropDb;
    this.onStart = onStart;
    this.onStop = onStop;

    this.state = DetectorState.LISTENING;
    this._pendingSince = null;
    this._noteStartedAt = null;
    this._notePeakDb = null;
  }

  setThresholds({ startThresholdDb, stopThresholdDb }) {
    if (typeof startThresholdDb === "number") this.startThresholdDb = startThresholdDb;
    if (typeof stopThresholdDb === "number") this.stopThresholdDb = stopThresholdDb;
  }

  // True once the level has dropped low enough to count as "not playing" —
  // either against the absolute stop threshold, or far enough below this
  // note's own peak, whichever fires first.
  _isQuiet(levelDb) {
    if (levelDb < this.stopThresholdDb) return true;
    return this._notePeakDb !== null && levelDb < this._notePeakDb - this.relativeStopDropDb;
  }

  // Returns to LISTENING without firing callbacks. Use when disarming.
  reset() {
    this.state = DetectorState.LISTENING;
    this._pendingSince = null;
    this._noteStartedAt = null;
    this._notePeakDb = null;
  }

  // Ends a note immediately, bypassing the stop-confirmation window. Safety
  // net so a note can never keep "timing" forever no matter what the room
  // does. No-op outside TIMING/CONFIRM_STOP.
  forceStop(now) {
    if (this.state !== DetectorState.TIMING && this.state !== DetectorState.CONFIRM_STOP) {
      return;
    }
    const startedAt = this._noteStartedAt;
    const durationMs = now - startedAt;
    this.state = DetectorState.LISTENING;
    this._pendingSince = null;
    this._noteStartedAt = null;
    this._notePeakDb = null;
    this.onStop(startedAt, now, durationMs);
  }

  // Call once per animation frame with the current loudness (dB) and timestamp (performance.now()).
  update(levelDb, now) {
    switch (this.state) {
      case DetectorState.LISTENING:
        if (levelDb >= this.startThresholdDb) {
          this.state = DetectorState.CONFIRM_START;
          this._pendingSince = now;
        }
        break;

      case DetectorState.CONFIRM_START:
        if (levelDb >= this.startThresholdDb) {
          if (now - this._pendingSince >= this.startConfirmMs) {
            this._noteStartedAt = now;
            this._notePeakDb = levelDb;
            this.state = DetectorState.TIMING;
            this.onStart(now);
          }
        } else {
          // Dropped back down before confirmation — treat as noise, abort.
          this.state = DetectorState.LISTENING;
          this._pendingSince = null;
        }
        break;

      case DetectorState.TIMING:
        this._notePeakDb = Math.max(this._notePeakDb, levelDb);
        if (this._isQuiet(levelDb)) {
          this.state = DetectorState.CONFIRM_STOP;
          this._pendingSince = now;
        }
        break;

      case DetectorState.CONFIRM_STOP:
        this._notePeakDb = Math.max(this._notePeakDb, levelDb);
        if (this._isQuiet(levelDb)) {
          if (now - this._pendingSince >= this.stopConfirmMs) {
            const startedAt = this._noteStartedAt;
            const durationMs = now - startedAt;
            this.state = DetectorState.LISTENING;
            this._pendingSince = null;
            this._noteStartedAt = null;
            this._notePeakDb = null;
            this.onStop(startedAt, now, durationMs);
          }
        } else {
          // Sound recovered (vibrato/breath dip) — resume timing without a gap.
          this.state = DetectorState.TIMING;
          this._pendingSince = null;
        }
        break;
    }
  }
}
