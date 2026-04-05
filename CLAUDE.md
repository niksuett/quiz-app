# QuizBlast — Project Context for Claude

## What this project is
A multiplayer quiz game inspired by gameon.world. A host configures and starts a game, players join on their own devices via a Game ID and nickname, everyone answers the same questions simultaneously, points are awarded by rank (closest answer wins), and a leaderboard shows after each question.

## Tech stack
- **Backend:** Node.js + Express + Socket.io (`server.js`)
- **Frontend:** Plain HTML + CSS + JavaScript (no frameworks)
- **Real-time communication:** Socket.io (WebSockets)
- **Maps:** Leaflet.js with CartoDB Voyager No Labels tiles (`rastertiles/voyager_nolabels`), maxZoom 19
- **Storage:** No database — game state in server memory, questions in `questions.json`
- **Entry point:** `node server.js` → runs at `http://localhost:3000`

## Project structure
```
quiz-app/
├── server.js          — backend: game logic, scoring, Socket.io events
├── questions.json     — all questions (edit here or via /admin.html)
├── package.json       — project metadata and dependencies
└── public/
    ├── index.html     — all 9 game screens in one file (shown/hidden by JS)
    ├── style.css      — Parchment & Ink theme (Cinzel/EB Garamond/Lora fonts, gold accents)
    ├── client.js      — browser-side: Socket.io events, screen switching, timer, maps
    └── admin.html     — question editor UI at http://localhost:3000/admin.html
```

## Core game flow
1. Host opens app → sees a configuration screen
2. Host configures: number of rounds (5/10/15/20/∞), which categories to include, autoplay on/off, scoring system (Rank or Accuracy + Rank)
3. Players join at the same URL, enter Game ID + nickname → see a waiting screen
4. Host sees lobby with live player count → clicks Start
5. Each question: host screen shows question + how many players have answered; player screens show the answer interface
6. After time runs out (or all players answer): answer result screen shown per player, then leaderboard
7. Repeat until rounds complete → final leaderboard

## Question categories
| Category | `category` value | Type | Count | Notes |
|----------|-----------------|------|-------|-------|
| Facts | `facts` | Multiple choice | 20 | General knowledge |
| Science | `science` | Multiple choice | 20 | |
| Sports | `sports` | Multiple choice | 20 | |
| Entertainment | `entertainment` | Multiple choice | 20 | |
| Flags | `flags` | Flag image + MC | 30 | Shows real flag image from flagcdn.com |
| Estimation | `estimation` | Slider | 23 | Drag to guess a number; scored by proximity |
| Timeline | `timeline` | Year slider | 25 | Drag to guess a year; scored by proximity |
| Natural Wonders | `geo-natural` | Map pin-drop | 10 | Mountains, lakes, waterfalls, etc. |
| Built World | `geo-built` | Map pin-drop | 22 | Monuments, temples, famous buildings |
| Cities | `geo-cities` | Map pin-drop | 12 | Urban centres worldwide |
| Where in History | `geo-history` | Map pin-drop | 8 | Battle sites, historical events, ruins |
| Sequence | `sequence` | Drag-to-order | 10 | 4 items in correct order; scored by positions correct |

## Answer mechanics
| Type | How it works |
|------|-------------|
| Multiple choice | 4 clickable buttons, one correct answer |
| Flag | Flag image shown, 4 country-name buttons |
| Slider | Draggable bar between a numeric range, scored by proximity |
| Timeline | Draggable marker on a year axis, scored by proximity |
| Map pin drop | Click/tap on a map, scored by haversine distance (exponential decay) |
| Sequence | Drag 4 items into the correct order; scored by how many are in the right position (0–4) |

## Scoring rules

Two selectable systems — host picks at game setup. Scoring is **deferred**: points are calculated server-side after all answers are in (at leaderboard time), not immediately on answer submission.

### Option A — Rank (default)
- Rank points by position: 1st=10, 2nd=8, 3rd=6, 4th=4, 5th=2, 6th+=1
- **MC/Flag:** all correct players get flat 10 pts (no speed differentiation); wrong = 0
- **Proximity (slider, timeline, map):** ranked by closeness (lowest error/distance = 1st)
- **Sequence:** ranked by correctCount descending (most positions correct = 1st)
- Players who didn't answer = 0 pts

### Option B — Accuracy + Rank
- Accuracy score 0–6 pts + rank bonus 0–4 pts = max 10 pts per question
- **MC/Flag:** correct = 6 pts base + rank bonus by speed (1st fastest=+4, 2nd=+3, 3rd=+2, 4th=+1); wrong = 0
- **Proximity:** accuracy score via `round(6 × accuracyFraction)` + rank bonus by closeness
  - Slider/timeline: `accuracyFraction = max(0, 1 − error/(range×0.5))`
  - Map: `accuracyFraction = exp(−(dist/50)^0.6)` stretched exponential
- **Sequence:** `accuracyFraction = correctCount / 4`; rank bonus by rank among players

### Result screen behaviour
- **Option A, MC correct:** shows flat "10 pts" immediately
- **Option A, proximity:** shows accuracy label ("150 km away") + "Rank points — see leaderboard"
- **Option B:** shows accuracy pts immediately + "Rank bonus on leaderboard"
- The `lb-gain` badge on the leaderboard always shows the total round points earned

## Timer limits per question type
- MC / Flags: **15 seconds**
- Sequence: **30 seconds**
- Estimation / Timeline: **20 seconds**
- Geography map pin: **35 seconds**

## Host controls
- Can advance manually OR use autoplay (auto-advances after `LEADERBOARD_PAUSE = 5` seconds)
- Host-only view during questions: sees question + timer + answered count (not what players answered)

## What's built
- Home screen with animated globe SVG (two-column: ink-dark left / parchment right)
- Host config screen: round count, category selection (11 categories), autoplay toggle, scoring system selector
- 6-character Game ID; players join by entering ID + nickname
- Host lobby: live player list
- Per-question-type timer limits (MC/flag=15s, estimation/timeline=20s, map=35s)
- Answer result screen: two-column layout (icon + heading left; score right)
  - MC correct: flat pts shown immediately (Option A) or accuracy base + "rank bonus on leaderboard" (Option B)
  - MC wrong: correct answer shown, 0 pts
  - Slider/timeline: guess vs correct, accuracy % label, pts (Option B) or "rank pending" (Option A)
  - Map: km distance, 5-tier label (Pinpoint / Very close / In the area / Not quite / Way off), same pts logic
- Leaderboard:
  - Per-player answer stat line (✓/✗ answer text for MC; guess + error for sliders; km away for map)
  - Animated score reveal: previous score → +gained badge pops in → counts up to new total
  - Current player's row highlighted with lapis border + "← you" label
  - Gold/silver/bronze medal styling for top 3
- Map leaderboard reveal: gold star at correct location, player pins animate in sequentially; auto-fit bounds, maxZoom 19
- Timeline/estimation leaderboard reveal: horizontal axis with gold star at correct value, animated player-pin dots
- Autoplay off mode: host sees "Next Question →" button
- Final leaderboard + Play Again button
- Mobile-friendly layout
- Animations: screen fade-in, answer button stagger, correct flash, wrong shake, timer urgency pulse, score count-up, gain badge pop
- Sound effects (Web Audio API, no files): question chime, correct/wrong tones, countdown ticks (≤5s), leaderboard fanfare, game-over melody
- Question editor at `/admin.html`: category tabs, add/edit/delete all question types, saves to `questions.json` live
- Historical photo support: any question can include an optional `imageUrl` field; photo shown above question text

## Question database
- All questions live in `questions.json` (213 total)
- Server reloads the file every time a new game is created — admin edits take effect without restarting
- Admin API: `GET /admin/questions` and `POST /admin/questions`
- Slider/timeline ranges are intentionally asymmetric (answer is not at midpoint)
- Geography coordinates are exact landmark locations (not just city centres)

---

## Known issues & planned improvements
*(Discovered during testing. Add new ones here as they come up.)*

### Completed

**Geography scoring curve** — replaced `exp(-dist/95)` with `exp(-(dist/50)^0.6)` in `server.js`. Same city now scores ~68pts instead of ~94pts; being in the right region still earns 10–37pts.

**Per-type result & leaderboard durations** — early-advance delay is now MC/flags=3s, estimation/timeline=4s, map=5s. Leaderboard autoplay pause is now MC/flags=5s, estimation/timeline=8s, map=10s.

**Slider/timeline text input** — the big value display for estimation and timeline questions is now an editable `<input type="number">` that stays in sync with the drag slider.

**Visual scale reveal on leaderboard** — after timeline and estimation questions, the leaderboard shows a horizontal axis with a gold star at the correct value and animated player-pin dots at each player's guess. Rendered by `showLeaderboardScale()` in `client.js`.

**Geography split into 4 subcategories** — old `geography` category retired. All 30 existing questions migrated to `geo-built` / `geo-natural` / `geo-cities`. New `geo-history` category added. 22 new questions added across all four. Config screen now shows 4 separate cards. Total questions: 188 → 210.

**Slider/timeline randomised start position** — thumb starts at a random position in the inner 80% of the range, not the midpoint.

**Historical photo support** — any question can include an optional `imageUrl` field; the photo is shown above the question text. 3 example photo-timeline questions added.

**Map leaderboard zoom** — removed `maxZoom` cap from `fitBounds` so the map zooms in as far as needed when guesses are close together.

**Map tile aesthetics** — switched both maps (question screen + leaderboard reveal) from CartoDB dark no-labels to **CartoDB Voyager No Labels** (`rastertiles/voyager_nolabels`). Lighter style with roads, water and borders visible. Removed the faint label overlay. `maxZoom` bumped to 19.

**Visual redesign: Parchment & Ink theme** — full redesign of `style.css` and `index.html`. Warm parchment/ink/gold palette. Three-font system: Cinzel (headings/labels), EB Garamond (decorative/italic), Lora (body/questions). Two-column home screen (ink left, parchment right). Two-column result screen (ink left with icon, parchment right with score). Answer buttons are white parchment cards with a colored left border per slot.

**New question type: Sequence** — drag 4 items into the correct chronological/logical order. Pointer-events drag (works on mobile and desktop). Scored by number of items in correct position (0–4), ranked like proximity questions. CSS counter auto-numbers items live as they are reordered. Leaderboard shows a correct-order numbered list + per-player 2×2 grid (green = correct position, red = wrong). 30-second timer.

**Sequence question fixes & expansion** — removed years from all item labels (years in parentheses spoiled the correct order). Expanded from 10 to 20 questions, adding non-chronological ordering tasks (planets by distance from Sun, mountains by height, oceans by size, animals by lifespan) alongside new chronological sets (US presidents, voyages of exploration, famous paintings, literature, French rulers, communication technologies).

**Scoring system rebalance** — replaced the old speed-bonus-heavy system with two selectable rank-based systems (host picks at game setup):
- **Rank** (Option A): closest answer wins most; all MC correct = same points; 10/8/6/4/2/1 pts by rank; no speed differentiation.
- **Accuracy + Rank** (Option B): 0–6 pts for accuracy; +4/3/2/1/0 rank bonus; max 10 pts per question. MC ranked by speed, proximity ranked by closeness.
- Scoring is deferred to leaderboard time (server calculates rank after all answers are in). Result screen shows accuracy feedback; leaderboard shows final rank points. Speed bonus pill removed.

**Landmark locationName accuracy audit** — updated 26 geo question `locationName` fields to include the specific landmark name (e.g. "Paris, France" → "Eiffel Tower, Paris") so the answer reveal is informative rather than just showing the city.

**Admin sequence question editor** — added Sequence as a fully editable type in `/admin.html`: four numbered item fields in correct order, collect/validate logic, pink badge. Also fixed the Geography sidebar to show the 4 real subcategories (geo-built, geo-natural, geo-cities, geo-history) with correct question counts.

**Admin map picker for geography questions** — the map question form in `/admin.html` now embeds a live Leaflet map (Voyager No Labels tiles). Click anywhere on the map to place a draggable pin; coordinates auto-fill the Lat/Lng inputs. Typing coordinates manually also moves the pin. No more hand-typing lat/lng to add geo questions.

**Sequence leaderboard layout fix** — player reveal blocks (`.seq-reveal-player`) were using the `tlPinAppear` animation which includes `translateX(-50%)`. That transform is designed for absolutely-positioned timeline pins; on regular block elements it shifted them 50% of their width to the left, escaping the card. Fixed by switching to the existing `fadeSlideIn` animation instead.

**Sequence drag fix (desktop)** — `pointermove`/`pointerup`/`pointercancel` were attached to the dragged `<li>` element directly, and `setPointerCapture` was used to keep events on it. Moving the element in the DOM via `insertBefore` caused some browsers to fire `pointercancel`, ending the drag after one move. Fixed by removing pointer capture and attaching all three listeners to `document` instead — a stable target that is unaffected by DOM changes.

**TV mode and Mobile mode** — host picks a display mode on the config screen:
- **Mobile mode** (default): host enters their own nickname and joins as a regular player. Server registers the host in `game.players`; `myRole` is set to `'player'` client-side so the host sees answer controls, result screens, and a highlighted leaderboard row. The host socket still receives `waiting-for-host` for the "Next Question →" button.
- **TV mode**: host device shows questions and leaderboard on a shared screen; players answer on their phones. Behaviour is the existing host view (read-only answer display, answer count).

**Leaderboard clarity improvements** — several fixes to make it immediately obvious why you got each score:
- `formatRoundInfo` now shows "Correct · +10 pts" for MC/Rank mode (was wrongly showing "1st place" for everyone), and "1st fastest · +10 pts" for MC/Accuracy+Rank mode (was "1st place", hiding that speed is the tiebreaker).
- Wrong/no-answer round-info rows now show in a muted colour instead of green.
- Gain badge now shows "+8 pts" instead of just "+8".
- For MC/flag questions in Accuracy+Rank mode: "⚡ Fastest correct answer earns the most points" hint shown below the answer buttons, and the result screen's rank bonus row is labelled "Speed rank bonus".
- Rank-reason text (e.g. "1st fastest · +10 pts") moved to the **right column** (below the score), so points and reason sit together. Left column now shows only name + answer stat.
- Sequence speed tiebreaker: when two players get the same number correct, the faster one ranks higher. Ties show "faster ⚡" in the rank reason instead of "most correct".
- Year decimal bug fixed: `toLocaleString()` was using the OS locale, causing "1.945" in European locales. All numeric displays now use `'en-US'` or `String()` for bare year values.

---

### Not yet done

**1. Dynamic leaderboard duration based on player count**
- The leaderboard autoplay pause is currently fixed per question type (MC=5s, timeline=8s, map=10s).
- Scale the pause with the number of players: more players → more rows to read → more time needed. Proposed formula: `base + (playerCount − 1) × 0.5s`, capped at a reasonable max (e.g. 20s). Implemented server-side when emitting `show-leaderboard` or client-side by reading the leaderboard row count.

**4. Expand Timeline / History (target: 60+ questions)**
- Current count is 25 (+ 3 photo questions). Cover all eras: ancient, medieval, early modern, modern, recent.
- Pure content work — defer to a dedicated question-writing session.

**5. New question type: Silhouette (MC)**
- Show a country/region outline silhouette; players pick the name from 4 buttons.
- Low complexity — reuses the flag question mechanic (image + 4 MC buttons).

### Supplemental categories — keep but don't grow
Facts, Science, Sports, Entertainment, Flags are supporting acts. Focus on quality over quantity; don't expand these.

---

## About the user
Complete beginner to web development. Knows basic Python and R from university but has never built a web app, used Node.js, or worked with a terminal for coding. This is their first web project.

## How to work with this user — follow these rules every session
1. **Every time you create or edit a file:** briefly explain (2–3 sentences) what that file does and why it exists.
2. **Every terminal command:** explain what the command actually does before they run it.
3. **Never assume web dev knowledge** — explain concepts simply when they come up.
4. **After each major step:** tell them what we just built and what the next step will be.
5. **Technical decisions:** explain which option was chosen and why, in plain language.
6. **Git commits and pushes:** after every larger set of edits (a feature, a redesign, a bug-fix batch), stage all changed files, commit with a clear message, and push to origin. Do this without being asked.
