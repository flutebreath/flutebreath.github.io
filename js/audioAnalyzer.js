import { detectPitchHz } from "./pitchDetector.js";

// Turns raw AnalyserNode samples into a single loudness reading (dBFS) per frame.
export class AudioAnalyzer {
  constructor(analyser) {
    this.analyser = analyser;
    this.buffer = new Float32Array(analyser.fftSize);
    this.pitchBuffer = new Float32Array(analyser.fftSize);
  }

  // Returns the RMS loudness of the current buffer in dBFS.
  // Silence maps to -100 (a practical floor, not true -Infinity).
  readLevelDb() {
    this.analyser.getFloatTimeDomainData(this.buffer);

    let sumSquares = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const sample = this.buffer[i];
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / this.buffer.length);

    if (rms <= 0.00001) return -100;
    return 20 * Math.log10(rms);
  }

  // Returns the detected fundamental frequency in Hz, or null if no
  // confident pitch is present (silence, noise, breath attack transients).
  readPitchHz(options) {
    this.analyser.getFloatTimeDomainData(this.pitchBuffer);
    return detectPitchHz(this.pitchBuffer, this.analyser.context.sampleRate, options);
  }
}
