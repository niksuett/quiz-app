# v2 overhaul — status & how to resume (written 2026-09-03)

## Done and committed (d9bd00e)
Server core v2: `games/` plugin registry, `scoring.js`, `server.js` (reconnect tokens, intros, skip/end/kick,
pause accounting, rematch, `/api/games`, `/qr/:id`, satellite tile proxy in `games/map.js`), `db.js`/`import.js`
delegate to modules, `tools/migrate-v2.js` (ran: facts/science/sports/entertainment → `trivia`, regions tagged),
`test/simulate.js` (passes), `docs/ARCHITECTURE.md` (binding contract).

## Update 2026-09-04 01:05 — the first runs were cut off by a usage limit; relaunched
Client: core + classic modules + admin were on disk (untested together); relaunched the Integrate + Review phases
(run wf_96dd5225-e93). New games: relaunched all builders (run wf_92de2a6a-65e); compass/fakes/build-countries
partials were on disk and are being completed.

## In progress (agent workflows, files land in the working tree)
1. **Client v2** — `public/index.html`, `public/client.js`, `public/style.css` (core), `public/games/{mc,flag,slider,timeline,map,sequence}.js|css`,
   `public/core/geo.js`, `public/dev/harness.html` (module test page), `public/admin.html` (done).
   Then an integration agent plays a game in the browser and fixes bugs; then a review + fix pass.
2. **New game types (server + data + content)** — one agent each: `trace` (borders, rivers), `halves`, `sizeup`, `curve`,
   `compass`, `tune`, `silhouette`, `fakes`; plus content for `emoji` + `birdseye`; plus the existing-bank upgrade
   (`content/difficulty-tags.json`, `content/delete-ids.json`, `content/ancient-timeline.json`, `content/trivia-upgrade.json`,
   `content/geo-upgrade.json`, `tools/set-fields.js`, `tools/delete-ids.js`). Each writes `games/<type>.js`, `tools/build-<type>.js`,
   `data/…`, `content/<name>.json`, `docs/games/<type>.md`. Every content file is then fact-checked by an independent agent,
   and finally ONE import agent runs: delete-ids → set-fields → `node import.js content/*.json` → `tools/migrate-v2.js` → `test/simulate.js`.

## Still to do after those finish
- **Client modules for the 8 new types**: `public/games/{trace,halves,sizeup,curve,compass,tune,silhouette,fakes}.js|css`,
  built from `docs/games/<type>.md` + `docs/ARCHITECTURE.md` §5, tested with `public/dev/harness.html?type=<type>` and a real game.
- Integration playthrough of ALL categories in the browser (host TV tab + player tab), mobile viewport check.
- Design polish pass (screenshots), `CLAUDE.md` + `QUESTION_PIPELINE.md` update (new categories, scoring, architecture),
  then commit and **push** (Railway deploys from main — only push once client and server match).
- Known: CartoDB Voyager tiles showed an "API KEY REQUIRED" watermark from this origin during admin testing — check
  `util.tiles.streets()` in the browser; if it persists switch to `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
  (with attribution) or `https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png`.

## How to check state quickly
```bash
git status --short
node test/simulate.js
node -e "console.log(require('./games').categories.map(c=>c.id).join(', '))"
ls content data docs/games public/games
```

## Next launch (prepared, not yet run)
Third workflow script (client modules for the 8 new types → integration → review → polish), with cheaper models set:
`C:\Users\niksu\.claude\projects\C--Users-niksu-projects-quiz-app\267c105d-1923-4f46-ae31-72457d13062d\workflows\scripts\quizblast-new-games-client.js`
Launch it (Workflow tool, scriptPath) only after: (a) client integrate/review run wf_96dd5225-e93 and (b) new-games run wf_92de2a6a-65e
have finished, or after checking on disk that docs/games/*.md, games/<type>.js and public/dev/harness.html exist. If either run was
cut off again, re-create a resume variant of its script with a NOTE ON STATE listing what is on disk, as done on 2026-09-04.

## Update 2026-09-04 ~06:30 — third attempt, in smaller waves with cheaper models
On disk now: server modules compass (verified), halves, curve, fakes, silhouette; data borders/countries/silhouettes/cities/halves(47);
content borders(250) compass(88) silhouettes(132) difficulty-tags(1088) delete-ids; tools set-fields/delete-ids/build-*.
Running: wave 1 (wf_b614029e-925: trace, sizeup, tune, halves-finish, curve-finish → scratch smoke test) and the client
integration/review (wf_ac2c2ada-a41). Prepared next: workflows/scripts/quizblast-wave2.js (fakes/emoji/birdseye/content-upgrade
content + verification of all content + REAL import into quiz.db), then quizblast-new-games-client.js (browser modules for the new types).

## Update 2026-09-04 ~08:00 — server + content + classic client DONE (commits 76f6970, 8aa86e6, 6cd07fb)
- quiz.db: 2158 questions / 20 categories; all new server modules pass test/simulate.js.
- Client v2 verified end to end for the 6 classic types (TV + mobile mode, pause/skip/end, reconnect, rematch, mobile viewport).
- Basemap: CARTO Voyager now needs an API key → client falls back to Esri World_Physical (no borders). Options: free CARTO key in
  `CARTO_KEY` (public/client.js) or try Esri `Canvas/World_Light_Gray_Base` (keyless, label-free) — to be checked in wave 3.
- NOT YET: browser modules for trace/halves/sizeup/curve/compass/tune/silhouette/fakes → run workflows/scripts/quizblast-new-games-client.js
  (8 module agents → integrate → review → polish). Until then do NOT push: Party Mix would select categories the client cannot render.

## Update 2026-09-04 — wave 3 launched (run wf_3a528b80-035)
Browser modules for the 8 new types → integrate → review/fix → polish. Models: opus for trace/halves/sizeup/curve, sonnet for
compass/tune/silhouette/fakes, sonnet review+fix, opus integrate+polish. If cut off: check public/games/ for which of
{trace,halves,sizeup,curve,compass,tune,silhouette,fakes}.js|css exist, then resume with
Workflow({scriptPath: …/quizblast-new-games-client.js, resumeFromRunId: 'wf_3a528b80-035'}).

## TODO after wave 3 (user request 2026-09-04): trace difficulty tiers
Game-level difficulty (game.setup.difficulty, available in payload(q, game)) should change what the Border Draw / River Run
payload gives away: casual = endpoints + lengthKm + known segments; mixed = endpoints, no lengthKm; expert = NO endpoints,
no lengthKm (rivers: mouth only, no source). Client (public/games/trace.js) must handle missing endpoints/lengthKm/source
(no gold dots, hint text "find where it starts and ends yourself"). Update docs/games/trace.md §3 + §UI. Small sonnet agent.
