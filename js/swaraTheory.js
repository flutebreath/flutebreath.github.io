// Maps Indian classical swaras (Sa Re Ga Ma Pa Dha Ni) to target
// frequencies relative to a user-chosen Sa (tonic), and scores how close a
// detected pitch is to that target.
//
// Sa is not a fixed pitch in Indian classical music — it's whatever tonic
// the performer sets for that session, matched to their voice or
// instrument. So there's no single "correct" frequency for Sa; the user
// picks a pitch class (e.g. "C", "D") and everything else is computed as a
// ratio from there.
//
// This uses standard 12-tone equal temperament, the same approximation
// virtually every digital tanpura/riyaz tool uses. Indian classical
// intonation has finer (shruti) nuance a performer adjusts contextually —
// this app doesn't attempt that; it's a practical practice aid, not a
// microtonal reference.

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Semitone offsets from Sa for the seven natural (shuddha) swaras.
export const SWARAS = [
  { name: "Sa", semitones: 0 },
  { name: "Re", semitones: 2 },
  { name: "Ga", semitones: 4 },
  { name: "Ma", semitones: 5 },
  { name: "Pa", semitones: 7 },
  { name: "Dha", semitones: 9 },
  { name: "Ni", semitones: 11 },
];

const A4_HZ = 440;
const A4_INDEX = NOTE_NAMES.indexOf("A");

// The absolute frequency for a pitch class, in whatever octave lands
// nearest A4 — only the pitch class matters for this app (see centsOff),
// so the specific octave chosen here is just an implementation detail.
export function noteFrequency(noteName) {
  const index = NOTE_NAMES.indexOf(noteName);
  return A4_HZ * Math.pow(2, (index - A4_INDEX) / 12);
}

export function targetFrequency(saNoteName, swaraSemitones) {
  return noteFrequency(saNoteName) * Math.pow(2, swaraSemitones / 12);
}

// How far detectedHz is from the nearest octave of targetHz, in cents
// (1/100 of a semitone). Octave-independent on purpose: a player may
// naturally play a swara an octave up or down from wherever Sa was set,
// and that's still the right note, not a wrong one.
export function centsOff(detectedHz, targetHz) {
  const rawCents = 1200 * Math.log2(detectedHz / targetHz);
  let wrapped = ((rawCents % 1200) + 1200) % 1200;
  if (wrapped > 600) wrapped -= 1200;
  return wrapped;
}

// Finds which of the seven swaras (relative to the given Sa) a detected
// pitch is closest to — for "what note did I just play" identification when
// there's no pre-chosen target, as opposed to centsOff/accuracyTier which
// score a single already-known target.
export function identifySwara(detectedHz, saNoteName) {
  let best = null;
  for (const swara of SWARAS) {
    const cents = centsOff(detectedHz, targetFrequency(saNoteName, swara.semitones));
    if (best === null || Math.abs(cents) < Math.abs(best.cents)) {
      best = { swara, cents };
    }
  }
  return best;
}

// Tolerance bands, in cents. ±15 is a typical "in tune" window for a
// practice tool (stricter tuners use less, but mic/pitch-detection noise
// makes that impractical here); beyond ±40 reads as a clearly different pitch.
export function accuracyTier(cents) {
  const abs = Math.abs(cents);
  if (abs <= 15) return "green";
  if (abs <= 40) return "yellow";
  return "red";
}
