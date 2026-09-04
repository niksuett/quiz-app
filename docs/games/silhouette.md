# 🗺️ Shape of Nations — `silhouette`

**Group:** classic · **Category id:** `silhouettes` · **Blurb:** "A country's outline. Which one is it?"
**How to:** "Look at the shape (north is up) and tap the country. Fastest correct answer scores most."

A country's outline is drawn (no map, no labels, north up); players pick the country from four
names. Mechanically identical to Flags: one correct button, speed-scored.

| Setting        | Value   |
|----------------|---------|
| `timeLimit`    | 15 s    |
| `revealPause`  | 7 s     |
| `earlyPause`   | 3000 ms |
| `speedScored`  | true    |
| `usesRegion`   | true    |

Files: `games/silhouette.js` (server), `data/countries.json` (shapes, 671 KB, served at
`/data/countries.json`), `tools/build-countries.js` (builds data + questions),
`content/silhouettes.json` (132 questions).

---

## 1. Question JSON (what `import.js` accepts)

```json
{
  "type": "silhouette", "category": "silhouettes",
  "question": "France",            // the country's display name — must equal answers[correct]
  "iso3": "FRA",                    // key into data/countries.json (Natural Earth ADM0_A3)
  "answers": ["Spain", "France", "Poland", "Romania"],
  "correct": 1,
  "region": "europe",               // optional: europe | asia | africa | north-america | south-america | oceania
  "difficulty": 1                   // optional: 1 iconic, 2 normal, 3 expert
}
```

`validate()` checks the MC rules (4 non-empty strings, `correct` 0–3), that `iso3` is a
3-letter upper-case code present in `data/countries.json`, and that `answers[correct] === question`.

DB row: `correct = "1"`, `extra = { answers, iso3, region?, difficulty? }`.

---

## 2. `data/countries.json`

`{ "<ISO3>": Country, … }` — 197 entries (every Natural Earth 50 m entry of TYPE
*Sovereign country / Country / Sovereignty / Disputed* whose `SOVEREIGNT === ADMIN`, plus Greenland;
dependencies, Antarctica, Western Sahara, Palestine, Siachen and de-facto states are dropped —
Northern Cyprus is merged into Cyprus and Somaliland into Somalia).

```js
{
  iso3: "FRA",
  iso2: "FR",                    // ISO_A2_EH, null if Natural Earth has none — use for flagcdn: https://flagcdn.com/w80/fr.png
  name: "France",                // display name (NAME_EN with a few overrides: Czechia, Ivory Coast, DR Congo, …)
  region: "europe",              // our region id (Russia/Turkey/Cyprus/Caucasus → asia)
  rings: [ [[lng, lat], …], … ], // outer rings only, NOT closed (first point ≠ last), 3 decimals
  bbox: [minLng, minLat, maxLng, maxLat],
  centroid: [lng, lat],
  areaKm2: 635043
}
```

Geometry rules (all decided in `tools/build-countries.js`):

* **Rings kept:** the largest ring plus every ring with area ≥ 3 % of it that is not further
  away than `max(1.2 × mainland diagonal, 3 500 km)` (so French Guiana is dropped, Indonesian
  Papua is kept). Canada uses 0.3 % so the Arctic archipelago survives. Hand-kept famous islands:
  Hawaii (4 big islands), Corsica, the Balearics, Tasmania, Argentine Tierra del Fuego, Sakhalin,
  Novaya Zemlya. Hand-dropped: Svalbard, Galápagos.
* **Point budget:** ≤ 350 points per country; ≤ 600 for countries > 2 M km² and for many-ring
  countries > 300 k km² (Canada, Indonesia, Japan, Philippines…). Douglas–Peucker with the
  tolerance raised until the budget fits. Max in the file: 600.
* **Antimeridian:** shapes are made contiguous. **Longitudes can exceed 180** — Russia runs from
  27.4 to 190.3, Fiji to 180.0 — so never wrap or normalise longitudes; project them as plain
  numbers. (The USA fits inside −168…−67 once the western Aleutians are gone.)
* **No holes**, no inner rings. Rings never overlap, so any fill rule works — simplest is to draw
  each ring as its own closed `<path>` with the same fill.

To rebuild: `node tools/build-countries.js` (idempotent, seeded — byte-identical output).

---

## 3. Payload (sent to every client at question start)

```js
{
  prompt: "Which country is this?",
  rings: [ [[-4.762, 48.4], [-4.1, 48.7], …], [[8.6, 42.9], …] ],   // same shape as the data file
  bbox:  [-4.762, 41.385, 9.551, 51.097],
  answers: ["Spain", "France", "Poland", "Romania"]
}
```

Nothing else — no name, no iso code, no centroid, no `correct`. Payload size: ≤ 11 KB.

## 4. Answer (client → server)

```js
{ index: 1 }          // integer 0–3, the tapped button
```

Anything that is not an integer 0–3 is rejected (`answer-rejected`).

## 5. Result (sent back to the answering player only)

```js
{
  isCorrect: false,
  correctIndex: 1,
  correctText: "France",
  yourText: "Spain",
  name: "France",                 // display name of the country
  iso2: "FR",                     // or null → flag image is optional
  rings: [...], bbox: [...]       // the shape again, so the result screen can draw it without keeping state
}
```
The core adds `type`, `quality` (1 or null), `elapsed`, `soundCorrect`.

## 6. Detail (stored per player, shown on leaderboard rows)

```js
{ isCorrect: true, index: 1, answerText: "France" }
```
`metric(detail)` → `"✓ France"` / `"✗ Spain"` (same as Flags).

## 7. Reveal (sent to everyone with the leaderboard)

```js
{
  answers: ["Spain", "France", "Poland", "Romania"],
  correctIndex: 1,
  counts:   [1, 3, 0, 0],                  // how many players picked each option
  pickedBy: [["Ana"], ["Ben", "Cleo", "Dan"], [], []],
  rings: [...], bbox: [...],               // the shape
  name: "France",
  iso2: "FR"
}
```
`correctText` on the leaderboard banner = the country name.

---

## 8. Scoring

Speed-scored MC (core, `scoring.js`):

* wrong / no answer → `quality = null` → 0 points, streak broken
* correct → `quality = 1` → accuracy points `round(100 × (0.5 + 0.5 × max(0, 1 − elapsed/15)))`
  (instant ≈ 100, at the buzzer ≈ 50)
* rank bonus among correct players by speed: +50 / +30 / +15
* streak +20 from the 3rd good answer in a row; final round ×2 if enabled

Sample answer for `test/simulate.js`: `{ index: random 0–3 }`.

---

## 9. Client module guidance — `public/games/silhouette.js`

**mount(container, payload, api)**

1. Draw the outline in an SVG that fills the top of the container (square-ish, max ~55 vh on
   phones so the four buttons stay visible without scrolling). Suggested layout, same as Flags:
   prompt line → shape card → 4 answer buttons (`.answer-btn`, staggered fade-in).
2. Projection: **north up, Mercator** — people know shapes from web maps, and Canada / Russia /
   Greenland look "right" in Mercator and oddly squashed in a plain lng/lat plot.

   ```js
   const merc = lat => Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, lat)) * Math.PI / 360));
   const [x0, y0, x1, y1] = payload.bbox;
   const W = x1 - x0, H = merc(y1) - merc(y0);          // lng is linear, lat via merc()
   const pad = 0.05 * Math.max(W, H);
   svg.setAttribute('viewBox', `${x0 - pad} ${-merc(y1) - pad} ${W + 2 * pad} ${H + 2 * pad}`);
   svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
   for (const ring of payload.rings) {
     const d = ring.map(([lng, lat], i) => `${i ? 'L' : 'M'}${lng} ${-merc(lat)}`).join('') + 'Z';
     // one <path d=d> per ring, fill var(--ink), stroke var(--gold) at ~0.8 % of the viewBox width
   }
   ```
   `util.project(lng, lat, bbox, w, h)` from `core/geo.js` (equirectangular) also works and is what
   the build preview used; shapes stay recognisable, only high-latitude giants look flatter.
   Do **not** clamp or wrap longitudes (Russia goes to 190.3°).
3. Small islands can shrink to sub-pixel slivers on phones — a thin stroke keeps them visible.
   Do not draw a graticule, coastline of neighbours, or anything that hints at location; the
   whole point is the shape alone. A subtle parchment card behind it is enough.
4. Buttons: `api.submit({ index })` on tap, then lock (disable buttons, keep the tapped one
   highlighted). Host in TV mode: draw the shape large, list the four options without buttons.
5. Optional flourish: fade the shape in with a short "draw-on" stroke animation (stroke-dasharray)
   over ~600 ms; keep it short — speed is scored.

**result(resultData)** → `{ icon: '✓'|'✗', iconColor, heading: name, subtitle: isCorrect ? 'Correct!' : `You picked ${yourText}` , html }`
where `html` can contain the shape (from `resultData.rings/bbox`) next to a flag image
(`https://flagcdn.com/w80/${iso2.toLowerCase()}.png`, only when `iso2` is set) — reuse the
Flags result look.

**reveal(container, revealData, ctx)** — show the shape (smaller, with the flag and the
name as a caption) and the four options as bars with `counts[i]` / `pickedBy[i]`, the correct
one in gold, as the MC/Flags reveal does. Highlight `ctx.myNickname` in `pickedBy`.

**metric(detail)** → `detail.isCorrect ? '✓ ' + detail.answerText : '✗ ' + detail.answerText`.

---

## 10. Content notes (`content/silhouettes.json`, generated)

* One question per country with a recognisable outline: 132 countries. Difficulty 1 (38): iconic
  shapes (Italy, UK, Norway, Japan, India, Chile, USA, Australia, Brazil, Egypt, Madagascar…);
  2 (79): most countries; 3 (15): Central Asia, the Caucasus, West-African and small Balkan
  interiors (Slovakia, Guinea, Benin, Togo, Guyana, Suriname…).
* Excluded on purpose (still in `data/countries.json` as distractors): featureless blobs
  (Burkina Faso, Burundi, Rwanda, Lesotho, Eswatini, Moldova, Kosovo, Luxembourg, Belize,
  Turkmenistan, Armenia, Bhutan, Bosnia, Slovenia, Montenegro, North Macedonia, Gabon, Congo,
  CAR, South Sudan, Eritrea, Sierra Leone, Liberia, …), island scatters (Bahamas, Fiji, Maldives,
  Micronesia, Kiribati, Tonga, Samoa, Comoros, Cape Verde, Caribbean micro-states, …) and
  micro-states (Vatican, Monaco, San Marino, Liechtenstein, Andorra, Malta, Singapore, Bahrain,
  Brunei). Edit the `QUESTIONS` table in `tools/build-countries.js` to change the list.
* Distractors: 3 picked at random (seeded) from the 8 best candidates ranked by
  `|log(area ratio)| + centroidDistance/2500 km` (+1.5 for another region), area ≥ 2 000 km².
  Result: neighbours of similar size (Uzbekistan → Kyrgyzstan, Afghanistan, Pakistan).
* Correct index is exactly 33 / 33 / 33 / 33.
* Regions: asia 40, africa 34, europe 30, north-america 13, south-america 12, oceania 3.
