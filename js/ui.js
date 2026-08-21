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
const CONSISTENCY_BAR_MIN_H = 4;
const CONSISTENCY_BAR_GAP = 1.5;
// How many recent attempts the trend graph shows — keeps bars legible
// instead of shrinking to nothing over a long practice history.
const TREND_WINDOW = 30;
// Maps stdDev (dB) to a 0-100 score for the trend graph, where higher is
// steadier. Chosen so the range we've actually observed in testing
// (~0dB rock-steady to ~10-11dB deliberately wavering) spans roughly 0-100.
const TREND_SCORE_PER_DB = 8;

function levelsStdDev(levels) {
  const mean = levels.reduce((sum, v) => sum + v, 0) / levels.length;
  const variance = levels.reduce((sum, v) => sum + (v - mean) ** 2, 0) / levels.length;
  return Math.sqrt(variance);
}

function steadinessScore(stdDev) {
  return Math.max(0, Math.min(100, Math.round(100 - stdDev * TREND_SCORE_PER_DB)));
}

// stdDev of raw dB samples within one note — real dB units, so these
// thresholds are physically meaningful rather than arbitrary percentages.
function consistencyLabel(stdDev) {
  if (stdDev <= 1.2) return "Very steady";
  if (stdDev <= 2.5) return "Steady";
  if (stdDev <= 4.5) return "Some variation";
  return "Wavering";
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
      consistencyTrendTag: document.getElementById("consistencyTrendTag"),
      consistencyTrendGraph: document.getElementById("consistencyTrendGraph"),
      consistencyTrendEmpty: document.getElementById("consistencyTrendEmpty"),
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
        label.textContent = `Attempt ${attemptNumber}`;

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
        li.appendChild(right);
        list.appendChild(li);
      });
  }

  // attempt: the most recent attempt, or null. Draws a bar graph of loudness
  // through that one note — even bars mean a steady blow, jagged ones don't.
  renderConsistency(attempt) {
    const svg = this.el.consistencyGraph;
    const levels = attempt?.levels ?? [];

    if (levels.length < 2) {
      svg.setAttribute("hidden", "");
      svg.innerHTML = "";
      this.el.consistencyEmpty.hidden = false;
      this.el.consistencyTag.textContent = "—";
      return;
    }

    this.el.consistencyEmpty.hidden = true;
    svg.removeAttribute("hidden");

    const stdDev = levelsStdDev(levels);
    this.el.consistencyTag.textContent = `${consistencyLabel(stdDev)} (±${stdDev.toFixed(1)} dB)`;

    const min = Math.min(...levels);
    const max = Math.max(...levels);
    const range = Math.max(max - min, 1);

    svg.innerHTML = "";
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
  }

  // attempts: the full session, chronological (oldest first). Shows one bar
  // per recent attempt so progress reads left-to-right, taller = steadier.
  // Attempts recorded before this feature existed have no levels data —
  // those render as short muted bars rather than being mistaken for a bad score.
  renderConsistencyTrend(attempts) {
    const svg = this.el.consistencyTrendGraph;
    const windowed = attempts.slice(-TREND_WINDOW);
    const scored = windowed.map((a) => (a.levels && a.levels.length >= 2 ? steadinessScore(levelsStdDev(a.levels)) : null));

    if (windowed.length < 2 || scored.every((s) => s === null)) {
      svg.setAttribute("hidden", "");
      svg.innerHTML = "";
      this.el.consistencyTrendEmpty.hidden = false;
      this.el.consistencyTrendTag.textContent = "—";
      return;
    }

    this.el.consistencyTrendEmpty.hidden = true;
    svg.removeAttribute("hidden");

    const withData = scored.filter((s) => s !== null);
    const avgScore = Math.round(withData.reduce((sum, s) => sum + s, 0) / withData.length);
    this.el.consistencyTrendTag.textContent = `Avg ${avgScore}/100`;

    svg.innerHTML = "";
    const barWidth = CONSISTENCY_VIEWBOX_W / scored.length;
    scored.forEach((score, i) => {
      const hasData = score !== null;
      const barHeight = hasData
        ? CONSISTENCY_BAR_MIN_H + (score / 100) * (CONSISTENCY_VIEWBOX_H - CONSISTENCY_BAR_MIN_H)
        : CONSISTENCY_BAR_MIN_H;
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", (i * barWidth + CONSISTENCY_BAR_GAP / 2).toFixed(2));
      rect.setAttribute("y", (CONSISTENCY_VIEWBOX_H - barHeight).toFixed(2));
      rect.setAttribute("width", Math.max(barWidth - CONSISTENCY_BAR_GAP, 0.5).toFixed(2));
      rect.setAttribute("height", barHeight.toFixed(2));
      rect.setAttribute("rx", "1");
      if (!hasData) rect.classList.add("no-data");
      svg.appendChild(rect);
    });
  }
}
