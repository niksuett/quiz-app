# 📐 Size It Up (`sizeup`)

Two silhouettes stand side by side. The **brown reference** has a size printed on
it ("City bus — 12 m long"). The **red target** ("Blue whale") starts at some
arbitrary size and the player drags a slider until the red shape *looks* the
right size next to the brown one. Lock in. The reveal shows the true size and
where everybody landed.

Adapted from [magnitudle.com/size-it-up](https://magnitudle.com/size-it-up).

| | |
|---|---|
| Category | `sizeup` — "Size It Up" 📐, group `draw` |
| Server module | `games/sizeup.js` |
| Client module | `public/games/sizeup.js` (+ `.css`) — **to be written** |
| Data | `data/silhouettes.json` (117 icons, 185 KB), built by `tools/build-silhouettes.js` |
| Content | `content/sizeup.json` (71 questions) |
| `timeLimit` | 30 s |
| `revealPause` | 10 s · `earlyPause` 4000 ms |
| `speedScored` | `false` (accuracy ranks; speed only breaks ties, done by the core) |
| `usesRegion` | `false` |

---

## 1. Question JSON (what `import.js` accepts)

```json
{
  "type": "sizeup",
  "category": "sizeup",
  "question": "How long is a blue whale next to a 12 m city bus?",
  "target":    { "name": "Blue whale", "icon": "whale", "sizeM": 30, "dim": "length" },
  "reference": { "name": "City bus",   "icon": "bus",   "sizeM": 12, "dim": "length" },
  "difficulty": 1
}
```

* `icon` — a key in `data/silhouettes.json` → `icons`. Run
  `node -e "console.log(Object.keys(require('./data/silhouettes.json').icons).join(' '))"`
  for the full list.
* `dim` — `"height"` or `"length"`: **which axis of the real object the `sizeM`
  refers to.** The client scales the icon's bounding box so that axis equals the
  size. (`length` is also used for "wingtip to wingtip" / "claw to claw"; the
  prompt text always says exactly what is being measured.)
* `sizeM` — metres, always > 0.
* `region` is not used by this type. `difficulty` is set on every question.
* Validation rejects: unknown icon keys, non-positive sizes, `target.icon ===
  reference.icon`, and a target/reference ratio outside 1/40 … 60.

**Storage:** `correct` = the true target size in metres (as a string);
`extra` = `{ target:{name,icon,dim}, reference:{name,icon,dim,sizeM} }`.

---

## 2. `payload` — sent to every client when the question starts

The true size is **never** sent. The slider range is randomised per question
(`min = truth / r1`, `max = truth × r2`, `r1, r2` independent uniform in
`[4, 14]`, each rounded to 2 significant digits), so the midpoint of the slider
gives nothing away and the same question feels different every game.

```jsonc
{
  "question": "How long is a blue whale next to a 12 m city bus?",
  "target": {
    "name": "Blue whale",
    "dim": "length",
    "icon": { "key": "whale", "body": "<path fill=\"currentColor\" d=\"…\"/>", "w": 512, "h": 512, "flip": false }
  },
  "reference": {
    "name": "City bus",
    "dim": "length",
    "sizeM": 12,                       // the reference size IS public — it is the yardstick
    "icon": { "key": "bus", "body": "…", "w": 512, "h": 512, "flip": false }
  },
  "range": { "min": 3.2, "max": 150 },  // randomised, log-scale slider bounds
  "credit": "Silhouettes from game-icons.net (CC BY 3.0) — https://game-icons.net"
}
```

`icon.body` is the inner markup of a `w × h` SVG (always 512 × 512) using
`fill="currentColor"`, so the colour comes from CSS. Render it as:

```html
<svg viewBox="0 0 512 512" style="color: var(--target-red)">…body…</svg>
```

`flip: true` means mirror it horizontally (`transform: scaleX(-1)`) — purely
cosmetic, so the two silhouettes face each other.

---

## 3. `answer` — what the client submits

```json
{ "sizeM": 24.5 }
```

A single positive number in metres. Anything else (missing, non-finite, ≤ 0) is
rejected server-side and the player gets `answer-rejected`.

---

## 4. Scoring

```
ratio   = guess / truth
err     = |ln(ratio)|                      // symmetric: 2× too big == 2× too small
quality = err <= ln(1.06) ? 1
        : clamp(1 - (err - ln 1.06) / (ln 2.5 - ln 1.06), 0, 1)
```

Within **6 %** of the truth → perfect 1.0. **2.5× off** in either direction → 0.

| guess / truth | 1.00 | 1.06 | 1.2 | 1.5 | 2.0 | 2.5 |
|---|---|---|---|---|---|---|
| quality | 1.00 | 1.00 | 0.86 | 0.60 | 0.26 | 0.00 |

The core (`scoring.js`) turns `quality` into accuracy points (`round(100 ×
quality)`), adds the rank bonus (+50/+30/+15) and the streak bonus. Ties on
quality are broken by answer time.

---

## 5. `result` — sent only to the answering player

```json
{
  "trueSizeM": 30,
  "yourSizeM": 20,
  "ratio": 0.667,
  "dim": "length",
  "targetName": "Blue whale",
  "referenceName": "City bus",
  "score": 60
}
```

Suggested result screen: icon `📐`, heading `"60 % — a bit small"` (from
`score`), subtitle `"You said 20 m · it's 30 m"`. A one-line phrasing of `ratio`
reads well: `< 1` → "you guessed it **1.5× too small**", `> 1` → "**1.5× too
big**", within 6 % → "spot on".

## 6. `detail` — stored on the player, used by `metric(detail)`

```json
{ "sizeM": 20, "ratio": 0.667 }
```

`metric(detail)` should return something like `"20 m (1.5× too small)"` for the
leaderboard row.

## 7. `reveal` — sent to everyone with the leaderboard

```jsonc
{
  "target":    { "name": "Blue whale", "dim": "length", "sizeM": 30, "icon": { … } },
  "reference": { "name": "City bus",   "dim": "length", "sizeM": 12, "icon": { … } },
  "guesses": [ { "nickname": "Ann", "sizeM": 20, "ratio": 0.667 }, … ]
}
```

`correctText(q)` → `"Blue whale: 30 m long"` (banner above the leaderboard).

---

## 8. UI guidance for the client module

### Answering screen (`mount`)

* **Layout.** A wide drawing area with both silhouettes **standing on a common
  baseline** (a thin ink line), reference on the left, target on the right.
  * Reference: `color: var(--ink)` / a warm brown (`#7a4a1e` works on parchment),
    with its size label under it — *always visible*, it is the yardstick.
  * Target: a red (`#b4402e` / `var(--wrong)`-ish) silhouette, no size label
    while answering — the number belongs on the slider, not on the shape.
* **Scaling rule.** Both icons are 512 × 512 boxes but the *drawing* inside does
  not fill it. Measure the real ink extent once per icon (render it offscreen and
  read `getBBox()` on a `<g>` wrapping the body) and scale so that
  **the bbox's `dim` axis** (`height` → bbox height, `length` → bbox width)
  equals `sizeM × pxPerMetre`.
* **pxPerMetre.** Recompute every frame from the *larger* of the two current
  sizes so the pair always fills the box:
  `pxPerMetre = usableHeight / max(referenceSizeM, currentGuessM) * 0.9`.
  This means the reference visibly shrinks as the player drags the target up —
  that is exactly the feeling from the original game and it is what makes it
  fun. Keep a floor so the reference never becomes an invisible speck: if the
  reference would render under ~6 px, draw it at 6 px and put a "not to scale"
  hairline under it.
* **Slider.** Horizontal, **logarithmic**: the slider position `t ∈ [0,1]` maps
  to `sizeM = exp(ln(min) + t·(ln(max) − ln(min)))`. Start the thumb at a random
  `t` in `[0.15, 0.85]` (never the middle — no anchoring). Show the current value
  above the thumb using the same formatting rule as the server: mm below 1 cm,
  cm below 1 m, 1 decimal below 10 m, whole metres above.
* **Pinch.** On touch, a two-finger pinch on the drawing area should also resize
  the target (map the pinch scale onto the log slider). `touch-action: none` on
  the surface.
* **Lock in** button; after `api.locked` freeze the slider and dim the control.
* Put the `credit` string in small type at the bottom of the surface (CC BY 3.0
  requires attribution) — once per screen is enough.

### Reveal

* Draw the same two silhouettes, but the target at its **true** size, with the
  size labels now shown on both.
* Overlay each player's guess as a **thin outlined silhouette** of the target at
  their guessed size (colour from `util.colorFor(index)`), plus a small
  name tag. Animate them in one by one, worst first, so the winner lands last.
* Alternative if the overlay gets too busy with 8+ players: a **logarithmic
  number line** under the drawing, gold star at the truth, one dot per player.
  Recommended: draw both — silhouettes for the top 3, the number line for all.
* Nice touch: after the animation, print the punchline as text, e.g.
  *"A blue whale is 2.5 city buses long."*

### Host / TV mode

`api.isHost && api.tvMode` → show the same drawing but with **no slider**: the
big question text, the two silhouettes with the target at a neutral size, and
the answered-count. The reveal is identical for host and players.
