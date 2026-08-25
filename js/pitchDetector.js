// Finds the fundamental frequency of a monophonic tone (a single flute note,
// not a chord) from a time-domain audio buffer, using normalized
// autocorrelation with parabolic interpolation for sub-sample precision.
//
// This is independent of the amplitude-based start/stop detection in
// soundDetector.js — it only answers "what pitch is this," not "is a note
// playing." It's deliberately a plain function over a buffer, not a class,
// since it has no state of its own between calls.

const MIN_RMS = 0.01; // below this, treat the buffer as silence/noise, don't even try
const MIN_CONFIDENCE = 0.85; // normalized autocorrelation peak height required to trust the result

function rms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

// buffer: Float32Array of time-domain samples. sampleRate: from the
// AudioContext. minHz/maxHz bound the search to the instrument's realistic
// range, which keeps this cheap (only that many lags get checked) and
// avoids octave-confusable results outside it.
export function detectPitchHz(buffer, sampleRate, { minHz = 100, maxHz = 2000 } = {}) {
  if (rms(buffer) < MIN_RMS) return null;

  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.min(Math.ceil(sampleRate / minHz), buffer.length - 1);
  if (minLag >= maxLag) return null;

  const corrAtLag = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sumProduct = 0;
    let sumSqA = 0;
    let sumSqB = 0;
    const limit = buffer.length - lag;
    for (let i = 0; i < limit; i++) {
      const a = buffer[i];
      const b = buffer[i + lag];
      sumProduct += a * b;
      sumSqA += a * a;
      sumSqB += b * b;
    }
    const denom = Math.sqrt(sumSqA * sumSqB);
    corrAtLag[lag] = denom > 0 ? sumProduct / denom : 0;
  }

  // Take the FIRST local peak strong enough to trust, scanning from short
  // lags (high frequency) upward — not the strongest peak overall. A pure
  // or near-pure tone correlates just as well (sometimes better, due to
  // windowing) at exact multiples of its true period, so grabbing the
  // global max tends to lock onto a lower octave than what's actually
  // playing. The true fundamental's peak is normally the first one that
  // clears the confidence bar.
  let bestLag = -1;
  let bestCorr = -Infinity;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    const isLocalPeak = corrAtLag[lag] >= corrAtLag[lag - 1] && corrAtLag[lag] >= corrAtLag[lag + 1];
    if (isLocalPeak && corrAtLag[lag] >= MIN_CONFIDENCE) {
      bestLag = lag;
      bestCorr = corrAtLag[lag];
      break;
    }
  }

  if (bestLag < 0 || bestCorr < MIN_CONFIDENCE) return null;

  // Parabolic interpolation around the peak for sub-sample lag precision —
  // without this, frequency resolution is limited to sampleRate/lag steps,
  // which is coarse enough at low frequencies to matter for cents accuracy.
  let refinedLag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y1 = corrAtLag[bestLag - 1];
    const y2 = corrAtLag[bestLag];
    const y3 = corrAtLag[bestLag + 1];
    const denom = y1 - 2 * y2 + y3;
    if (denom !== 0) {
      refinedLag = bestLag + 0.5 * (y1 - y3) / denom;
    }
  }

  return sampleRate / refinedLag;
}
