# 🖊️🌊 Border Draw & River Run — `trace`

One mechanic, two categories: **draw a line on a blank ink-on-parchment map**.

| Category  | Label         | Emoji | Group  | Blurb                                          | How-to                                                   |
|-----------|---------------|-------|--------|------------------------------------------------|----------------------------------------------------------|
| `borders` | Border Draw   | 🖊️   | `draw` | Two neighbours, one missing border. Draw it.   | Draw one line where the border runs, then lock in.       |
| `rivers`  | River Run     | 🌊    | `draw` | Trace a famous river from mouth to source.     | Draw the river's course between the two markers, then lock in. |

* **`borders`** (the idea comes from reborder.app): two neighbouring countries are drawn as
  **one filled blob** — the border between them is simply not there — and the player draws
  where they think it runs. The two ends of the missing border are marked, so it is always
  clear *which* line is wanted.
* **`rivers`**: a coastline map with two markers — the river's **mouth** and its **source** —
  and the player traces the river's course between them.

Module settings: `timeLimit: 45`, `revealPause: 12`, `earlyPause: 5000`,
`speedScored: false`, `usesRegion: true`.

---

## 1. Question JSON (what `import.js` accepts)

```jsonc
// content/borders.json — one entry per country pair
{ "type": "trace", "category": "borders",
  "question": "Draw the border between Spain and France",
  "pairId": "ESP-FRA",           // key in data/borders.json
  "region": "europe", "difficulty": 1 }

// content/rivers.json — one entry per river
{ "type": "trace", "category": "rivers",
  "question": "Trace the course of the Nile",
  "riverId": "nile",             // key in data/rivers.json
  "region": "africa", "difficulty": 1 }
```

`validate()` checks that the id actually exists in the data file, so a typo is caught at
import time rather than mid-game. Stored in the DB as `extra = { pairId }` / `extra = { riverId }`;
`correct` is always `NULL`.

Current content: **288 border pairs** and **79 rivers**, all six regions represented.

---

## 2. Data files

Both are generated, committed, and read **once at require time** by `games/trace.js`.

> ⚠️ **These two files contain the answer keys** (`border`, `shapes`, `path`). If the core ever
> serves `data/` as a public static directory, these two must be excluded — otherwise a player
> can just fetch `/data/borders.json` and read the answer. Everything the client legitimately
> needs is already in the payload; the client module must **never** fetch these files itself.

### `data/borders.json` — built by `tools/build-borders.js` (2.5 MB, 293 pairs)

```jsonc
"ESP-FRA": {
  "id": "ESP-FRA",
  "a": { "iso3": "ESP", "iso2": "ES", "name": "Spain" },
  "b": { "iso3": "FRA", "iso2": "FR", "name": "France" },
  "region": "europe",
  "bbox": [-9.236, 36.026, 9.556, 51.097],   // [minLng, minLat, maxLng, maxLat] of both shapes
  "clipped": false,     // true = a giant neighbour was cropped to a window around the small one
  "shapes": { "a": [ring…], "b": [ring…] },  // TRUE outlines, border included — REVEAL ONLY
  "blob":   [ring…],                          // same rings, border flattened to a straight chord
  "outline":[polyline…],                      // the real coast / third-country edges only
  "known":  [polyline…],                      // parts of the A–B border that are given away
  "border": [[lng,lat]…],                     // THE ANSWER — the hidden run
  "endpoints": [[…],[…]],                     // border[0] and border[last]
  "closed": false,                            // true = the border is a full loop (LSO-ZAF)
  "bridged": false,                           // the run was bridged across a micro-state
  "lengthKm": 511, "knownKm": 0
}
```

Why `blob` exists: `shapes.a` and `shapes.b` each contain the border vertices, so sending them
would hand the player the answer. In `blob`, every piece of a ring that runs along the shared
border is replaced by a **straight chord** between its two ends. The sliver between chord and
real border always belongs to one of the two countries, so `A' ∪ B'` is still exactly `A ∪ B`:
**fill every `blob` ring in one single colour and you get the correct silhouette**, with no
trace of the border's shape anywhere in the data.

`outline` holds only the *outer* edges (coast, borders with third countries). Stroke those and
the chords stay invisible — which is the whole visual trick.

### `data/rivers.json` — built by `tools/build-rivers.js` (1.2 MB, 79 rivers)

```jsonc
"nile": {
  "id": "nile", "name": "the Nile", "region": "africa",
  "path": [[31.237,30.124], … ],   // THE ANSWER — mouth first, source last, ≤ 400 points
  "bbox": [29.856, 13.896, 34.432, 31.863],   // path bbox padded by 12 %
  "lengthKm": 2744,                            // length of `path`, not the textbook length
  "mouth":  [31.237, 30.124],                  // = path[0]
  "source": [32.49, 15.635],                   // = path[last]
  "context": [ring…]                           // land outlines in the window, ≤ 1500 points total
}
```

Natural Earth stores a river as dozens of separate line pieces; the build script chains them
end-to-end (tolerance 0.02°) and keeps the longest chain. `lengthKm` is therefore the length of
the *chained* path — for the Nile that is 2 744 km, not the full 6 650 km. Scoring uses this
number, so that is the right one.

Rebuild either file with `node tools/build-borders.js` / `node tools/build-rivers.js`
(add `--verbose` to see every pair/river and why anything was skipped). Both are idempotent.

---

## 3. Payload (server → every client at question start)

**Contains no part of the hidden line.** Verified by `test/simulate.js`'s leak check and by a
vertex-level check in the build: not one interior vertex of `border` appears in `blob`/`outline`.

### Difficulty tiers

How much of the answer's *shape* is given away — never the truth or the scoring, which are
identical at every difficulty — depends on `game.setup.difficulty` via `tierFor()` in
`games/trace.js`. The payload carries the result as `tier: 'casual' | 'mixed' | 'expert'` so the
client can word its hint, and the fields below are added or omitted per tier:

| Field         | casual | mixed (and the internal `'normal'`) | expert |
|---------------|:------:|:------------------------------------:|:------:|
| `endpoints` *(border)* | ✅ | ✅ | ❌ |
| `closed` *(border)*    | ✅ | ✅ | ❌ — meaningless with no marks to draw it on, so it isn't sent unused |
| `mouth` *(river)*      | ✅ | ✅ | ✅ — a river must reach the sea *somewhere*, so this stays even at expert |
| `source` *(river)*     | ✅ | ✅ | ❌ |
| `lengthKm` *(both)*    | ✅ | ❌ | ❌ |

Everything else (`blob`/`outline`/`known`/`names`/`clipped` for borders; `context`/`name` for
rivers) is unaffected by difficulty — hiding the two blended countries or the river's shape would
make the question unanswerable, not harder.

**The client module must treat every optional field above as possibly absent** — no gold marks
for a missing `endpoints`/`source`, no "≈ N km" hint for a missing `lengthKm`, and the tier hint
described in §9 stands in for them instead. `evaluate()` / `reveal()` are untouched: they read the
geometry straight from `data/borders.json` / `data/rivers.json`, never from the payload, so the
truth and every point value are identical regardless of what the player was shown.

### `mode: 'border'` (7–25 KB)

```jsonc
{
  "mode": "border",
  "question": "Draw the border between Germany and Poland",
  "bbox": [5.858, 47.279, 24.106, 54.903],
  "blob":    [[[lng,lat]…], …],   // 1–8 closed rings → fill ALL of them in ONE colour
  "outline": [[[lng,lat]…], …],   // open polylines → stroke these (the real coast)
  "known":   [[[lng,lat]…], …],   // parts of this border that are shown solid (often empty)
  "names":   { "a": "Germany", "b": "Poland" },
  "clipped": false,    // true → a huge neighbour was cropped; don't draw a frame around it
  "tier": "casual",    // 'casual' | 'mixed' | 'expert' — see the table above
  "endpoints": [[14.2589,53.7296],[14.8094,50.859]],   // OPTIONAL — absent at 'expert'
  "closed": false,      // OPTIONAL — absent at 'expert'. true → endpoints are the same point
  "lengthKm": 361        // OPTIONAL — only present at 'casual'. Fair hint: how long the missing border is
}
```

### `mode: 'river'` (3–20 KB)

```jsonc
{
  "mode": "river",
  "question": "Trace the course of the Nile",
  "name": "the Nile",
  "bbox": [29.856, 13.896, 34.432, 31.863],
  "context": [[[lng,lat]…], …],   // closed land rings → fill as land
  "mouth":  [31.237, 30.124],     // always present, at every tier
  "tier": "casual",               // 'casual' | 'mixed' | 'expert' — see the table above
  "source": [32.49, 15.635],      // OPTIONAL — absent at 'expert'
  "lengthKm": 2744                // OPTIONAL — only present at 'casual'
}
```

## 4. Answer (client → server)

```jsonc
{ "line": [[lng, lat], [lng, lat], …] }     // 2 – 600 points, in drawing order
```

Direction does not matter — scoring is symmetric. Duplicated consecutive points, non-numbers and
out-of-range coordinates are dropped server-side; fewer than 2 usable points, a missing `line`,
or more than 600 points → the answer is **rejected** (`answer-rejected`), so the client should
resample its own stroke down to ~150–300 points before submitting.

## 5. Result (server → the answering player only)

```jsonc
{ "score": 66, "errKm": 73.1, "rating": "Border Guard",
  "truth": [[lng,lat]…],          // the true line, now safe to draw
  "bbox": [29.856,13.896,34.432,31.863],
  "mode": "river" }
```

Ratings by score: ≥ 90 `Master Cartographer` · ≥ 75 `Chief Surveyor` · ≥ 55 `Border Guard` ·
≥ 35 `Weekend Hiker` · ≥ 15 `Lost Tourist` · else `Wrong Continent?`

## 6. Detail (stored per player, used for leaderboard rows and the reveal)

```jsonc
{ "errKm": 73.1, "line": [[lng,lat]… ≤ 100 pts], "score": 66 }
```

`metric(detail)` in the client module should render something like **`73 km off`**.

## 7. Reveal (server → everyone, with the leaderboard)

```jsonc
// borders
{ "mode": "border", "bbox": […],
  "truth": [[lng,lat]…],                       // the real border
  "shapes": { "a": [ring…], "b": [ring…] },    // now the two countries CAN be told apart
  "outline": [polyline…], "known": [polyline…],
  "names": { "a": "Spain", "b": "France" },
  "lines": [ { "nickname": "Ana", "line": [[lng,lat]…], "score": 82, "errKm": 21.4 }, … ] }

// rivers
{ "mode": "river", "bbox": […], "truth": [[lng,lat]…],
  "name": "the Nile", "context": [ring…], "mouth": […], "source": […],
  "lines": [ … ] }
```

`lines` is already sorted best score first.

`correctText(q)` → `"Spain – France border"` / `"The Nile"`.

---

## 8. Scoring

Both lines are projected into a local flat kilometre frame around the map centre
(`x = lng × 111.32 × cos(midLat)`, `y = lat × 110.57`) and resampled to **120 evenly spaced
points** each. Then:

```
d1 = mean distance from each TRUE sample    to the player's polyline   (coverage)
d2 = mean distance from each PLAYER sample  to the true polyline       (precision)

errKm = 0.5 × (d1 + d2)

T = clamp(0.08 × lengthKm, 20 km, 150 km)      // the error that "costs about a third"

quality = 1                       if errKm ≤ 0.02 × T
        = 0                       if errKm > 3 × T
        = exp(−(errKm / T)^1.2)   otherwise

if the drawn line is shorter than 25 % of lengthKm →  quality × 0.3
```

Two averages are used because either one alone is cheatable: `d1` alone lets you score by
scribbling densely on one corner, `d2` alone lets you score by drawing all over the map.

The 150 km cap on `T` is a deliberate departure from a pure `0.08 × length` rule: without it a
5 000 km border (USA–Canada) handed out ~80 points for a single straight line.

What the numbers feel like in practice:

| Attempt                                   | Spain–France (511 km) | Canada–USA (5 620 km) | Nile (2 744 km) |
|-------------------------------------------|----------------------|------------------------|-----------------|
| exact trace                                | 100                  | 100                    | 100             |
| whole line shifted 0.05° (~5 km)           | 91                   | 98                     | 99              |
| whole line shifted 0.15° (~16 km)          | 72                   | 95                     | 95              |
| straight line between the two markers      | 65                   | 43                     | 66              |
| a dot / tiny scribble                      | 1                    | 0                      | 0               |

Egypt–Sudan scores 100 for a straight line — because that border *is* the 22nd parallel. That is
a feature, not a bug: it is exactly the "oh!" moment the category is for.

The core then turns `quality` into points as usual (`scoring.js`): 0–100 accuracy points,
+50/+30/+15 rank bonus, streak bonus. `speedScored` is false, so answering fast never helps —
but speed still breaks ties on equal quality.

---

## 9. Client module guidance — `public/games/trace.js`

### Projection

Use `util.project(lng, lat, bbox, w, h)` from `core/geo.js` for everything; the payload `bbox`
is already padded, so fit it to the canvas with a small margin and **preserve the aspect ratio**
(letterbox — a squashed country is unrecognisable). Recompute on resize / `orientationchange`.

An SVG is the easier choice here (crisp strokes, no redraw loop, hit-testing not needed); a
canvas is fine too. Either way put `touch-action: none` on the drawing surface.

### Drawing surface — both modes

* One pointer stroke = the answer. `pointerdown` starts a fresh line (drawing again **replaces**
  the previous attempt — say so with a small hint), `pointermove` appends, `pointerup` ends it.
* Append a point only when it is more than ~3 px from the previous one, and simplify to
  ≤ 300 points before `submit` (the server rejects > 600).
* Show an **Undo / Clear** button and a **Lock in** button. Lock in is disabled until the line
  has at least 2 points. After `submit` freeze everything (`api.locked`).
* Ink look: stroke `var(--gold)` at ~3 px with round caps/joins while drawing.
* TV / host-passive view (`api.isHost && api.tvMode`): draw the map, the markers and the prompt,
  but no drawing surface — just the "N of M have drawn" progress the core already renders.
* The live "your line: N km" readout (the length of what the player has drawn so far) is always
  shown, at every tier — only the pre-drawn scaffolding (gold marks, the "≈ N km" length hint)
  varies by difficulty.

### Difficulty hint (`payload.tier`)

Draw the gold `endpoints` / river `source` marker only when the field is present in the payload
(§3), and swap the idle hint (shown before the player has drawn anything) for one that names the
tier instead of pointing at marks that may not be there:

| `payload.tier` | Border idle hint | River idle hint |
|----------------|-------------------|------------------|
| `casual`       | "Drag one stroke between the two gold marks" | "Drag from the mouth 💧 to the source ○ in one stroke" |
| `mixed`        | "Start and end are marked" | "Start and end are marked" |
| `expert`       | "Expert: nobody shows you where it starts and ends — draw the whole border from memory" | "Expert: only the mouth is marked — find the source yourself" |

The result screen and the leaderboard reveal are unaffected: both come from `evaluate()` /
`reveal()` on the server, which always carry the full truth regardless of what the player was
shown while drawing.

### `mode: 'border'`

1. Fill **every** ring of `blob` with the same land colour (`var(--ink)` at low opacity over
   parchment reads well). One colour is mandatory — two colours would reveal the border.
2. Stroke each `outline` polyline in the ink colour (~1.5 px). Do **not** stroke the blob rings
   themselves: their chord segments are exactly where the border is hidden.
3. Stroke each `known` polyline as a solid thin line — these are bits of the same border that are
   given away (e.g. the Alaska stretch of Canada–USA).
4. Draw the two `endpoints` as small gold circles with a subtle pulse: they are the "start here,
   end there" affordance. When `closed` is true both endpoints are the same point — label it
   "start & finish" and expect a loop (only LSO–ZAF today).
5. Put the two country names in the corners (`names.a`, `names.b`) — the player must know which
   two countries are fused. Placing them near the two halves' centroids is nicer but optional.
6. `lengthKm` is a fair hint: "the missing border is about 361 km long".
7. `clipped: true` means one country was cropped to the window; do not draw a border/frame around
   the map, or the crop edge looks like a coastline.

### `mode: 'river'`

1. Fill every `context` ring as land; leave the rest as sea (a slightly cooler parchment).
2. Draw the `mouth` marker as a filled droplet/circle labelled **Mouth** and the `source` as a
   small ring labelled **Source**. Different shapes, not just different colours.
3. Show the river's name and `lengthKm` ("about 2 744 km to trace").
4. Nothing else — no other rivers, no lakes. The blank map is the challenge.

### Result screen — `result(resultData)`

```js
{ icon: '🖊️', iconColor: …, heading: resultData.rating,
  subtitle: `${resultData.errKm} km average error`,
  html: '<svg …>'   // small map: the truth in gold, the player's line in white
}
```
Score buckets map neatly to icons: ≥ 75 🏅, ≥ 55 🖊️, ≥ 35 🥾, else 🧭.

### Reveal — `reveal(container, revealData, ctx)`

* Re-draw the map at the reveal size: for `border` use `shapes.a` / `shapes.b` filled in **two
  different tints** so the border finally reads; for `river` re-use `context`.
* Animate the `truth` line in first (gold, ~600 ms path-length dash animation), then the players'
  `lines` one at a time (~250 ms apart), each in `util.colorFor(i)`, with the nickname at the end
  of the line and `score`/`errKm` in a compact side list.
* Highlight `ctx.myNickname`'s line (thicker, full opacity; others at ~55 %).
* Lines are already sorted best-first — reveal worst-first for suspense and finish on the winner.
* Keep the whole animation under ~6 s; `revealPause` is 12 s.

### `metric(detail)`

```js
metric: d => (d && d.errKm != null) ? `${Math.round(d.errKm)} km off` : ''
```

---

## 10. Content notes

* `content/borders.json` — 288 pairs. Difficulty 1 for the famous ones (Spain–Portugal,
  USA–Canada, Germany–Poland), 2 for solid-trivia neighbours, 3 for the obscure ones. Every
  pair is tagged with the region of the border itself (French Guiana's pairs are
  `south-america`, not `europe`).
* `content/rivers.json` — 79 rivers. Prompts name the river and, when it is not a household
  name, add a country hint: *"Trace the course of the Ebro (Spain)"*.
* Deliberately absent: the Okavango, the Salween, the Shannon, the St. Lawrence, the Snake and
  the Godavari — Natural Earth carries only a fragment of each, which would make an
  unrecognisable question. `tools/build-rivers.js --verbose` prints the reason for every skip.
