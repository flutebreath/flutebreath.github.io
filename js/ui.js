import { formatDuration } from "./sustainTimer.js";

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
    };
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
}
