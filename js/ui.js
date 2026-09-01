import { formatDuration } from "./sustainTimer.js";
import { SWARAS } from "./swaraTheory.js";

function swaraNameFor(semitones) {
  return SWARAS.find((s) => s.semitones === semitones)?.name ?? "?";
}

const METER_MIN_DB = -70;
const METER_MAX_DB = -10;

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

function dbToPercent(db) {
  const range = METER_MAX_DB - METER_MIN_DB;
  return clampPercent(((db - METER_MIN_DB) / range) * 100);
}

// marginDb is dB *above the current ambient noise floor* required to count
// as a note starting — smaller margin = triggers more easily = more sensitive.
function sensitivityTag(marginDb) {
  if (marginDb <= 12) return "High";
  if (marginDb <= 18) return "Medium";
  if (marginDb <= 23) return "Medium-low";
  return "Low";
}

const SVG_NS = "http://www.w3.org/2000/svg";
const CONSISTENCY_VIEWBOX_W = 300;
const CONSISTENCY_VIEWBOX_H = 60;
// A bar for a perfectly flat (very steady) note still needs to be
// perceptible even in the small per-row graphs (22px tall), not just the
// big 70px one — 4 units of a 60-unit viewBox is under a pixel there.
const CONSISTENCY_BAR_MIN_H = 8;
const CONSISTENCY_BAR_GAP = 1.5;

function levelsStdDev(levels) {
  const mean = levels.reduce((sum, v) => sum + v, 0) / levels.length;
  const variance = levels.reduce((sum, v) => sum + (v - mean) ** 2, 0) / levels.length;
  return Math.sqrt(variance);
}

// stdDev of raw dB samples within one note — real dB units, so these
// thresholds are physically meaningful rather than arbitrary percentages.
function consistencyLabel(stdDev) {
  if (stdDev <= 1.2) return "Very steady";
  if (stdDev <= 2.5) return "Steady";
  if (stdDev <= 4.5) return "Some variation";
  return "Wavering";
}

// Draws the loudness-over-time bars into an existing (empty) <svg>, scaled
// to that note's own min/max so shape is legible regardless of absolute
// volume. Bar count == sample count, so longer notes naturally read as
// thinner, denser bars — shared by the big last-attempt graph and the
// compact per-row ones in history. Returns false (and leaves the svg empty)
// when there's not enough data to draw anything meaningful.
function buildConsistencyBars(svg, levels) {
  svg.innerHTML = "";
  if (!levels || levels.length < 2) return false;

  const min = Math.min(...levels);
  const max = Math.max(...levels);
  const range = Math.max(max - min, 1);
  const barWidth = CONSISTENCY_VIEWBOX_W / levels.length;

  levels.forEach((level, i) => {
    const normalized = (level - min) / range;
    const barHeight = CONSISTENCY_BAR_MIN_H + normalized * (CONSISTENCY_VIEWBOX_H - CONSISTENCY_BAR_MIN_H);
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", (i * barWidth + CONSISTENCY_BAR_GAP / 2).toFixed(2));
    rect.setAttribute("y", (CONSISTENCY_VIEWBOX_H - barHeight).toFixed(2));
    rect.setAttribute("width", Math.max(barWidth - CONSISTENCY_BAR_GAP, 0.5).toFixed(2));
    rect.setAttribute("height", barHeight.toFixed(2));
    rect.setAttribute("rx", "1");
    svg.appendChild(rect);
  });
  return true;
}

export class UI {
  constructor() {
    this.el = {
      stateBadge: document.getElementById("stateBadge"),
      stateLabel: document.getElementById("stateLabel"),
      timerDisplay: document.getElementById("timerDisplay"),
      errorBanner: document.getElementById("errorBanner"),
      armButton: document.getElementById("armButton"),
      meterFill: document.getElementById("meterFill"),
      meterThreshold: document.getElementById("meterThreshold"),
      meterDbLabel: document.getElementById("meterDbLabel"),
      sensitivitySlider: document.getElementById("sensitivitySlider"),
      thresholdValueLabel: document.getElementById("thresholdValueLabel"),
      sensitivityTag: document.getElementById("sensitivityTag"),
      lastStat: document.getElementById("lastStat"),
      bestStat: document.getElementById("bestStat"),
      avgStat: document.getElementById("avgStat"),
      historyList: document.getElementById("historyList"),
      resetButton: document.getElementById("resetButton"),
      consistencyTag: document.getElementById("consistencyTag"),
      consistencyGraph: document.getElementById("consistencyGraph"),
      consistencyEmpty: document.getElementById("consistencyEmpty"),
      recordBestToggle: document.getElementById("recordBestToggle"),
      bestAudioDownload: document.getElementById("bestAudioDownload"),
      recordConsentOverlay: document.getElementById("recordConsentOverlay"),
      recordConsentCancel: document.getElementById("recordConsentCancel"),
      recordConsentConfirm: document.getElementById("recordConsentConfirm"),
      wakeLockHint: document.getElementById("wakeLockHint"),
      saSelect: document.getElementById("saSelect"),
      swaraButtons: document.getElementById("swaraButtons"),
      pitchFeedback: document.getElementById("pitchFeedback"),
      pitchTarget: document.getElementById("pitchTarget"),
      pitchTierBadge: document.getElementById("pitchTierBadge"),
      pitchCentsReadout: document.getElementById("pitchCentsReadout"),
      identifyFeedback: document.getElementById("identifyFeedback"),
      identifySaLabel: document.getElementById("identifySaLabel"),
      identifyNoteBadge: document.getElementById("identifyNoteBadge"),
      identifyCentsReadout: document.getElementById("identifyCentsReadout"),
      tabBar: document.getElementById("tabBar"),
      swaraPanel: document.getElementById("swaraPanel"),
      sequencePractice: document.getElementById("sequencePractice"),
      sequencePracticeName: document.getElementById("sequencePracticeName"),
      sequenceExitBtn: document.getElementById("sequenceExitBtn"),
      sequenceRow: document.getElementById("sequenceRow"),
      sequenceSummary: document.getElementById("sequenceSummary"),
      builderRow: document.getElementById("builderRow"),
      builderEmpty: document.getElementById("builderEmpty"),
      builderButtons: document.getElementById("builderButtons"),
      builderUndoBtn: document.getElementById("builderUndoBtn"),
      builderClearBtn: document.getElementById("builderClearBtn"),
      sequenceNameInput: document.getElementById("sequenceNameInput"),
      saveSequenceBtn: document.getElementById("saveSequenceBtn"),
      sequenceLibraryList: document.getElementById("sequenceLibraryList"),
    };
  }

  setActiveTab(tabName) {
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== tabName;
    });
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.tab === tabName);
    });
  }

  setState(state) {
    this.el.stateBadge.dataset.state = state;
    const labels = {
      READY: "READY",
      LISTENING: "LISTENING…",
      TIMING: "● PLAYING",
      COMPLETE: "● COMPLETE",
    };
    this.el.stateLabel.textContent = labels[state] || state;
  }

  setTimerMs(ms) {
    this.el.timerDisplay.textContent = formatDuration(ms);
  }

  setError(message) {
    if (!message) {
      this.el.errorBanner.hidden = true;
      this.el.errorBanner.textContent = "";
      return;
    }
    this.el.errorBanner.hidden = false;
    this.el.errorBanner.textContent = message;
  }

  setArmed(armed) {
    this.el.armButton.dataset.armed = String(armed);
    this.el.armButton.textContent = armed ? "Stop Listening" : "Start Listening";
  }

  setWakeLockWarning(show) {
    this.el.wakeLockHint.hidden = !show;
  }

  setMeter(levelDb, startThresholdDb, floorDb) {
    this.el.meterFill.style.width = `${dbToPercent(levelDb)}%`;
    this.el.meterThreshold.style.left = `${dbToPercent(startThresholdDb)}%`;
    this.el.meterDbLabel.textContent =
      floorDb == null ? `${Math.round(levelDb)} dB` : `${Math.round(levelDb)} dB · room ${Math.round(floorDb)} dB`;
  }

  setThresholdLabel(marginDb, effectiveThresholdDb) {
    this.el.thresholdValueLabel.textContent =
      effectiveThresholdDb == null ? `+${marginDb} dB` : `${Math.round(effectiveThresholdDb)} dB`;
    this.el.sensitivityTag.textContent = sensitivityTag(marginDb);
  }

  renderStats({ lastMs, bestMs, avgMs }) {
    this.el.lastStat.textContent = lastMs == null ? "—" : `${formatDuration(lastMs)}s`;
    this.el.bestStat.textContent = bestMs == null ? "—" : `${formatDuration(bestMs)}s`;
    this.el.avgStat.textContent = avgMs == null ? "—" : `${formatDuration(avgMs)}s`;
  }

  renderHistory(attempts, bestMs, onDelete) {
    const list = this.el.historyList;
    list.innerHTML = "";

    if (attempts.length === 0) {
      const li = document.createElement("li");
      li.className = "history-empty";
      li.textContent = "No attempts yet";
      list.appendChild(li);
      return;
    }

    attempts
      .slice()
      .reverse()
      .forEach((attempt, idx) => {
        const attemptNumber = attempts.length - idx;
        const li = document.createElement("li");
        if (attempt.durationMs === bestMs) li.classList.add("is-best");

        const label = document.createElement("span");
        label.className = "history-label";
        label.textContent = `Attempt ${attemptNumber}`;

        const graphWrap = document.createElement("span");
        graphWrap.className = "history-graph-wrap";
        const graphSvg = document.createElementNS(SVG_NS, "svg");
        graphSvg.classList.add("consistency-graph");
        graphSvg.setAttribute("viewBox", `0 0 ${CONSISTENCY_VIEWBOX_W} ${CONSISTENCY_VIEWBOX_H}`);
        graphSvg.setAttribute("preserveAspectRatio", "none");
        buildConsistencyBars(graphSvg, attempt.levels);
        graphWrap.appendChild(graphSvg);

        const right = document.createElement("span");
        right.className = "history-right";

        const value = document.createElement("span");
        value.textContent = `${formatDuration(attempt.durationMs)} s`;

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "history-delete";
        deleteBtn.setAttribute("aria-label", `Delete attempt ${attemptNumber}`);
        deleteBtn.textContent = "×";
        deleteBtn.addEventListener("click", () => onDelete?.(attempt.id));

        right.appendChild(value);
        right.appendChild(deleteBtn);
        li.appendChild(label);
        li.appendChild(graphWrap);
        li.appendChild(right);
        list.appendChild(li);
      });
  }

  // attempt: the most recent attempt, or null. Draws a bar graph of loudness
  // through that one note — even bars mean a steady blow, jagged ones don't.
  renderConsistency(attempt) {
    const svg = this.el.consistencyGraph;
    const levels = attempt?.levels ?? [];
    const hasData = buildConsistencyBars(svg, levels);

    if (!hasData) {
      svg.setAttribute("hidden", "");
      this.el.consistencyEmpty.hidden = false;
      this.el.consistencyTag.textContent = "—";
      return;
    }

    this.el.consistencyEmpty.hidden = true;
    svg.removeAttribute("hidden");
    const stdDev = levelsStdDev(levels);
    this.el.consistencyTag.textContent = `${consistencyLabel(stdDev)} (±${stdDev.toFixed(1)} dB)`;
  }

  setRecordToggleChecked(checked) {
    this.el.recordBestToggle.checked = checked;
  }

  // info: { url, extension } from BestAudioRecorder.getDownloadInfo(), or null to hide the link.
  setBestAudio(info) {
    const link = this.el.bestAudioDownload;
    if (!info) {
      link.hidden = true;
      link.removeAttribute("href");
      link.removeAttribute("download");
      return;
    }
    link.href = info.url;
    link.setAttribute("download", `flute-breath-timer-best.${info.extension}`);
    link.hidden = false;
  }

  showRecordConsentModal() {
    this.el.recordConsentOverlay.removeAttribute("hidden");
  }

  hideRecordConsentModal() {
    this.el.recordConsentOverlay.setAttribute("hidden", "");
  }

  // swaraKey: "off" or the swara's semitone offset as a string ("0", "2", ...).
  setSwaraSelection(swaraKey) {
    this.el.swaraButtons.querySelectorAll(".swara-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.swara === swaraKey);
    });
  }

  setPitchPracticeVisible(visible) {
    this.el.pitchFeedback.hidden = !visible;
  }

  setPitchTarget(text) {
    this.el.pitchTarget.textContent = text;
  }

  // Shown while armed/listening but no note is currently being measured.
  resetPitchFeedback() {
    this.el.pitchTierBadge.dataset.tier = "none";
    this.el.pitchTierBadge.textContent = "—";
    this.el.pitchCentsReadout.textContent = "Play the note to check your pitch";
  }

  // tier: "green" | "yellow" | "red" | "none" (no confident pitch detected).
  // cents: signed deviation from target, or null when tier is "none".
  setLivePitch(tier, cents) {
    const labels = { green: "In tune", yellow: "Close", red: "Off pitch", none: "…" };
    this.el.pitchTierBadge.dataset.tier = tier;
    this.el.pitchTierBadge.textContent = labels[tier] ?? "—";

    if (cents == null) {
      this.el.pitchCentsReadout.textContent = "No clear pitch detected";
      return;
    }
    const rounded = Math.round(cents);
    if (Math.abs(rounded) < 3) {
      this.el.pitchCentsReadout.textContent = "Right on pitch";
    } else {
      this.el.pitchCentsReadout.textContent = `${Math.abs(rounded)}¢ ${rounded > 0 ? "sharp" : "flat"}`;
    }
  }

  setIdentifyPracticeVisible(visible) {
    this.el.identifyFeedback.hidden = !visible;
  }

  setIdentifySaLabel(text) {
    this.el.identifySaLabel.textContent = text;
  }

  resetIdentifyFeedback() {
    this.el.identifyNoteBadge.dataset.tier = "none";
    this.el.identifyNoteBadge.textContent = "—";
    this.el.identifyCentsReadout.textContent = "Play a note to see which swara it is";
  }

  // name: identified swara name, or null when no confident pitch is
  // detected. tier: how close the pitch sits to that identified swara (not
  // pass/fail against a fixed target — there's no "wrong" note here, this
  // just reflects how centered the identification is). cents: signed
  // deviation from the identified swara, or null.
  setIdentifiedNote(name, tier, cents) {
    if (name == null) {
      this.el.identifyNoteBadge.dataset.tier = "none";
      this.el.identifyNoteBadge.textContent = "…";
      this.el.identifyCentsReadout.textContent = "No clear pitch detected";
      return;
    }
    this.el.identifyNoteBadge.dataset.tier = tier;
    this.el.identifyNoteBadge.textContent = name;
    const rounded = Math.round(cents);
    if (Math.abs(rounded) < 3) {
      this.el.identifyCentsReadout.textContent = "Right on pitch";
    } else {
      this.el.identifyCentsReadout.textContent = `${Math.abs(rounded)}¢ ${rounded > 0 ? "sharp" : "flat"}`;
    }
  }

  setSwaraPanelVisible(visible) {
    this.el.swaraPanel.hidden = !visible;
  }

  setSequencePracticeVisible(visible) {
    this.el.sequencePractice.hidden = !visible;
  }

  setSequencePracticeName(text) {
    this.el.sequencePracticeName.textContent = text;
  }

  // swaraSemitones: the sequence's notes. repResults: array same length,
  // each entry a final tier string ("green"/"yellow"/"red"/"none") once
  // that note has been played and committed, or null while still pending.
  // currentPosition: index of the note currently up next/being played.
  renderSequenceRow(swaraSemitones, repResults, currentPosition) {
    const row = this.el.sequenceRow;
    row.innerHTML = "";
    swaraSemitones.forEach((semitones, i) => {
      const chip = document.createElement("span");
      chip.className = "sequence-chip";

      const label = document.createElement("span");
      label.textContent = swaraNameFor(semitones);
      chip.appendChild(label);

      const result = repResults[i];
      if (result) {
        const passed = result !== "red" && result !== "none";
        chip.dataset.result = passed ? "pass" : "fail";
        const mark = document.createElement("span");
        mark.className = "sequence-chip-mark";
        mark.textContent = passed ? "✓" : "✗";
        chip.appendChild(mark);
      }
      if (i === currentPosition) chip.classList.add("is-current");
      row.appendChild(chip);
    });
  }

  // Live-updates just the current position's chip color while a note is
  // still being played, without touching the rest of the row.
  setSequenceLiveTier(position, tier) {
    const chip = this.el.sequenceRow.children[position];
    if (!chip) return;
    if (tier === "none") delete chip.dataset.tier;
    else chip.dataset.tier = tier;
  }

  setSequenceSummary(text) {
    this.el.sequenceSummary.textContent = text;
  }

  // semitonesInProgress: the phrase currently being built, in order.
  renderBuilder(semitonesInProgress, onRemove) {
    const row = this.el.builderRow;
    row.innerHTML = "";

    if (semitonesInProgress.length === 0) {
      const empty = document.createElement("p");
      empty.className = "builder-empty";
      empty.id = "builderEmpty";
      empty.textContent = "Tap swaras below to build a phrase.";
      row.appendChild(empty);
      this.el.saveSequenceBtn.disabled = true;
      return;
    }

    this.el.saveSequenceBtn.disabled = false;
    semitonesInProgress.forEach((semitones, i) => {
      const chip = document.createElement("span");
      chip.className = "builder-chip";
      const label = document.createElement("span");
      label.textContent = swaraNameFor(semitones);
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "builder-chip-remove";
      removeBtn.setAttribute("aria-label", `Remove ${swaraNameFor(semitones)} at position ${i + 1}`);
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => onRemove(i));
      chip.appendChild(label);
      chip.appendChild(removeBtn);
      row.appendChild(chip);
    });
  }

  clearSequenceNameInput() {
    this.el.sequenceNameInput.value = "";
  }

  // sequences: saved list. onPractice/onDelete: (id) => void.
  renderSequenceLibrary(sequences, onPractice, onDelete) {
    const list = this.el.sequenceLibraryList;
    list.innerHTML = "";

    if (sequences.length === 0) {
      const li = document.createElement("li");
      li.className = "sequence-library-empty";
      li.textContent = "No saved sequences yet";
      list.appendChild(li);
      return;
    }

    sequences
      .slice()
      .reverse()
      .forEach((seq) => {
        const li = document.createElement("li");
        li.className = "sequence-library-item";

        const info = document.createElement("div");
        info.className = "sequence-library-info";
        const name = document.createElement("div");
        name.className = "sequence-library-name";
        name.textContent = seq.name;
        const notes = document.createElement("div");
        notes.className = "sequence-library-notes";
        notes.textContent = seq.swaraSemitones.map(swaraNameFor).join(" → ");
        info.appendChild(name);
        info.appendChild(notes);

        const practiceBtn = document.createElement("button");
        practiceBtn.type = "button";
        practiceBtn.className = "sequence-library-practice";
        practiceBtn.textContent = "Practice";
        practiceBtn.addEventListener("click", () => onPractice(seq.id));

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "sequence-library-delete";
        deleteBtn.setAttribute("aria-label", `Delete sequence ${seq.name}`);
        deleteBtn.textContent = "×";
        deleteBtn.addEventListener("click", () => onDelete(seq.id));

        li.appendChild(info);
        li.appendChild(practiceBtn);
        li.appendChild(deleteBtn);
        list.appendChild(li);
      });
  }
}
