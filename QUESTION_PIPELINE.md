# QuizBlast — Question Data Model & Pipeline Spec

Technical reference for adding questions to QuizBlast: database schema, the JSON shape each question type expects, the validation rules, and how to plug a generation pipeline into the project.

**Target reader:** Claude — either Claude Code inside this repo, or a Claude.ai chat being used to design a new question-generation pipeline. This document is intentionally self-contained: you can paste the whole thing into a fresh chat and start designing from there.

For game design, UX, scoring display, and host controls, see `CLAUDE.md`. This document sticks to data shapes and pipeline mechanics.

---

## Storage

All questions live in a single SQLite table in `quiz.db` (committed to git — it is the source of truth).

```sql
CREATE TABLE questions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  category  TEXT    NOT NULL,
  type      TEXT    NOT NULL DEFAULT 'mc',
  question  TEXT    NOT NULL,
  correct   TEXT,                           -- NULL for map and sequence types
  image_url TEXT,                           -- optional; used by timeline for historical photos
  extra     TEXT    NOT NULL DEFAULT '{}'   -- JSON blob; fields depend on type
);
```

The `extra` column is a JSON blob because different question types need different fields — a flat schema with nullable columns for every type would be messy. Conversion between the row shape and the in-memory JS object shape happens in `db.js` via `rowToQuestion` and `questionToRow`. A pipeline never needs to touch `db.js` directly; it just produces JSON in the shape shown below.

---

## Valid categories and their types

| Category (`category`) | Question type (`type`) | Count (as of 2026-04) |
|---|---|---|
| `facts` | `mc` | 106 |
| `science` | `mc` | 97 |
| `sports` | `mc` | 72 |
| `entertainment` | `mc` | 84 |
| `flags` | `flag` | 102 |
| `estimation` | `slider` | 80 |
| `timeline` | `timeline` | 81 |
| `geo-natural` | `map` | 72 |
| `geo-built` | `map` | 142 |
| `geo-cities` | `map` | 81 |
| `geo-history` | `map` | 58 |
| `sequence` | `sequence` | 110 |

Category and type are tightly coupled — the category determines the type. Adding a new category inside an existing type (e.g. a new `mc` category) is cheap. Adding a new type is bigger: it needs frontend UI work in `public/client.js` and `public/style.css` too.

---

## JSON shape per question type

These are the object shapes a pipeline produces. Write an array of them to a JSON file and pass it to `import.js` (see "How to add questions" below).

### Multiple-choice (`mc`)

```json
{
  "category": "facts",
  "question": "What is the capital of Australia?",
  "answers": ["Sydney", "Canberra", "Melbourne", "Perth"],
  "correct": 1
}
```

- No `type` field — `mc` is the default when `type` is absent.
- `answers` must be exactly 4 strings.
- `correct` is the 0-indexed position of the correct answer (0, 1, 2, or 3).
- Across a batch, distribute the correct-answer index roughly evenly across 0/1/2/3. Players notice patterns.
- Distractors should be plausible same-domain alternatives, not random noise.

### Flag (`flag`)

```json
{
  "type": "flag",
  "category": "flags",
  "question": "jp",
  "answers": ["Japan", "China", "South Korea", "Thailand"],
  "correct": 0
}
```

- **Quirk:** the `question` field stores the **lowercase 2-letter ISO 3166-1 alpha-2 country code**, not a natural-language prompt. The frontend constructs the flag image from it: `https://flagcdn.com/w320/{code}.png`. Use `gb` for the UK (not `uk`).
- Distractors should be visually or geographically plausible. For the Irish tricolor, use Italy and Ivory Coast, not Mongolia.
- Same index-distribution rule as `mc`.

### Slider (`slider`) — used by `estimation`

```json
{
  "type": "slider",
  "category": "estimation",
  "question": "How tall is the Eiffel Tower (in metres)?",
  "min": 150,
  "max": 700,
  "step": 5,
  "unit": "m",
  "correct": 330
}
```

- `min`, `max`, `step`, `correct` are all numbers. `min < max`. `correct` must satisfy `min ≤ correct ≤ max`.
- The thumb starts at a random position in the **inner 80% of the range** — so `correct` very close to `min` or `max` becomes too easy (or too hard to move to). Keep it away from the edges.
- Don't centre `correct` at `(min + max) / 2` either; moderate asymmetry is best to avoid anchoring bias.
- Choose `step` to match the precision you're confident in — don't use `step: 1` on "global population in billions".
- `unit` is a short display label: `"m"`, `"km"`, `"°C"`, `"%"`, `"million"`, `"billion"`, `""` for unitless, etc.

### Timeline (`timeline`) — specialized year slider

```json
{
  "type": "timeline",
  "category": "timeline",
  "question": "In what year did the Berlin Wall fall?",
  "min": 1970,
  "max": 2000,
  "step": 1,
  "unit": "",
  "correct": 1989,
  "imageUrl": "https://example.com/historical-photo.jpg"
}
```

- Mechanically a slider with `step: 1` and `unit: ""`, but the frontend renders a year picker with integer tick labels.
- `imageUrl` is optional. If present, the frontend shows a historical photo above the question. Must be a stable, hotlink-safe URL. Stored in the `image_url` column (not in `extra`).
- Choose `min`/`max` windows suited to the era — tight (~±20 years) for modern events, wider (~±100) for ancient ones. Same "don't centre `correct`" rule applies.
- **BCE / negative years:** technically the range input accepts them, but tick labels render as `-323` which looks ugly. Stick to CE/AD dates unless you add BCE-aware tick formatting to `public/client.js`.

### Map pin-drop (`map`) — used by all `geo-*` categories

```json
{
  "type": "map",
  "category": "geo-natural",
  "question": "Where is Mount Everest?",
  "correctLat": 27.9881,
  "correctLng": 86.925,
  "locationName": "Mount Everest, Nepal/Tibet"
}
```

- `correctLat` in `[-90, 90]`, `correctLng` in `[-180, 180]`, both as numbers (not strings).
- Precision to at least 3 decimal places (~100 m), ideally 4.
- `locationName` is a short label shown on the leaderboard reveal. `"Landmark, Country"` or `"City, Country"` work well.
- No `correct` field at the top level — the `correct` DB column is `NULL` for map questions.
- Scoring uses haversine distance with exponential decay: `exp(-(dist_km / 50) ^ 0.6)`. A 50 km miss still scores ~0.37; 150 km scores ~0.08. Good for "roughly where in the world?" questions, bad for "which of these two buildings on the same street?" questions.

### Sequence (`sequence`) — drag-to-order

```json
{
  "type": "sequence",
  "category": "sequence",
  "question": "Order these inventions from earliest to latest",
  "items": ["Printing press", "Steam engine", "Telephone", "Internet"]
}
```

- `items` is exactly 4 strings, **in the correct order**. The frontend shuffles them before display.
- No `correct` field at the top level.
- Scored by how many items the player placed in the right position (0–4). Getting adjacent items right isn't rewarded — it's positional, not edit-distance.

---

## Validation rules enforced by `import.js`

The importer runs all of these before touching the DB. If any fail, nothing is written — errors are printed and the process exits non-zero.

- `category` must be one of the 12 valid categories.
- `type` (defaulted to `"mc"` if absent) must be one of `mc`, `flag`, `slider`, `timeline`, `map`, `sequence`.
- `question` must be a non-empty string.
- `mc` / `flag`: `answers` must be an array of exactly 4 strings; `correct` must be a number in `[0, 3]`.
- `slider` / `timeline`: `min`, `max`, `correct` must be numbers; `min < max`; `correct` must lie within `[min, max]`.
- `map`: `correctLat` must be a number in `[-90, 90]`; `correctLng` must be a number in `[-180, 180]`.
- `sequence`: `items` must be an array of exactly 4 strings.

See `import.js` for the exact assertions. The importer does **not** check for duplicates, category-to-type consistency, or factual accuracy — that's the pipeline's job.

---

## How to add questions

### Option A — admin editor (interactive, low volume)

Run `node server.js` and open `http://localhost:3000/admin.html`. Category tabs on top; add, edit, or delete questions per category. Includes a map picker for `geo-*` questions (click to set coordinates) and a drag-to-reorder UI for sequences. Saves via an admin POST endpoint that atomically replaces all rows in the `questions` table.

### Option B — `import.js` (scripted, high volume — the pipeline entry point)

```bash
node import.js path/to/new-questions.json
```

The file must contain a JSON array of question objects matching one of the shapes above. The script:

1. Parses the JSON.
2. Validates every question against the rules above. Bails on any error — nothing is written.
3. Inserts all valid questions in a single transaction (via `questionToRow` in `db.js`).
4. Prints a per-category breakdown of what was added and the new total.

`import.js` is append-only — it does not wipe or dedupe existing rows. If your pipeline might re-generate overlapping content, handle deduplication before calling `import.js`.

**This is where question-generation pipelines plug in.** A pipeline's only job is to produce a valid JSON array; `import.js` handles everything else. A pipeline should almost never write directly to `quiz.db` — go through `import.js` so validation can't be bypassed.

---

## Pipeline design sketch

A generation pipeline has four stages:

1. **Fetch** — Pull raw data from a source (API, SPARQL endpoint, static dataset, hand-curated list).
2. **Transform** — Map raw records to the question JSON shapes above. This is where pipeline logic lives: writing MC distractors, choosing slider ranges, building `locationName` strings, picking question phrasings.
3. **Validate locally** (optional) — Run your output through the same checks `import.js` does. Or just let `import.js` catch errors — it's transactional, so a bad batch is a no-op.
4. **Import** — Write the JSON file, run `import.js`, verify the counts, commit `quiz.db`.

For repeatability, keep the fetch + transform stages as deterministic scripts in a `pipelines/` directory (not yet created). One pipeline per source is a good shape — e.g. `pipelines/world-bank-estimation.js`, `pipelines/wikidata-map.js`.

### Source ideas

**World Bank Open Data API** (`https://api.worldbank.org/v2/`)

- Natural fit for `estimation` sliders. Good indicator candidates: population, GDP (USD), GDP per capita, life expectancy, CO2 emissions per capita, literacy rate, surface area, forest cover, electricity consumption, mobile subscriptions per 100 people, urbanisation percentage.
- **Gotcha: values drift every year.** Two options:
  1. **Pin the year in the question text** (e.g. `"What was Brazil's population in 2020 (millions)?"`). Simple; the question stays correct forever.
  2. **Annual refresh** — store a `source_year` in `extra`, and re-import yearly. The current schema has no `source_year` column, but `extra` is a free-form JSON blob, so you can add the field in your pipeline and filter in `server.js` at game-creation time. This is a bigger change.
- Slider range tip: a reasonable natural range is the min/max of the indicator across countries for that year, with ~10% padding. Avoids players anchoring on the midpoint.

**WikiData SPARQL endpoint** (`https://query.wikidata.org/sparql`)

- Fits almost every type. Useful properties:
  - `P625` — coordinate location. First-class lat/lng for cities, landmarks, battles, monuments, natural features. Gold for `map` questions.
  - `P585` — point in time. For `timeline` questions about specific events.
  - `P569` / `P570` — date of birth / date of death. For people-centric timeline questions.
  - `P577` — publication date. For books, films, albums.
  - `P31` — instance of. For filtering entities to a class (e.g. "all capital cities": `?x wdt:P31 wd:Q5119`).
  - `P41` — flag image. But the existing flagcdn.com integration is simpler; only switch if you need flags flagcdn doesn't have.
- **MC distractors from WikiData are very strong.** For "who wrote X?", fetch other notable authors (`?x wdt:P31 wd:Q5 . ?x wdt:P106 wd:Q36180`) and pick three at random as distractors — they'll be in the same class automatically.
- **Gotchas:**
  - WikiData is volunteer-edited. Occasional inaccuracies and joke entries exist. Always spot-check a sample.
  - SPARQL queries at the public endpoint time out at 60 seconds. Batch narrowly — filter by class first.
  - Labels can be missing in non-English languages. Force `SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }`.

**LLM-generated, spot-checked** (the approach used for the 2026-04 bulk import)

- Fit: all types.
- Strength: high quality for "interestingness" and variety, especially for `facts`, `entertainment`, `sports`, `timeline`.
- Weakness: factual drift. Always spot-check a sample before importing a batch, and prefer questions about stable facts (historical events, physical constants, well-established records) over live data (current rankings, recent pop culture).

### What to avoid in statistics-based questions

- **Anything whose answer changes without a year pinned.** Populations grow, GDPs fluctuate, records break. Either pin the year in the question text or commit to re-importing yearly.
- **Rankings that flip.** "Which country has the Nth largest economy?" changes even when the underlying numbers are stable. Prefer absolute values over ranks.
- **Questions with very tight numeric tolerances.** Slider scoring is proximity-based and lenient — "estimate the speed of light in m/s to 3 significant figures" isn't fun.
- **Politically contested data.** Disputed borders, disputed population counts, disputed histories. Keep them out unless you want to deal with the feedback.
- **Data that requires context to interpret.** "What is the Gini coefficient of Germany?" means nothing to most players. Pick intuitive metrics.

---

## Scoring, in one paragraph

Rank-based scoring: after all players answer (or the timer expires), the server ranks answers by quality and hands out points by rank — 1st = 10, 2nd = 8, 3rd = 6, 4th = 4, 5th = 2, 6th and below = 1. `mc` / `flag` are ranked by answer speed among correct answers (wrong answers get 0). `slider` / `timeline` are ranked by closeness (smallest error wins). `map` is ranked by haversine distance. `sequence` is ranked by how many items landed in the right position. Speed breaks ties. Full scoring details are in `CLAUDE.md`. **Pipeline implication:** you don't need to calibrate absolute difficulty across questions — rank is relative to the other players on the same question, so any question that produces a spread of answers works.
