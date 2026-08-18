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
    onStart = () => {},
    onStop = () => {},
  } = {}) {
    this.startThresholdDb = startThresholdDb;
    this.stopThresholdDb = stopThresholdDb;
    this.startConfirmMs = startConfirmMs;
    this.stopConfirmMs = stopConfirmMs;
    this.onStart = onStart;
    this.onStop = onStop;

    this.state = DetectorState.LISTENING;
    this._pendingSince = null;
    this._noteStartedAt = null;
  }

  setThresholds({ startThresholdDb, stopThresholdDb }) {
    if (typeof startThresholdDb === "number") this.startThresholdDb = startThresholdDb;
    if (typeof stopThresholdDb === "number") this.stopThresholdDb = stopThresholdDb;
  }

  // Returns to LISTENING without firing callbacks. Use when disarming.
  reset() {
    this.state = DetectorState.LISTENING;
    this._pendingSince = null;
    this._noteStartedAt = null;
  }

  // Ends a note immediately, bypassing the stop-confirmation window. Safety
  // net so a note can never keep "timing" forever — e.g. if the room's noise
  // floor never drops below the stop threshold. No-op outside TIMING/CONFIRM_STOP.
  forceStop(now) {
    if (this.state !== DetectorState.TIMING && this.state !== DetectorState.CONFIRM_STOP) {
      return;
    }
    const startedAt = this._noteStartedAt;
    const durationMs = now - startedAt;
    this.state = DetectorState.LISTENING;
    this._pendingSince = null;
    this._noteStartedAt = null;
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
        if (levelDb < this.stopThresholdDb) {
          this.state = DetectorState.CONFIRM_STOP;
          this._pendingSince = now;
        }
        break;

      case DetectorState.CONFIRM_STOP:
        if (levelDb < this.stopThresholdDb) {
          if (now - this._pendingSince >= this.stopConfirmMs) {
            const startedAt = this._noteStartedAt;
            const durationMs = now - startedAt;
            this.state = DetectorState.LISTENING;
            this._pendingSince = null;
            this._noteStartedAt = null;
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
