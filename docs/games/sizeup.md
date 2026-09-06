# 📐 Size It Up (`sizeup`)

Two silhouettes stand side by side on a canvas. The **brown reference** has a
size printed on it ("City bus — 12 m long"). The **red target** ("Blue whale")
starts at some random size and the player **drags the red shape (or its corner
handle) bigger or smaller** until it *looks* the right size next to the brown
one; the canvas can be zoomed in and out (buttons, pinch, wheel). Lock in. The
reveal shows the true size and where everybody landed.

Adapted from [magnitudle.com/size-it-up](https://magnitudle.com/size-it-up).

| | |
|---|---|
| Category | `sizeup` — "Size It Up" 📐, group `draw` |
| Server module | `games/sizeup.js` |
| Client module | `public/games/sizeup.js` (+ `.css`) |
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

The true size is **never** sent. The range has to *contain* the truth, so it can
never be completely information-free — the goal is that it carries no
**systematic** signal.

The range is randomised per question: pick a log-width `span` uniform in
`[4, 6]` natural-log units (a total ratio of ≈55×–400×), then slide that window
so the truth sits at a uniformly random position inside it, never closer than
12% of the span to either end. Both bounds are rounded to 2 significant digits.
This means the geometric centre of the range is as likely to be a factor of ten
out as it is to be right, and guessing an endpoint is worse still.

> **Do not go back to the old formula** (`min = truth / r1`, `max = truth × r2`
> with `r1, r2` independent uniform in `[4, 14]`). Because both bounds derived
> from the same truth with multipliers from the same range, the truth sat near
> the geometric centre: `sqrt(min × max) = truth × sqrt(r2 / r1)`, and
> `sqrt(r2 / r1)` clusters around 1. Measured over all 71 sizeup questions,
> reading `range` out of devtools and answering `sqrt(min × max)` — with no
> reasoning about the object at all — scored **83/100** average accuracy and was
> perfect 20% of the time. Under the current formula the same attack scores
> **26/100** and is perfect 3% of the time, and always-guess-an-endpoint scores
> **1.7/100**.

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
  "range": { "min": 3.2, "max": 150 },  // randomised resize limits (log-scale)
  "tier": "mixed",                       // 'casual' | 'mixed' | 'expert' — see 2a
  "credit": "Silhouettes from game-icons.net (CC BY 3.0) — https://game-icons.net"
}
```

### 2a. Difficulty tiers (`payload.tier`, from the host's difficulty pick)

The truth and the scoring never change; only the help on the answering canvas does.

| | casual | mixed | expert |
|---|---|---|---|
| reference size label | yes | yes | yes (it is the yardstick) |
| live readout of the guess ("24 m · 2.0× as long as the bus") | yes | yes | no — shows "?" / "judge it by eye" |
| metre ruler + faint guide lines on the canvas | yes | no | no |
| target's dimension-bracket label while answering | "?" | "?" | "?" |

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

### Answering screen (`mount`) — how it is built

* **The canvas is the control.** One `<svg>` paints a sky gradient, a ground strip
  and both silhouettes standing on the ground line, reference left, target right.
  Each figure is an icon body inside a `<g>` whose `fill` is a gradient from the
  SVG `<defs>` (the icon's own `fill="currentColor"` attributes are stripped so the
  gradient applies). A soft drop shadow lifts them off the sky.
* **Scaling rule.** Both icons are 512 × 512 boxes but the drawing inside does not
  fill it. The real ink extent is measured once per icon (`getBBox()`) and cached;
  the bbox's `dim` axis (`height` → bbox height, `length` → bbox width) is drawn at
  `sizeM × pxPerMetre`.
* **Fit vs. manual zoom.** By default (*fit*) one shared `pxPerMetre` is recomputed
  every frame from the larger of the two figures, so both always fill the stage
  and the reference visibly shrinks as the target is pulled bigger — the feeling
  from the original game. The − / + buttons, a two-finger pinch or the mouse
  wheel switch to a *manual* scale that stays put; **Fit** returns to fit mode
  (it pulses when the target is clipped). In manual mode the layout keeps the
  target on screen and lets the reference run off the left edge. If a manual
  zoom runs out of room while dragging, the canvas falls back to fit by itself.
* **Resizing.** A one-finger drag anywhere on the canvas that is not the
  reference figure (or a button) resizes the target: the size is multiplied by
  the ratio of the pointer's distance from the target's foot now vs. one move
  ago (both measured in the same frame, so a zoom change between moves never
  makes the size jump). A gold corner handle with a resize glyph marks the
  affordance; it is clamped inside the stage so a clipped target can still be
  grabbed. Small − / + nudge buttons (±6 %) and the arrow keys (±3 %) give fine
  control. Size is clamped to `payload.range`.
* **Dimension brackets** show what is being measured: vertical with a label for
  `height`, along the ground for `length`. The reference's label is its size; the
  target's is "?" while answering.
* **Start size** is log-uniform in `[0.15, 0.85]` of the range — never the middle.
* **Readout** under the canvas: target name, current size, and how it compares to
  the reference ("1.7× as long as the City bus"). Hidden at expert (see 2a).
* **Lock in** freezes the canvas (handle, zoom and nudge controls disappear).
* The `credit` string sits in small type under the canvas (CC BY 3.0 attribution).

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

`api.role === 'host'` (TV-mode host) → the same canvas with no controls; the
target slowly "breathes" between sizes so the big screen looks alive without
revealing anything. The reveal is identical for host and players.
