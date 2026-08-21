// Optional, off-by-default recording of only the current best attempt's
// audio. Nothing here runs unless explicitly enabled (see app.js's consent
// flow) — this module never touches the mic on its own.
//
// Recording starts when a note is detected as starting and stops when it
// ends, so the clip covers roughly that note (it can miss the first ~80ms
// of attack, since that's the confirmation window before a note is even
// recognized as started — an accepted tradeoff to keep this simple rather
// than running a continuous rolling buffer).
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];

function pickSupportedMimeType() {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return null;
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

function extensionFor(mimeType) {
  if (mimeType && mimeType.includes("mp4")) return "m4a";
  if (mimeType && mimeType.includes("aac")) return "aac";
  return "webm";
}

export class BestAudioRecorder {
  constructor() {
    this.enabled = false;
    this.mimeType = pickSupportedMimeType();
    this.mediaRecorder = null;
    this.chunks = [];
    this.bestBlob = null;
    this.bestDurationMs = null;
    this.bestObjectUrl = null;
  }

  static isSupported() {
    return typeof MediaRecorder !== "undefined";
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.clearBest();
  }

  clearBest() {
    if (this.bestObjectUrl) URL.revokeObjectURL(this.bestObjectUrl);
    this.bestBlob = null;
    this.bestDurationMs = null;
    this.bestObjectUrl = null;
  }

  startRecording(stream) {
    if (!this.enabled || !stream || !BestAudioRecorder.isSupported()) return;
    this.chunks = [];
    try {
      this.mediaRecorder = new MediaRecorder(stream, this.mimeType ? { mimeType: this.mimeType } : undefined);
    } catch (err) {
      console.warn("Best-attempt recording unavailable:", err);
      this.mediaRecorder = null;
      return;
    }
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start();
  }

  // Resolves with a Blob (or null if nothing was recording / no data).
  stopRecording() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === "inactive") {
        resolve(null);
        return;
      }
      this.mediaRecorder.onstop = () => {
        const blob = this.chunks.length ? new Blob(this.chunks, { type: this.mimeType || "audio/webm" }) : null;
        this.chunks = [];
        resolve(blob);
      };
      this.mediaRecorder.stop();
    });
  }

  // Cuts a recording short without keeping it — used when a note is
  // abandoned (e.g. disarming mid-note) rather than completed normally.
  abort() {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
      try {
        this.mediaRecorder.stop();
      } catch {
        // already stopped/inactive — nothing to clean up
      }
    }
    this.mediaRecorder = null;
    this.chunks = [];
  }

  // Keeps blob as the new best only if it actually beats the current one,
  // discarding whichever clip loses. Returns whether it was kept.
  considerAsBest(blob, durationMs) {
    if (!blob) return false;
    if (this.bestDurationMs !== null && durationMs <= this.bestDurationMs) return false;
    this.clearBest();
    this.bestBlob = blob;
    this.bestDurationMs = durationMs;
    this.bestObjectUrl = URL.createObjectURL(blob);
    return true;
  }

  getDownloadInfo() {
    if (!this.bestBlob) return null;
    return { url: this.bestObjectUrl, extension: extensionFor(this.mimeType) };
  }
}
