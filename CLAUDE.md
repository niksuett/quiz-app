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

**Geography scoring curve** — replaced `exp(-dist/95)` with `exp(-(dist/50)^0.6)` in `server.js`. Same city now scores ~68pts instead of ~94pts; being in the right region still earns 10–37pts. See `submit-answer` handler, map branch.

**Per-type result & leaderboard durations** — in `server.js`, early-advance delay (when all players answer before time runs out) is now MC/flags=3s, estimation/timeline=4s, map=5s. Leaderboard autoplay pause is now MC/flags=5s, estimation/timeline=8s, map=10s.

**Slider/timeline text input** — in `client.js`, the big value display for estimation and timeline questions is now an editable `<input type="number">`. Typing syncs the slider thumb; dragging syncs the number input. Values clamp on submit. New helpers: `syncSliderFromInput`, `clampSliderInput`, `syncTimelineFromInput`, `clampTimelineInput`.

**Visual timeline on leaderboard** — after timeline questions, the leaderboard screen shows a horizontal axis with a gold star at the correct year and animated player-pin dots at each player's guess, labelled with name and year. Server sends `timelineData` (correct value + all player guesses) alongside the leaderboard payload. Rendered by `showLeaderboardTimeline()` in `client.js`. Container `#leaderboard-timeline` in `index.html`; styles in `style.css` under `/* ─── Timeline leaderboard reveal */`.

---

### Not yet done

**1. Slider & timeline initial position is always the midpoint**
- The slider thumb starts at the centre of the range. Since ranges are designed to contain the answer, midpoint guessing still provides a hint.
- Fix: randomise starting thumb position within the range (±20% from midpoint) so it doesn't signal anything.

**2. Admin map picker for geography questions**
- Adding a map question requires typing lat/lng manually. An inline Leaflet map in the admin form where you click to set the correct location would be much easier.

**3. Add text input option for slider/estimation/timeline questions** ✅ DONE
- Players can only drag the slider; there's no way to type an exact number.
- Fix: add a synced number `<input>` field next to the slider — typing updates the thumb position, dragging updates the text field.
- Applies to: Estimation, Timeline question types.

**4. Result screen duration is too short for complex question types** ✅ DONE
- After an answer is revealed, all question types use the same pause duration. Players don't have enough time to read score breakdowns or compare answers on the leaderboard for estimation/map questions.
- Fix: introduce per-type pause durations (in server.js):
  - MC / Flags: ~3 seconds (current is fine)
  - Estimation / Timeline: ~6 seconds (players want to compare guesses)
  - Geography: ~8–10 seconds (map reveal with player pins is the most engaging moment)

**6. Visual timeline for answer reveal on timeline questions** ✅ DONE
- Currently the result screen just shows "Your guess: 1847 | Correct: 1851" as text. This is dry and makes comparing against other players uninteresting.
- Fix: render a horizontal timeline bar on the answer/leaderboard screen showing:
  - A labelled marker for the correct year
  - Each player's guess as a small pin/dot on the same axis, labelled with their nickname
  - The current player's pin highlighted (distinct colour or size)
  - The visible range of the axis should span from the earliest to latest guess, with some padding, so all markers are readable
- This turns answer comparison into something visual and scannable — especially satisfying when guesses cluster around the right answer or are wildly spread out.
- Scope: affects the answer result screen and the leaderboard screen for timeline questions. The timeline axis can be a simple CSS/SVG bar; no external library needed.

**5. Geography scoring curve is unbalanced** ✅ DONE
- Current formula `exp(-dist/95)` is too forgiving at close range: being in the same city as a specific landmark (e.g. putting the pin anywhere in Rio for Christ the Redeemer, ~6km away) scores ~94 pts — nearly as good as the exact location.
- At long distances the curve drops off too fast, leaving nothing for being in the right country/region.
- Fix: switch to a stretched exponential: `100 * exp(-(dist/50)^0.6)`
  - 0 km (exact): 100 pts
  - 5 km (walking distance): ~78 pts
  - 10 km (across the city): ~68 pts
  - 50 km (nearby city): ~37 pts
  - 200 km (right region): ~10 pts
  - 500 km (right country): ~2 pts
- This punishes "close enough" city-level guesses more while preserving a long, gentle tail for wider-area guesses.

---

## Game focus & category expansion plan
*(Strategic direction for future content work)*

**Core identity: Geography + History.** These question types (map pin-drop, timeline, estimation) are the most engaging and differentiating. All category growth should prioritise them.

### Geography — split into 3 subcategories (target: 30 questions each)
| Subcategory | Focus |
|-------------|-------|
| Natural Wonders | Mountains, rivers, lakes, national parks, coastlines |
| Built World | Monuments, bridges, stadiums, famous buildings, ruins |
| Cities & Capitals | Urban centres worldwide, not just capitals |

### History / Timeline — expand significantly (target: 60+ questions)
- Cover all eras: ancient, medieval, early modern, modern, recent
- Keep the year-slider mechanic; vary question framing (inventions, battles, discoveries, births)

### New question type ideas
| Type | Description | Complexity |
|------|-------------|------------|
| **Where in History** (map) | Pin-drop for historical locations — battle sites, ancient ruins, where a discovery happened. Combines geography + history in one question. | Medium — reuses map mechanic, needs new category |
| **Silhouette** (MC) | Show a country or region outline, players name it. New MC subtype. | Low — image + 4 buttons |
| **Historical Photo** (timeline) | Show an old photo of a place or event, guess the year. Reuses timeline slider. | Low — timeline variant with image |
| **Sequence** (ordering) | Put 4 historical events in chronological order by dragging. Entirely new interaction. | High — new UI component needed |

### Supplemental categories — keep but don't grow
Facts, Science, Sports, Entertainment, Flags are supporting acts. Cap question counts; focus on quality over quantity for these.

---

## About the user
Complete beginner to web development. Knows basic Python and R from university but has never built a web app, used Node.js, or worked with a terminal for coding. This is their first web project.

## How to work with this user — follow these rules every session
1. **Every time you create or edit a file:** briefly explain (2–3 sentences) what that file does and why it exists.
2. **Every terminal command:** explain what the command actually does before they run it.
3. **Never assume web dev knowledge** — explain concepts simply when they come up.
4. **After each major step:** tell them what we just built and what the next step will be.
5. **Technical decisions:** explain which option was chosen and why, in plain language.
