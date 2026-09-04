# 🕵️ Spot the Fakes — hand-off doc

Server module: `games/fakes.js`. Category id: `fakes` (single category, group `classic`, order 90).
Content: `content/fakes.json` (30 sets).

## Idea

Six short names/terms are shown. 2–4 of them are fake (invented, plausible-sounding).
Players tap every one they believe is fake, then lock in. Some sets twist the premise —
e.g. "Pokémon or pharmaceutical? Tap the DRUGS" — via an optional `fakeLabel` that names
what the flagged items actually are ("Drugs", "Fakes", …). The `fake:true` flag on an item
always means "this is one to tap", regardless of the label's wording.

## Question JSON shape (content/fakes.json)

```json
{
  "category": "fakes", "type": "fakes", "difficulty": 2,
  "question": "James Bond film or made up? Tap the FAKES",
  "fakeLabel": "Fakes",           // optional, defaults to "Fakes"
  "items": [
    { "text": "Goldfinger", "fake": false },
    { "text": "Silverstrike", "fake": true }
    // ... exactly 6 items total, 2-4 with fake:true
  ]
}
```

Constraints enforced by `validate()`: exactly 6 items, each `{text, fake}`, distinct texts
(case-insensitive), 2–4 fakes, optional `fakeLabel` ≤ 30 chars.

## Timing

`timeLimit: 25`, `revealPause: 9`, `earlyPause: 4000` (client can early-advance 4s after
everyone answers), `speedScored: false` (order doesn't matter — it's an accuracy game),
`usesRegion: false`.

## payload() — what the client receives at question start

```json
{
  "question": "James Bond film or made up? Tap the FAKES",
  "imageUrl": null,
  "items": ["Silverstrike", "Goldfinger", "Nightfall Protocol", "Moonraker", "Diamond Requiem", "Skyfall"],
  "fakeCount": 3,
  "fakeLabel": "Fakes"
}
```

- `items` is the 6 texts in a **shuffled, seeded order** (seed = game id + question id), so a
  reconnecting player sees the identical order — never re-shuffle client-side.
- `fakeCount` tells the player how many they're looking for (shown as a counter/hint, e.g. "3 fakes").
- No `fake` flags are ever sent in payload — the module only leaks them after answers are scored.

## Client UI guidance

- Render `items` as 6 tappable cards/chips in a grid (2×3 or 3×2 depending on screen width).
- Tapping toggles a "picked" visual state (e.g. border highlight + strike/X icon); tapping again un-picks.
- No hard cap on how many can be picked client-side beyond the 6 items themselves — a player
  can pick 0–6; scoring naturally penalizes over/under-picking.
- Show `fakeLabel` in the header ("Tap the DRUGS") and optionally a live counter ("2 of 3 fakes selected" —
  but note the player doesn't actually know which 3, so avoid implying they can verify count against truth).
- Lock-in button submits `{ picks: [indices into payload.items] }` — indices are positions in
  the shuffled `items` array, NOT any stable id.
- Countdown/timer UI identical to other MC-style question types (15–30s range questions use).

## Answer shape

```json
{ "picks": [0, 3, 4] }
```
Array of integers, each an index into the shuffled `payload.items`. Order doesn't matter,
duplicates are deduped server-side. Empty array is valid (picks nothing).

## evaluate() — scoring

Every one of the 6 items is a binary yes/no decision (tap it or don't). Let `c` = number of
items where the player's tap state matches the truth (tapped a fake, or correctly left a real
item alone).

```
quality = max(0, (c - 3) / 3)
```

So: 6/6 correct → quality 1.0, 5/6 → 0.67, 4/6 → 0.33, 3/6 or worse → 0. A pure coin-flip
strategy averages ~3/6 correct, so it nets nothing — you have to actually know something.
`speedScored: false`, so `quality` alone determines rank points; there's no speed tiebreak
component built into this module (ties are broken however `scoring.js` breaks proximity ties
generally — check there if exact tie behavior matters).

### result (sent back to the answering player)

```json
{
  "items": [
    { "text": "Silverstrike", "fake": true, "picked": true },
    { "text": "Goldfinger", "fake": false, "picked": false },
    ...
  ],
  "correct": 5, "total": 6,
  "score": 0.67, "accuracyPct": 67,
  "fakeLabel": "Fakes",
  "soundCorrect": false
}
```
Use this to show a per-item review (green check for correct tap/non-tap, red X for a miss),
plus "5 of 6 correct" and the quality-derived point contribution. `soundCorrect` (true when
`correct >= 5`) is a hint for which result chime to play — treat it like the "wrong answer"
sound gate other MC types use.

## reveal() — leaderboard reveal payload

```json
{
  "items": [
    { "text": "Silverstrike", "fake": true, "pickedBy": ["Bot1", "Bot3"] },
    { "text": "Goldfinger", "fake": false, "pickedBy": [] },
    ...
  ],
  "fakeCount": 3,
  "fakeLabel": "Fakes",
  "scores": [{ "nickname": "Bot1", "correct": 4 }, ...]
}
```

Suggested leaderboard visual: list the 6 items in `reveal.items` order, mark the true fakes
(gold/starred), and under each item show avatar chips or initials for everyone in `pickedBy`
(green chip if that pick was correct — i.e. item.fake === true — red if it was a miss on a
real item). This mirrors the sequence-type reveal's "who got what right" grid style.

`correctText(q)` returns a plain-text summary like `"Fakes: Silverstrike, Nightfall Protocol,
Diamond Requiem"` — useful for a TV-mode banner or chat log line.

## Content notes

30 sets across varied themes (IKEA products, Bond films, dinosaurs, Pokémon vs. drug names,
Shakespeare plays, US states, chemical elements, Greek gods, constellations, dog breeds,
cheeses, world capitals, NBA teams, rivers, board games, vitamins/minerals, Roman emperors,
sushi rolls, dance styles, volcanoes, operating systems, yoga poses, cocktails,
butterflies/moths, musical instruments, car brands, programming languages, Harry Potter
spells, cloud types, sailing knots). Difficulty spread: 1→6, 2→18, 3→6. No `region` set —
none of the themes have a natural single-continent anchor strong enough to justify it (world
capitals and rivers span all regions within one set).

## Verification performed

- `node import.js content/fakes.json --dry-run` → 30/30 valid.
- Imported into a scratch copy of `quiz.db` (never touched the real database) and ran
  `node test/simulate.js --categories fakes --rounds 10 --verbose` → all checks passed,
  including the payload-leak assertion (no `fake` field ever appears in `payload()`).
