# QuizBlast — Question Data Model & Pipeline Spec (v2)

Technical reference for adding questions to QuizBlast: database schema, the JSON shape each of the 14 game types expects, how validation and storage work, and how to plug a content-generation pipeline into the project.

**Target reader:** Claude — either Claude Code inside this repo, or a Claude.ai chat being used to design a new question-generation pipeline. This document is intentionally self-contained: paste the whole thing into a fresh chat and start designing from there.

For game design, scoring, host controls, and the general architecture, see `CLAUDE.md` and `docs/ARCHITECTURE.md`. This document sticks to data shapes and pipeline mechanics.

---

## 1. Storage

All questions live in one SQLite table in `quiz.db` (committed to git — it is the source of truth, 2158 rows as of this writing):

```sql
CREATE TABLE questions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  category  TEXT    NOT NULL,
  type      TEXT    NOT NULL DEFAULT 'mc',
  question  TEXT    NOT NULL,
  correct   TEXT,                           -- NULL for most non-MC types; a stringified answer for mc/flag/silhouette/tune/slider/timeline/sizeup
  image_url TEXT,                           -- optional; used by timeline (historical photo) and any type via `imageUrl`
  extra     TEXT    NOT NULL DEFAULT '{}'   -- JSON blob; every field that varies by type lives here
);
```

`extra` is a JSON blob because 14 different types need 14 different shapes — a flat schema with nullable columns per type would be unmanageable. **Each game module owns its own slice of `extra`.** `db.js` only handles the columns every question shares (`id`, `category`, `type`, `question`, `imageUrl`) plus two fields that are common enough to be lifted out of `extra` automatically: `region` and `difficulty`.

```js
// db.js — rowToQuestion (row → in-memory question object)
const q = { id: row.id, category: row.category, type: row.type || 'mc', question: row.question };
if (row.image_url)   q.imageUrl   = row.image_url;
if (extra.region)     q.region     = extra.region;
if (extra.difficulty) q.difficulty = extra.difficulty;
Object.assign(q, registry.get(type).fromRow(row, extra));   // everything else is the module's job
```

A pipeline never touches `db.js`, `server.js`, or `scoring.js` directly — it produces plain JSON in the shape shown in §3, and `import.js` + the relevant `games/<type>.js` module do the rest (validate → `toRow` → INSERT).

### `region` and `difficulty`
Both optional, both stored inside `extra`, both lifted to the top level by `db.js`:
- `region` — one of `europe | asia | africa | north-america | south-america | oceania`. Used by the host's geographic-focus filter; a question without one always passes the filter. Not every type uses it — see the `usesRegion` flag per module in §3 (only meaningful as a hint to a content pipeline about whether tagging it is worthwhile; `validate()` still accepts it either way).
- `difficulty` — `1` (casual) / `2` (normal, the default when omitted) / `3` (expert). Used by the host's casual/mixed/expert filter (`server.js`: casual keeps 1–2, expert keeps 2–3, mixed/default keeps everything).

---

## 2. Question object (common shape) and category → type table

Every question, once loaded into memory, has:

```js
{
  id, category, type,          // type is always explicit in v2, even for mc
  question,                    // prompt text (for silhouette: the country name; for compass: not used, from/to carry it)
  imageUrl?,                   // optional photo above the prompt
  region?, difficulty?,        // optional tags, lifted from extra
  ...typeSpecificFields         // see §3
}
```

| Category id | Type | Group | Count | Data file(s) it depends on |
|---|---|---|---|---|
| `borders` | `trace` | draw | 288 | `data/borders.json` |
| `rivers` | `trace` | draw | 79 | `data/rivers.json` |
| `curves` | `curve` | draw | 56 | none (series lives in the question row) |
| `halves` | `halves` | draw | 46 | `data/halves/<ISO3>.json` |
| `compass` | `compass` | draw | 88 | `data/cities.json` (optional — can also be inlined per question) |
| `sizeup` | `sizeup` | draw | 71 | `data/silhouettes.json` |
| `birdseye` | `map` | map | 72 | none (satellite tiles are proxied live) |
| `geo-natural` | `map` | map | 79 | none |
| `geo-built` | `map` | map | 145 | none |
| `geo-cities` | `map` | map | 86 | none |
| `geo-history` | `map` | map | 58 | none |
| `trivia` | `mc` | classic | 389 | none |
| `emoji` | `mc` | classic | 123 | none |
| `flags` | `flag` | classic | 102 | none (flag image comes from flagcdn.com by ISO code) |
| `silhouettes` | `silhouette` | classic | 132 | `data/countries.json` |
| `tunes` | `tune` | classic | 36 | none (melody lives in the question row) |
| `estimation` | `slider` | classic | 70 | none |
| `timeline` | `timeline` | classic | 114 | none |
| `sequence` | `sequence` | classic | 94 | none |
| `fakes` | `fakes` | classic | 30 | none |

Re-check this table against the live DB before trusting exact counts:
```
node -e "const D=require('better-sqlite3');const db=new D('quiz.db');console.log(db.prepare('SELECT category,type,COUNT(*) n FROM questions GROUP BY 1,2').all())"
```

---

## 3. How a module owns its format

Each `games/<type>.js` implements the full contract from `docs/ARCHITECTURE.md` §4. The three functions that matter for the data pipeline:

- **`validate(q)`** — takes a plain question object (the shape a content JSON file uses), returns an array of error strings (empty = valid). Called by both `import.js` and the admin API — a pipeline's output must pass this before anything is written.
- **`toRow(q)`** — question object → `{ correct, extra }` for the INSERT. Decides exactly which fields get stored and where.
- **`fromRow(row, extra)`** — the inverse, used every time a question is loaded out of the DB.

Never guess a type's storage shape — read its `toRow`/`fromRow` (or its `docs/games/<type>.md`, which documents both the accepted JSON and the storage shape) before writing a pipeline for it. The exact JSON each type's `import.js` accepts, one section per type:

### Classic types (no separate spec doc — see `games/<type>.js` directly, they're short)

**`mc`** (`games/mc.js`, categories `trivia` / `emoji`)
```json
{ "type": "mc", "category": "trivia", "question": "What is the capital of Peru?",
  "answers": ["Quito", "Lima", "Bogotá", "Santiago"], "correct": 1,
  "region": "south-america", "difficulty": 1 }
```
`answers` = exactly 4 non-empty strings, `correct` = 0–3 index. Stored as `correct: "1"`, `extra: { answers, region?, difficulty? }`.

**`flag`** (`games/flag.js`, category `flags`) — same shape as `mc`, plus the flag is drawn from `question` as an ISO country code resolved to `https://flagcdn.com/w320/<code>.png` client-side (check `games/flag.js` / `public/games/flag.js` for the exact field name it reads, since the country code and the display prompt are different things for this type).

**`slider`** (`games/slider.js`, category `estimation`)
```json
{ "type": "slider", "category": "estimation", "question": "How many bones does an adult human have?",
  "correct": 206, "min": 100, "max": 300, "step": 1, "unit": "bones" }
```
Scored by a proximity curve between `min`/`max` centred on `correct` — not pass/fail. Stored as `correct: "206"`, `extra: { min, max, step, unit }`.

**`timeline`** (`games/timeline.js`, category `timeline`) — same shape as `slider` but the values are years; **negative = BCE** (formatted "X BCE" everywhere via `formatYear()` in `games/_shared.js`). A hint about typing negative numbers is shown client-side whenever the question's range dips below year 1.

**`sequence`** (`games/sequence.js`, category `sequence`)
```json
{ "type": "sequence", "category": "sequence",
  "question": "Order these events earliest to latest",
  "items": ["Fall of Constantinople", "American Revolution", "French Revolution", "Moon Landing"] }
```
`items` = exactly 4 strings **already in the correct order** — that order is the answer; the client shuffles for display. Scored partly by exact-position count, mainly by pairwise (Kendall-style) correctness, so a near-miss still earns partial credit.

### New v2 types — see `docs/games/<type>.md` §1 for the full spec each; summarized here

**`trace`** (`games/trace.js`, categories `borders` / `rivers`) — `docs/games/trace.md`
```jsonc
{ "type": "trace", "category": "borders", "question": "Draw the border between Spain and France",
  "pairId": "ESP-FRA", "region": "europe", "difficulty": 1 }
{ "type": "trace", "category": "rivers", "question": "Trace the course of the Nile",
  "riverId": "nile", "region": "africa", "difficulty": 1 }
```
`pairId` / `riverId` must exist as a key in `data/borders.json` / `data/rivers.json` — `validate()` checks this at import time. The geometry itself is never in the question row.

**`halves`** (`games/halves.js`, category `halves`) — `docs/games/halves.md`
```json
{ "type": "halves", "category": "halves", "question": "Draw a line that splits Egypt's population in half",
  "regionId": "EGY", "region": "africa", "difficulty": 1 }
```
`regionId` must match a file `data/halves/<regionId>.json` (built by `tools/build-halves.js` from WorldPop rasters).

**`compass`** (`games/compass.js`, category `compass`) — `docs/games/compass.md`
```json
{ "type": "compass", "category": "compass", "question": "From Paris, which direction is Cairo?",
  "from": { "id": "paris", "name": "Paris", "lat": 48.8534, "lng": 2.3488 },
  "to":   { "id": "cairo", "name": "Cairo", "lat": 30.0626, "lng": 31.2497 },
  "region": "europe", "difficulty": 1 }
```
`from`/`to` need `name`+`lat`+`lng`, or just `{ "id": "<key in data/cities.json>" }` and the module fills the rest in. `validate()` rejects pairs closer than 50 km (bearing meaningless) or beyond ~18,500 km (near-antipodal). The true bearing is computed on the fly, never stored.

**`sizeup`** (`games/sizeup.js`, category `sizeup`) — `docs/games/sizeup.md`
```json
{ "type": "sizeup", "category": "sizeup", "question": "How long is a blue whale next to a 12 m city bus?",
  "target":    { "name": "Blue whale", "icon": "whale", "sizeM": 30, "dim": "length" },
  "reference": { "name": "City bus",   "icon": "bus",   "sizeM": 12, "dim": "length" },
  "difficulty": 1 }
```
`icon` must be a key in `data/silhouettes.json` (list them with `node -e "console.log(Object.keys(require('./data/silhouettes.json').icons).join(' '))"`). `dim` is `"height"` or `"length"` — which axis `sizeM` measures. Validation rejects a target/reference size ratio outside roughly 1/40…60 (too similar or too extreme to compare visually).

**`curve`** (`games/curve.js`, category `curves`) — `docs/games/curve.md`
```json
{ "type": "curve", "category": "curves", "question": "World population, 1960–2024 (billions)",
  "series": [[1960, 3.03], [1962, 3.14], "...", [2024, 8.16]],
  "xLabel": "Year", "yLabel": "Population (billions)", "unit": "bn",
  "yMin": 0, "yMax": 11, "knownFraction": 0.25, "decimals": 2, "source": "World Bank",
  "region": "asia", "difficulty": 1 }
```
`series` (5–60 points, strictly increasing x) is the **entire** truth — the server splits it into a known lead-in and a hidden tail to be drawn. `yMin`/`yMax` need enough headroom that the true line never touches the axis edges. The whole series lives in the row; no separate data file is read at play time.

**`silhouette`** (`games/silhouette.js`, category `silhouettes`) — `docs/games/silhouette.md`
```json
{ "type": "silhouette", "category": "silhouettes", "question": "France",
  "iso3": "FRA", "answers": ["Spain", "France", "Poland", "Romania"], "correct": 1,
  "region": "europe", "difficulty": 1 }
```
`iso3` must be a key in `data/countries.json` (built from Natural Earth by `tools/build-countries.js`), and `answers[correct]` must equal `question`.

**`tune`** (`games/tune.js`, category `tunes`) — `docs/games/tune.md`
```json
{ "type": "tune", "category": "tunes", "question": "Name that tune",
  "notes": [[66,1],[66,1],[67,1],[69,1], "..."], "bpm": 120, "wave": "square",
  "answers": ["Ode to Joy", "Hallelujah Chorus", "Pomp and Circumstance", "Bridal Chorus"], "correct": 0,
  "difficulty": 1 }
```
`notes` = 8–40 `[midi, beats]` pairs (`midi` 36–96, or `0` for a rest; `beats` > 0, ≤ 16). `bpm` 50–220. `wave` optional (`square` default, or `triangle`/`sawtooth`/`sine`). No audio file — the client synthesizes it with Web Audio. Keep melodies ~3–15 s so they fit twice inside the 25 s timer.

**`fakes`** (`games/fakes.js`, category `fakes`) — `docs/games/fakes.md`
```json
{ "type": "fakes", "category": "fakes", "difficulty": 2,
  "question": "James Bond film or made up? Tap the FAKES",
  "fakeLabel": "Fakes",
  "items": [
    { "text": "Goldfinger", "fake": false },
    { "text": "Silverstrike", "fake": true }
  ] }
```
Exactly 6 items, each `{text, fake}`, texts distinct (case-insensitive), 2–4 marked `fake: true`. `fakeLabel` (optional, ≤ 30 chars) lets a set twist the premise (e.g. tap the drugs, not the fakes) — the `fake:true` flag always means "this is one to tap" regardless of wording.

**`map`** (`games/map.js`, categories `geo-natural` / `geo-built` / `geo-cities` / `geo-history` / `birdseye`)
```json
{ "type": "map", "category": "geo-natural", "question": "Where is the Sahara Desert?",
  "correctLat": 23.4, "correctLng": 11.0, "locationName": "Sahara Desert",
  "toleranceKm": 1500, "region": "africa", "difficulty": 1 }
```
`correctLat`/`correctLng` required. `toleranceKm` (optional, positive) — implemented and used in real scoring: any guess within that radius counts as a perfect hit (`effectiveDist = max(0, haversineDist − toleranceKm)`), for large/fuzzy features (deserts, mountain ranges, seas) where a single "correct" point would be arbitrary. `birdseye` questions additionally require `satellite: { zoom }` — the server proxies satellite tiles by token so the coordinates are never sent to the client before the reveal.

---

## 4. The content/ + import.js workflow

1. Write (or generate) an array of question objects in the shape above, save it as `content/<name>.json`.
2. Dry-run it: `node import.js content/<name>.json --dry-run` — every question is validated by its module's `validate()`; nothing is written, and every failure is reported (up to 60 shown at once) with a human-readable message.
3. Fix whatever `validate()` complained about and re-run the dry run until it's clean.
4. Import for real: `node import.js content/<name>.json`. **Import is append-only** — existing rows are never touched or overwritten. There's no "replace category" step; duplicates are the pipeline's responsibility to avoid (e.g. don't re-import the same file twice without editing/removing the old rows first).
5. Run `node test/simulate.js` to make sure the new questions play through a full game without errors.
6. Commit `quiz.db` (and, if you generated new geodata, the relevant `data/*.json`) and push — Railway deploys from `main`.

The admin API (`POST /admin/questions`, used by `/admin.html`) is different: it validates and then **replaces every row atomically** in one transaction — that's how the in-editor add/edit/delete flow works, and it's a different code path from `import.js`'s append-only one. A pipeline generating bulk new content should use `import.js`, not the admin endpoint.

### Bulk-editing existing rows
Two small scripts exist for touching rows already in the DB without going through the admin UI:
- `tools/set-fields.js content/<file>.json` — merges fields (typically `region`/`difficulty`) into existing rows by id: `{ "12": { "difficulty": 2 }, "345": { "difficulty": 3, "region": "africa" } }`. Used for the difficulty-tagging pass (`content/difficulty-tags.json`, all 2158 questions tagged).
- `tools/delete-ids.js content/<file>.json` — deletes rows by id: `{ "ids": [2, 10, 57], "reasons": { "2": "too trivial" } }`. Used to prune weak questions (`content/delete-ids.json`, 92 pruned in the v2 content pass).

Both run in one transaction, are safe to re-run (missing ids are reported and skipped, not errors), and both honour `QUIZ_DB` for testing against a scratch database.

---

## 5. Geodata builders (`tools/build-*.js`)

Each builder downloads a source dataset once (cached under `tools/raw/`, gitignored), derives a `data/*.json` file the server module reads at require-time, and usually also writes a ready-to-import `content/*.json`. Re-run one whenever the upstream source changes or you want to regenerate a category from scratch — every builder documents its exact inputs/outputs in its own file header, worth reading before running it:

| Builder | Produces | Source |
|---|---|---|
| `tools/build-borders.js` | `data/borders.json`, `content/borders.json` | Natural Earth country polygons |
| `tools/build-rivers.js` | `data/rivers.json`, `content/rivers.json` | Natural Earth rivers/lakes |
| `tools/build-countries.js` | `data/countries.json`, `content/silhouettes.json` | Natural Earth admin-0 countries |
| `tools/build-compass.js` | `data/cities.json`, `content/compass.json` | GeoNames `cities15000` |
| `tools/build-halves.js` | `data/halves/<ISO3>.json` | WorldPop 2020 population rasters |
| `tools/build-curves.js` | `data/curves-src.json` (cache), `content/curves.json` | (see file header — pulls per-series public datasets, e.g. World Bank) |
| `tools/build-silhouettes.js` | `data/silhouettes.json` | game-icons.net icon set via the Iconify API (CC BY 3.0 — keep attribution if these SVGs are reused elsewhere) |

`tools/lib/geo.js` is the shared geometry toolkit these scripts use: `loadNaturalEarth(name)` (downloads + caches a Natural Earth GeoJSON layer), `pointInPolygon`/`pointInFeature` (ray casting), and `continentOf(lng, lat)` / `countryOf(lng, lat)` — this is how **region tagging** gets attached to a question during a build (a question's coordinates are looked up against Natural Earth polygons to decide which of the 6 continents it belongs to). A pipeline that generates its own coordinate-bearing content (new map questions, new compass pairs) should call `continentOf` the same way rather than tagging regions by hand.

---

## 6. Difficulty tags

`difficulty` (1 casual / 2 normal / 3 expert) was added to the whole existing bank in one pass via `content/difficulty-tags.json` + `tools/set-fields.js` — not baked into any builder. There's no automated difficulty scoring; each `docs/games/<type>.md` gives a rough per-type rubric (e.g. for silhouettes: 1 = iconic/instantly recognisable, 2 = normal, 3 = obscure/expert) meant as guidance for a human or an LLM doing the tagging, not a formula.

---

## 7. How to add a brand-new question type

Checklist, in order (each step's output is what the next step consumes):

1. **Server module** — `games/<type>.js` implementing the full contract in `docs/ARCHITECTURE.md` §4 (`type`, `categories`, `timeLimit`, `validate`, `toRow`, `fromRow`, `payload`, `evaluate`, `reveal`, `correctText`, `sampleAnswer`; `games/index.js` throws at boot if any required key is missing). Reuse `games/_shared.js` helpers (`shuffle`, `haversineKm`, `bearingDeg`, `formatYear`, `validateCommon`, and the `validateMC`/`evaluateMC`/`revealMC` trio if the new type is button-based).
2. **Client module** — `public/games/<type>.js` (+ optional `.css`) implementing `docs/ARCHITECTURE.md` §5's contract (`mount`, `result`, `reveal`, `metric`), registered via `QuizGames.register(...)`. Test it in isolation first: `http://localhost:3000/dev/harness.html?type=<type>&show=both` (add `&payload=<json>` for a specific question, `&tv=1`/`&host=1` to check those views) — much faster than a full game while the module is still rough.
3. **Docs spec** — write `docs/games/<type>.md` (question JSON shape, payload/answer/reveal wire shapes, any data file format, timing table) following the pattern of the existing files in that folder. This becomes both the reference for a content pipeline and the source this document (§3) summarizes from.
4. **Content JSON** — produce `content/<type>.json` per §3/§4 above; if the type needs geodata, write `tools/build-<type>.js` first (see §5 for the pattern) and have it emit both `data/<type>.json` and `content/<type>.json`.
5. **Import** — `node import.js content/<type>.json --dry-run` until clean, then for real.
6. **Simulate** — `node test/simulate.js --categories <the new category id>` to confirm the whole loop (question → answer → leaderboard → game-over) works headlessly before ever opening a browser.
7. Only then wire up any host-facing extras (a new preset entry in `games/index.js`, a difficulty-tier behaviour, etc.) — keep those changes inside the module per the "a game type touches only its own files" rule in `docs/ARCHITECTURE.md` §1.
