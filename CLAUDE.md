# QuizBlast — Project Context for Claude

## What this project is
A multiplayer quiz game inspired by gameon.world. A host configures and starts a game, players join on their own devices via a Game ID and nickname, everyone answers the same questions simultaneously, points are awarded by accuracy + speed, and a leaderboard shows after each question.

## Tech stack
- **Backend:** Node.js + Express + Socket.io (`server.js`)
- **Frontend:** Plain HTML + CSS + JavaScript (no frameworks)
- **Real-time communication:** Socket.io (WebSockets)
- **Maps:** Leaflet.js with CartoDB dark no-labels tiles + faint label overlay
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
    ├── style.css      — Noir Indigo dark theme, glass cards, gradient buttons
    ├── client.js      — browser-side: Socket.io events, screen switching, timer, maps
    └── admin.html     — question editor UI at http://localhost:3000/admin.html
```

## Core game flow
1. Host opens app → sees a configuration screen
2. Host configures: number of rounds (5/10/15/20/∞), which categories to include, autoplay on/off
3. Players join at the same URL, enter Game ID + nickname → see a waiting screen
4. Host sees lobby with live player count → clicks Start
5. Each question: host screen shows question + how many players have answered; player screens show the answer interface
6. After time runs out (or all players answer): answer result screen shown per player, then leaderboard
7. Repeat until rounds complete → final leaderboard

## Question categories
| Category | Type | Count | Notes |
|----------|------|-------|-------|
| Facts | Multiple choice | 20 | General knowledge |
| Science | Multiple choice | 20 | |
| Sports | Multiple choice | 20 | |
| Entertainment | Multiple choice | 20 | |
| Flags | Flag image + MC | 30 | Shows real flag image from flagcdn.com |
| Estimation | Slider | 23 | Drag to guess a number; scored by proximity |
| Timeline | Year slider | 25 | Drag to guess a year; scored by proximity |
| Geography | Map pin-drop | 30 | Click on Leaflet map; scored by distance |

## Answer mechanics
| Type | How it works |
|------|-------------|
| Multiple choice | 4 clickable buttons, one correct answer |
| Flag | Flag image shown, 4 country-name buttons |
| Slider | Draggable bar between a numeric range, scored by proximity |
| Timeline | Draggable marker on a year axis, scored by proximity |
| Map pin drop | Click/tap on a map, scored by haversine distance (exponential decay) |

## Scoring rules (current constants in server.js)
- `POINTS_FOR_CORRECT = 100` — base points for correct/accurate answer
- `MAX_SPEED_BONUS = 50` — speed bonus cap for MC/flag questions
- Speed bonus for slider/timeline/map is capped at **30% of MAX_SPEED_BONUS** (= 15 pts) — accuracy matters more than speed for these types
- MC/flag: correct = 100 pts base + up to 50 speed bonus (150 max per question)
- Slider/timeline: proximity-based (0–100 pts) + up to 15 speed bonus
- Map: exponential decay scoring (`exp(-dist/95)`): 10km away ≈ 90%, 50km ≈ 59%, 200km ≈ 12%
- Wrong MC answer = 0 points

## Timer limits per question type
- MC / Flags: **15 seconds**
- Estimation / Timeline: **20 seconds**
- Geography map pin: **35 seconds**

## Host controls
- Can advance manually OR use autoplay (auto-advances after `LEADERBOARD_PAUSE = 5` seconds)
- Host-only view during questions: sees question + timer + answered count (not what players answered)

## What's built
- Home screen with animated globe SVG
- Host config screen: round count, category selection, autoplay toggle
- 6-character Game ID; players join by entering ID + nickname
- Host lobby: live player list
- Per-question-type timer limits
- Speed bonus pill: live countdown of bonus available (shows correct cap per question type)
- Answer result screen: correct/wrong, score breakdown (base + speed + total)
  - MC wrong: shows what the correct answer was
  - Slider/timeline: shows your guess vs correct value
  - Map: shows km distance from correct location, 5-tier label (Pinpoint / Very close / In the area / Not quite / Way off)
- Leaderboard:
  - Per-player answer stat line (✓/✗ answer text for MC; guess + error for sliders; km away for map)
  - Animated score reveal: previous score → +gained badge pops in → counts up to new total
  - Current player's row highlighted with indigo border + "← you" label
  - Gold/silver/bronze medal styling for top 3
- Map leaderboard reveal: gold star at correct location, player pins animate in sequentially with dashed lines; auto-fit bounds
- Map tiles: CartoDB dark no-labels base + 25% opacity label overlay for orientation without giving answers away
- Autoplay off mode: host sees "Next Question →" button
- Final leaderboard + Play Again button
- Mobile-friendly layout
- Animations: screen fade-in, answer button stagger, correct flash, wrong shake, timer urgency pulse, score count-up, gain badge pop
- Sound effects (Web Audio API, no files): question chime, correct/wrong tones, countdown ticks (≤5s), leaderboard fanfare, game-over melody
- Question editor at `/admin.html`: category tabs, add/edit/delete all question types, saves to `questions.json` live

## Question database
- All questions live in `questions.json` (188 total)
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

**Visual timeline on leaderboard** — after timeline questions, the leaderboard shows a horizontal axis with a gold star at the correct year and animated player-pin dots at each player's guess. Rendered by `showLeaderboardTimeline()` in `client.js`.

---

### Not yet done

**1. Slider & timeline initial position is always the midpoint**
- The slider thumb starts at the centre of the range. Since ranges are designed to contain the answer, midpoint guessing still provides a hint.
- Fix: randomise starting thumb position within the range (±20% from midpoint) so it doesn't signal anything.

**2. Admin map picker for geography questions**
- Adding a map question requires typing lat/lng manually. An inline Leaflet map in the admin form where you click to set the correct location would be much easier.

**3. Split Geography into 3 subcategories (target: 30 questions each)**
- The single "geography" category should become three separate selectable categories so hosts can control what they get.

| Subcategory | `category` value in questions.json | Focus |
|-------------|-------------------------------------|-------|
| Natural Wonders | `geo-natural` | Mountains, rivers, lakes, national parks, coastlines |
| Built World | `geo-built` | Monuments, bridges, stadiums, famous buildings, ruins |
| Cities & Capitals | `geo-cities` | Urban centres worldwide |

- Requires: renaming/adding questions in `questions.json`, adding the 3 new category cards to `screen-host-config` in `index.html`, and updating any category filtering logic in `server.js` (currently just `q.category`).
- The existing `geography` category can remain as a catch-all or be retired once questions are migrated.

**4. Expand Timeline / History (target: 60+ questions)**
- Current count is 25. Cover all eras: ancient, medieval, early modern, modern, recent.
- Vary question framing: inventions, battles, discoveries, births, treaties, first achievements.
- Pure content work — no code changes needed.

**5. Add "Where in History" map category**
- A new map pin-drop category for historical sites: battle sites, ancient ruins, where a discovery or event happened.
- Reuses the existing map mechanic entirely — only needs new questions with `category: "geo-history"` and a new category card in the config screen.
- This is the most natural way to merge geography and history into one question type.

**6. New question type: Silhouette (MC)**
- Show a country or region outline silhouette as an image; players pick the name from 4 buttons.
- Low complexity — reuses the flag question mechanic (image + 4 MC buttons). Needs silhouette images hosted or generated.

**7. New question type: Historical Photo (timeline variant)**
- Show a black-and-white photo of a place or event; players guess the year with the timeline slider.
- Low complexity — reuses the timeline mechanic, just adds an image above the question text (same pattern as flag questions).

**8. New question type: Sequence (ordering)**
- Put 4 historical events in chronological order by dragging them.
- High complexity — requires a new drag-to-reorder UI component, new scoring logic, and new question format in `questions.json`.

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
