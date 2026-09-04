# 📈 Draw the Curve — `curve`

**Group:** draw · **Category id:** `curves` · **Blurb:** "You know how it started. Draw how it went on."
**How to:** "The start of the chart is given — draw the rest of the line with your finger, then lock in."

A chart shows the *start* of a real time series (e.g. world population, 1960–1975). The player
drags/draws the rest of the line, freehand, up to the last year, then locks it in. The reveal
overlays the true line and every player's line on the same axes. Inspired by the NYT "You Draw It"
charts.

| Setting        | Value    |
|----------------|----------|
| `timeLimit`    | 40 s     |
| `revealPause`  | 12 s     |
| `earlyPause`   | 5000 ms  |
| `speedScored`  | false    |
| `usesRegion`   | false    |

Files: `games/curve.js` (server module), `tools/build-curves.js` (fetches/builds the data —
`node tools/build-curves.js` to rebuild, `--offline` to use only the cache), `data/curves-src.json`
(full-resolution cache of every fetched series, gitignored inputs not required at runtime),
`content/curves.json` (56 ready-to-import questions).

Every question carries its **own** (already-thinned) series in the DB row — the game needs no
network at play time. `data/curves-src.json` exists only so `tools/build-curves.js` can re-cut the
question list (different years/step/axis) without re-hitting the network.

---

## 1. Question JSON (what `import.js` accepts)

```json
{
  "type": "curve", "category": "curves",
  "question": "World population, 1960–2024 (billions)",
  "series": [[1960, 3.03], [1962, 3.14], "...", [2024, 8.16]],
  "xLabel": "Year", "yLabel": "Population (billions)", "unit": "bn",
  "yMin": 0, "yMax": 11,
  "knownFraction": 0.25,
  "decimals": 2,
  "source": "World Bank",
  "region": "asia",       // optional — set only when the subject has an obvious continent
  "difficulty": 1          // optional: 1 = everyone knows the shape, 2 = solid, 3 = expert/surprising
}
```

- `series` — 5–60 points `[x, y]`, `x` strictly increasing integers (years). This is the ENTIRE
  truth; the server splits it into "known" (shown before drawing) and "hidden" (what's scored).
- `yMin` / `yMax` — the fixed axis range shown to the player. `validate()` requires ≥ 10 %
  headroom between the series' actual min/max and the axis edges (so the line never touches the
  top/bottom), unless `yMin` is exactly `0`, which then only constrains the top.
  Aim for the truth using **40–80 %** of the axis height (the build script prints a warning line
  when a series falls outside that band — it's a quality target, not a hard validation rule).
- `knownFraction` (0.1–0.5, default 0.25) — the share of the x-range revealed before the player
  starts drawing. At least 2 points are always shown, and never the whole series.
- `decimals` (0–4, default 2) — how values are rounded/displayed everywhere (payload, reveal,
  `correctText`).
- `unit` — short suffix shown after the number: `"bn"`, `"%"`, `"yrs"`, `"°C"`, `""` (none), or the
  special case `"$"` which is prefixed instead of suffixed (`"$1,234.00"` not `"1,234.00 $"`).

DB row: `correct` = the last value's string form (handy when browsing the raw DB — not used for
scoring), `extra = { series, xLabel, yLabel, unit, yMin, yMax, knownFraction, decimals, source }`.

---

## 2. `payload(q)` — what every client receives when the question starts

**The hidden points are never sent** — only their bare x values, inside `xs`.

```json
{
  "question": "World population, 1960–2024 (billions)",
  "xs": [1960, 1962, 1964, "...", 2024],
  "known": [[1960, 3.03], [1962, 3.14], [1964, 3.28], [1966, 3.41]],
  "xMin": 1960, "xMax": 2024,
  "yMin": 0, "yMax": 11,
  "xLabel": "Year", "yLabel": "Population (billions)", "unit": "bn", "decimals": 2
}
```

`known` is a prefix of `xs`/the real series (with y-values). Every x in `xs` **after** `known`'s
last entry is hidden — the player must supply a y for each of those, in order.

### UI guidance — question screen
- Draw a line chart on a fixed-size canvas/SVG mapping `[xMin, xMax] × [yMin, yMax]` to pixels.
  Plot `known` as a solid line immediately (this is real data, always visible).
- From the last known point onward, let the player drag/drui a continuation. Recommended
  interaction: track pointer x → find the nearest `xs` entry after `known` → set that x's y from
  pointer y (clamped to `[yMin, yMax]`) → redraw the line so far. A simple "drag anywhere on the
  canvas, y follows the finger, x is nearest gridline" model works well on touch.
  A number input mirroring the *currently dragged point*'s value (like the slider/timeline
  screens) helps precision on desktop.
  Auto-fill any x's the player skips by linear interpolation between drawn points before submit,
  so `ys.length` always equals the hidden count — the server treats a still-`null` entry as a full
  miss (mae contribution of 1.0 for that point), so submitting gaps is legal but costly.
- Show axis labels (`xLabel` on the x-axis, `yLabel` — plus `unit` — on the y-axis) and gridlines.
  Timer bar as usual (40 s).
- Submit answer shape: `{ "ys": [number|null, ...] }` — one entry per hidden x, in the same order
  as `xs.slice(known.length)`.

---

## 3. `evaluate(q, answer)` — scoring

For every hidden year, error = `|drawn_y − truth_y| / (yMax − yMin)` (a share of the axis height).
A gap (`null`/`undefined`/non-numeric) counts as a full miss, error = 1. `mae` = mean of all those
errors, rounded to 4 dp. If **nothing** was drawn (`drawn === 0`), `evaluate` returns `null` — the
client should not submit an entirely-empty answer (treat it like "no answer").

```
quality = 1                          if mae ≤ 0.015  (≤ 1.5 % of the axis — "perfect")
quality = clamp(1 − mae / 0.30, 0, 1) otherwise        (mae ≥ 30 % of the axis → 0)
```

Points are **rank-based** (standard scoring.js pipeline): players are ranked by `quality`
descending (closest curve first), rank points 1st=10 … 6th+=1, speed is the tiebreaker on equal
quality. This is the same "proximity" pattern as slider/timeline/map — `curve` just adds an extra
dimension (a whole line instead of one number).

`detail` (stored per-answer, used to build the reveal): `{ ys, mae }` — `ys` is the player's drawn
values, clamped to `[yMin, yMax]` and rounded to 3 dp (`null` preserved for gaps).

`result` (sent back to that one player immediately): `{ truth, ys, mae, score, unit, decimals,
lastTruth: [x, y], lastYours: number|null }` where `score = round(quality * 100)`.

### UI guidance — result screen
Overlay the player's drawn line (`ys`) against the truth (`truth`, the full series) on the same
axes used at play time. Show `mae` as a rough "how far off" indicator and the rank-pending message
("Rank points — see leaderboard") matching the slider/timeline convention, since final points
depend on everyone's answers.

---

## 4. `reveal(q, answers)` — leaderboard screen (everyone)

```json
{
  "xs": [1960, 1962, "...", 2024],
  "truth": [[1960, 3.03], "...", [2024, 8.16]],
  "known": [[1960, 3.03], [1962, 3.14], [1964, 3.28], [1966, 3.41]],
  "xMin": 1960, "xMax": 2024, "yMin": 0, "yMax": 11,
  "xLabel": "Year", "yLabel": "Population (billions)", "unit": "bn", "decimals": 2,
  "source": "World Bank",
  "lines": [
    { "nickname": "Bot1", "ys": [3.5, 3.9, "..."], "mae": 0.031, "score": 89 },
    { "nickname": "Bot2", "ys": [3.2, 3.4, "..."], "mae": 0.180, "score": 40 }
  ]
}
```

### UI guidance — reveal
- Draw the full axes + `known` prefix as before, then the **truth** line (gold, solid, matching
  the theme's star/correct-answer color) from the end of `known` to `xMax`.
  Then each player's line from `lines[]` in a distinct color per player (fade in sequentially like
  the map/timeline reveals do), each hidden-x segment only (their line also starts where `known`
  ends). Label with nickname + score, e.g. "Bot1 · 89".
  Show `source` as a small credit line near the chart, and use `correctText`-style formatting
  (`fmt()` inside `games/curve.js` — fixed decimals + unit, `$` prefixed not suffixed) everywhere a
  number is displayed.
- Sort the leaderboard rows/legend by `score` descending to match rank points awarded.

---

## 5. `correctText(q)`

`"Ended at 8.16 bn in 2024"` — the last truth point, formatted with `decimals`/`unit`. Used
wherever a compact one-line "here's the answer" summary is needed outside the full reveal.

---

## 6. Content — `content/curves.json`

56 questions built by `tools/build-curves.js` from:
- **World Bank API** (population, fertility, life expectancy, child mortality, internet/mobile
  adoption, electricity access, GDP per capita, inflation, unemployment, poverty, military
  spending, CO₂ emissions, forest cover — many countries × many indicators)
- **NOAA Mauna Loa** annual-mean CO₂ (1959–2025)
- **NASA GISTEMP v4** global temperature anomaly (1880–2025, J-D column)
- **Hand-curated series**: men's 100 m world record progression, UN member-state count, Summer
  Olympics nations count, US federal minimum wage, US adult smoking rate, Detroit and Greater
  London census population — each typed in directly in `tools/build-curves.js` with its source
  cited in a comment and in the question's `source` field.

Difficulty spread: 1→12, 2→30, 3→14. Every series was validated with the real `games/curve.js`
`validate()` (same rules `import.js` applies) before being written out, and the build script prints
each series' axis-usage percentage so a follow-up pass can retune any question sitting outside the
40–80 % target band.

To rebuild: `node tools/build-curves.js` (fetches whatever isn't cached under
`tools/raw/curves/`, which is gitignored) or `node tools/build-curves.js --offline` to only use
what's already cached. Both `data/curves-src.json` and `content/curves.json` are rewritten from
scratch every run — it's idempotent.

**Known environment note:** in this sandbox, Node's built-in `fetch` failed specifically for
`data.giss.nasa.gov` (TLS/connection issue) while `curl` to the same URL succeeded fine. If a
future run hits `✗ fetch failed` on the GISTEMP URL, work around it with:
```
curl -sS "https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv" \
  -o "tools/raw/curves/gistemp-GLB.Ts+dSST.csv"
```
then re-run the build script — it will find the cached file and skip the network fetch.

---

## 7. Tested

- `node import.js content/curves.json --dry-run` → 56/56 valid.
- Imported into a scratch copy of `quiz.db` and ran
  `node test/simulate.js --categories curves --rounds 8 --verbose` → all checks passed (bots draw
  noisy continuations via `sampleAnswer`, quality/points/ranking all behaved as expected).
