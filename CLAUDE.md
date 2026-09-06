# QuizBlast — Project Context for Claude

## What this project is
A multiplayer quiz game inspired by gameon.world. A host configures and starts a game, players join on their own devices via a Game ID (or QR code) and nickname, everyone answers the same questions simultaneously, and a leaderboard shows after each question. QuizBlast v2 has 14 different game **types** (buttons, sliders, map pins, drawing, dragging, resizing…) spread across 20 **categories**, built as a plugin system so a new type can be added without touching the core game loop.

## Tech stack
- **Backend:** Node.js + Express + Socket.io (`server.js`)
- **Frontend:** Plain HTML + CSS + JavaScript (no frameworks)
- **Real-time communication:** Socket.io (WebSockets)
- **Maps:** Leaflet.js. Basemap is CARTO Voyager (no labels) if an API key is set, otherwise Esri World Physical Map with label-free Esri satellite imagery fading in from zoom 9 (keyless fallback — see "Client architecture" below)
- **Storage:** SQLite (`quiz.db`) via `better-sqlite3` for questions; all live game state lives in server memory (lost on restart — there's no game-state database)
- **Entry point:** `server.js` exports `{ app, server, io, start, games, registry }`. Run directly with `node server.js` (reads `PORT`, defaults to 3000) or `require('./server').start(port)` from a test.
- **Env vars:** `PORT` (server port, default 3000), `ADMIN_PASSWORD` (password for `/admin.html`, default `ilikehistory99` — change it before deploying anywhere public; setting it genuinely works now, it used to lock the editor into a redirect loop because `admin.html` compared the cookie against the hard-coded default), `QUIZ_DB` (override the SQLite file path, used by tests), `QUIZ_TEST=1` (shortens game-over cleanup delay and unlocks a `testFast` option for `test/simulate.js`)

## Project structure
```
quiz-app/
├── server.js              core: express + socket.io, game loop, lobby, reconnect, host controls, admin API
├── scoring.js              core: unified scoring (accuracy + rank bonus + streak + final-round double) + end-game awards
├── db.js                   SQLite open + rowToQuestion / questionToRow (delegates type-specific fields to games/)
├── import.js                append new questions from a JSON file into quiz.db (validated per module, append-only)
├── migrate.js               legacy one-time loader for the old questions.json → quiz.db (superseded by tools/migrate-v2.js)
├── quiz.db                  SQLite database — committed to git, source of truth for all 2188 questions
├── questions.json           original v1 question data — kept as historical backup only, not read at runtime
├── games/                   one server module per game type (the plugin registry)
│   ├── index.js              loads every games/*.js, builds the category/group/region/preset lists for /api/games
│   ├── _shared.js             helpers shared by modules (shuffle, seeded shuffle, haversine, bearing, formatYear, MC helpers incl. per-game option order) — not a game type itself
│   └── mc.js flag.js slider.js timeline.js map.js sequence.js       classic types
│       trace.js halves.js sizeup.js curve.js compass.js tune.js silhouette.js fakes.js   new v2 types
├── data/                    generated geodata read by server modules at require-time (JSON, committed to git, NEVER served over HTTP — it contains the answers)
│   ├── borders.json rivers.json    line geometry for Border Draw / River Run
│   ├── countries.json               outlines for Shape of Nations (silhouette)
│   ├── silhouettes.json             game-icons.net SVG icon bodies for Size It Up
│   ├── cities.json                  ~150 world cities for Compass
│   └── halves/<ISO3>.json           per-country population grid for Population Split
├── content/                 question seed JSON, one file per content batch — imported once via import.js, not read at runtime afterwards
├── tools/                   one-off / re-runnable build scripts (raw downloads cache to tools/raw/, gitignored)
│   ├── build-borders.js build-rivers.js build-compass.js build-countries.js
│   │   build-curves.js build-halves.js build-silhouettes.js         each downloads a source dataset and writes data/*.json + content/*.json
│   ├── migrate-v2.js                  merged the old facts/science/sports/entertainment categories into "trivia", tagged regions
│   ├── set-fields.js / delete-ids.js   bulk-edit or bulk-delete existing DB rows from a JSON list (used for the difficulty-tag and prune passes)
│   └── lib/geo.js                     shared geometry helpers for the builders: Natural Earth loader, point-in-polygon, continentOf()/countryOf()
├── test/
│   ├── simulate.js          headless end-to-end test: starts the server in-process, host + bots play a full game over socket.io-client
│   └── security.js          answer-leak + admin-auth checks (tile proxy zoom pinning, session cookie, save guards, static exposure)
├── docs/
│   ├── ARCHITECTURE.md      binding contract for server modules (§4), client modules (§5), socket protocol (§8), question JSON (§9) — read this first when touching game logic
│   ├── games/<type>.md      one spec per new v2 type (compass, curve, fakes, halves, silhouette, sizeup, trace, tune) — question JSON shape + UI notes
│   └── STATUS.md            working log of the v2 build (what's done, what's still in progress) — not a permanent doc, but useful for "why does this look half-finished"
├── QUESTION_PIPELINE.md     the data-model + content-pipeline spec (paste into a Claude chat to brainstorm new question sources)
└── public/
    ├── index.html            all screens (shown/hidden by JS)
    ├── style.css              Parchment & Ink theme (Cinzel/EB Garamond/Lora fonts, gold accents) + core screens
    ├── client.js               core client: sockets, screen switching, timer, sounds, leaderboard, config UI, loads game modules dynamically
    ├── core/geo.js              shared browser geometry helpers (equirectangular projection, polyline distance, resample, Douglas-Peucker simplify)
    ├── games/<type>.js|css      one client module per type, registered on `window.QuizGames` (loaded on demand, matched to games/<type>.js on the server)
    ├── admin.html                question editor UI at /admin.html (password-gated)
    ├── admin-login.html          password prompt that sets the admin cookie
    └── dev/harness.html           standalone module test page: /dev/harness.html?type=<type>&payload=<json>&show=result|reveal|both&tv=1&host=1
```

Rule from `docs/ARCHITECTURE.md`: a game type touches only `games/<type>.js`, `public/games/<type>.js|.css`, its `data/` files, its `tools/build-<type>.js`, its `docs/games/<type>.md`, and its question JSON in `content/`. It never touches `server.js`, `scoring.js`, `db.js`, or another type's files.

## Running locally

**First time only (or after pulling on a new machine):**
```
npm install
```
Installs express, socket.io, better-sqlite3, cookie-parser, compression, qrcode, geotiff (dev dependency: socket.io-client, used by test/simulate.js).

**Every time:**
```
node server.js
```
Starts the app at `http://localhost:3000` (or `$PORT`). Prints how many categories/types loaded from the DB.

**Testing a change (do this before every push):**
```
node test/simulate.js [--rounds N] [--bots N] [--categories a,b] [--port P]
```
Spins up the server in-process, creates a game, joins `N` bots (default a handful), plays every round with a plausible random answer per type, and asserts every player gets `new-question` → `show-leaderboard` for each round, scores never go negative, no answer ever leaks through a question `payload`, and `game-over` fires. Exit code 0 = pass. `--categories` restricts which categories are exercised; omit it to test everything.

**Security checks (run these too before a push that touches `server.js`, `games/map.js` or the admin editor):**
```
node test/security.js
```
Runs against a *copy* of `quiz.db` in the temp directory, so it can exercise the destructive admin save path safely. Covers the two things a player must never be able to do — read an answer they haven't earned, and touch the question bank:
- **Satellite tile proxy** — the zoom is pinned to the one the question was authored at. Every tile is *centred* on the secret point and the token is in the question payload, so accepting any zoom let a player ask for zoom 3 and get a continent-scale view centred on the answer.
- **Admin auth** — the cookie is an opaque session id (never the password), `HttpOnly`, killed server-side on logout, and login is throttled per IP.
- **The question bank** — a save that would shrink the library by more than half is refused with a 409 unless you repeat it with `?force=1`. `POST /admin/questions` is a whole-table replace, so an empty array used to wipe all 2188 rows in one request.
- **Static exposure** — `data/`, `content/`, `quiz.db` and the server-side modules are not reachable over HTTP. (`/games/<type>.js` *is* served and should be: that path resolves to `public/games/<type>.js`, the browser module.)

It also checks the **reveal** of every round, which is where two live bugs hid in Sept 2026:
- `reveal` must not be `null` — the server catches a throwing `reveal()` and sends null, so a crashed payoff screen would otherwise look like a pass.
- **Every player whose answer the server accepted must appear in the reveal** (matched by nickname, which every module includes in its per-player entries). This is what catches a reveal that silently drops players — the mc-family option tally showed `0 / 0% / nobody` for months because wrong answers were filtered out before `reveal()` saw them.
- `correctText` must be a non-empty string.
- No `payload()` or `reveal()` may return a non-finite number. This one is checked by wrapping the modules **server-side**: socket.io serialises with JSON, which turns `NaN` into `null`, so a NaN is undetectable by the time it reaches a client.

What it still does **not** check: anything about how a screen actually renders. `simulate.js` passing means the loop and the data are sound, not that the game looks right — for that, play it (`/dev/harness.html?type=<type>` for one type in isolation).

**Trying one game type in isolation**, without spinning up a full game:
```
http://localhost:3000/dev/harness.html?type=compass&show=both
```
Renders just that type's mount/result/reveal UI with a sample or custom (`&payload=<json>`) question — much faster than playing a full game to check one screen.

**Adding new questions:**
```
node import.js content/<file>.json [--dry-run]
```
Validates every question in the file against its game module's `validate()` first — if anything fails, nothing is written. `--dry-run` checks without writing. Existing rows are never touched; import only appends. To regenerate a whole geodata-backed category (e.g. after Natural Earth updates upstream), re-run its `tools/build-<type>.js` — each one documents at the top of the file what it downloads (cached under `tools/raw/`) and what it writes to `data/` and `content/`.

`quiz.db` is committed to git and is the source of truth. To add or edit questions day-to-day, use the admin editor at `/admin.html` (enter the `ADMIN_PASSWORD`) — it saves straight to `quiz.db` via the admin API, no restart needed. Saving replaces the whole table, so a save that would drop more than half the library is refused; if a big prune really is intended, repeat the request with `?force=1`. Then commit and push `quiz.db` — Railway redeploys from `main` and picks up the new questions automatically. **Only push once the server and the client agree on every category** — a category whose client module (`public/games/<type>.js`) doesn't exist yet will break for anyone who selects it.

`migrate.js` is the old v1 loader (questions.json → quiz.db) and is no longer the way new content gets in; it's kept only as a historical reference. The v2 equivalent, `tools/migrate-v2.js`, was a one-time script that merged the old MC categories into `trivia` and tagged regions — it doesn't need to be run again.

---

## Core game flow
1. Host opens the app → configuration screen (rounds, categories, region/difficulty filters, pace, autoplay, Mobile/TV mode, final-round ×2, intros)
2. Players join at the same URL with the Game ID (typed, or via QR code) + nickname → waiting screen
3. Host sees the lobby with a live player list → clicks Start (in Mobile mode, the host also enters a nickname and plays)
4. Each question: a short intro splash (category + how-to, first time that category appears), then the answering screen for the type; host (TV mode) or everyone (Mobile mode) sees a live answered-count
5. Once everyone has answered (or the timer runs out — a `time-up` event freezes everyone's screen for a short buzzer pause first): a short per-player result screen, then the shared leaderboard with a type-specific reveal (map pins, drawn lines, heat maps, etc.). All these pauses live in the `TIMING` block at the top of `server.js` and are scaled by the host's **Pace** option.
6. Repeat until rounds complete → final leaderboard + up to 5 end-of-game awards → Rematch option (same players, same settings, fresh questions, no one re-enters a code)

Reconnects: every player and the host hold a reconnect token (cookie-backed); a dropped connection or page reload rejoins the same game in progress via a `rejoin` socket event, restoring the current screen from a state snapshot.

## Categories
Generated from the live database (`node -e "const Database=require('better-sqlite3');const db=new Database('quiz.db');console.log(db.prepare('SELECT category,type,COUNT(*) n FROM questions GROUP BY 1,2').all())"`) and `node -e "console.log(JSON.stringify(require('./games').categories,null,1))"` for labels/emoji/groups. **2188 questions total across 20 categories.**

| Group | Category | id | Type | Count | Time limit | Mechanic |
|---|---|---|---|---|---|---|
| 🎨 Draw & Build | Border Draw | `borders` | trace | 288 | 45s | Two countries shown as one blob — draw the missing border between them |
| 🎨 Draw & Build | River Run | `rivers` | trace | 79 | 45s | Draw a river's course between its mouth and source markers |
| 🎨 Draw & Build | Draw the Curve | `curves` | curve | 56 | 40s | A chart's start is shown — draw how the line continues |
| 🎨 Draw & Build | Population Split | `halves` | halves | 46 | 40s | Drag a line's ends until it splits a country's population 50/50 |
| 🎨 Draw & Build | Compass | `compass` | compass | 88 | 20s | Rotate a needle to point from one city towards another |
| 🎨 Draw & Build | Size It Up | `sizeup` | sizeup | 71 | 30s | Drag a silhouette bigger or smaller on a zoomable canvas until it matches a real-world size next to a reference object |
| 🗺️ On the Map | Bird's Eye | `birdseye` | map | 72 | 35s | A satellite close-up is shown; drop a pin where on Earth it is |
| 🗺️ On the Map | Natural Wonders | `geo-natural` | map | 79 | 35s | Mountains, lakes, deserts, waterfalls — drop a pin |
| 🗺️ On the Map | Built World | `geo-built` | map | 145 | 35s | Monuments, temples, famous buildings — drop a pin |
| 🗺️ On the Map | Cities | `geo-cities` | map | 86 | 35s | Urban centres worldwide — drop a pin |
| 🗺️ On the Map | Where in History | `geo-history` | map | 58 | 35s | Battlefields, ruins, historical events — drop a pin |
| 🧠 Classic Quiz | Trivia | `trivia` | mc | 389 | 15s | 4 buttons, one right answer (merged facts/science/sports/entertainment) |
| 🧠 Classic Quiz | Flags | `flags` | flag | 102 | 15s | Real flag image (flagcdn.com) + 4 country buttons |
| 🧠 Classic Quiz | Shape of Nations | `silhouettes` | silhouette | 132 | 15s | A country outline (north up) + 4 name buttons |
| 🧠 Classic Quiz | Name That Tune | `tunes` | tune | 36 | 25s | A chiptune melody plays (Web Audio) + 4 title buttons |
| 🧠 Classic Quiz | Emoji Riddles | `emoji` | mc | 123 | 15s | An emoji clue decodes to a film/place/phrase + 4 buttons |
| 🧠 Classic Quiz | Estimation | `estimation` | slider | 70 | 20s | Drag a slider (or type a number) to guess a value; scored by proximity |
| 🧠 Classic Quiz | Timeline | `timeline` | timeline | 114 | 20s | Drag/type a year; scored by proximity. Negative = BCE, shown as "X BCE" |
| 🧠 Classic Quiz | Sequence | `sequence` | sequence | 94 | 30s | Drag 4 items into the correct order |
| 🧠 Classic Quiz | Spot the Fakes | `fakes` | fakes | 60 | 25s | 6 names, some invented — tap every fake one |

Some timeline questions carry an optional `imageUrl` (historical photo shown above the prompt). Region tag (`europe/asia/africa/north-america/south-america/oceania`) and difficulty tag (1 casual / 2 normal / 3 expert, default 2) are optional on most types and live inside the `extra` JSON blob — `db.js` lifts them to the top level of the in-memory question object.

## Game types
One server module (`games/<type>.js`) + one client module (`public/games/<type>.js`) per type; `docs/ARCHITECTURE.md` §4/§5 is the binding contract both follow.

- **mc** — 4 buttons, one correct. Answer is `{ index }`; correct = `quality: 1`, wrong = `quality: null` (0 points). Speed-scored (see Scoring). Reveal shows how many players picked each option. The four options are **shuffled per game** on the server (`mcOrder` in `_shared.js`, seeded from game id + question id, so reconnects see the same order); every index the client sends or receives is in displayed order. flag / silhouette / tune inherit this.
- **flag** — same mechanic as mc (reuses `evaluateMC`/`revealMC` from `_shared.js`), with a flag image (flagcdn.com) above the buttons.
- **silhouette** — same mechanic as mc again, with a country outline (from `data/countries.json`, built from Natural Earth) instead of a flag; reveal also sends the outline so the client can label it.
- **tune** — same mechanic as mc a third time; the payload carries a note sequence (`[[midi, beats], …]` + bpm + waveform) that the client synthesizes with Web Audio, no audio files.
- **slider** — drag a bar or type a number; answer `{ value }`. Quality is a proximity curve between `min`/`max` around `correct` (closer = higher quality; not a hard pass/fail). The shown range is **slid per game** so the answer does not sit near the middle (`shownRange` in `games/slider.js`, seeded from game id + question id like the mc shuffle, so `payload`/`evaluate`/`reveal` agree and a reconnect is stable). The authored ranges were near-centred — mean position 0.49, sd 0.12 — so "drag to the exact middle every round" scored 80/100 with no knowledge; it now scores ~65. The range **width is preserved**, because the width is the scoring tolerance and changing it would change the difficulty.
- **timeline** — identical mechanic to slider (delegates to the same proximity curve `slider._proximityQuality` and the same `slider._shownRange`) but the axis is years and negative values format as BCE.
- **map** — tap/click a Leaflet map; answer `{ lat, lng }`. Quality comes from haversine distance to `correctLat/correctLng` run through an exponential decay curve, after subtracting an optional `toleranceKm` (any guess inside that radius counts as a perfect hit — see Data notes below). Bird's Eye additionally shows a satellite close-up first, proxied tile-by-tile through `/map/sat/:token/:z/:dx/:dy` so the browser never learns the real coordinates before the reveal.
- **sequence** — drag 4 items into order; answer `{ order: [items] }`. Quality is the fraction of correctly-ordered pairs (Kendall-style), not just exact-position count, so a near-miss still scores partial credit; the result screen also reports the raw correct-position count.
- **trace** (Border Draw, River Run) — draw a freehand line; answer `{ line: [[lng,lat], …] }`. The drawn line and the true border/river line are each resampled to fixed points and matched to the nearest point on the other line (a two-way Hausdorff-style average distance), projected locally so degrees-to-km stays accurate near the subject. Error is compared against a tolerance scaled to the feature's own length, and a too-short scribble is penalised. Reveal shows the true line and the player's line together.
- **halves** (Population Split) — drag a line's two endpoints across a country; answer `{ a: {lat,lng}, b: {lat,lng} }`. The server splits a precomputed population grid (from WorldPop, downsampled per country) by that line and scores how close the split is to 50/50. Reveal includes a heat map of where the population actually is.
- **compass** — rotate a needle; answer `{ bearing }` (degrees). Quality compares it to the true great-circle initial bearing between two cities (from `data/cities.json`, sourced from GeoNames).
- **sizeup** (Size It Up) — a zoomable canvas: drag the red silhouette (game-icons.net SVGs, CC BY 3.0) or its corner handle bigger/smaller next to a brown reference object; − / + / Fit buttons, pinch and mouse wheel zoom the canvas; answer `{ sizeM }`. Quality is based on the log-ratio between the guessed and true size (so doubling vs. halving is treated symmetrically), clamped against adversarial input. Difficulty tiers: casual adds a metre ruler, expert hides the numeric readout (judge by eye). Spec: `docs/games/sizeup.md`.
- **curve** (Draw the Curve) — a chart shows a known lead-in; the player draws the rest with their finger; answer `{ ys: [values] }` for the hidden x-positions. Quality comes from mean absolute error relative to the chart's y-range; a fully blank drawing is rejected rather than scored.
- **fakes** (Spot the Fakes) — 6 names, 2–4 invented; answer `{ picks: [indices] }`. The 6-item order is a deterministic shuffle seeded from `gameId + questionId` (so a reconnecting player sees the identical order, without server-side per-player state). Quality rewards each fake correctly tapped and each real one correctly left alone, penalised below a break-even point (formula: `max(0, (correct − 3) / 3)`).

## Scoring (`scoring.js`) — the single scoring mode
Points are calculated server-side once everyone has answered (or the timer runs out), never on submission.

- **Accuracy points** `0–100`, from `quality` (`0 = wrong/no answer` … `1 = perfect`): `round(100 × quality)` for most types. For **speed-scored** types (mc, flag, silhouette, tune) a correct answer instead scores `round(100 × (0.5 + 0.5 × speedFactor))` where `speedFactor = max(0, 1 − elapsed/timeLimit)` — instant answers ≈100, answers at the buzzer ≈50; wrong answers score 0 regardless of speed.
- **Rank bonus**: players are ranked by quality (desc), speed as tiebreaker; 1st +50, 2nd +30, 3rd +15, others +0. Only earned by an answer with some merit (quality > ~0.02). Ties on quality are flagged — the earlier-in-time player keeps the rank, the later one is marked `speedTiebreakedOut` ("slower ⚡" on the leaderboard).
- **Streak bonus**: +20 once a player has 3+ questions in a row scoring 60+ accuracy points; breaks on any question scored below that (including no-answer).
- **Final round ×2**: if the host enabled it, accuracy + rank + streak are all doubled on the last question.
- `roundPoints = (accuracyPts + rankBonus + streakBonus) × multiplier`. A player who didn't answer scores 0 and their streak resets.
- **End-of-game awards** (up to 5, computed by `computeAwards`): 🎯 Sharpshooter (highest average accuracy, 3+ answers), ⚡ Speed Demon (fastest average on speed-scored questions, 2+), 🔥 Hot Streak (longest streak, 3+), 🧭 Master Cartographer (best average on map/trace/halves/compass/silhouette rounds, 2+ and 25+ avg), 🎢 Comeback Kid (biggest rank climb from mid-game to final), 💎 Perfectionist (most perfect (quality ≥ 0.999) answers, 2+), 🧨 Bold Explorer (the single wildest miss, quality ≤ 0.05).

## Host options
Set at `create-game` (handled in `server.js`):
- **Rounds**: 1–100, or `'infinite'`
- **Categories**: any subset of the 20 above, or a **preset** (`party` = everything, `creative` = drawing/dragging/guessing types, `geography` = maps/borders/rivers/flags/shapes, `classic` = buttons/sliders/sequence)
- **Regions**: optional geographic focus filter (one or more of the 6 continents); questions without a region tag always pass the filter
- **Difficulty**: `casual` / `mixed` (default) / `expert` — filters the question pool by the `difficulty` tag (casual keeps 1–2, expert keeps 2–3). **Expert is also meant to strip away help within a question**, not just pick harder ones: for Border Draw / River Run, casual gives start/end markers + the true length + a couple of known segments, mixed gives markers but no length, and expert gives no markers and no length at all (rivers: mouth marker only, no source) — forcing the player to find the endpoints themselves. Implemented in `games/trace.js` (`tierFor(game)` + `payload()`, which adds a `tier` field); the browser module shows a matching hint. Field-by-tier table in `docs/games/trace.md` §3. The same pattern now covers **Size It Up** (casual: ruler + readout, expert: no numbers), **Compass** (casual: distance hint, expert: no locator map), **Population Split** (casual: 3 population-hub dots, expert: no capital marker) and **Draw the Curve** (casual shows more of the line, expert less and hides the y-axis values) — each documented in its `docs/games/<type>.md`.
- **Pace**: `brisk` / `normal` (default) / `relaxed` — multiplies every non-answering pause (intro splashes, the wait after everyone answered, the time's-up buzzer pause, how long the leaderboard stays) by 0.7 / 1 / 1.4. The per-type answering time never changes. Defaults live in the `TIMING` block in `server.js`: intro 5 s first time / 2.2 s repeat, ≥4 s result-screen time after the last answer, 2.5 s buzzer, leaderboard ≥8 s + 0.5 s per extra player (cap 30 s).
- **Autoplay**: on (auto-advances after a dynamic pause — see `revealPause` per type, scaled up with player count) or off (host presses "Next Question →")
- **Mobile / TV mode**: Mobile = host also plays and enters a nickname; TV = host device is a shared screen, players answer on their own phones
- **Final round ×2**: doubles all scoring components on the last question
- **Intros**: a short splash (category name + how-to-play) shown the first time each category comes up in the game
- In-game host controls: **pause/resume** (freezes the exact remaining time, resumes from it), **skip** (jump straight to the leaderboard or straight to the next question), **end game** (scores the in-progress question first if mid-question), **kick player** (lobby only), **rematch** (same players/settings, fresh questions, new game ID, everyone moved automatically — offered after game-over)
- **QR join**: `GET /qr/:gameId` serves an SVG QR code of the join link; `GET /?join=ABC123` prefills the join screen
- **Reconnect tokens**: every host and player socket gets a token (issued on `create-game`/`join-game`) that a `rejoin` event exchanges for the game's current state — survives a page reload or dropped connection

## Client architecture
`public/client.js` is the core: sockets, screens, timer, sounds, leaderboard, config UI. It fetches `/api/games` on load to build the category picker (nothing about categories is hard-coded in HTML), then for each question dynamically loads `public/games/<type>.js` (+ `.css` if present) the first time that type appears. Each module calls `QuizGames.register({ type, mount(container, payload, api), result(resultData), reveal(container, revealData, ctx), metric(detail) })` — see `docs/ARCHITECTURE.md` §5 for the full contract, the `api` object passed to `mount` (submit/isHost/timeLimit/locked/onTick/sound/util), and the `QuizGames.util` helpers (haversine, tile layers, projection, polyline resample/simplify, ordinal/formatYear/escapeHtml).

**Basemap note**: Leaflet maps normally use CARTO Voyager (no labels), but that needs a paid API key to avoid a watermark. `CARTO_KEY` in `public/client.js` is currently empty, so the app falls back to Esri's keyless `World_Physical_Map` tiles (no place labels, `maxNativeZoom: 8`). Because those tiles only exist up to zoom 8, `util.tiles.streets()` stacks Esri's label-free `World_Imagery` satellite layer on top and fades it in from zoom 9 (0.55 → 0.85 → 1.0 at zoom 11+), so close-ups are sharp instead of a blur. Esri's `Canvas/World_Light_Gray_Base` was considered and rejected because, despite the name, it still shows labels — it would leak answers on map questions. If you get a free CARTO key, set `CARTO_KEY` to enable the nicer tileset. The dev harness has its own copy of this helper (`public/dev/harness.html`) — keep the two in sync.

## Data licences / attributions
Shown in the site footer (`public/index.html`): **Natural Earth** (country/river outlines, public domain), **WorldPop** (population grids for Population Split), **CARTO** (basemap, when a key is set), **Esri** (basemap fallback + satellite imagery for Bird's Eye), **game-icons.net** (Size It Up silhouettes, CC BY 3.0 — attribution required if reused elsewhere), **flagcdn.com** (flag images), **GeoNames** (the `cities15000` dataset, for Compass).

---

## Planned improvements

**Done since the v1 plan (kept here for history, not because they're still open):**
- Silhouette question type — built (`games/silhouette.js`, category `silhouettes`, 132 questions).
- Ancient / pre-year-0 timeline coverage — expanded (`content/ancient-timeline.json`); BCE formatting is handled throughout (`formatYear` in `games/_shared.js`, mirrored on the client).
- Map tolerance radius — implemented. `toleranceKm` is a validated optional field on map questions (`games/map.js`: `validate`, `toRow`/`fromRow`, `evaluate` all handle it — `effectiveDist = max(0, haversineDist − toleranceKm)`), and it's used for real scoring, not just a plan. Not yet independently verified: whether the leaderboard map reveal draws the tolerance circle, and whether the admin editor exposes the field — check `public/games/map.js` and `public/admin.html` if you need those.

- Spot the Fakes content pass — done 2026-09-05 (`content/fakes-2.json`, 30 → 60 sets).
- Server-side answer shuffling for MC-style types — done 2026-09-05 (`mcOrder` in `games/_shared.js`; mc/flag/silhouette/tune).
- Difficulty hint tiers for halves / sizeup / curve / compass — done 2026-09-05 (see Host options → Difficulty).
- Pacing pass + host Pace option + time's-up buzzer pause — done 2026-09-05 (`TIMING` in `server.js`).
- Size It Up rebuilt as a drag-to-resize, zoomable canvas — done 2026-09-05.
- Sharp basemap at high zoom (satellite layer fading in from zoom 9) — done 2026-09-05.

**Still open:**
- **User accounts** — schema is still just a plan (add a `users` table, optionally link questions to `created_by`); no login/session flow designed yet.
- **Free CARTO key** for the nicer Voyager basemap (`CARTO_KEY` in `public/client.js`).
- **Tune the pace defaults after real play-testing** — the `TIMING` numbers are reasoned defaults, not measured ones; if a real group finds leaderboards too long or intros too short, change them there (one place) rather than per module.

### Supplemental categories — keep but don't grow
Trivia, Emoji Riddles, Flags, Shape of Nations, Name That Tune are supporting acts among the classic types — quality over quantity there. The draw/map types are the differentiator; that's where new content effort should go.

---

## About the user
Complete beginner to web development. Knows basic Python and R from university but has never built a web app, used Node.js, or worked with a terminal for coding. This is their first web project.

## How to work with this user — follow these rules every session
1. **Every time you create or edit a file:** briefly explain (2–3 sentences) what that file does and why it exists.
2. **Every terminal command:** explain what the command actually does before they run it.
3. **Never assume web dev knowledge** — explain concepts simply when they come up.
4. **After each major step:** tell them what we just built and what the next step will be.
5. **Technical decisions:** explain which option was chosen and why, in plain language.
6. **Git commits and pushes:** after every larger set of edits (a feature, a redesign, a bug-fix batch), stage all changed files, commit with a clear message, and push to origin. Do this without being asked.
