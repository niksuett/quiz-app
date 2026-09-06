# v2 — status

## Playtest + audit pass (2026-09-06)

Played the app on a 360 px viewport and audited the core; everything below was a real bug, not a cleanup.

**Two of these were breaking live features and neither showed up in `test/simulate.js`:**
* **MC option tally was always empty.** `showLeaderboard` built the reveal from players filtered by
  `quality !== null`, but the mc-family types score a *wrong* answer as quality null — so every wrong
  answer was dropped and "how many picked each option" read `0 / 0% / nobody` for all five button
  categories (trivia, flags, silhouettes, tunes, emoji). One clause in `server.js`; non-answerers were
  already excluded by `p.answer`. `docs/ARCHITECTURE.md` §4 now records that `reveal()` sees null quality.
* **Population Split's reveal threw.** `public/games/halves.js` called `setOpacity()` on the result of
  `util.tiles.streets()`, which became an `L.layerGroup` when the satellite fade-in was added — no heat
  map, no player lines, for all 46 questions. `streets()` takes a `fade` argument now (mirrored into the
  harness copy per the sync rule in CLAUDE.md).

**Answer leak:** Size It Up's range was `truth/r1 … truth*r2` with `r1, r2` from the same `[4,14]`, which
put the truth near the geometric centre. Reading `range` in devtools and answering `sqrt(min*max)` scored
**83/100** average and was perfect 20% of the time, measured over all 71 questions. The window is now slid
so the truth sits at a uniformly random position inside it: same attack scores **26/100**, endpoints 1.7.
Measurements and a "don't reintroduce this" note are in `docs/games/sizeup.md` §2.

**Also fixed:** a double-tap on Skip advanced two steps (players never saw the reveal); connection loss
showed a 2.6 s toast and then left the player on a frozen screen (there is a persistent offline banner
now); a reconnect remounted the open question and wiped 40-45 s of part-drawn answer; players who typed a
game code never prefetched the modules, so question 1 was blank with a running timer; `answer-rejected`
for question N could reset question N+1's inputs; `haversineKm` returned NaN for near-antipodal points;
import-time guards for empty population grids / missing bbox / missing outlines; phone tap targets
(Size It Up's zoom buttons *shrank* to 30 px below 400 px); safe-area insets on the play bar and the
Create-game footer; the round counter was hidden on 375 px phones against its own comment's intent.

**Content:** fact-checked all 512 hand-written trivia + emoji questions. One error — "In which country was
basketball invented?" was keyed to Canada (it was Springfield, Massachusetts; Naismith was Canadian-born).

**Test:** `test/simulate.js`'s payload leak check treated a map question's `locationName` as forbidden
anywhere in the payload, but "Where is the Caspian Sea?" has to name its own subject — the suite failed at
random depending on which questions were drawn. Names are now checked against the payload minus the prompt.

Still open: user accounts; a free CARTO key (`CARTO_KEY`); pace defaults want real play-testing.

## Close-out pass (2026-09-05)

* **Pacing** in one place (`server.js` `TIMING` + `PACE_FACTOR`): intros 5 s / 2.2 s, everyone-answered wait >= 4 s,
  leaderboard >= 8 s + 0.5 s per extra player, new 2.5 s "time's up" buzzer pause (`time-up` event) so last-second
  answerers still see their result screen. New host option **Pace** (brisk / normal / relaxed) on the config screen.
* **Basemap**: Esri World Imagery (label-free) fades in from zoom 9 on top of the zoom-8 physical map, so close-ups
  are sharp instead of blurry (`QuizGames.util.tiles.streets()`; mirrored in the dev harness shim).
* **Size It Up rewritten** as a direct-manipulation canvas: drag the red shape / corner handle to resize, − / + / Fit
  zoom, pinch + wheel, nudge buttons, dimension brackets, sky/ground art, gradient silhouettes. Difficulty tiers:
  casual = metre ruler + readout, mixed = readout, expert = no numbers.
* **Server-side option shuffle** for mc / flag / silhouette / tune (seeded per game + question, `_shared.js mcOrder`).
* **Difficulty tiers** for compass (expert: no locator map; casual: distance hint), halves (casual: population hubs;
  expert: no capital) and curve (casual/expert shift the known fraction; expert hides y-axis values).
* **Spot the Fakes**: +30 sets (`content/fakes-2.json`) → 60. 2188 questions total.
* GeoNames added to the footer credits.

Still open: user accounts; a free CARTO key for the Voyager basemap (`CARTO_KEY`).

## v2 overhaul — status (final, 2026-09-04)

The v2 overhaul is complete and deployed from `main`:
- 20 categories / 14 game types / 2158 questions in `quiz.db`.
- Server: plugin registry (`games/`), unified scoring (`scoring.js`), reconnect, intros, host controls, rematch, QR join.
- Client: one module per game type in `public/games/`, core in `public/client.js`, dev harness in `public/dev/harness.html`,
  screenshot harness in `public/dev/_shot.html`.
- Border Draw / River Run difficulty tiers: casual = markers + length, mixed = markers only, expert = no markers (rivers: mouth only).

Headless check: `node test/simulate.js` (see CLAUDE.md for flags). Contract: `docs/ARCHITECTURE.md`. Per-type specs: `docs/games/*.md`.

Open ideas (not started): free CARTO key for the Voyager basemap (`CARTO_KEY` in `public/client.js`), more Spot-the-Fakes sets,
server-side answer shuffling for MC types, difficulty tiers for halves/sizeup/curve/compass, user accounts.

History of the build (waves, run IDs, cut-offs) lives in git history of this file.
