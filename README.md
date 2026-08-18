# Flute Breath Timer

A browser-based, microphone-activated timer for flute players. It detects when a
flute note starts and stops, and measures the sustain duration automatically —
no need to touch the screen while you're playing.

Note: what the microphone actually measures is the duration of the audible
flute tone, not your breath itself (your breath starts before the flute
produces sound, so the mic can't capture that part) — but "breath timer"
is how the exercise is practiced and talked about, so that's the name.

## How to use it

1. Open the page.
2. Grant microphone permission when prompted.
3. Press **Start Listening**.
4. Put the phone/laptop near the flute.
5. Play a note. The timer starts automatically once the note is detected.
6. Stop playing. The timer stops automatically once the note ends.
7. The result is added to your attempt history immediately, and the app goes
   back to listening — play as many notes as you like without touching the
   screen. Press **Stop Listening** when you're done.

## How detection works

This is **not** a sound-activated stopwatch that starts on any noise. It's a
small state machine (see [`js/soundDetector.js`](js/soundDetector.js)) with
two thresholds and two confirmation windows, so short noises (talking, a fan,
a chair creak, a notification) don't start or stop the timer:

```
LISTENING
   │  level rises above START threshold
   ▼
CONFIRM_START  ── level drops back down ──▶ LISTENING (ignored as noise)
   │  level stays above START threshold for 80 ms
   ▼
TIMING  (timer running)
   │  level falls below STOP threshold (lower than START — hysteresis)
   ▼
CONFIRM_STOP  ── level recovers ──▶ TIMING (brief dip/vibrato, keep going)
   │  level stays below STOP threshold for 250 ms
   ▼
LISTENING  (attempt recorded, ready for the next note)
```

Loudness is measured as RMS amplitude of the raw microphone signal, converted
to dBFS (`js/audioAnalyzer.js`).

**Thresholds are adaptive, not fixed.** A hardcoded absolute dB value (e.g.
"start above &minus;40dB") breaks the moment the room, the device's mic gain,
or handling noise doesn't match whatever was assumed — too sensitive in a
quiet room, or so insensitive in a noisy one that a real note never
registers, or so gap-prone that silence never reads as "quiet enough" to
stop. Instead, [`js/noiseFloor.js`](js/noiseFloor.js) continuously tracks the
current ambient noise level (only while nothing is playing, so a note can't
drag its own floor upward), and both thresholds float a fixed margin above
*that*: `start = floor + margin`, `stop = floor + margin − 6dB`. The
**Sensitivity** slider controls the margin, not an absolute level. This is
what lets the app correctly recognize both "arming in a noisy room shouldn't
immediately start the timer" and "letting go of the note should register as
silence, even if the room was never truly silent to begin with."

Two more guards round out false-trigger protection:

- **Arm warm-up** — the first 600ms after pressing Start Listening is shown on the meter
  but never fed to the detector, since connecting the mic and physically
  picking up/positioning the device both tend to produce a brief loud
  transient that isn't the flute.
- **Max-duration safety net** — a note is force-stopped after 30 seconds
  regardless of the audio level, so a stuck detector can never freeze the
  timer indefinitely.

Duration is measured with `performance.now()` timestamps taken at the exact
moment the state machine confirms a start and a stop — never by incrementing
a counter on a `setInterval`. The on-screen timer updates every animation
frame purely for display; the recorded duration is always the timestamp
delta.

## Microphone permissions

The browser will prompt for microphone access the first time you press
Start Listening. If you deny it (or dismiss the prompt), the app shows an
inline error and stays in the READY state — press Start Listening again to
retry. Most browsers remember your choice for the site afterwards.

Echo cancellation, noise suppression, and auto gain control are explicitly
disabled on the microphone track (`js/audioInput.js`), since those are tuned
for voice calls and tend to suppress or distort a sustained musical tone.

## Privacy

All audio processing happens locally in your browser using the Web Audio
API. **Audio is never uploaded, recorded to disk, or sent to any server** —
there is no backend at all. Attempt history is saved to your browser's
`localStorage` (`js/sessionManager.js`) so it survives a page reload, but it
never leaves your device. Use **Reset session** to clear all of it, or the
× next to an individual attempt to remove just that one.

## Project structure

```
index.html          Markup / layout
styles.css           Mobile-first styling
js/audioInput.js      getUserMedia + AudioContext/AnalyserNode setup
js/audioAnalyzer.js   RMS → dBFS loudness calculation
js/noiseFloor.js      Adaptive ambient noise floor tracker
js/soundDetector.js   Start/stop state machine (hysteresis + confirmation)
js/sustainTimer.js    performance.now()-based duration measurement
js/sessionManager.js  Attempt history, best, average
js/ui.js              DOM rendering
js/app.js             Wires the above together, wake lock, event handlers
```

Each module is independent of the others where possible (the detector, timer,
and session manager have no DOM dependencies) so the detection algorithm can
be improved later without touching the UI.

## Running locally

No build step — it's plain HTML/CSS/JS modules. Serve the folder over HTTP
(module scripts and `getUserMedia` need a proper origin, not `file://`):

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Pages**.
3. Set the source to the branch/folder containing `index.html` (e.g. `main`,
   root).
4. Visit the published `github.io` URL. Note: `getUserMedia` requires HTTPS
   (or `localhost`) — GitHub Pages serves over HTTPS by default, so this
   works out of the box.

## Roadmap (not yet implemented)

This is v1 — deliberately minimal so the core detection + timing loop is
reliable before adding more:

- Explicit calibration wizard (walk through silence, then a sample note) —
  partly superseded by the continuous adaptive noise floor described above,
  but a one-time step could still give a better starting point than the
  600ms warm-up alone
- Daily/weekly progress tracking on top of the persisted attempt list
  already in place (e.g. "personal best," "7-day average," a trend graph)
- Microphone selection when multiple inputs are available
- Frequency-based detection (FFT tonal/pitch analysis) to reduce false
  triggers further, on top of the current amplitude-only detection
- Practice modes (breath phrasing, repeated notes, challenge mode with a
  target duration)
- PWA install support (manifest + home screen icon) for a more native feel
  on iPhone
