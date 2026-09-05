# 🧭 Compass — game-type hand-off

**Type id:** `compass` · **Category:** `compass` (group `draw`) · **Server module:** `games/compass.js`
**Data:** `data/cities.json` (built by `tools/build-compass.js`) · **Questions:** `content/compass.json` (88)

> *"Which way is Tokyo from here? Point the needle."*

The player is shown two city names — a **from** city and a **to** city — and rotates a compass needle
to the direction in which the *to* city lies. The answer is the **initial great-circle bearing**
(0° = north, 90° = east, clockwise). This is deliberately surprising: on a globe the shortest route
from London to Tokyo starts out heading **north-north-east (32°)**, not east, because great circles
bend towards the pole. From New York, Madrid is **east-north-east (66°)**; from Buenos Aires, Sydney is
**south-south-west (205°)**.

Module settings: `timeLimit 20 s`, `revealPause 9 s`, `earlyPause 4000 ms`, `speedScored false`,
`usesRegion true` (region = continent of the **from** city).

---

## 1. Question JSON (what `import.js` accepts)

```json
{
  "type": "compass",
  "category": "compass",
  "question": "From Paris, which direction is Cairo?",
  "from": { "id": "paris", "name": "Paris", "lat": 48.8534, "lng": 2.3488 },
  "to":   { "id": "cairo", "name": "Cairo", "lat": 30.0626, "lng": 31.2497 },
  "region": "europe",
  "difficulty": 1
}
```

* `from` / `to` need `name`, `lat`, `lng`. `id` is optional; if only `{ "id": "london" }` is given the
  module fills in name/coordinates from `data/cities.json`.
* `validate()` rejects pairs closer than 50 km (bearing is meaningless) and further than 18 500 km
  (near-antipodal — every direction is "shortest").
* The bearing is **never stored**; it is computed from the coordinates every time
  (`bearingDeg` in `games/_shared.js`).
* DB row: `correct = NULL`, `extra = { from:{id,name,lat,lng}, to:{id,name,lat,lng}, region, difficulty }`.

---

## 2. Wire shapes

### `payload` — sent to every client on `new-question`

```json
{
  "question": "From Paris, which direction is Cairo?",
  "from": { "name": "Paris", "lat": 48.8534, "lng": 2.3488 },
  "to":   { "name": "Cairo" }
}
```

Only the **from** city has coordinates (so the client can draw a small locator map / "you are here").
The target has a name only — its position is the secret. Test: `JSON.stringify(payload)` must not
contain `to.lat` / `to.lng`.

### Difficulty tiers

How much of the **from** city the payload gives away — never the truth or the scoring, which are
identical at every difficulty — depends on `game.setup.difficulty` via `tierFor()` in
`games/compass.js`. The payload carries the result as `tier: 'casual' | 'mixed' | 'expert'` so the
client can word its hint, and the fields below are added or omitted per tier:

| Field                   | casual | mixed (and the internal `'normal'`) | expert |
|-------------------------|:------:|:------------------------------------:|:------:|
| `from.lat` / `from.lng` | ✅     | ✅ — today's behaviour, unchanged     | ❌ — `from` is `{ name }` only |
| `distanceKm`            | ✅     | ❌                                     | ❌ |

* **casual** — same coordinates as before, plus a `distanceKm` hint (great-circle distance between
  the two cities, rounded) so the client can show "About 1,200 km away".
* **mixed** — exactly today's payload: `from` has coordinates (so the locator map still draws), no
  `distanceKm`.
* **expert** — `from` drops to `{ name }` only. No coordinates means no locator map either — the
  player has to know where *both* cities are, not just aim from a map pin. `distanceKm` is dropped
  too (a hint with no map to anchor it against would be a bare number, not a fair one).

**The client module must treat `from.lat`/`from.lng` and `distanceKm` as possibly absent** — no
locator map, and no "About N km away" line, when the server left them out; the tier hint described
below stands in for them instead. `evaluate()` / `reveal()` are untouched: they read `q.from` /
`q.to` straight off the stored question, never off the payload, so the truth and every point value
are identical regardless of what the player was shown before aiming.

### `answer` — what the client module submits

```json
{ "bearing": 123.4 }
```

Degrees, clockwise from north. Any finite number is accepted and normalised into `[0, 360)`
(so `-30` and `330` are the same answer). Anything else (missing, string, NaN, Infinity) → answer rejected.

### `result` — sent back only to the answering player (`answer-result`)

```json
{
  "trueBearing": 119.9,
  "yourBearing": 150,
  "err": 30.1,
  "distanceKm": 3209,
  "trueName": "ESE",
  "yourName": "SSE",
  "from": { "name": "Paris", "lat": 48.8534, "lng": 2.3488 },
  "to":   { "name": "Cairo", "lat": 30.0626, "lng": 31.2497 },
  "score": 70
}
```

`trueName` / `yourName` are 16-point compass abbreviations (`N, NNE, NE, ENE, E, …`).
`score` is `round(quality × 100)` = the accuracy points.

### `detail` — stored per player, shown on the leaderboard row

```json
{ "bearing": 150, "err": 30.1 }
```

### `reveal` — sent to everyone with `show-leaderboard`

```json
{
  "from": { "name": "Paris", "lat": 48.8534, "lng": 2.3488 },
  "to":   { "name": "Cairo", "lat": 30.0626, "lng": 31.2497 },
  "trueBearing": 119.9,
  "trueName": "ESE",
  "distanceKm": 3209,
  "arrows": [
    { "nickname": "Anna", "bearing": 150,   "err": 30.1 },
    { "nickname": "Ben",  "bearing": 118.5, "err": 1.4  }
  ]
}
```

`arrows` is in the same order as the `answers` the core passed in (players who answered; non-answerers
are absent).

### `correctText` — leaderboard banner

`Cairo is 120° (east-south-east) from Paris` — degrees rounded, plus the long 16-point name.

---

## 3. Scoring

```
trueBearing = initial great-circle bearing from → to        (games/_shared.js bearingDeg)
err         = smallest angular difference (0–180°)          min(|a−b|, 360−|a−b|)
quality     = err ≤ 4  ? 1
            : clamp(1 − (err − 4) / 86, 0, 1)               → 0 at 90° off or worse
```

| err   | quality | accuracy pts |
|-------|---------|--------------|
| 0–4°  | 1.00    | 100 |
| 10°   | 0.93    | 93  |
| 20°   | 0.81    | 81  |
| 30°   | 0.70    | 70  |
| 45°   | 0.52    | 52  |
| 60°   | 0.35    | 35  |
| ≥ 90° | 0.00    | 0   |

Rank bonus (+50/+30/+15), streak and final-double come from the core (`scoring.js`); ties on quality
are broken by speed. `speedScored` is false, so answering fast does not raise accuracy points.

---

## 4. Client module guidance (`public/games/compass.js` + `.css`)

### mount(container, payload, api)

**What to draw**

1. Prompt: the `payload.question` text, with the two city names visually emphasised
   (e.g. `From **Paris**, which direction is **Cairo**?`).
2. A large **compass rose** (SVG, ≥ 260 px, fills the width on phones): outer ring with tick marks
   every 10° (longer at 30°, longest at 90°), the 4 cardinal letters **N E S W** in Cinzel/gold, the
   intercardinals (NE, SE, SW, NW) smaller. North is fixed at the top — the rose never rotates, only
   the needle. Parchment face, ink ticks, gold accents (`var(--gold)`, `var(--ink)`, `var(--parchment)`).
3. A **needle** (gold pointer with a dark tail) pivoting on the centre, drawn as an SVG group with
   `transform="rotate(θ)"`. Under the needle, a small label at the centre: the from-city name
   (the player is standing *there*).
4. A live readout under the rose: `123° · ESE` (degrees rounded, 16-point name). Keep the numeric
   degree — it lets players who "know" a bearing dial it in precisely.
5. Optional but nice: a tiny (≈ 120 px) inset locator map centred on `payload.from` at world zoom
   (Leaflet with `util.tiles.streets()`, no interaction), just to remind people where the start city
   is. Never show the target on it. **Only draw it when `payload.from.lat`/`.lng` are present** — at
   the expert tier `from` is `{ name }` only (see "Difficulty hint" below) and the map must be
   skipped cleanly, not shown empty or thrown at with `NaN` coordinates.
6. When `payload.distanceKm` is present (casual tier only), show a small "About 1,200 km away" line
   near the prompt — omit it entirely rather than showing "about 0 km" when the field is absent.
7. A **Lock in** button (theme primary style). Disabled state after submit.

**Interaction**

* Pointer events (`pointerdown / pointermove / pointerup`, `setPointerCapture`) on the SVG, with
  `touch-action: none`. On every move compute `θ = atan2(dx, −dy)` from the rose centre to the pointer,
  in degrees, normalised to `[0, 360)`. The needle follows the finger anywhere on the rose — no need
  to grab the needle tip itself.
* Start the needle at a **random bearing** (avoid anchoring at north).
* Snap gently: while dragging, no snapping; on release, keep the exact angle (do not round to
  16 points — 4° is the perfect window, players should be able to fine-tune).
* Nice-to-have: `[−1°] [+1°]` nudge buttons or arrow keys for precision; a double-tap on a cardinal
  letter jumps the needle there.
* `api.sound.click()` on lock-in.
* `submit({ bearing: θ })` once; then freeze the needle (ignore pointer events), dim the rose slightly,
  and show "Locked: 123° ESE". Respect `api.locked`.
* Host in TV mode (`api.isHost && api.tvMode`): show the prompt, a static rose with **no needle** and
  no lock-in button (the audience should not be shown a hint), plus the answered-count the core renders.
* Recompute the rose size on `ResizeObserver` / `orientationchange`; it should be `min(containerWidth,
  60vh)` square.

**Difficulty hint (`payload.tier`)**

The idle hint line (shown before the player has moved the needle) doubles as the difficulty tell,
the same trick `public/games/trace.js` uses:

| `payload.tier` | Idle hint |
|----------------|-----------|
| `casual`       | "Casual: your starting point is shown, with how far away the target is" |
| `mixed`        | "You're shown where you're starting from" |
| `expert`       | "Expert: no locator map — you'll need to know both cities" |

The result screen and the leaderboard reveal are unaffected: both come from `evaluate()` /
`reveal()` on the server, which always carry the full `from`/`to` coordinates regardless of what
the player was shown while aiming.

### result(resultData)

Return `{ icon, iconColor, heading, subtitle, html }`:

* `err ≤ 4` → icon 🎯, gold, heading "Spot on!"
* `err ≤ 20` → icon 🧭, green, heading "Close — {err}° off"
* `err ≤ 60` → icon 🧭, amber, heading "{err}° off"
* else → icon 🌀, red, heading "Way off — {err}°"
* `subtitle`: `{to.name} is {trueBearing}° ({trueName}) from {from.name} · {distanceKm.toLocaleString()} km`
* `html`: a small rose (≈ 140 px) with **two needles**: gold = true bearing, player colour/ink = yours,
  and the `.compare-*` rows: *Your needle* `150° SSE` / *True bearing* `120° ESE`.

### reveal(container, revealData, ctx)

The reveal is where the "really?!" happens, so make it the hero:

1. **Big rose** (same component as mount, read-only) with:
   * a thick **gold** needle at `trueBearing`, labelled with `to.name` at its tip;
   * one thin coloured needle per entry in `arrows`, colour from `util.colorFor(index)` (index = position
     in `ctx.players` so colours match the leaderboard), nickname label at the tip; highlight
     `ctx.myNickname` (thicker / outlined);
   * animate: needles sweep in from north one after the other (~120 ms stagger), gold one last with a
     short "ding" (`api` is not passed to reveal — use CSS transitions only).
   * a translucent gold wedge (`±4°`) around the true bearing = the perfect zone.
2. **Great-circle mini map** to explain *why*: a Leaflet map (`util.tiles.streets()`, non-interactive,
   `fitBounds` on both cities) drawing the great-circle arc between `from` and `to` as a polyline
   (interpolate ~64 points along the great circle — spherical interpolation, *not* a straight
   lat/lng line — that curve is the whole point of the game), gold markers at both cities, and a
   short straight "rhumb" dashed line for contrast if the bearing difference is > 15°.
   Caption: `Shortest path: {distanceKm} km, starting {trueBearing}° {trueName}`.
3. Under it, the sorted list of players by `err` is already the leaderboard, so keep the reveal focused
   on the two visuals. On small screens stack rose above map; on TV side by side.

### metric(detail)

Return `` `${Math.round(detail.err)}° off` `` (`'Spot on'` when `err ≤ 4`).

---

## 5. Data & tooling

`tools/build-compass.js` (idempotent, `--preview` prints every pair with its bearing):

1. Reads the GeoNames `cities15000` dump from `tools/raw/cities15000.txt` (unzips `cities15000.zip`
   if needed — gitignored; get it from https://download.geonames.org/export/dump/cities15000.zip).
2. Looks up a curated list of ~170 cities by `country code + name` (alternate names included), picks
   the most populous match, and **fails loudly** if a city is missing or matches a tiny place.
3. Region via `tools/lib/geo.js` (`countryOf` → `regionForCountry`, falling back to `regionForIso2`),
   with two overrides (Istanbul → europe, Honolulu → oceania).
4. Writes `data/cities.json` = `{ "london": { name, country, lat, lng, pop, region }, … }` (23 KB).
5. Builds `content/compass.json` from a curated `PAIRS` list `[fromId, toId, difficulty]` — the bearing
   is always computed, never typed. Pairs > 18 500 km are skipped with a warning.

Current content: 88 questions — difficulty 1: 25, 2: 45, 3: 18. Mix of same-continent pairs
(Europe 17, Asia 13, Africa 6, N. America 9, S. America 5, Oceania 3) and 35 intercontinental
"the great circle bends" pairs (London→Tokyo 32° NNE, New York→Madrid 66° ENE, Los Angeles→Tokyo
306° NW, Moscow→Los Angeles 340° NNW, Delhi→New York 338° NNW, Beijing→New York 8° N, …).

To add a question: append to `PAIRS` (and `CITIES` if a city is new), re-run the tool, then
`node import.js content/compass.json`.

---

## 6. Testing

```
node import.js content/compass.json --dry-run
cp quiz.db /tmp/test-compass.db
QUIZ_DB=/tmp/test-compass.db node import.js content/compass.json
QUIZ_DB=/tmp/test-compass.db node test/simulate.js --categories compass --rounds 6 --verbose
```

Module internals exported for tests: `_compassPoint(deg)`, `_angularError(a, b)`, `_bearingQuality(err)`.
