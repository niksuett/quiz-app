# QuizBlast — Project Context for Claude

## What this project is
A multiplayer quiz game inspired by gameon.world. A host configures and starts a game, players join on their own devices via a Game ID and nickname, everyone answers the same questions simultaneously, points are awarded by rank (closest answer wins), and a leaderboard shows after each question.

## Tech stack
- **Backend:** Node.js + Express + Socket.io (`server.js`)
- **Frontend:** Plain HTML + CSS + JavaScript (no frameworks)
- **Real-time communication:** Socket.io (WebSockets)
- **Maps:** Leaflet.js with CartoDB Voyager No Labels tiles (`rastertiles/voyager_nolabels`), maxZoom 19
- **Storage:** SQLite (`quiz.db`) via `better-sqlite3` for questions; game state in server memory
- **Entry point:** `node server.js` → runs at `http://localhost:3000`

## Project structure
```
quiz-app/
├── server.js          — backend: game logic, scoring, Socket.io events
├── db.js              — SQLite setup, rowToQuestion / questionToRow helpers
├── migrate.js         — one-time script: loads questions.json → quiz.db (run once)
├── quiz.db            — SQLite database file (gitignored; created by migrate.js)
├── questions.json     — original question data; kept as seed/backup, not read at runtime
├── package.json       — project metadata and dependencies
└── public/
    ├── index.html     — all 9 game screens in one file (shown/hidden by JS)
    ├── style.css      — Parchment & Ink theme (Cinzel/EB Garamond/Lora fonts, gold accents)
    ├── client.js      — browser-side: Socket.io events, screen switching, timer, maps
    └── admin.html     — question editor UI at http://localhost:3000/admin.html
```

## Running locally

**First time only (or after pulling on a new machine):**
```
npm install          — installs all packages (express, socket.io, better-sqlite3)
```

**Every time:**
```
node server.js       — starts the app at http://localhost:3000
```

`quiz.db` is committed to git and is the source of truth for all questions. `questions.json` is kept only as a backup/seed reference. To add or edit questions: use the admin editor at `/admin.html`, then commit and push `quiz.db` — Railway will pick up the new questions automatically on its next deploy.

`migrate.js` only needs to be run if `quiz.db` is ever lost or corrupted. It rebuilds the database from `questions.json`.

---

## Core game flow
1. Host opens app → sees a configuration screen
2. Host configures: number of rounds (5/10/15/20/∞), which categories to include, autoplay on/off, display mode (Mobile/TV)
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
| Timeline | `timeline` | Year slider | 28 | Drag to guess a year; scored by proximity |
| Natural Wonders | `geo-natural` | Map pin-drop | 10 | Mountains, lakes, waterfalls, etc. |
| Built World | `geo-built` | Map pin-drop | 22 | Monuments, temples, famous buildings |
| Cities | `geo-cities` | Map pin-drop | 12 | Urban centres worldwide |
| Where in History | `geo-history` | Map pin-drop | 8 | Battle sites, historical events, ruins |
| Sequence | `sequence` | Drag-to-order | 20 | 4 items in correct order; scored by positions correct |

**Total: 233 questions.** Some timeline questions include an optional `imageUrl` (historical photo shown above the question text).

## Answer mechanics
| Type | How it works |
|------|-------------|
| Multiple choice | 4 clickable buttons, one correct answer |
| Flag | Flag image shown, 4 country-name buttons |
| Slider | Draggable bar + editable number input; scored by proximity to correct value |
| Timeline | Draggable marker on a year axis + editable number input; scored by proximity |
| Map pin drop | Click/tap on a Leaflet map; scored by haversine distance with exponential decay `exp(-(dist/50)^0.6)` |
| Sequence | Drag 4 items into the correct order; scored by how many are in the right position (0–4) |

Slider and timeline thumbs start at a **random position** in the inner 80% of the range (not the midpoint) to avoid anchoring bias.

## Scoring rules

Single scoring mode — **Rank + Speed**. Scoring is **deferred**: points are calculated server-side after all answers are in (at leaderboard time), not immediately on answer submission.

- Rank points by position: 1st=10, 2nd=8, 3rd=6, 4th=4, 5th=2, 6th+=1
- **MC/Flag:** ranked by answer speed (fastest correct = 1st); wrong = 0
- **Proximity (slider, timeline, map):** ranked by closeness (lowest error/distance = 1st); speed is tiebreaker on equal closeness
- **Sequence:** ranked by correctCount descending; speed is tiebreaker on equal count
- Players who didn't answer = 0 pts

### Result screen behaviour
- **MC correct:** shows "Speed rank — see leaderboard" (rank unknown until all answers in)
- **MC wrong:** shows correct answer, 0 pts
- **Proximity / sequence:** shows guess vs correct + "Rank points — see leaderboard"
- Points earned are shown in the rank-reason line below the score (e.g. "Correct · 1st fastest · +10 pts")

### Leaderboard rank-reason display
- **MC:** "Correct · 1st fastest · +10 pts" (or 2nd, 3rd, etc.)
- **Proximity:** "1st closest · +10 pts" (or "1st closest · faster ⚡ · +10 pts" when speed broke a tie)
- **Sequence:** "1st · most correct · +10 pts" (or "faster ⚡" when speed broke a tie)
- **Tied · slower** shown for the loser of a speed tiebreak

## Timer limits per question type
- MC / Flags: **15 seconds**
- Estimation / Timeline: **20 seconds**
- Sequence: **30 seconds**
- Geography map pin: **35 seconds**

## Host controls
- **Mobile mode** (default): host enters their own nickname and plays as a regular player; sees answer controls, result screens, and a highlighted leaderboard row
- **TV mode**: host device shows questions and leaderboard on a shared screen; players answer on their phones
- **Autoplay on**: game auto-advances after a dynamic pause — `base + (playerCount − 1) × 0.5s`, capped at 20s. Base times: MC/flag=5s, slider/timeline/sequence=8s, map=10s
- **Autoplay off**: host sees "Next Question →" button and advances manually
- **Pause button**: freezes the timer mid-question (bar shows ⏸ for all players) or pauses the leaderboard auto-advance countdown; resumes from exact remaining time

## What's built

**Screens & flow**
- Home screen with animated globe SVG (two-column: ink-dark left / parchment right)
- Host config: round count (5/10/15/20/∞), 12 category checkboxes (all on by default, "Deselect all" button), autoplay toggle, Mobile/TV mode selector
- 6-character Game ID; players join at the same URL with their Game ID + nickname
- Host lobby with live player list and Start button
- Per-player answer result screen (two-column: icon + heading left, score right)
- Animated leaderboard with per-player rank-reason lines and score count-up
- Final leaderboard + Play Again button

**Question display**
- Multiple choice / flag: 4 answer buttons with staggered fade-in animation
- Slider / timeline: draggable thumb + editable number input, both stay in sync
- Map: Leaflet map (Voyager No Labels tiles); click to place a pin
- Sequence: drag-and-drop list (works on mobile and desktop via pointer events)
- Optional historical photo above question text (uses `<img>` tag, not innerHTML)

**Leaderboard reveals (per question type)**
- Map: gold star at correct location, player pins animate in sequentially, map auto-fits bounds
- Timeline / estimation: horizontal axis with gold star at correct value, animated player-pin dots
- Sequence: correct-order numbered list + per-player 2×2 grid (green = correct position, red = wrong)

**Admin editor (`/admin.html`)**
- Category tabs with question counts; add / edit / delete all 6 question types
- Sequence editor: four numbered item fields in correct order
- Map picker: embedded Leaflet map — click to place a pin, coordinates auto-fill lat/lng inputs
- Saves to `quiz.db` live via the admin API (no server restart needed)

**Polish**
- Parchment & Ink visual theme: warm gold/ink palette, Cinzel / EB Garamond / Lora font system
- Sound effects via Web Audio API (no audio files): question chime, correct/wrong tones, countdown ticks (≤5s), leaderboard fanfare, game-over melody
- Animations: screen fade-in, answer button stagger, correct flash, wrong shake, timer urgency pulse, score count-up
- Mobile-friendly layout throughout

## Question database
- All questions live in `quiz.db` (SQLite, 233 total) — managed via `db.js`
- Schema: single `questions` table — `id`, `category`, `type`, `question`, `correct`, `image_url`, `extra` (JSON blob for type-varying fields: `answers[]`, `items[]`, coordinates, `min`/`max`/`step`/`unit`)
- `quiz.db` is committed to git — it is the source of truth for all questions
- `questions.json` is kept as a backup only; it is not read at runtime
- Server queries the DB on every `create-game` event — admin edits take effect without restarting
- Admin POST endpoint replaces all rows atomically in a single transaction
- User accounts can be added later as a new `users` table — no changes to `questions` needed

---

## Planned improvements

**Expand Timeline / History (target: 60+ questions)**
- Currently 28 questions. Cover all eras: ancient, medieval, early modern, modern, recent.
- Pure content work — defer to a dedicated question-writing session.

**New question type: Silhouette (MC)**
- Show a country/region outline silhouette; players pick the name from 4 buttons.
- Reuses the flag question mechanic (image + 4 MC buttons) — low implementation complexity.
- Needs a source of country silhouette SVGs.

**User accounts**
- Schema is ready (add a `users` table, optionally link questions to `created_by`).
- Frontend login/register flow and session handling not yet designed.

### Supplemental categories — keep but don't grow
Facts, Science, Sports, Entertainment, Flags are supporting acts. Focus on quality over quantity.

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
