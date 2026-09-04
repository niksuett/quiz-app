# 🎵 Name That Tune — `tune`

**Group:** classic · **Category id:** `tunes` · **Blurb:** "A chiptune melody plays. Which piece is it?"
**How to:** "Listen (tap replay if you like) and pick the title. Fastest correct answer scores most."

A short melody is played in the browser as an 8-bit style chiptune; players pick the title from four
buttons. Mechanically identical to Flags and Shape of Nations: one correct button, speed-scored.

There are **no audio files**. Every question stores its melody as a list of
`[midiNote, lengthInBeats]` pairs plus a tempo, and the client synthesises it with the Web Audio API
(one oscillator, one note at a time). That means zero download, no licensing of recordings, instant
start, and identical playback everywhere.

| Setting        | Value   |
|----------------|---------|
| `timeLimit`    | 25 s    |
| `revealPause`  | 8 s     |
| `earlyPause`   | 3500 ms |
| `speedScored`  | true    |
| `usesRegion`   | false   |

Files: `games/tune.js` (server), `content/tunes.json` (36 questions). No `data/` file and no build
script — the melodies are small enough to live in the question itself.

---

## 1. Question JSON (what `import.js` accepts)

```json
{
  "type": "tune", "category": "tunes",
  "question": "Name that tune",
  "notes": [[66,1],[66,1],[67,1],[69,1],[69,1],[67,1],[66,1],[64,1],
            [62,1],[62,1],[64,1],[66,1],[66,1.5],[64,0.5],[64,2]],
  "bpm": 120,
  "wave": "square",
  "answers": ["Ode to Joy", "Hallelujah Chorus", "Pomp and Circumstance", "Bridal Chorus"],
  "correct": 0,
  "difficulty": 1
}
```

* **`notes`** — 8–40 pairs of `[midi, beats]`.
  * `midi` — MIDI note number, integer **36–96** (C2–C7), or **`0` = a rest** (silence).
    60 is middle C; +1 is one semitone; +12 is one octave. A4 (440 Hz) is 69.
  * `beats` — length in quarter notes: `1` quarter, `0.5` eighth, `0.25` sixteenth,
    `1.5` dotted quarter, `2` half. Must be > 0 (and ≤ 16).
* **`bpm`** — quarter notes per minute, 50–220. One beat lasts `60 / bpm` seconds.
* **`wave`** — optional oscillator shape: `square` (default, classic chiptune lead), `triangle`
  (soft, flute-like), `sawtooth` (buzzy, brassy), `sine` (pure, music-box).
* **`answers` / `correct`** — the usual MC four titles and the 0–3 index of the right one.
* `region` is not used for this type. `difficulty` 1 (everyone knows it) – 3 (expert).

`validate()` checks the MC rules, the note-list rules above, the bpm range and the wave name.

DB row: `correct = "0"`, `extra = { answers, notes, bpm, wave, difficulty? }`.

Helper for tools/tests: `require('./games/tune')._durationSec(notes, bpm)` → playing time in
seconds. Keep tunes roughly 3–15 s (the current set averages 7.2 s) so a player can hear the whole
melody twice inside the 25 s timer.

---

## 2. Payload (sent to every client at question start)

```js
{
  prompt: "Name that tune",
  notes:  [[66,1],[66,1],[67,1], …],
  bpm:    120,
  wave:   "square",
  answers: ["Ode to Joy", "Hallelujah Chorus", "Pomp and Circumstance", "Bridal Chorus"]
}
```

No `correct`, no title field — the answer is simply one of the four options, exactly as in any
multiple-choice question. Payload size: < 1 KB.

## 3. Answer (client → server)

```js
{ index: 0 }          // integer 0–3, the tapped button
```

Anything else (missing, non-integer, out of range) is rejected → `answer-rejected`.

## 4. Result (sent back to the answering player only)

```js
{
  isCorrect: true,
  correctIndex: 0,
  correctText: "Ode to Joy",
  yourText: "Ode to Joy"
}
```
The core adds `type`, `quality` (1 or null), `elapsed`, `soundCorrect`.

## 5. Detail (stored per player, shown on leaderboard rows)

```js
{ isCorrect: true, index: 0, answerText: "Ode to Joy" }
```
`metric(detail)` → `"✓ Ode to Joy"` / `"✗ Bridal Chorus"` (same as Flags).

## 6. Reveal (sent to everyone with the leaderboard)

```js
{
  answers: ["Ode to Joy", "Hallelujah Chorus", "Pomp and Circumstance", "Bridal Chorus"],
  correctIndex: 0,
  counts:   [2, 1, 0, 0],                      // how many players picked each option
  pickedBy: [["Ana", "Ben"], ["Cleo"], [], []],
  notes: [[66,1], …], bpm: 120, wave: "square" // so the reveal can replay the tune
}
```
`correctText` on the leaderboard banner = the correct title.

---

## 7. Scoring

Speed-scored MC (core, `scoring.js`):

* wrong / no answer → `quality = null` → 0 points, streak broken
* correct → `quality = 1` → accuracy points `round(100 × (0.5 + 0.5 × max(0, 1 − elapsed / 25)))`
  (instant ≈ 100, at the buzzer ≈ 50)
* rank bonus among correct players by speed: +50 / +30 / +15
* streak +20 from the 3rd good answer in a row; final round ×2 if the host enabled it

Sample answer for `test/simulate.js`: `{ index: random 0–3 }`.

---

## 8. Client module guidance — `public/games/tune.js`

### 8.1 Playing a melody with Web Audio

One shared `AudioContext` per page, one `OscillatorNode` per note, scheduled ahead of time so the
rhythm is sample-accurate (never use `setTimeout` per note — it jitters).

```js
const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);

function playMelody(ctx, { notes, bpm, wave }, onDone) {
  const spb = 60 / bpm;                 // seconds per beat
  let t = ctx.currentTime + 0.08;       // small lead-in so the first note is not clipped
  const nodes = [];
  for (const [midi, beats] of notes) {
    const dur = beats * spb;
    if (midi > 0) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = wave || 'square';
      osc.frequency.value = midiToHz(midi);
      // Short attack + release envelope: without it every note starts with an audible click.
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
      gain.gain.setValueAtTime(0.22, t + Math.max(0.02, dur * 0.75));
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.95);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t); osc.stop(t + dur);
      nodes.push(osc);
    }
    t += dur;                           // rests (midi 0) just advance the clock
  }
  const endsAt = t;
  return { endsAt, stop() { for (const o of nodes) { try { o.stop(); } catch (e) {} } } };
}
```

Notes for the implementer:

* **Autoplay policy.** `ctx.state` may be `'suspended'` until the user has tapped something. Call
  `ctx.resume()` inside the first pointer event of the round; if it is still suspended when the
  question mounts, show a big **▶ Play** button instead of auto-playing, and start the melody (and
  the "already heard it once" state) on that tap.
* **Volume.** Keep the peak gain low (≈ 0.2) — square waves are loud. Run everything through one
  master gain so a future mute switch is trivial. Reuse `api.sound`'s context if the core exposes it.
* Always `stop()` the scheduled oscillators in `destroy()`, otherwise a melody keeps playing over
  the leaderboard.

### 8.2 mount(container, payload, api)

1. Layout, top to bottom: a big animated **now playing** card (a row of bars, one per note, that
   light up in time with the music is a nice cheap visualiser — you know every note's start time
   from the loop above), a **↻ Replay** button, then the four `.answer-btn` titles with the usual
   staggered fade-in.
2. Auto-play once on mount (after `ctx.resume()`), then let the player press **Replay** as often as
   they like — the answer is speed-scored, so replaying costs points by itself; no extra penalty.
   Disable Replay while a playback is running and re-enable it when `endsAt` passes.
3. `api.submit({ index })` on tap, then freeze: disable all four buttons, keep the tapped one
   highlighted, and stop the audio (the player is done; the result screen is next).
4. **TV mode / host** (`api.isHost && api.tvMode`): the host device is the shared speaker — play the
   melody there and show the four titles as a large list *without* buttons. In mobile mode the host
   plays along like everyone else. Every device plays its own audio; do not attempt to sync them.
5. Show a small "🎧 sound on" hint the first time, and a muted-device fallback: if
   `ctx.state !== 'running'` after `resume()`, put "Turn your ringer/volume on" under the play button.

### 8.3 result(resultData)

```js
{ icon: isCorrect ? '✓' : '✗', iconColor, heading: resultData.correctText,
  subtitle: isCorrect ? 'Correct!' : `You picked ${resultData.yourText}` }
```
Do **not** replay the audio here — the result screen is short and several devices would overlap.

### 8.4 reveal(container, revealData, ctx)

Same look as the MC/Flags reveal: the four titles as bars with `counts[i]` and `pickedBy[i]`, the
correct one in gold, `ctx.myNickname` highlighted. Add a **▶ Hear it again** button that replays
`revealData.notes / bpm / wave` — now with the title on screen, which is the satisfying "ohhh, that
one!" moment. In TV mode auto-play it once, quietly (lower gain), as the leaderboard animates in;
on player phones require a tap so the room does not turn into a canon of 8 phones.

### 8.5 metric(detail)

`detail.isCorrect ? '✓ ' + detail.answerText : '✗ ' + detail.answerText`

---

## 9. Content notes (`content/tunes.json`, 36 questions)

* **Public domain only.** Every melody played is either traditional/folk or by a composer who died
  more than 70 years ago (Beethoven, Mozart, Bach, Pachelbel, Grieg, Wagner, Rossini, Bizet,
  Vivaldi, Strauss, Chopin, Brahms, Joplin, Rimsky-Korsakov, Mendelssohn…). **Distractor titles may
  be any well-known piece** — only the audio has to be free. Never add a film, TV or video-game
  theme as the *played* melody.
* Mix: 21 classical, 14 folk/traditional/seasonal, 1 anthem (The Star-Spangled Banner).
* Difficulty: 17 × 1 (nursery rhymes, anthems, Ode to Joy, Beethoven's 5th, Tetris),
  16 × 2, 3 × 3 (Morning Mood, Habanera, Vivaldi's Spring).
* Correct index distribution is exactly 9 / 9 / 9 / 9.
* Distractors are always other famous pieces of a similar kind (waltz vs. waltz, carol vs. carol,
  rag vs. rag) so guessing by genre does not work.
* Each melody is the first 8–24 notes of the most recognisable phrase, transposed to sit in
  MIDI 48–84 where a square wave sounds best.

### Adding a tune

1. Write the phrase out as note names, convert to MIDI (`60 = C4`, +1 per semitone).
2. Write the rhythm in quarter-note beats and pick a bpm that matches the real tempo.
3. `node import.js content/tunes.json --dry-run` to validate, then listen to it (a two-line HTML
   page with the `playMelody` function above is enough) before committing — a wrong note is worse
   than a missing question.
