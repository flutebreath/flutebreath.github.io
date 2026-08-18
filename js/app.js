import { AudioInput } from "./audioInput.js";
import { AudioAnalyzer } from "./audioAnalyzer.js";
import { SoundDetector, DetectorState } from "./soundDetector.js";
import { SustainTimer } from "./sustainTimer.js";
import { SessionManager } from "./sessionManager.js";
import { NoiseFloorTracker } from "./noiseFloor.js";
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

const ui = new UI();
const sessionManager = new SessionManager();
const sustainTimer = new SustainTimer();
const audioInput = new AudioInput();
const floorTracker = new NoiseFloorTracker();

let analyzer = null;
let armed = false;
let rafHandle = null;
let wakeLock = null;
let completeFlashTimeout = null;
let armedAt = null;

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
    ui.setState("TIMING");
  },
  onStop: (startedAt, now, durationMs) => {
    sustainTimer.stop(now);
    sessionManager.addAttempt(durationMs);
    ui.setTimerMs(durationMs);
    ui.setState("COMPLETE");
    renderStats();

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
  ui.renderHistory(sessionManager.attempts, sessionManager.bestMs());
}

async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch (err) {
    // Not fatal — screen may just dim during long practice sessions on
    // browsers/devices that don't support or allow this.
    console.warn("Wake lock unavailable:", err);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
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
  releaseWakeLock();

  ui.setArmed(false);
  ui.setState("READY");
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
  renderStats();
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
