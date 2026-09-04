# v2 overhaul — status (final, 2026-09-04)

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
