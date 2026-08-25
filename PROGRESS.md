# Progress log

Internal development log for Flute Breath Timer — what's shipped, known
limitations, open questions, and what's still on the roadmap. This is for
keeping track across sessions; user-facing feature docs live in
[README.md](README.md).

**Live site**: https://flutebreath.github.io/
**Repos** (both get pushed on every change): `origin` →
github.com/hacback17/Flute-Breath-Timer, `flutebreath` →
github.com/flutebreath/flutebreath.github.io (the one that's actually live).
GitHub Pages here has a known failure mode — a deployment can get stuck
"in progress" and block all future deploys. Fix: Settings → Environments →
delete `github-pages` → redo Settings → Pages source. Already hit and
resolved once.

The browser caches this site's files aggressively (no cache-control
headers on plain GitHub Pages) — always mention a hard refresh when
verifying a fix, and when testing locally with `python3 -m http.server`,
use a fresh port per test rather than trusting a reload, or you'll debug
against stale JS.

Note: not everything in git history came from a Claude session — the user
has made direct commits too (e.g. `6f7e002`, `0b55292`, footer wording).
Check `git log` rather than assuming this file's history is complete.

## Shipped

**V1 MVP** — amplitude-based sustain timer. State machine
(READY/LISTENING/TIMING) with hysteresis start/stop detection, sensitivity
slider, attempt history, best/average stats.

**Adaptive noise floor** — thresholds float a margin above a continuously
measured ambient floor instead of a fixed absolute dB guess, so the app
works across rooms/devices without manual tuning. Plus a 600ms arm
warm-up (ignores mic-connect pop) and a 30s max-note safety net.

**Persistence** — attempt history survives reload via `localStorage`,
with per-attempt delete and full session reset.

**Branding** — renamed Flute Sustain Timer → Flute Breath Timer (to match
the `flutebreath.github.io.io` repo name), favicon + iOS home-screen icon,
footer credit/Instagram link, SEO metadata + visible FAQ with matching
JSON-LD structured data.

**Blow consistency** — per-attempt bar graph of loudness through a note
(bigger stdDev = more "wavering"). Tried a separate session-wide trend
chart first; replaced it with a compact waveform inline in each Attempt
History row instead, since the abstracted 0-100 score compressed real
differences into similar-looking bars and lost the actual note shape.

**Opt-in best-attempt audio recording** — off by default, gated behind an
explicit consent modal. Records only the current longest attempt via
`MediaRecorder`, replaces itself when beaten, session-only (never
persisted, never uploaded). Download link once a clip exists.

**Bug fixes**:
- Note could hang open forever if ambient noise rose *during* a long note
  (the room can only be re-measured while LISTENING, so the stop threshold
  went stale). Fixed with a second, independent stop condition: a big
  enough drop below *that note's own peak* counts as stopped too,
  regardless of the absolute threshold.
- Every recorded duration was silently inflated by up to ~250ms — the
  start/stop confirmation windows (there to filter out blips) were being
  included in the measured time instead of just used to decide whether to
  trust the transition. Now both timestamps backdate to the actual
  crossing point.
- Screen wake lock failed completely silently. Now shows a visible
  fallback hint (adjust device Auto-Lock manually) when unsupported/denied,
  and actively tries to reacquire if unexpectedly released while still
  armed.

**Swara pitch-accuracy practice mode** — real pitch detection
(autocorrelation-based fundamental frequency, `js/pitchDetector.js`), a
Sa/swara selector (`js/swaraTheory.js`, standard 12-TET, octave-independent
comparison since Sa is a movable tonic not a fixed pitch), and live
green/yellow/red feedback with cents sharp/flat while playing, freezing on
the note's average when it ends. This is genuinely new — the app had no
pitch awareness before, only loudness. Caught and fixed a classic
autocorrelation octave-error bug during development (naive global-max peak
picking locks onto the wrong octave for pure/near-pure tones); fixed by
taking the first sufficiently strong peak from short lags upward instead.
Verified against synthetic sine/harmonic waveforms and a full mocked-audio
run through the real app before shipping.

**Pitch display smoothing** (`js/pitchHold.js`) — the live swara badge had
no debouncing, so isolated dropouts (breath noise, natural
micro-fluctuations — reported by the user on a real bansuri) flickered it
between a reading and "no pitch detected" throughout an otherwise solid
note. Holds the last confident reading for a 300ms grace period before
actually switching, same asymmetric-hysteresis idea as start/stop
detection. Verified with a mocked source that swaps tone/white-noise at
matching loudness (isolating pitch-display behavior from amplitude
detection): a 150ms dropout now holds with zero flicker, a 500ms one still
correctly resolves to "no pitch."

## Known limitations (already stated to the user, worth remembering)

- Swara tuning is standard 12-tone equal temperament, **not** microtonal
  shruti precision. A well-played note on some bansuris — especially
  handmade/traditionally-tuned ones — may genuinely read a nonzero cents
  deviation even when played "correctly" by ear, because the instrument's
  actual hole placement doesn't target strict 12-TET for every note.
- Wake Lock API needs iOS Safari 16.4+; unsupported on older iOS or on
  browsers without the API at all (e.g. much of Firefox's history).
- `MediaRecorder` output format differs by browser (webm/opus on
  Chrome/Android, mp4/aac on Safari) — handled via `MIME_CANDIDATES`
  fallback list, but not exhaustively tested across real devices.
- Sound detection is amplitude-only for start/stop (pitch detection exists
  now for the swara feature but doesn't gate start/stop) — a sufficiently
  loud voice or other noise can still trigger the timer.

## Open questions / needs diagnosis

- **Swara "Ma" reading "Off pitch" (77¢ sharp) for a beginner bansuri
  player, Sa=C.** Not yet determined whether this is (a) genuine beginner
  embouchure/breath-pressure sharpening — very common and expected on any
  edge-tone flute, nothing to fix — (b) this specific bansuri's Ma hole
  genuinely sitting ~77¢ from strict 12-TET even when well played, or (c) an
  actual bug (wrong Sa reference, detection glitch). Suggested next step:
  have the user play Sa itself (fewest fingers, most stable note on any
  bansuri) with the Sa button selected and compare — if Sa reads clean,
  the app's reference/detection is very likely fine and the Ma reading is
  either genuine beginner variance or an instrument characteristic, not a
  software bug. Don't change tolerance thresholds or detection logic based
  on this single data point without that comparison. (A separate, related
  bug — the live badge flickering between a reading and "no pitch" — was
  found and fixed in the meantime; that's a display-stability fix, not an
  answer to whether the 77¢ reading itself was accurate. Still waiting on
  the Sa comparison.)

## Roadmap (discussed but not built)

- Calibration wizard (measure background noise + a sample note, suggest a
  threshold) — partly superseded by the continuous adaptive floor.
- Daily/weekly progress tracking across sessions (personal best trend,
  7-day average) on top of the persisted attempt list already in place.
- Microphone selection when multiple inputs are available.
- Practice modes beyond plain sustain (breath phrasing, repeated notes,
  challenge mode with a target duration).
- PWA install support (manifest + service worker) for a more native feel.
- Persisting Sa/swara selection across reloads (currently resets each
  page load — minor, mentioned once, not requested since).
- Surfacing per-attempt pitch accuracy in the Attempt History list itself
  (the data is already stored per attempt — `pitchCents`/`targetSwara` on
  each attempt object — just not rendered there yet), mirroring how blow
  consistency got its own history-row treatment.
- Pitch-gated start/stop detection (currently amplitude-only) — would let
  the swara mode also ignore a loud wrong note, not just flag it as red.
