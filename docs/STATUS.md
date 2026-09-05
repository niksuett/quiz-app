# v2 — status

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
