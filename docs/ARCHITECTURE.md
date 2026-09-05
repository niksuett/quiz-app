# QuizBlast v2 — Architecture & Game-Module Contract

This document is the contract every game type follows. It is written so that a
module can be built and tested in isolation, then dropped in without touching
the core. Read it fully before adding or changing a game type.

---

## 1. Directory layout

```
quiz-app/
├── server.js                 core: express + socket.io, game loop, lobby, reconnect, host controls
├── scoring.js                core: unified scoring (accuracy + rank bonus + streak + final double)
├── db.js                     SQLite open + rowToQuestion / questionToRow (delegates to modules)
├── import.js                 append questions from JSON, validated by the module of each type
├── games/
│   ├── index.js              registry: loads every games/*.js module, builds category list
│   ├── mc.js flag.js slider.js timeline.js map.js sequence.js   (classic types)
│   └── trace.js sizeup.js halves.js curve.js compass.js tune.js silhouette.js fakes.js (new)
├── data/                     game data read by server modules (JSON, committed; NEVER served — it contains answers)
│   ├── borders.json  rivers.json  silhouettes.json  countries.json  halves/<ISO3>.json ...
├── tools/                    build scripts that generate data/* from raw sources (raw files are gitignored under tools/raw/)
├── test/simulate.js          headless end-to-end test: host + bots play a whole game via socket.io-client
└── public/
    ├── index.html            all screens
    ├── style.css             theme + core screens
    ├── client.js             core client: sockets, screens, timer, sounds, leaderboard, config UI
    ├── core/geo.js           shared browser geometry helpers (projection, polyline distance, simplify)
    ├── games/<type>.js       client module per type (registered on window.QuizGames)
    └── games/<type>.css      optional module stylesheet (auto-loaded with the module)
```

Rule: a game type touches only `games/<type>.js`, `public/games/<type>.js|.css`,
its `data/` files, its `tools/build-<type>.js`, and its question JSON. Never the core.

---

## 2. Vocabulary

* **type** — the mechanic (`map`, `trace`, `sizeup`…). One server module + one client module per type.
* **category** — what the host picks on the config screen (`geo-cities`, `borders`, `trivia`…).
  A category belongs to exactly one type; a type can own several categories (e.g. `trace` owns
  `borders` and `rivers`). Categories are declared by the module, and the config screen is built
  from `GET /api/games` — nothing is hard-coded in HTML.
* **group** — how categories are grouped on the config screen: `draw` (Draw & Build), `map`, `classic`.
* **region** — optional geographic tag on a question: one of
  `europe | asia | africa | north-america | south-america | oceania`. Used by the host's
  "Geographic focus" filter. Questions without a region always pass the filter.
* **difficulty** — optional 1 (casual) / 2 (normal) / 3 (expert). Missing = 2.

---

## 3. Question object (in-memory shape, produced by rowToQuestion)

Common fields on every question:

```js
{
  id, category, type,          // type is always present in v2 (mc is explicit)
  question,                    // prompt text (for flag: ISO code; for silhouette: country name)
  imageUrl?,                   // optional photo above the prompt
  region?, difficulty?,        // optional tags (stored inside extra)
  ...typeSpecificFields         // e.g. answers/correct, min/max/step/unit, correctLat/correctLng, items, pairId
}
```

Storage: `questions(id, category, type, question, correct, image_url, extra)`.
`extra` is a JSON blob. `region` and `difficulty` live in `extra` and are lifted to the
top level by `db.js`. Each module's `toRow` / `fromRow` handles its own fields; db.js only
handles the common ones.

---

## 4. Server module contract — `games/<type>.js`

```js
module.exports = {
  type: 'trace',
  categories: [
    {
      id: 'borders', label: 'Border Draw', emoji: '🖊️', group: 'draw',
      blurb: 'Two neighbours, one missing border. Draw it.',          // config screen, <= 70 chars
      howTo:  'Draw a single line where the border runs, then lock in.', // intro splash, <= 90 chars
    },
  ],
  timeLimit: 45,           // seconds for the question
  revealPause: 10,         // base seconds the leaderboard stays up on autoplay
  earlyPause: 4000,        // ms to wait after everyone answered (result screen time)
  speedScored: false,      // true for MC-like types: accuracy points scale with answer speed
  usesRegion: true,        // questions of this type may carry a region tag

  // Validation for import.js / admin. Return [] when valid, else array of messages.
  validate(q) { return []; },

  // DB serialisation of type-specific fields. Common fields are handled by db.js.
  toRow(q)  { return { correct: null, extra: { pairId: q.pairId } }; },
  fromRow(row, extra) { return { pairId: extra.pairId }; },

  // Data sent to every client when the question starts. MUST NOT leak the answer.
  // May return large objects (geometry) — they are sent once per question.
  payload(q, game) { return { ... }; },

  // Evaluate one submitted answer. `answer` is whatever the client module sent.
  // Return:
  //   quality: number in [0,1] (1 = perfect) or null (= wrong / not rankable, 0 points)
  //   detail:  small object stored on the player and shown on the leaderboard (metric text, reveal)
  //   result:  object sent back ONLY to the answering player for the result screen
  // Throwing or returning null = answer rejected (client gets `answer-rejected`).
  evaluate(q, answer, ctx /* { elapsed, timeLimit, game } */) { return { quality, detail, result }; },

  // Reveal data for the leaderboard, sent to everyone. `answers` = players who answered:
  //   [{ nickname, detail, quality, elapsed, roundPoints }]
  reveal(q, answers, game) { return { ... }; },

  // One-line correct answer for the leaderboard banner.
  correctText(q) { return 'France – Spain border'; },
};
```

Notes
* `payload`, `evaluate`, `reveal` are synchronous. Load data files at require-time (or lazily
  and cache) from `data/`.
* Never include `q.correct*` in `payload`. Test: `JSON.stringify(payload)` must not contain the answer.
* `evaluate` must be defensive: validate `answer` shape and clamp numbers. Bad input → return null.
* Speed-scored types (`speedScored: true`) return `quality: 1` for correct, `null` for wrong;
  the core applies the speed factor.
* **Difficulty tiers.** `game.setup.difficulty` is `'casual' | 'mixed' | 'expert'`. A module may use it
  to change how much HELP the payload carries (markers, rulers, readouts, how much of a series is shown)
  — never the truth or the scoring. Convention: a `tierFor(game)` helper, a `tier` field in the payload
  so the client can show a hint line, and a "Difficulty tiers" table in `docs/games/<type>.md`. If the
  tier changes what `evaluate()` scores against (curve does), `payload`, `evaluate` (via `ctx.game`) and
  `reveal` must all derive it from the same `game`. Implemented for trace, sizeup, halves, curve, compass.
* **Per-game shuffles** (MC-style option order, Spot-the-Fakes item order) are seeded from
  `game.id + q.id` (`_shared.js` → `hashString` / `seededOrder` / `mcOrder`), so every client and every
  reconnect sees the same order without server-side per-player state, and the same question is laid out
  differently in the next game. Indices in `answer`, `result` and `reveal` are all in DISPLAYED order.

---

## 5. Client module contract — `public/games/<type>.js`

Each file registers itself. It is loaded dynamically (plus `<type>.css` if it exists) by the core
after `/api/games` is fetched, before the first question.

```js
QuizGames.register({
  type: 'trace',

  // Build the answering UI inside `container`. Called for players AND the host (TV mode shows a
  // passive view — check api.isHost). Return an object with destroy() to clean up (maps, listeners).
  mount(container, payload, api) { ...; return { destroy() {} }; },

  // Result screen (player only). Return { icon, iconColor, heading, subtitle?, html? }.
  // `html` is rendered inside the dark left panel (use the .compare-* classes from style.css).
  result(resultData) { ... },

  // Leaderboard reveal. Render into container. Return { destroy() } or nothing.
  reveal(container, revealData, ctx /* { myNickname, players: leaderboard entries, isHost } */) { ... },

  // Short metric for the leaderboard row from the stored detail, e.g. "312 km away". Return ''.
  metric(detail) { return ''; },
});
```

`api` passed to `mount`:

```js
{
  submit(answer),           // send the answer once; the core disables further submits
  isHost, role, tvMode,     // role: 'host' | 'player'. In mobile mode the host is also a player.
  timeLimit,                // seconds
  locked,                   // becomes true after submit — modules should freeze their UI
  onTick(fn),               // fn(remainingSeconds) every second (for modules that care)
  sound: { correct(), wrong(), tick(), click() },
  util,                     // = QuizGames.util (see section 6)
}
```

Conventions
* Use the theme tokens from style.css (`var(--gold)`, `var(--ink)`, `var(--parchment)` …).
* Everything must work with touch (pointer events, `touch-action: none` on drawing surfaces).
* Never rely on `window` size at mount time — containers can be resized; use ResizeObserver
  or recompute on `mount` and on `orientationchange`.
* Show a clear "Lock in" button; after locking, the UI freezes and the core takes over.
* Leaflet is global (`L`). Tile helpers: `util.tiles.streets()` (Voyager no-labels),
  `util.tiles.satellite()` (Esri World Imagery).

---

## 6. Shared browser utilities — `QuizGames.util`

```
escapeHtml(s)                 formatYear(y)  → "323 BCE" / "800 CE" / "1969"
ordinal(n) → "1st"            fmtNum(n, unit?)  → "1,234 km"
haversineKm(lat1,lng1,lat2,lng2)
tiles.streets() / tiles.satellite()          → L.tileLayer instances
project(lng, lat, bbox, w, h)                → [x, y] in an equirectangular box (core/geo.js)
polylineDist(pt, line)                       → nearest-point distance
resample(line, n)                            → n evenly spaced points along a polyline
simplify(line, tolerance)                    → Douglas-Peucker
colorFor(index)                              → distinct player colour (used by reveals)
```

---

## 7. Scoring (core, `scoring.js`) — the single mode

Per question, for each player who answered with `quality !== null`:

* **Accuracy points** `A = round(100 × quality)`.
  For `speedScored` types: `A = round(100 × (0.5 + 0.5 × max(0, 1 − elapsed / timeLimit)))`
  when correct, so instant answers ≈ 100, answers at the buzzer ≈ 50.
* **Rank bonus** among ranked players sorted by `quality` desc, then `elapsed` asc:
  1st +50, 2nd +30, 3rd +15, 4th and below +0. Ties on quality are broken by speed and the
  loser is flagged `speedTiebreakedOut` (shown as "slower ⚡").
* **Streak bonus** +20 when the player's streak (consecutive questions with A ≥ 60) reaches 3 or more.
* **Final round**: if the host enabled "Final round ×2", all of the above are doubled on the last question.
* `roundPoints = (A + rankBonus + streakBonus) × multiplier`. Players who did not answer get 0 and their streak resets.

The leaderboard entry carries every component so the client can explain it:
`{ nickname, score, roundPoints, roundRank, accuracyPts, rankBonus, streakBonus, streak, quality, detail, elapsed, speedTiebreak, speedTiebreakedOut, connected, stats }`.

`stats` (accumulated): `{ answered, firsts, bestRound, sumAccuracy, perfects, fastestMs, byType: {type: {n, sumAccuracy}} }` → used for end-of-game awards.

---

## 8. Socket protocol

Host → server: `create-game {rounds, categories[], regions[]|null, difficulty:'mixed'|'casual'|'expert', pace:'brisk'|'normal'|'relaxed', autoplay, gameMode:'mobile'|'tv', finalDouble, intros, testIds?}`
→ `game-created {gameId, gameMode, autoplay, hostToken}` | `create-error msg`

Player → server: `join-game {gameId, nickname}` → `join-success {gameId, nickname, playerToken}` | `join-error msg`
Anyone → `rejoin {token}` → `rejoin-success {role, gameId, nickname, gameMode, autoplay}` followed by the current-state event, or `rejoin-error`.
Host → `start-game {hostNickname?}`, `next-question`, `skip-question`, `end-game`, `kick-player {nickname}`, `pause-game`, `resume-game`.
Player → `submit-answer {answer}` → `answer-result {type, quality, soundCorrect, ...result}` | `answer-rejected msg`.

Server → room:
* `lobby-update {players:[{nickname, connected}]}`
* `question-intro {questionNumber, totalQuestions, type, category:{id,label,emoji,group,howTo}, firstTime, durationMs}`
* `new-question {questionNumber, totalQuestions, type, category:{...}, timeLimit, remainingMs?, payload, isLast, multiplier}` — a reconnect snapshot also carries `paused`, `closed` (time is up, leaderboard imminent), `answered`, `myResult`
* `time-up` — the question timer ran out and answers are closed; the leaderboard follows after a short buzzer pause so last-second answerers still see their result screen
* `answer-progress {answered, total}` (host only)
* `game-paused {remainingMs}` / `game-resumed {remainingMs}`
* `show-leaderboard {leaderboard, correctText, type, category:{...}, questionNumber, totalQuestions, isLast, multiplier, reveal}`
* `waiting-for-host` (host only, autoplay off)
* `game-over {leaderboard, awards:[{emoji,title,nickname,detail}]}`
* `host-left`, `kicked`

Pacing (server.js `TIMING` + `PACE_FACTOR`): intro splash 5 s the first time a category appears, 2.2 s afterwards;
once everyone has answered the leaderboard waits `max(4 s, module.earlyPause)`; after time-up a 2.5 s buzzer pause;
the leaderboard stays `max(8 s, module.revealPause) + 0.5 s per extra player` (cap 30 s). The host's `pace` option
scales all of these by 0.7 (brisk) / 1 (normal) / 1.4 (relaxed). The per-type `timeLimit` never changes.

HTTP: `GET /api/games` → `{ types:[{type,timeLimit,speedScored,...}], categories:[{id,label,emoji,group,blurb,howTo,type,count}], groups:[{id,label,emoji}], regions:[...], presets:[{id,label,categories}] }`
`GET /qr/:gameId` → SVG QR code of the join link. (`data/` is not served — modules put what the client needs in the payload.) `GET /?join=ABC123` prefills the join screen.

---

## 9. Question JSON per type (what import.js accepts)

See `QUESTION_PIPELINE.md` for the classic types. New types:

* `trace` — `{ type:'trace', category:'borders'|'rivers', question, pairId|riverId, region? }`
  Geometry is looked up in `data/borders.json` / `data/rivers.json` by id.
* `sizeup` — `{ type:'sizeup', category:'sizeup', question, target:{name, icon, sizeM, dim:'height'|'length'}, reference:{name, icon, sizeM, dim} }`
  `icon` is a key in `data/silhouettes.json` (`{ key: { body: '<svg path…>', w, h } }`).
* `halves` — `{ type:'halves', category:'halves', question, regionId, region? }` → grid in `data/halves/<regionId>.json`.
* `curve` — `{ type:'curve', category:'curves', question, series:[[x,y]...], xLabel, yLabel, yMin, yMax, unit?, source?, knownFraction? }`
* `compass` — `{ type:'compass', category:'compass', question, from:{name,lat,lng}, to:{name,lat,lng}, region? }`
* `tune` — `{ type:'tune', category:'tunes', question, notes:[[midi, beats]...], bpm, wave?, answers[4], correct }`
* `silhouette` — `{ type:'silhouette', category:'silhouettes', question (country name), iso3, answers[4], correct, region? }` → shape from `data/countries.json`.
* `fakes` — `{ type:'fakes', category:'fakes', question, items:[{text, fake:boolean} × 6] }`
* `map` gains optional `satellite: { zoom }` (category `birdseye`), `toleranceKm`, `region`.

---

## 10. Testing

`node test/simulate.js [--rounds N] [--bots N] [--categories a,b] [--port P]` starts the server in-process
on a free port, creates a game, joins bots, answers every question with a plausible random answer for its
type, and asserts: every player receives `new-question` → `show-leaderboard` for each round, scores are
non-negative and monotonic, `payload` never contains the correct answer, and `game-over` arrives.
Run it after touching the core or any module. Exit code 0 = pass.

---

## 11. Optional server-module hooks

* `sampleAnswer(payload)` — return a plausible random answer for this type. Used by `test/simulate.js`
  so every type can be exercised headlessly. Required for every module.
* `routes(app, ctx)` — register extra HTTP routes (e.g. a tile proxy). `ctx = { getGame(id) }`.
  Prefix routes with `/<type>/…` to avoid collisions.
* `order` (number, on a category) — sort position inside its group on the config screen.

## 12. Rematch

Host → `rematch` (only in state `gameover`). The server builds a new game with the same players
(scores reset, tokens kept), same settings and fresh questions, moves every socket into the new room
and emits `rematch {gameId, gameMode, autoplay, totalQuestions, players}` to everyone. Clients show
their lobby screen again; the host presses Start (no nickname needed — the host player is kept).
