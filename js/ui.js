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

  renderHistory(attempts, bestMs) {
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
        li.innerHTML = `<span>Attempt ${attemptNumber}</span><span>${formatDuration(attempt.durationMs)} s</span>`;
        list.appendChild(li);
      });
  }
}
