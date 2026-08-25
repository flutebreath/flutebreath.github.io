import { AudioInput } from "./audioInput.js";
import { AudioAnalyzer } from "./audioAnalyzer.js";
import { SoundDetector, DetectorState } from "./soundDetector.js";
import { SustainTimer } from "./sustainTimer.js";
import { SessionManager } from "./sessionManager.js";
import { NoiseFloorTracker } from "./noiseFloor.js";
import { BestAudioRecorder } from "./bestAudioRecorder.js";
import { SWARAS, targetFrequency, centsOff, accuracyTier } from "./swaraTheory.js";
import { UI } from "./ui.js";

const STOP_MARGIN_GAP_DB = 6; // stop threshold sits this many dB below the start threshold's margin
const START_CONFIRM_MS = 80;
const STOP_CONFIRM_MS = 250;
const COMPLETE_FLASH_MS = 900;
// Mic streams often produce a brief loud pop/click as the hardware settles
// right after getUserMedia connects, and picking the device up to position
// it near the flute adds handling noise. Show the level meter immediately
// but don't feed it to the detector until this has passed.
const ARM_WARMUP_MS = 600;
// Safety net: a note can never "hang" forever even if the room's noise floor
// somehow never drops below the stop threshold.
const MAX_NOTE_MS = 30000;
// How often to sample loudness while a note is playing, for the blow
// consistency graph. Throttled well below frame rate — a graph doesn't need
// 60 points/sec, and it keeps the per-attempt storage footprint small.
const LEVEL_SAMPLE_INTERVAL_MS = 100;
// Same idea for swara pitch sampling, at a slightly livelier rate — a tuner
// feel benefits from feeling responsive, and pitch detection over the
// bounded flute-range lag search is cheap enough to afford it.
const PITCH_SAMPLE_INTERVAL_MS = 80;
const PITCH_MIN_HZ = 100;
const PITCH_MAX_HZ = 2000;

const ui = new UI();
const sessionManager = new SessionManager();
const sustainTimer = new SustainTimer();
const audioInput = new AudioInput();
const floorTracker = new NoiseFloorTracker();
const bestAudioRecorder = new BestAudioRecorder();

let analyzer = null;
let armed = false;
let rafHandle = null;
let wakeLock = null;
let completeFlashTimeout = null;
let armedAt = null;
let currentNoteLevels = [];
let lastLevelSampleAt = null;

// Swara practice: null semitones means practice mode is off (plain sustain
// timer, unchanged behavior). saNote is a pitch class only ("C", "D#", …) —
// Sa isn't a fixed pitch in Indian classical music, so octave is irrelevant.
let saNote = "C";
let practiceSwaraSemitones = null;
let practiceSwaraName = null;
let currentNotePitchCents = [];
let lastPitchSampleAt = null;

// marginDb = how many dB above the *current* ambient noise floor a sound
// must reach to count as a note starting. The floor itself is measured
// continuously (see noiseFloor.js), so this stays correct across rooms,
// devices, and mic gain — instead of a fixed absolute dB guess.
let marginDb = Number(ui.el.sensitivitySlider.value);

function currentThresholds() {
  const startThresholdDb = floorTracker.floorDb + marginDb;
  const stopThresholdDb = floorTracker.floorDb + marginDb - STOP_MARGIN_GAP_DB;
  return { startThresholdDb, stopThresholdDb };
}

const detector = new SoundDetector({
  ...currentThresholds(),
  startConfirmMs: START_CONFIRM_MS,
  stopConfirmMs: STOP_CONFIRM_MS,
  onStart: (now) => {
    clearTimeout(completeFlashTimeout);
    sustainTimer.start(now);
    currentNoteLevels = [];
    lastLevelSampleAt = null;
    currentNotePitchCents = [];
    lastPitchSampleAt = null;
    bestAudioRecorder.startRecording(audioInput.getStream());
    ui.setState("TIMING");
  },
  onStop: (startedAt, now, durationMs) => {
    sustainTimer.stop(now);

    const practiceActive = practiceSwaraSemitones !== null;
    sessionManager.addAttempt(durationMs, currentNoteLevels, {
      pitchCents: practiceActive ? currentNotePitchCents : null,
      targetSwara: practiceActive ? practiceSwaraName : null,
    });
    currentNoteLevels = [];

    if (practiceActive) {
      if (currentNotePitchCents.length > 0) {
        const avgCents = currentNotePitchCents.reduce((sum, c) => sum + c, 0) / currentNotePitchCents.length;
        ui.setLivePitch(accuracyTier(avgCents), avgCents);
      } else {
        ui.setLivePitch("none", null);
      }
    }
    currentNotePitchCents = [];

    ui.setTimerMs(durationMs);
    ui.setState("COMPLETE");
    renderStats();

    bestAudioRecorder.stopRecording().then((blob) => {
      if (bestAudioRecorder.considerAsBest(blob, durationMs)) {
        ui.setBestAudio(bestAudioRecorder.getDownloadInfo());
      }
    });

    completeFlashTimeout = setTimeout(() => {
      if (armed) ui.setState("LISTENING");
    }, COMPLETE_FLASH_MS);
  },
});

function renderStats() {
  ui.renderStats({
    lastMs: sessionManager.attempts.at(-1)?.durationMs ?? null,
    bestMs: sessionManager.bestMs(),
    avgMs: sessionManager.averageMs(),
  });
  ui.renderHistory(sessionManager.attempts, sessionManager.bestMs(), (id) => {
    sessionManager.removeAttempt(id);
    renderStats();
  });
  ui.renderConsistency(sessionManager.attempts.at(-1) ?? null);
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) {
    ui.setWakeLockWarning(true);
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    ui.setWakeLockWarning(false);
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      // The OS/browser can revoke this for reasons outside our control
      // (backgrounding, battery saver, etc.) — silently try to win it back
      // if we're still supposed to be holding it. If that reacquire attempt
      // itself fails, the catch block below surfaces the warning.
      if (armed && document.visibilityState === "visible") {
        acquireWakeLock();
      }
    });
  } catch (err) {
    // Not fatal — the app still works, the screen just might sleep on its
    // own. Surface it so the user can fall back to their device's own
    // auto-lock setting instead of silently wondering why it locked.
    console.warn("Wake lock unavailable:", err);
    wakeLock = null;
    ui.setWakeLockWarning(true);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  ui.setWakeLockWarning(false);
}

document.addEventListener("visibilitychange", () => {
  if (armed && document.visibilityState === "visible" && !wakeLock) {
    acquireWakeLock();
  }
});

function frame() {
  if (!armed || !analyzer) return;

  const now = performance.now();
  const levelDb = analyzer.readLevelDb();

  // Only let quiet ("nothing playing") moments shape the floor estimate —
  // otherwise the note itself would drag its own floor upward.
  if (detector.state === DetectorState.LISTENING) {
    floorTracker.update(levelDb, now);
  }

  const { startThresholdDb, stopThresholdDb } = currentThresholds();
  detector.setThresholds({ startThresholdDb, stopThresholdDb });
  ui.setMeter(levelDb, startThresholdDb, floorTracker.floorDb);
  ui.setThresholdLabel(marginDb, startThresholdDb);

  const warmedUp = armedAt !== null && now - armedAt >= ARM_WARMUP_MS;
  if (warmedUp) {
    detector.update(levelDb, now);
  }

  if (detector.state === DetectorState.TIMING) {
    ui.setTimerMs(sustainTimer.elapsedMs(now));
    if (sustainTimer.elapsedMs(now) > MAX_NOTE_MS) {
      detector.forceStop(now);
    }
    if (lastLevelSampleAt === null || now - lastLevelSampleAt >= LEVEL_SAMPLE_INTERVAL_MS) {
      currentNoteLevels.push(Math.round(levelDb));
      lastLevelSampleAt = now;
    }

    if (practiceSwaraSemitones !== null) {
      if (lastPitchSampleAt === null || now - lastPitchSampleAt >= PITCH_SAMPLE_INTERVAL_MS) {
        lastPitchSampleAt = now;
        const pitchHz = analyzer.readPitchHz({ minHz: PITCH_MIN_HZ, maxHz: PITCH_MAX_HZ });
        if (pitchHz) {
          const cents = centsOff(pitchHz, targetFrequency(saNote, practiceSwaraSemitones));
          currentNotePitchCents.push(cents);
          ui.setLivePitch(accuracyTier(cents), cents);
        } else {
          ui.setLivePitch("none", null);
        }
      }
    }
  }

  rafHandle = requestAnimationFrame(frame);
}

async function arm() {
  ui.setError(null);
  try {
    const analyserNode = await audioInput.start();
    analyzer = new AudioAnalyzer(analyserNode);
  } catch (err) {
    ui.setError(
      err.name === "NotAllowedError"
        ? "Microphone permission denied. Allow microphone access and try again."
        : `Could not access microphone: ${err.message}`
    );
    return;
  }

  armed = true;
  detector.reset();
  sustainTimer.stop();
  armedAt = performance.now();
  floorTracker.begin(armedAt);
  ui.setArmed(true);
  ui.setState("LISTENING");
  ui.setTimerMs(0);

  await acquireWakeLock();
  rafHandle = requestAnimationFrame(frame);
}

function disarm() {
  armed = false;
  armedAt = null;
  clearTimeout(completeFlashTimeout);
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;

  audioInput.stop();
  analyzer = null;
  detector.reset();
  sustainTimer.stop();
  floorTracker.reset();
  bestAudioRecorder.abort();
  currentNotePitchCents = [];
  lastPitchSampleAt = null;
  releaseWakeLock();

  ui.setArmed(false);
  ui.setState("READY");
  ui.setTimerMs(0);
  ui.setMeter(-100, floorTracker.floorDb + marginDb, null);
}

ui.el.armButton.addEventListener("click", () => {
  if (armed) {
    disarm();
  } else {
    arm();
  }
});

ui.el.sensitivitySlider.addEventListener("input", (event) => {
  marginDb = Number(event.target.value);
  ui.setThresholdLabel(marginDb, floorTracker.floorDb + marginDb);
});

ui.el.resetButton.addEventListener("click", () => {
  sessionManager.reset();
  bestAudioRecorder.clearBest();
  ui.setBestAudio(null);
  if (practiceSwaraSemitones !== null) ui.resetPitchFeedback();
  renderStats();
});

ui.el.recordBestToggle.addEventListener("change", (event) => {
  if (event.target.checked) {
    // Revert immediately — only the explicit modal confirmation actually
    // turns this on, so a stray click never silently starts recording.
    event.target.checked = false;
    if (!BestAudioRecorder.isSupported()) {
      ui.setError("Recording isn't supported in this browser.");
      return;
    }
    ui.showRecordConsentModal();
  } else {
    bestAudioRecorder.setEnabled(false);
    ui.setBestAudio(null);
  }
});

ui.el.recordConsentCancel.addEventListener("click", () => {
  ui.hideRecordConsentModal();
  ui.setRecordToggleChecked(false);
});

ui.el.recordConsentConfirm.addEventListener("click", () => {
  bestAudioRecorder.setEnabled(true);
  ui.setRecordToggleChecked(true);
  ui.hideRecordConsentModal();
});

function updatePitchTargetDisplay() {
  if (practiceSwaraSemitones === null) return;
  const hz = targetFrequency(saNote, practiceSwaraSemitones);
  ui.setPitchTarget(`Target: ${practiceSwaraName} · ${hz.toFixed(1)} Hz`);
}

ui.el.saSelect.addEventListener("change", (event) => {
  saNote = event.target.value;
  updatePitchTargetDisplay();
  if (practiceSwaraSemitones !== null) ui.resetPitchFeedback();
});

ui.el.swaraButtons.addEventListener("click", (event) => {
  const button = event.target.closest(".swara-btn");
  if (!button) return;
  const key = button.dataset.swara;

  if (key === "off") {
    practiceSwaraSemitones = null;
    practiceSwaraName = null;
    ui.setSwaraSelection("off");
    ui.setPitchPracticeVisible(false);
    return;
  }

  const swara = SWARAS.find((s) => s.semitones === Number(key));
  practiceSwaraSemitones = swara.semitones;
  practiceSwaraName = swara.name;
  currentNotePitchCents = [];
  ui.setSwaraSelection(key);
  ui.setPitchPracticeVisible(true);
  updatePitchTargetDisplay();
  ui.resetPitchFeedback();
});

// Initial paint.
ui.setThresholdLabel(marginDb, floorTracker.floorDb + marginDb);
ui.setState("READY");
ui.setArmed(false);
ui.setMeter(-100, floorTracker.floorDb + marginDb, null);
renderStats();

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  ui.setError("This browser doesn't support microphone access (getUserMedia).");
  ui.el.armButton.disabled = true;
}
