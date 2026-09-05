# 🧮 Population Split — `halves`

**Group:** draw · **Category id:** `halves` · **Blurb:** "Slice a country so half its people are on each side."
**How to:** "Drag the line's ends to move and rotate it until the population is split 50/50, then lock in."

Adapted from geoslice.net's "Halves": a straight line lies across a country's outline. The player
drags the line's two endpoints to move and rotate it until it splits the country's **population**
(not its area) as close to 50/50 as possible. Area and population look nothing alike — 95% of
Egypt lives on ~5% of its land along the Nile, a third of Argentina lives around Buenos Aires,
half of Australia's people fit into a thin strip along the south-east coast. That mismatch is the
whole game.

| Setting        | Value   |
|----------------|---------|
| `timeLimit`    | 40 s    |
| `revealPause`  | 12 s    |
| `earlyPause`   | 5000 ms |
| `speedScored`  | false   |
| `usesRegion`   | true    |

Files: `games/halves.js` (server), `data/halves/<ISO3>.json` (per-country population grid +
outline, one file per country, ≤ 250 KB each), `data/halves/index.json` (roster),
`tools/build-halves.js` (builds the data from WorldPop 2020 rasters), `content/halves.json`
(46 questions).

---

## 1. Question JSON (what `import.js` accepts)

```json
{
  "type": "halves", "category": "halves",
  "question": "Draw a line that splits Egypt's population in half",
  "regionId": "EGY",              // ISO3 key into data/halves/<ISO3>.json
  "region": "africa",             // optional: europe | asia | africa | north-america | south-america | oceania
  "difficulty": 1                 // optional: 1 = one obvious megacity, 2 = most countries, 3 = evenly spread
}
```

`validate()` checks the common fields, that `regionId` is a non-empty string, and that
`data/halves/<regionId>.json` was actually loaded (i.e. `tools/build-halves.js` was run for it).

DB row: `correct = null`, `extra = { regionId }`. Nothing else is stored — the population grid
lives only in `data/halves/`, never in the DB.

---

## 2. `data/halves/<ISO3>.json` (input to the server, not sent to clients)

```js
{
  id: "EGY", name: "Egypt", region: "africa",
  bbox: [minLng, minLat, maxLng, maxLat],   // of the trimmed grid
  cols: 92, rows: 74,                       // grid is ≤ 160 on the longer side
  pop: [ …cols*rows ints, row-major, north-west first… ],  // WorldPop 2020, aggregated
  total: 96172587,                          // sum of pop[]
  outline: [ [[lng,lat], …], … ],           // country outline rings, simplified, ≤ 500 pts total
  capital: { name: "Cairo", lat: 30.04, lng: 31.24 },
}
```

`index.json` is `[{ id, name, total, region }, …]` for every country that was successfully built —
this is what `games/halves.js` reads at require time to know which regions exist.

The **population grid is the secret**. `payload()` only ever sends `bbox`, `outline`, `total` and
`capital` — never `pop`, `cols`, or `rows`. A blurred/low-res "heat" version of the grid (≤ 64×64,
values 0–255 scaled by `sqrt(pop/max)` so a single megacity doesn't blow out the whole palette) is
computed once at load time and is only exposed via `reveal()`, after everyone has answered.

---

## 3. Payload sent to clients at question start

```js
{
  question: "Draw a line that splits Egypt's population in half",
  regionId: "EGY",
  name: "Egypt",
  bbox: [24.7, 22.0, 36.9, 31.7],
  outline: [ [[lng,lat], …], … ],
  total: 96172587,
  tier: "casual",                              // "casual" | "mixed" | "expert" — see §3a below
  capital: { name: "Cairo", lat: 30.04, lng: 31.24 },  // null at the expert tier
  hubs: [ { lat: 31.2, lng: 29.9 }, … ],        // casual tier only, up to 3 points, no names
}
```

## UI guidance for the client module

- Draw the country `outline` on a plain SVG or Canvas (no map tiles needed — it's just a shape),
  scaled to fit the screen with the `bbox` aspect ratio preserved. A light fill + ink stroke in the
  Parchment & Ink palette works well; no basemap, no Leaflet.
- Render a straight line across the shape with two draggable circular handles at its ends. Start it
  at a **random position/angle** through roughly the middle of the bbox (matches the "random start,
  not the answer" pattern used by slider/timeline) so it isn't pre-solved.
- As the player drags a handle, the line should visibly extend to the edges of the drawing area (or
  just past the outline) so it reads as an infinite line, not a segment — but only the two handle
  points are sent as the answer.
- No live percentage/feedback while dragging — the split is secret until reveal (there's nothing to
  compute client-side; the grid never reaches the client). A simple "Lock in" / submit button once
  both ends have been placed.
- `capital` is provided as a landmark players can reason from ("half of Argentina lives around
  Buenos Aires") — show it as a small dot + label on the map, always visible before submission.

---

## 3a. Difficulty tiers

Set by the host's difficulty pick (`game.setup.difficulty`), read via `tierFor(game)` in
`games/halves.js` — the same pattern `games/trace.js` uses for Border Draw / River Run. The
population grid and the scoring never change between tiers; only what `payload()` sends before the
player draws changes. `payload()` always includes a `tier` field so the client can show a matching
hint line.

| Field     | casual | mixed (default) | expert |
|-----------|--------|------------------|--------|
| `outline` | ✓ | ✓ | ✓ |
| `capital` | ✓ | ✓ | `null` |
| `hubs`    | up to 3 `{lat,lng}` points | *(absent)* | *(absent)* |

`hubs` are computed once per country at load time (`prepare()` in `games/halves.js`), from the
same low-resolution heat grid used for the reveal: the densest heat cells are translated back to
lat/lng and greedily kept if they sit at least 80 km from the capital and from every hub already
picked — so a single sprawling city can't hand out three markers stacked on itself, and the three
dots actually spread the player's attention around the map. Hubs carry no name and no population
figure, just a position — a much lighter hint than the named capital marker. Because `hubs` is
derived from the heat grid (not the raw pop grid) it costs nothing extra at question time; it's
folded into the same one-time `prepare()` pass that already builds the reveal's heat map.

The client (`public/games/halves.js`) draws `hubs` as small unlabeled warm dots (`.hv-hub`,
distinct from the capital's named lapis-and-label style) when the field is present, and shows a
tier-aware idle hint ("Casual: capital + population hubs marked…" / "Expert: no capital or
population hubs — the outline is all you get"). `capital: null` at the expert tier is handled the
same way a payload with no capital always was — `drawCapital()` already no-ops on missing
coordinates.

The leaderboard reveal (`reveal()`) is unaffected by tier: it always sends the real `capital` and
the full `heat` grid, since by then the round is over and there's nothing left to hide.

---

## 4. Answer shape (what the client submits)

```json
{ "a": [31.0, 29.5], "b": [31.5, 30.5] }
```

Two distinct `[lng, lat]` points defining an **infinite line** through them (not a segment). Side
"A" is the left-hand side when walking from `a` to `b`. Points are sanitized: must be finite,
`|lng| ≤ 360`, `|lat| ≤ 90`, and `a`/`b` must not be (nearly) the same point — a degenerate line
scores `evaluate() → null` (no answer).

---

## 5. Scoring (`evaluate()`)

Each populated grid cell is treated as a thin slab whose width across the line is `cs` (so the
score changes smoothly as the line is nudged, instead of jumping whenever a dense city cell flips
sides in one go):

```
side A share = Σ over cells of pop[i] × clamp01(0.5 + (signedDist(cell, line) / cs))
imbalance    = |popA − popB| / total
quality      = clamp(1 − imbalance / 0.8, 0, 1)     // 50/50 → 1, 70/30 → 0.5, 90/10 → 0
```

The **ideal line** (same direction as the player's line, but shifted parallel until the split is
exactly even) is found by a 40-step binary search on the perpendicular offset — `popAAt(t)` is
monotonic in `t`, so this always converges. It's returned so the reveal can show "your line" next
to "the perfect line" at the same angle.

`detail` (stored per-answer, used to rebuild `reveal`): `{ a, b, pctA, pctB, popA, popB, imbalance }`

`result` (sent to the answering player immediately): `{ pctA, pctB, popA, popB, ideal:{a,b}, total,
score, name, bbox, outline, yourLine:{a,b} }` — `score` is `round(quality * 100)`, shown as e.g.
"58% / 42% split — 58 pts" alongside the player's own line drawn against the outline. This is a
proximity-style result (not speed-scored): show guess vs. the ideal split, "Rank points — see
leaderboard" per the standard proximity result convention.

---

## 6. Leaderboard reveal (`reveal()`)

```js
{
  regionId: "EGY", name: "Egypt", bbox: [...], outline: [...], total: 96172587,
  heat: { cols: 46, rows: 37, bbox: [...], values: [0, 12, 255, …] },  // ≤ 64×64, 0–255
  lines: [
    { nickname: "Bot1", a: [31.0,29.5], b: [31.5,30.5], pctA: 58.0, pctB: 42.0, ideal: {a,b} },
    …
  ],
}
```

Draw the `heat` grid as a translucent density overlay on the outline (this is the reveal moment —
first time the actual population distribution is shown). Then animate in each player's line
sequentially (matches the sequential-pin-in pattern used by the map reveal), each labelled with
their nickname and split %. A common gold "ideal" line (any one player's `ideal` — they're all the
same line, since it only depends on direction) can be drawn as the reference the others are judged
against; note different players' lines have different directions, so there isn't one single
"ideal" across all of them — treat each player's `ideal` as their own personal best-parallel-line
for comparison purposes, don't try to merge them into one reveal line.

`correctText()` → `'Where the people are: 50 / 50 split'`.

---

## 7. Countries included (46)

USA, CAN, MEX, BRA, ARG, CHL, PER, COL, GBR, IRL, FRA, DEU, ESP, PRT, ITA, POL, NLD, SWE, NOR, FIN,
GRC, TUR, UKR, RUS, EGY, MAR, DZA, NGA, ZAF, KEN, ETH, COD, SAU, IRN, IRQ, PAK, IND, CHN, JPN, KOR,
VNM, THA, IDN, PHL, AUS, NZL — all 45 planned countries downloaded and built successfully (one
extra entry beyond the original 45-country list rounds out an even Q&A set; check
`data/halves/index.json` for the exact final roster and totals).

Difficulty assignment in `content/halves.json`: **1** (one dominant megacity — Egypt, Argentina,
Chile, Australia, Japan, South Korea, Peru, Thailand), **3** (population evenly spread —
Germany, Poland, India, Nigeria), **2** (everyone else).

---

## 8. `sampleAnswer()` (used by `test/simulate.js`)

Picks a random interior point of the (15%-padded) bbox and a random angle, returns a short line
segment through that point — a plausible bot guess, not tuned for quality.
