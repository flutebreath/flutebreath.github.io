import { AudioInput } from "./audioInput.js";
import { AudioAnalyzer } from "./audioAnalyzer.js";
import { SoundDetector, DetectorState } from "./soundDetector.js";
import { SustainTimer } from "./sustainTimer.js";
import { SessionManager } from "./sessionManager.js";
import { NoiseFloorTracker } from "./noiseFloor.js";
import { BestAudioRecorder } from "./bestAudioRecorder.js";
import { SWARAS, targetFrequency, centsOff, accuracyTier } from "./swaraTheory.js";
import { PitchHoldTracker } from "./pitchHold.js";
import { SequenceLibrary } from "./sequenceLibrary.js";
import { UI } from "./ui.js";

const STOP_MARGIN_GAP_DB = 6; // stop threshold sits this many dB below the start threshold's margin
const START_CONFIRM_MS = 80;
const STOP_CONFIRM_MS = 250;
const COMPLETE_FLASH_MS = 900;
// How long to show a just-finished sequence note's ✓/✗ before either
// advancing is instant (no flash needed) or, on a wrong note / a full
// completed pass, resetting back to the start of the phrase.
const SEQUENCE_RESET_FLASH_MS = 900;
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
const pitchHoldTracker = new PitchHoldTracker();
const sequenceLibrary = new SequenceLibrary();

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

// Sequence (sargam phrase) practice. activeSequence set means it takes
// priority over single-swara practice — the two are mutually exclusive.
// The phrase must be played correctly in order, in one go: a wrong note
// resets back to the first note rather than skipping ahead, same as a
// completed pass loops back to practice again.
let activeSequence = null;
let sequencePosition = 0;
let sequenceRepResults = []; // per-position final tier string or null, current rep
let sequenceAggregate = []; // per-position {green,yellow,red,none} counts, this armed session
let sequenceResetTimeout = null;

// Sequences tab: the phrase currently being assembled before saving.
let builderSemitones = [];

// The semitone offset the player is expected to hit right now, whichever
// practice mode (if any) is active.
function currentTargetSemitones() {
  if (activeSequence) return activeSequence.swaraSemitones[sequencePosition];
  return practiceSwaraSemitones;
}

function isPracticeActive() {
  return activeSequence !== null || practiceSwaraSemitones !== null;
}

// Rewinds to the first note without touching the aggregate — used both
// when a wrong note ends the attempt and when a full pass completes.
function resetSequenceRep() {
  if (!activeSequence) return;
  sequencePosition = 0;
  sequenceRepResults = new Array(activeSequence.swaraSemitones.length).fill(null);
}

function resetSequenceProgress() {
  if (!activeSequence) return;
  clearTimeout(sequenceResetTimeout);
  resetSequenceRep();
  sequenceAggregate = activeSequence.swaraSemitones.map(() => ({ green: 0, yellow: 0, red: 0, none: 0 }));
}

function renderSequenceUI() {
  if (!activeSequence) return;
  ui.renderSequenceRow(activeSequence.swaraSemitones, sequenceRepResults, sequencePosition);
  ui.setSequenceSummary(sequenceSummaryText());
}

function sequenceSummaryText() {
  if (!activeSequence) return "";
  let worstIndex = -1;
  let worstMisses = -1;
  let worstTotal = 0;
  sequenceAggregate.forEach((counts, i) => {
    const total = counts.green + counts.yellow + counts.red + counts.none;
    if (total === 0) return;
    const misses = total - counts.green;
    if (misses > worstMisses) {
      worstMisses = misses;
      worstIndex = i;
      worstTotal = total;
    }
  });
  if (worstIndex === -1) return "Play through the phrase to see where to focus.";
  if (worstMisses === 0) return "Every note has landed in tune so far — nice.";
  const name = activeSequence.swaraSemitones
    .map((s) => SWARAS.find((sw) => sw.semitones === s)?.name)
    .filter((_, i) => i === worstIndex)[0];
  return `Focus on "${name}" — off pitch ${worstMisses} of ${worstTotal} times so far.`;
}

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
    pitchHoldTracker.reset();
    bestAudioRecorder.startRecording(audioInput.getStream());
    ui.setState("TIMING");
  },
  onStop: (startedAt, now, durationMs) => {
    sustainTimer.stop(now);

    const practiceActive = isPracticeActive();
    const targetSemitones = currentTargetSemitones();
    const targetName = SWARAS.find((s) => s.semitones === targetSemitones)?.name ?? null;
    sessionManager.addAttempt(durationMs, currentNoteLevels, {
      pitchCents: practiceActive ? currentNotePitchCents : null,
      targetSwara: practiceActive ? targetName : null,
    });
    currentNoteLevels = [];

    if (practiceActive) {
      const hasPitch = currentNotePitchCents.length > 0;
      const avgCents = hasPitch
        ? currentNotePitchCents.reduce((sum, c) => sum + c, 0) / currentNotePitchCents.length
        : null;
      const tier = hasPitch ? accuracyTier(avgCents) : "none";

      if (activeSequence) {
        const passed = tier !== "red" && tier !== "none";
        sequenceRepResults[sequencePosition] = tier;
        sequenceAggregate[sequencePosition][tier] += 1;

        if (!passed) {
          // Wrong note — show the ✗ briefly, then restart the phrase from
          // the beginning rather than skipping ahead as if it succeeded.
          renderSequenceUI();
          clearTimeout(sequenceResetTimeout);
          sequenceResetTimeout = setTimeout(() => {
            resetSequenceRep();
            renderSequenceUI();
          }, SEQUENCE_RESET_FLASH_MS);
        } else {
          sequencePosition += 1;
          if (sequencePosition >= activeSequence.swaraSemitones.length) {
            // Full correct pass through the phrase — show the final ✓
            // briefly, then loop back to the start for another rep.
            renderSequenceUI();
            clearTimeout(sequenceResetTimeout);
            sequenceResetTimeout = setTimeout(() => {
              resetSequenceRep();
              renderSequenceUI();
            }, SEQUENCE_RESET_FLASH_MS);
          } else {
            renderSequenceUI();
          }
        }
      } else {
        ui.setLivePitch(tier, avgCents);
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

    if (isPracticeActive()) {
      if (lastPitchSampleAt === null || now - lastPitchSampleAt >= PITCH_SAMPLE_INTERVAL_MS) {
        lastPitchSampleAt = now;
        const pitchHz = analyzer.readPitchHz({ minHz: PITCH_MIN_HZ, maxHz: PITCH_MAX_HZ });
        if (pitchHz) {
          pitchHoldTracker.markHit(now);
          const cents = centsOff(pitchHz, targetFrequency(saNote, currentTargetSemitones()));
          currentNotePitchCents.push(cents);
          const tier = accuracyTier(cents);
          if (activeSequence) ui.setSequenceLiveTier(sequencePosition, tier);
          else ui.setLivePitch(tier, cents);
        } else if (pitchHoldTracker.shouldShowNoPitch(now)) {
          // Only actually switch the display once dropouts have persisted
          // past the hold window — a single missed frame mid-note is
          // normal and shouldn't visibly flicker the badge.
          if (activeSequence) ui.setSequenceLiveTier(sequencePosition, "none");
          else ui.setLivePitch("none", null);
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
  clearTimeout(sequenceResetTimeout);
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
  pitchHoldTracker.reset();
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
  if (activeSequence) {
    resetSequenceProgress();
    renderSequenceUI();
  }
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

// --- Sequences tab: builder ---

function renderBuilder() {
  ui.renderBuilder(builderSemitones, (index) => {
    builderSemitones.splice(index, 1);
    renderBuilder();
  });
}

ui.el.builderButtons.addEventListener("click", (event) => {
  const button = event.target.closest(".swara-btn");
  if (!button) return;
  builderSemitones.push(Number(button.dataset.swara));
  renderBuilder();
});

ui.el.builderUndoBtn.addEventListener("click", () => {
  builderSemitones.pop();
  renderBuilder();
});

ui.el.builderClearBtn.addEventListener("click", () => {
  builderSemitones = [];
  renderBuilder();
});

ui.el.saveSequenceBtn.addEventListener("click", () => {
  if (builderSemitones.length === 0) return;
  const typedName = ui.el.sequenceNameInput.value.trim();
  const defaultName = builderSemitones.map((s) => SWARAS.find((sw) => sw.semitones === s)?.name).join(" ");
  sequenceLibrary.add(typedName || defaultName, builderSemitones);
  builderSemitones = [];
  renderBuilder();
  ui.clearSequenceNameInput();
  renderSequenceLibrary();
});

// --- Sequences tab: saved library ---

function renderSequenceLibrary() {
  ui.renderSequenceLibrary(
    sequenceLibrary.sequences,
    (id) => startSequencePractice(id),
    (id) => {
      sequenceLibrary.remove(id);
      if (activeSequence?.id === id) exitSequencePractice();
      renderSequenceLibrary();
    }
  );
}

function startSequencePractice(id) {
  const sequence = sequenceLibrary.sequences.find((s) => s.id === id);
  if (!sequence) return;

  practiceSwaraSemitones = null;
  practiceSwaraName = null;
  ui.setSwaraSelection("off");
  ui.setPitchPracticeVisible(false);
  ui.setSwaraPanelVisible(false);

  activeSequence = sequence;
  resetSequenceProgress();
  ui.setSequencePracticeName(sequence.name);
  ui.setSequencePracticeVisible(true);
  renderSequenceUI();

  ui.setActiveTab("practice");
}

function exitSequencePractice() {
  clearTimeout(sequenceResetTimeout);
  activeSequence = null;
  sequencePosition = 0;
  sequenceRepResults = [];
  sequenceAggregate = [];
  ui.setSequencePracticeVisible(false);
  ui.setSwaraPanelVisible(true);
}

ui.el.sequenceExitBtn.addEventListener("click", () => {
  exitSequencePractice();
});

ui.el.tabBar.addEventListener("click", (event) => {
  const button = event.target.closest(".tab-btn");
  if (!button) return;
  ui.setActiveTab(button.dataset.tab);
});

// Initial paint.
ui.setActiveTab("practice");
ui.setSwaraPanelVisible(true);
ui.setSequencePracticeVisible(false);
ui.setThresholdLabel(marginDb, floorTracker.floorDb + marginDb);
ui.setState("READY");
ui.setArmed(false);
ui.setMeter(-100, floorTracker.floorDb + marginDb, null);
renderStats();
renderBuilder();
renderSequenceLibrary();

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  ui.setError("This browser doesn't support microphone access (getUserMedia).");
  ui.el.armButton.disabled = true;
}
