// ─────────────────────────────────────────────────────────────────────────────
// client.js — runs in the browser: UI, animations, sounds, server communication
// ─────────────────────────────────────────────────────────────────────────────

const socket = io();

// ── State ─────────────────────────────────────────────────────────────────────
let myRole          = null;
let myNickname      = null;
let gameMode        = 'mobile'; // 'mobile' | 'tv'
let amHost          = false;    // true if this socket created the game (never changes to false)
let gameAutoplay    = true;     // whether autoplay is on (set when game is created)
let timerInterval      = null;
let timerTotal         = 0;     // total seconds for current question (for proportional bar on resume)
let gamePaused         = false; // client-side pause state
let resultTimeout      = null;

let leafletMap       = null;  // Leaflet map instance (during question)
let mapPin           = null;  // the marker the player drops
let pendingMapCoords = null;  // { lat, lng } set when player clicks the map
let leaderboardMap   = null;  // Leaflet map instance (leaderboard reveal)

// ═════════════════════════════════════════════════════════════════════════════
// SOUND SYSTEM
// Uses the browser's built-in Web Audio API to generate sounds on the fly —
// no audio files needed. AudioContext must be created after a user click
// (browsers block audio until the user has interacted with the page).
// ═════════════════════════════════════════════════════════════════════════════
let audioCtx = null;

function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// Plays a single tone. startOffset lets you schedule notes in the future.
function playNote(freq, duration, type = 'sine', vol = 0.22, startOffset = 0) {
  try {
    const ctx  = getAudio();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.value = freq;
    const t = ctx.currentTime + startOffset;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.start(t);
    osc.stop(t + duration + 0.01);
  } catch (e) { /* silently ignore if audio isn't available */ }
}

// Question appears — short ascending two-note cue
function soundQuestionStart() {
  playNote(440, 0.09);
  playNote(554, 0.14, 'sine', 0.22, 0.1);
}

// Correct answer — happy three-note chime (C-E-G)
function soundCorrect() {
  playNote(523, 0.13);
  playNote(659, 0.13, 'sine', 0.22, 0.13);
  playNote(784, 0.28, 'sine', 0.22, 0.26);
}

// Wrong answer — low descending buzz
function soundWrong() {
  playNote(260, 0.12, 'sawtooth', 0.18);
  playNote(190, 0.28, 'sawtooth', 0.18, 0.12);
}

// Countdown tick — quiet high click (plays each second ≤ 5)
function soundTick() {
  playNote(880, 0.04, 'square', 0.07);
}

// Leaderboard appears — ascending three-note fanfare
function soundLeaderboard() {
  playNote(392, 0.1,  'sine', 0.18);
  playNote(523, 0.1,  'sine', 0.18, 0.12);
  playNote(659, 0.22, 'sine', 0.22, 0.24);
}

// Game over — triumphant little melody
function soundGameOver() {
  playNote(523, 0.1,  'sine', 0.2);
  playNote(659, 0.1,  'sine', 0.2,  0.12);
  playNote(784, 0.1,  'sine', 0.2,  0.24);
  playNote(1047,0.35, 'sine', 0.25, 0.36);
}

// ═════════════════════════════════════════════════════════════════════════════
// ANIMATION HELPERS
// ═════════════════════════════════════════════════════════════════════════════

// Resets a CSS animation so it replays even if the element is already visible.
// Trick: removing the animation, forcing the browser to notice (offsetHeight),
// then re-applying it.
function resetAnimation(el, animationClass) {
  el.classList.remove(animationClass);
  void el.offsetHeight; // forces browser reflow
  el.classList.add(animationClass);
}

// Counts a number up from 0 to `target` over `duration` milliseconds.
function animateCount(el, target, duration = 700) {
  const start = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    // ease-out curve: starts fast, slows at the end
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(eased * target).toLocaleString('en-US');
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Builds and animates the leaderboard list, with staggered slide-ins
// and score count-up for each entry.
function renderLeaderboard(listEl, entries, questionType) {
  listEl.innerHTML = '';
  entries.forEach((entry, i) => {
    const li = document.createElement('li');
    li.style.animationDelay = `${i * 0.09}s`;
    li.classList.add('lb-animate');
    if (entry.nickname === myNickname) li.classList.add('me');

    const nameSpan = document.createElement('span');
    nameSpan.className   = 'lb-name';
    nameSpan.textContent = entry.nickname;

    const statSpan = document.createElement('span');
    statSpan.className   = 'lb-stat';
    statSpan.textContent = formatAnswerStat(entry.lastAnswer);

    const nameCol = document.createElement('div');
    nameCol.className = 'lb-name-col';
    nameCol.append(nameSpan, statSpan);

    // Score area: counts up to total → rank reason below
    const scoreWrap = document.createElement('div');
    scoreWrap.className = 'lb-score-wrap';

    const scoreSpan = document.createElement('span');
    scoreSpan.className   = 'lb-score';
    const prev = (entry.score || 0) - (entry.roundPoints || 0);
    scoreSpan.textContent = prev.toLocaleString('en-US');

    // Rank reason line: explains how points were earned (e.g. "1st fastest · +10 pts")
    const rankReasonSpan = document.createElement('span');
    rankReasonSpan.className   = 'lb-rank-reason' + (entry.roundPoints > 0 ? '' : ' lb-rank-reason-zero');
    rankReasonSpan.textContent = formatRoundInfo(entry, questionType);

    scoreWrap.append(scoreSpan, rankReasonSpan);
    li.append(nameCol, scoreWrap);
    listEl.append(li);

    const slideDelay = i * 90 + 300;
    if (entry.roundPoints > 0) {
      setTimeout(() => animateCount(scoreSpan, entry.score), slideDelay + 400);
    }
  });
}

// Builds the final-results leaderboard with per-player game stats instead of
// round-by-round details (since the game is over, rank info is less relevant).
function renderFinalLeaderboard(listEl, entries) {
  listEl.innerHTML = '';
  entries.forEach((entry, i) => {
    const li = document.createElement('li');
    li.style.animationDelay = `${i * 0.09}s`;
    li.classList.add('lb-animate');
    if (entry.nickname === myNickname) li.classList.add('me');

    const nameSpan = document.createElement('span');
    nameSpan.className   = 'lb-name';
    nameSpan.textContent = entry.nickname;

    const stats = entry.stats || {};
    const parts = [];
    if (stats.roundsAnswered) parts.push(`${stats.roundsAnswered} answered`);
    if (stats.roundsFirst)    parts.push(`${stats.roundsFirst}× 1st place`);
    if (stats.bestRound)      parts.push(`best round: +${stats.bestRound} pts`);

    const statSpan = document.createElement('span');
    statSpan.className   = 'lb-stat';
    statSpan.textContent = parts.join(' · ') || '';

    const nameCol = document.createElement('div');
    nameCol.className = 'lb-name-col';
    nameCol.append(nameSpan, statSpan);

    const scoreSpan = document.createElement('span');
    scoreSpan.className   = 'lb-score';
    scoreSpan.textContent = (entry.score || 0).toLocaleString('en-US');

    li.append(nameCol, scoreSpan);
    listEl.append(li);
  });
}

function formatAnswerStat(ans) {
  if (!ans) return 'No answer';
  if (ans.type === 'map') {
    return `📍 ${ans.distanceKm.toLocaleString('en-US')} km away`;
  }
  if (ans.type === 'slider' || ans.type === 'timeline') {
    const u      = ans.unit ? ` ${ans.unit}` : '';
    // For timeline (years) avoid thousands separator; for sliders use en-US commas
    const fmtVal = ans.type === 'timeline' ? String(Math.round(ans.value)) : ans.value.toLocaleString('en-US');
    const fmtDiff = ans.type === 'timeline' ? String(Math.round(ans.diff)) : ans.diff.toLocaleString('en-US');
    const diff = ans.diff === 0 ? 'exact!' : `off by ${fmtDiff}${u}`;
    return `${fmtVal}${u} — ${diff}`;
  }
  if (ans.type === 'sequence') {
    return `${ans.correctCount} / ${ans.correctOrder.length} in correct position`;
  }
  // MC / flag
  if (ans.isCorrect) return `✓ ${ans.answerText}`;
  return `✗ ${ans.answerText}  →  ${ans.correctText}`;
}

// Converts a number to its ordinal string: 1 → "1st", 2 → "2nd", etc.
function ordinalStr(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Returns a one-line summary of how many points a player earned this round
// and why (e.g. "Correct · 1st fastest · +10 pts" or "Incorrect · 0 pts").
function formatRoundInfo(entry, questionType) {
  const pts  = entry.roundPoints || 0;
  const rank = entry.roundRank;

  if (!entry.lastAnswer) return 'No answer · 0 pts';
  if ('isCorrect' in entry.lastAnswer && !entry.lastAnswer.isCorrect) return 'Incorrect · 0 pts';
  if (pts === 0) return '0 pts this round';

  const rankStr = rank ? ordinalStr(rank) : null;
  const isProximity = (questionType === 'slider' || questionType === 'timeline' || questionType === 'map');
  const isMC        = !isProximity && questionType !== 'sequence';

  let label;
  if (isMC) {
    // MC/flag: always ranked by speed
    label = rankStr ? `Correct · ${rankStr} fastest` : 'Correct';
  } else if (questionType === 'sequence') {
    const allCorrect = entry.lastAnswer &&
      entry.lastAnswer.correctCount === entry.lastAnswer.correctOrder?.length;
    if (allCorrect) {
      label = entry.speedTiebreak      ? `Correct · faster ⚡`
            : entry.speedTiebreakedOut ? `Correct · slower`
            :                            `Correct`;
    } else {
      label = rankStr
        ? entry.speedTiebreak      ? `${rankStr} · faster ⚡`
        : entry.speedTiebreakedOut ? `Tied · slower`
        :                            `${rankStr} · most correct`
        : null;
    }
  } else {
    // Proximity (slider / timeline / map): ranked by closeness; speed breaks ties
    const isExact = entry.lastAnswer && (
      questionType === 'map'
        ? entry.lastAnswer.distanceKm === 0
        : entry.lastAnswer.diff === 0
    );
    if (isExact) {
      label = entry.speedTiebreak      ? `Correct · faster ⚡`
            : entry.speedTiebreakedOut ? `Correct · slower`
            :                            `Correct`;
    } else {
      label = rankStr
        ? entry.speedTiebreak      ? `${rankStr} closest · faster ⚡`
        : entry.speedTiebreakedOut ? `Tied · slower`
        :                            `${rankStr} closest`
        : null;
    }
  }

  return label ? `${label} · +${pts} pts` : `+${pts} pts`;
}

// ═════════════════════════════════════════════════════════════════════════════
// SCREEN SWITCHING
// ═════════════════════════════════════════════════════════════════════════════
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ═════════════════════════════════════════════════════════════════════════════
// UI ACTIONS (called by button clicks)
// ═════════════════════════════════════════════════════════════════════════════

function hostGame() {
  myRole = 'host';
  showScreen('screen-host-config');
}

function joinGame() {
  const gameId   = document.getElementById('input-game-id').value.trim().toUpperCase();
  const nickname = document.getElementById('input-nickname').value.trim();
  clearError('join-error');
  if (!gameId)   return showError('join-error', 'Please enter a Game ID.');
  if (!nickname) return showError('join-error', 'Please enter a nickname.');
  socket.emit('join-game', { gameId, nickname });
}

function createGame() {
  clearError('config-error');
  const activeRoundBtn = document.querySelector('.round-btn.active');
  const rounds         = activeRoundBtn ? activeRoundBtn.dataset.rounds : '5';
  const categories     = Array.from(document.querySelectorAll('.cat-card input:checked'))
                           .map(cb => cb.value);
  if (categories.length === 0)
    return showError('config-error', 'Please select at least one category.');
  const autoplay      = document.getElementById('autoplay-toggle').checked;
  const activeModeBtn = document.querySelector('#mode-selector .scoring-btn.active');
  const selectedMode  = activeModeBtn ? activeModeBtn.dataset.mode : 'mobile';
  socket.emit('create-game', { rounds, categories, autoplay, gameMode: selectedMode });
}

function startGame() {
  clearError('start-error');
  if (gameMode === 'mobile') {
    const hostNickname = document.getElementById('host-nickname-input').value.trim();
    if (!hostNickname)
      return showError('start-error', 'Enter your nickname to join the game.');
    myNickname = hostNickname;
    myRole     = 'player'; // host plays as a regular player in mobile mode
    socket.emit('start-game', { hostNickname });
  } else {
    socket.emit('start-game', {});
  }
}

function submitAnswer(index) {
  document.querySelectorAll('.answer-btn').forEach(b => (b.disabled = true));
  document.getElementById('speed-bonus-display').classList.add('hidden');
  socket.emit('submit-answer', { answerIndex: index });
}

function nextQuestion() {
  document.getElementById('next-question-btn').classList.add('hidden');
  socket.emit('next-question');
}

function deselectAllCategories() {
  document.querySelectorAll('.cat-card input').forEach(cb => {
    cb.checked = false;
    cb.closest('.cat-card').classList.remove('checked');
  });
}

// ── Config screen interactivity ───────────────────────────────────────────────
document.querySelectorAll('.round-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.round-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.querySelectorAll('#mode-selector .scoring-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#mode-selector .scoring-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

document.getElementById('autoplay-toggle').addEventListener('change', function () {
  document.getElementById('autoplay-desc').textContent = this.checked
    ? 'On — next question loads automatically'
    : 'Off — you control when each question starts';
});

// ── Error helpers ─────────────────────────────────────────────────────────────
function showError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError(id) {
  document.getElementById(id).classList.add('hidden');
}

// ═════════════════════════════════════════════════════════════════════════════
// COUNTDOWN TIMER
// ═════════════════════════════════════════════════════════════════════════════
function startTimer(seconds) {
  clearInterval(timerInterval);
  timerTotal = seconds;
  let remaining = seconds;
  updateTimer(remaining, seconds);

  timerInterval = setInterval(() => {
    remaining--;
    if (remaining < 0) { clearInterval(timerInterval); return; }
    updateTimer(remaining, seconds);

    // Countdown ticks + urgent pulse for the last 5 seconds
    if (remaining <= 5 && remaining > 0) {
      soundTick();
      document.getElementById('timer-text').classList.add('timer-urgent');
    }
  }, 1000);
}

// Resumes the timer after a pause, using the original total for correct bar proportions.
function resumeTimer(remainingMs) {
  clearInterval(timerInterval);
  let remaining = Math.ceil(remainingMs / 1000);
  updateTimer(remaining, timerTotal);

  timerInterval = setInterval(() => {
    remaining--;
    if (remaining < 0) { clearInterval(timerInterval); return; }
    updateTimer(remaining, timerTotal);
    if (remaining <= 5 && remaining > 0) {
      soundTick();
      document.getElementById('timer-text').classList.add('timer-urgent');
    }
  }, 1000);
}

function togglePause() {
  if (gamePaused) {
    socket.emit('resume-game');
  } else {
    socket.emit('pause-game');
  }
}

function updateTimer(remaining, total) {
  const pct  = (remaining / total) * 100;
  const fill = document.getElementById('timer-fill');
  const text = document.getElementById('timer-text');
  fill.style.width = pct + '%';
  text.textContent = remaining;

  const color = remaining > total * 0.5  ? 'var(--gold-bright)'
              : remaining > total * 0.25 ? '#e07020'
              :                            'var(--wrong)';
  fill.style.backgroundColor = color;
  text.style.color            = color;

  // Speed bonus pill is unused in rank-based scoring — kept hidden by new-question handler
}

function stopTimer() {
  clearInterval(timerInterval);
  document.getElementById('timer-text').classList.remove('timer-urgent');
  // Hide the speed bonus pill once the question is over
  const pill = document.getElementById('speed-bonus-display');
  if (pill) pill.classList.add('hidden');
}

// ═════════════════════════════════════════════════════════════════════════════
// SOCKET EVENTS FROM THE SERVER
// ═════════════════════════════════════════════════════════════════════════════

socket.on('create-error', (msg) => showError('config-error', msg));

socket.on('game-created', ({ gameId, gameMode: mode, autoplay }) => {
  amHost       = true;
  gameMode     = mode || 'mobile';
  gameAutoplay = autoplay !== false;
  document.getElementById('host-game-id').textContent = gameId;
  document.getElementById('player-count').textContent = '0';
  document.getElementById('player-list').innerHTML    = '';
  document.getElementById('host-nickname-input').value = '';
  clearError('start-error');
  // Show nickname input only in mobile mode (host plays as a player)
  document.getElementById('host-nickname-section').classList.toggle('hidden', gameMode !== 'mobile');
  // Update start button label to make the action clear
  document.getElementById('start-btn').textContent =
    gameMode === 'mobile' ? '▶ Join & Start' : '▶ Start Game';
  showScreen('screen-host-lobby');
});

socket.on('lobby-update', ({ players }) => {
  document.getElementById('player-count').textContent = players.length;
  document.getElementById('player-list').innerHTML =
    players.map(name => `<li>👤 ${name}</li>`).join('');
});

socket.on('start-error', (msg) => showError('start-error', msg));

socket.on('join-success', ({ gameId, nickname }) => {
  myNickname = nickname;
  myRole     = 'player';
  document.getElementById('lobby-nickname').textContent = nickname;
  document.getElementById('lobby-game-id').textContent  = gameId;
  clearError('join-error');
  showScreen('screen-player-lobby');
});

socket.on('join-error', (msg) => showError('join-error', msg));

// ── New question ──────────────────────────────────────────────────────────────
socket.on('new-question', ({ questionNumber, totalQuestions, question, answers, timeLimit, type, min, max, step, unit, imageUrl, items }) => {
  stopTimer();
  clearTimeout(resultTimeout);
  soundQuestionStart();
  // Clean up the leaderboard reveal map from the previous question
  if (leaderboardMap) { leaderboardMap.remove(); leaderboardMap = null; }

  document.getElementById('question-number').textContent =
    `Question ${questionNumber} / ${totalQuestions}`;

  // Show/hide the historical photo (separate element above the question text)
  const photoEl = document.getElementById('question-photo');
  if (photoEl) {
    if (imageUrl) {
      photoEl.src = imageUrl;
      photoEl.classList.remove('hidden');
    } else {
      photoEl.src = '';
      photoEl.classList.add('hidden');
    }
  }

  // Render the question text
  const qText = document.getElementById('question-text');
  if (type === 'flag') {
    // question = ISO 2-letter code (e.g. 'fr') — fetch real image from flagcdn.com
    qText.innerHTML =
      `<span class="flag-prompt">Which country does this flag belong to?</span>` +
      `<img src="https://flagcdn.com/w320/${question}.png" class="flag-image" alt="Flag">`;
  } else {
    qText.textContent = question;
  }
  resetAnimation(qText, 'question-slide');

  const colors  = ['answer-a', 'answer-b', 'answer-c', 'answer-d'];
  const letters = ['A', 'B', 'C', 'D'];
  const grid    = document.getElementById('answers-grid');

  if (type === 'timeline') {
    // ── Timeline question UI ────────────────────────────────────────────────
    grid.classList.add('slider-mode');
    // Random start: anywhere in the inner 80% of the range so the initial
    // thumb position doesn't hint at the answer
    const margin  = Math.round((max - min) * 0.1);
    const midYear = Math.round(min + margin + Math.random() * (max - min - 2 * margin));

    // Build 5 evenly-spaced year labels for the tick row
    const ticks = Array.from({ length: 5 }, (_, i) =>
      Math.round(min + (i / 4) * (max - min))
    ).map(y => `<span>${y}</span>`).join('');

    grid.innerHTML = `
      <div class="timeline-wrap">
        <input type="number" class="timeline-year-input" id="timeline-year-display"
               min="${min}" max="${max}" step="1" value="${midYear}"
               oninput="syncTimelineFromInput(this.value)"
               onblur="clampTimelineInput()"
               ${myRole === 'host' ? 'disabled' : ''}>
        <input type="range" id="timeline-input" class="timeline-input"
               min="${min}" max="${max}" step="1" value="${midYear}"
               oninput="updateTimelineDisplay(this.value)"
               ${myRole === 'host' ? 'disabled' : ''}>
        <div class="timeline-tick-labels">${ticks}</div>
        ${myRole !== 'host'
          ? `<button class="btn btn-red slider-submit-btn" id="timeline-submit-btn"
                     onclick="submitTimeline()">Lock In Year</button>`
          : `<p style="color:#888; margin-top:16px; font-size:0.9rem;">👀 Players are guessing the year…</p>`
        }
      </div>`;

    document.getElementById('host-label').classList.add('hidden');
    document.getElementById('answer-progress')
      .classList[myRole === 'host' ? 'remove' : 'add']('hidden');
    if (myRole === 'host')
      document.getElementById('progress-text').textContent = `0 / ? answered`;

  } else if (type === 'slider') {
    // ── Slider question UI ──────────────────────────────────────────────────
    grid.classList.add('slider-mode');
    // Random start: anywhere in the inner 80% of the range
    const margin   = (max - min) * 0.1;
    const rawStart = min + margin + Math.random() * (max - min - 2 * margin);
    const midPoint = Math.round(rawStart / (step || 1)) * (step || 1);
    grid.innerHTML = `
      <div class="slider-wrap">
        <div class="slider-value-row">
          <input type="number" class="slider-number-input" id="slider-value-display"
                 min="${min}" max="${max}" step="${step}" value="${midPoint}"
                 oninput="syncSliderFromInput(this.value)"
                 onblur="clampSliderInput()"
                 ${myRole === 'host' ? 'disabled' : ''}>
          ${unit ? `<span class="slider-unit-label">${unit}</span>` : ''}
        </div>
        <input type="range" id="answer-slider" class="answer-slider"
               min="${min}" max="${max}" step="${step}" value="${midPoint}"
               oninput="updateSliderDisplay(this.value)"
               ${myRole === 'host' ? 'disabled' : ''}>
        <div class="slider-bounds">
          <span>${min.toLocaleString('en-US')}${unit ? ' ' + unit : ''}</span>
          <span>${max.toLocaleString('en-US')}${unit ? ' ' + unit : ''}</span>
        </div>
        ${myRole !== 'host'
          ? `<button class="btn btn-red slider-submit-btn" id="slider-submit-btn"
                     onclick="submitSlider()">Lock In Answer</button>`
          : `<p style="color:#888; margin-top:16px; font-size:0.9rem;">👀 Players are sliding…</p>`
        }
      </div>`;
    document.getElementById('host-label').classList.add('hidden');
    document.getElementById('answer-progress').classList[myRole === 'host' ? 'remove' : 'add']('hidden');
    if (myRole === 'host') document.getElementById('progress-text').textContent = `0 / ? answered`;

  } else if (type === 'map') {
    // ── Map pin-drop UI ─────────────────────────────────────────────────────
    grid.classList.add('slider-mode');
    // Destroy any leftover map from a previous question
    if (leafletMap) { leafletMap.remove(); leafletMap = null; mapPin = null; }
    pendingMapCoords = null;

    if (myRole !== 'host') {
      grid.innerHTML = `
        <div class="map-wrap">
          <div class="map-hint" id="map-hint">Click anywhere on the map to drop your pin</div>
          <div id="map-container" class="map-container"></div>
          <button class="btn btn-red slider-submit-btn" id="map-submit-btn"
                  onclick="submitMapAnswer()" disabled>Lock In Location</button>
        </div>`;
      // Leaflet needs the container to be visible before it can measure its size,
      // so we initialise it on the next animation frame (after showScreen runs).
      requestAnimationFrame(initLeafletMap);
    } else {
      grid.innerHTML = `
        <div class="map-wrap">
          <div class="map-placeholder">🗺️ Players are pinning their guesses on the map…</div>
        </div>`;
    }
    document.getElementById('host-label').classList.add('hidden');
    document.getElementById('answer-progress')
      .classList[myRole === 'host' ? 'remove' : 'add']('hidden');
    if (myRole === 'host')
      document.getElementById('progress-text').textContent = `0 / ? answered`;

  } else if (type === 'sequence') {
    // ── Sequence drag-to-order UI ───────────────────────────────────────────
    grid.classList.add('slider-mode');
    if (myRole !== 'host') {
      const itemsHtml = (items || []).map(text =>
        `<li class="seq-item" data-text="${text.replace(/"/g, '&quot;')}">${text}</li>`
      ).join('');
      grid.innerHTML = `
        <div class="seq-wrap">
          <p class="seq-instruction">Drag items into the correct order — earliest / first at the top</p>
          <ol class="seq-list" id="seq-list">${itemsHtml}</ol>
          <button class="btn btn-red slider-submit-btn" id="seq-submit-btn"
                  onclick="submitSequence()">Lock In Order</button>
        </div>`;
      initSequenceDrag();
    } else {
      grid.innerHTML = `
        <div class="seq-wrap">
          <div class="map-placeholder">🔢 Players are ordering the sequence…</div>
        </div>`;
    }
    document.getElementById('host-label').classList.add('hidden');
    document.getElementById('answer-progress')
      .classList[myRole === 'host' ? 'remove' : 'add']('hidden');
    if (myRole === 'host')
      document.getElementById('progress-text').textContent = `0 / ? answered`;

  } else {
    // ── Multiple choice UI (text or flag) ───────────────────────────────────
    grid.classList.remove('slider-mode');
    if (myRole === 'host') {
      grid.innerHTML = answers.map((text, i) =>
        `<button class="answer-btn ${colors[i]}"
                 style="animation: bounceIn 0.35s ease ${i * 0.1}s both"
                 disabled>
          <span class="answer-letter">${letters[i]}</span>${text}
        </button>`
      ).join('');
      document.getElementById('host-label').classList.add('hidden'); // not needed on TV
      document.getElementById('answer-progress').classList.remove('hidden');
      document.getElementById('progress-text').textContent = `0 / ? answered`;
    } else {
      grid.innerHTML = answers.map((text, i) =>
        `<button class="answer-btn ${colors[i]}"
                 style="animation: bounceIn 0.35s ease ${i * 0.1}s both"
                 onclick="submitAnswer(${i})">
          <span class="answer-letter">${letters[i]}</span>${text}
        </button>`
      ).join('');
      document.getElementById('host-label').classList.add('hidden');
      document.getElementById('answer-progress').classList.add('hidden');
    }
  }

  // Speed hint: only for MC/flag questions in Accuracy+Rank mode
  const qHint = document.getElementById('question-hint');
  if (qHint) {
    const isMCType = type !== 'slider' && type !== 'timeline' && type !== 'map' && type !== 'sequence';
    qHint.textContent = '⚡ Fastest correct answer earns the most points';
    qHint.classList.toggle('hidden', !isMCType);
  }

  showScreen('screen-question');
  startTimer(timeLimit);

  // Speed bonus pill is not used in rank-based scoring — always keep hidden
  const pill = document.getElementById('speed-bonus-display');
  if (pill) pill.classList.add('hidden');

  // Pause button: only the host sees it; hide leaderboard button, show question button
  gamePaused = false;
  setPauseBtns('⏸ Pause', false);
  const pauseBtn   = document.getElementById('pause-btn');
  const pauseBtnLb = document.getElementById('pause-btn-lb');
  if (pauseBtn)   pauseBtn.classList.toggle('hidden', !amHost);
  if (pauseBtnLb) pauseBtnLb.classList.add('hidden');
});

// ── Answer progress (host only) ───────────────────────────────────────────────
socket.on('answer-progress', ({ answered, total }) => {
  document.getElementById('progress-text').textContent = `${answered} / ${total} answered`;
});

// ── Pause / Resume ────────────────────────────────────────────────────────────
socket.on('game-paused', () => {
  gamePaused = true;
  // Freeze the countdown timer only on the question screen
  if (document.getElementById('screen-question').classList.contains('active')) {
    clearInterval(timerInterval);
    const timerText = document.getElementById('timer-text');
    if (timerText) { timerText.textContent = '⏸'; timerText.classList.remove('timer-urgent'); }
    const fill = document.getElementById('timer-fill');
    if (fill) fill.style.backgroundColor = 'var(--aged)';
  }
  setPauseBtns('▶ Resume', true);
});

socket.on('game-resumed', ({ remainingMs }) => {
  gamePaused = false;
  setPauseBtns('⏸ Pause', false);
  // Only restart the visual timer if currently on the question screen
  if (document.getElementById('screen-question').classList.contains('active')) {
    resumeTimer(remainingMs);
  }
});

// Updates the text and paused state of both pause buttons (question + leaderboard screens).
function setPauseBtns(text, paused) {
  ['pause-btn', 'pause-btn-lb'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = text;
    btn.classList.toggle('paused', paused);
  });
}

// ── Slider helper functions ───────────────────────────────────────────────────

// Called every time the slider thumb moves — keeps the number input in sync
function updateSliderDisplay(value) {
  const numInput = document.getElementById('slider-value-display');
  if (numInput) numInput.value = Number(value);
}

// Called when the player types in the number input — keeps the range slider in sync
function syncSliderFromInput(value) {
  const slider = document.getElementById('answer-slider');
  if (slider) slider.value = value;
}

// Called when the player leaves the number input — clamps to valid range
function clampSliderInput() {
  const numInput = document.getElementById('slider-value-display');
  const slider   = document.getElementById('answer-slider');
  if (!numInput || !slider) return;
  const v = Math.max(parseInt(slider.min) || 0, Math.min(parseInt(slider.max) || 999999, parseInt(numInput.value) || parseInt(slider.value)));
  numInput.value = v;
  slider.value   = v;
}

// Called when the player clicks "Lock In Answer" on an estimation question
function submitSlider() {
  clampSliderInput(); // ensure number input and slider agree before reading
  const slider   = document.getElementById('answer-slider');
  const numInput = document.getElementById('slider-value-display');
  const btn      = document.getElementById('slider-submit-btn');
  const value    = parseInt(slider.value, 10);
  slider.disabled   = true;
  if (numInput) numInput.disabled = true;
  btn.disabled      = true;
  btn.textContent   = 'Locked in!';
  document.getElementById('speed-bonus-display').classList.add('hidden');
  socket.emit('submit-answer', { answerValue: value });
}

// ── Timeline helper functions ─────────────────────────────────────────────────

// Called every time the timeline thumb moves — keeps the year input in sync
function updateTimelineDisplay(value) {
  const numInput = document.getElementById('timeline-year-display');
  if (numInput) numInput.value = value;
}

// Called when the player types in the year input — keeps the range slider in sync
function syncTimelineFromInput(value) {
  const slider = document.getElementById('timeline-input');
  if (slider) slider.value = value;
}

// Called when the player leaves the year input — clamps to valid range
function clampTimelineInput() {
  const numInput = document.getElementById('timeline-year-display');
  const slider   = document.getElementById('timeline-input');
  if (!numInput || !slider) return;
  const v = Math.max(parseInt(slider.min), Math.min(parseInt(slider.max), parseInt(numInput.value) || parseInt(slider.value)));
  numInput.value = v;
  slider.value   = v;
}

// Called when the player clicks "Lock In Year"
function submitTimeline() {
  clampTimelineInput(); // ensure year input and slider agree before reading
  const slider   = document.getElementById('timeline-input');
  const numInput = document.getElementById('timeline-year-display');
  const btn      = document.getElementById('timeline-submit-btn');
  const value    = parseInt(slider.value, 10);
  slider.disabled   = true;
  if (numInput) numInput.disabled = true;
  btn.disabled      = true;
  btn.textContent   = 'Locked in!';
  document.getElementById('speed-bonus-display').classList.add('hidden');
  socket.emit('submit-answer', { answerValue: value });
}

// ── Map helper functions ──────────────────────────────────────────────────────

// Creates the Leaflet map inside #map-container and listens for clicks
function initLeafletMap() {
  leafletMap = L.map('map-container', { zoomControl: true }).setView([20, 0], 2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 19,
  }).addTo(leafletMap);

  // Custom red dot icon for the player's pin
  const playerPinIcon = L.divIcon({
    html: '<div class="lf-player-pin"></div>',
    className: '',
    iconSize:   [22, 22],
    iconAnchor: [11, 11],
  });

  leafletMap.on('click', function (e) {
    const { lat, lng } = e.latlng;
    pendingMapCoords = { lat, lng };
    if (mapPin) {
      mapPin.setLatLng([lat, lng]);
    } else {
      mapPin = L.marker([lat, lng], { icon: playerPinIcon }).addTo(leafletMap);
    }
    const btn  = document.getElementById('map-submit-btn');
    const hint = document.getElementById('map-hint');
    if (btn)  btn.disabled     = false;
    if (hint) hint.textContent = 'Pin placed! Click elsewhere to move it, or lock in your answer.';
  });
}

// Called when the player clicks "Lock In Location"
function submitMapAnswer() {
  if (!pendingMapCoords) return;
  const btn = document.getElementById('map-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Locked in!'; }
  if (leafletMap) leafletMap.off('click'); // prevent moving pin after submission
  document.getElementById('speed-bonus-display').classList.add('hidden');
  socket.emit('submit-answer', { answerLat: pendingMapCoords.lat, answerLng: pendingMapCoords.lng });
}

// ── Sequence drag-to-order ────────────────────────────────────────────────────

// Wires up pointer-based drag-to-reorder on the sequence list.
// Works with both mouse (desktop) and touch (mobile) via the Pointer Events API.
function initSequenceDrag() {
  const list = document.getElementById('seq-list');
  if (!list) return;

  let dragging = null; // the <li> currently being dragged

  list.addEventListener('pointerdown', e => {
    const item = e.target.closest('.seq-item');
    if (!item || item.classList.contains('seq-locked')) return;
    e.preventDefault();

    item.classList.add('seq-grabbed');
    dragging = item;

    const onMove = ev => {
      if (!dragging) return;
      const y        = ev.clientY;
      const siblings = [...list.querySelectorAll('.seq-item:not(.seq-grabbed)')];

      // Find the first sibling whose midpoint is below the pointer
      let target = null;
      for (const sib of siblings) {
        const r = sib.getBoundingClientRect();
        if (y < r.top + r.height / 2) { target = sib; break; }
      }

      // Only update DOM when position would actually change (avoids jitter)
      if (target !== null && dragging.nextElementSibling !== target) {
        list.insertBefore(dragging, target);
      } else if (target === null && dragging.nextElementSibling !== null) {
        list.appendChild(dragging);
      }
    };

    const onEnd = () => {
      if (dragging) {
        dragging.classList.remove('seq-grabbed');
        dragging = null;
      }
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup',     onEnd);
      document.removeEventListener('pointercancel', onEnd);
    };

    // Listen on document so events keep firing even when the pointer moves
    // outside the list or the dragged element repositions in the DOM.
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup',     onEnd, { once: true });
    document.addEventListener('pointercancel', onEnd, { once: true });
  });
}

// Called when the player clicks "Lock In Order"
function submitSequence() {
  const list = document.getElementById('seq-list');
  const btn  = document.getElementById('seq-submit-btn');
  if (!list || !btn) return;

  // Read the current DOM order — each item's text is in data-text
  const order = [...list.querySelectorAll('.seq-item')].map(li => li.dataset.text);

  list.querySelectorAll('.seq-item').forEach(li => li.classList.add('seq-locked'));
  btn.disabled    = true;
  btn.textContent = 'Locked in!';
  document.getElementById('speed-bonus-display').classList.add('hidden');
  socket.emit('submit-answer', { answerSequence: order });
}

// Renders the post-question map reveal on the leaderboard screen.
// Shows a gold star at the correct location, then animates each player's
// pin in one by one, with a dashed line back to the correct spot.
function showLeaderboardMap(mapData) {
  if (leaderboardMap) { leaderboardMap.remove(); leaderboardMap = null; }

  const wrap = document.getElementById('leaderboard-map');
  wrap.innerHTML = '<div id="lb-map-container" class="lb-map-container"></div>';
  wrap.classList.remove('hidden');

  // Leaflet needs the container visible before it measures dimensions
  requestAnimationFrame(() => {
    leaderboardMap = L.map('lb-map-container', {
      zoomControl: true,
      attributionControl: false,
    }).setView([mapData.correctLat, mapData.correctLng], 4);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(leaderboardMap);

    // ── Correct location: gold star marker ──────────────────────────────────
    const correctIcon = L.divIcon({
      html:       '<div class="lf-correct-marker">★</div>',
      className:  '',
      iconSize:   [34, 34],
      iconAnchor: [17, 17],
      popupAnchor:[0, -20],
    });
    L.marker([mapData.correctLat, mapData.correctLng], { icon: correctIcon, zIndexOffset: 1000 })
      .addTo(leaderboardMap)
      .bindPopup(`<b>✓ ${mapData.locationName}</b>`);

    const allLatLngs = [[mapData.correctLat, mapData.correctLng]];

    // ── Player pins: animate in one by one ──────────────────────────────────
    mapData.playerPins.forEach((pin, i) => {
      setTimeout(() => {
        allLatLngs.push([pin.lat, pin.lng]);

        // Dashed line from player's guess to the correct spot
        L.polyline(
          [[pin.lat, pin.lng], [mapData.correctLat, mapData.correctLng]],
          { color: '#aaa', weight: 1.5, dashArray: '6, 5', opacity: 0.5 }
        ).addTo(leaderboardMap);

        const initial = pin.nickname.charAt(0).toUpperCase();
        const pinIcon = L.divIcon({
          html:       `<div class="lf-reveal-pin">${initial}</div>`,
          className:  '',
          iconSize:   [28, 28],
          iconAnchor: [14, 14],
          popupAnchor:[0, -16],
        });
        L.marker([pin.lat, pin.lng], { icon: pinIcon })
          .addTo(leaderboardMap)
          .bindPopup(`<b>${pin.nickname}</b><br>${pin.distanceKm.toLocaleString('en-US')} km away`);

        // After the last pin lands, zoom to fit everything
        if (i === mapData.playerPins.length - 1) {
          setTimeout(() => {
            leaderboardMap.fitBounds(allLatLngs, { padding: [50, 50] });
          }, 400);
        }
      }, 600 + i * 400);
    });

    // If nobody submitted a guess, just stay zoomed on the correct location
    if (mapData.playerPins.length === 0) {
      leaderboardMap.setView([mapData.correctLat, mapData.correctLng], 6);
    }
  });
}

// Renders the post-question scale reveal on the leaderboard screen.
// Used for both timeline and estimation (slider) questions.
// Shows a gold star at the correct value, then animates each player's guess
// onto the same axis, labelled with their nickname.
function showLeaderboardScale(timelineData) {
  const wrap = document.getElementById('leaderboard-timeline');
  wrap.innerHTML = '';
  wrap.classList.remove('hidden');

  const { correctValue, unit, playerGuesses } = timelineData;
  const fmt = v => unit ? `${v.toLocaleString('en-US')} ${unit}` : String(v);

  // Calculate the visible axis range with a bit of padding on each side
  const allValues = [correctValue, ...playerGuesses.map(g => g.value)];
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const span   = Math.max(rawMax - rawMin, 20); // minimum span of 20 to avoid a collapsed axis
  const pad    = Math.max(5, Math.round(span * 0.12));
  const visMin = rawMin - pad;
  const visMax = rawMax + pad;
  const visSpan = visMax - visMin;

  // Convert a value to a left-percentage on the axis
  const pct = v => Math.max(1, Math.min(99, ((v - visMin) / visSpan) * 100));

  // Header label
  const header = document.createElement('div');
  header.className   = 'tl-reveal-header';
  header.textContent = 'Where did everyone guess?';
  wrap.appendChild(header);

  // The track holds the axis line, tick marks, and all pins
  const track = document.createElement('div');
  track.className = 'tl-track';
  wrap.appendChild(track);

  const axisLine = document.createElement('div');
  axisLine.className = 'tl-axis-line';
  track.appendChild(axisLine);

  // 6 evenly-spaced tick marks + a year-label row below the track
  const labelsRow = document.createElement('div');
  labelsRow.className = 'tl-year-labels';
  wrap.appendChild(labelsRow);

  for (let i = 0; i <= 5; i++) {
    const v = Math.round(visMin + (i / 5) * visSpan);
    const p = pct(v);

    const tick = document.createElement('div');
    tick.className  = 'tl-tick-mark';
    tick.style.left = p + '%';
    track.appendChild(tick);

    const lbl = document.createElement('span');
    lbl.className  = 'tl-tick-label';
    lbl.style.left = p + '%';
    lbl.textContent = v;
    labelsRow.appendChild(lbl);
  }

  // Correct answer pin — appears first with a short delay
  setTimeout(() => {
    const pin = document.createElement('div');
    pin.className  = 'tl-pin-wrap tl-correct-pin';
    pin.style.left = pct(correctValue) + '%';
    pin.innerHTML  = `
      <div class="tl-pin-name">Correct</div>
      <div class="tl-pin-value">${fmt(correctValue)}</div>
      <div class="tl-pin-dot">★</div>`;
    track.appendChild(pin);
  }, 250);

  // Player pins — animate in one by one
  playerGuesses.forEach((guess, i) => {
    const isMe    = guess.nickname === myNickname;
    const initial = guess.nickname.charAt(0).toUpperCase();
    setTimeout(() => {
      const pin = document.createElement('div');
      pin.className  = 'tl-pin-wrap tl-player-pin' + (isMe ? ' tl-me-pin' : '');
      pin.style.left = pct(guess.value) + '%';
      pin.innerHTML  = `
        <div class="tl-pin-name">${guess.nickname}${isMe ? ' ←' : ''}</div>
        <div class="tl-pin-value">${fmt(guess.value)}</div>
        <div class="tl-pin-dot">${initial}</div>`;
      track.appendChild(pin);
    }, 550 + i * 350);
  });
}

// Renders the post-question sequence reveal on the leaderboard screen.
// Shows the correct order as a numbered list, then each player's answers
// in a 2-column grid (green = correct position, red tint = wrong).
function showLeaderboardSequence(seqData) {
  const wrap = document.getElementById('leaderboard-sequence');
  wrap.innerHTML = '';
  wrap.classList.remove('hidden');

  const { correctOrder, playerAnswers } = seqData;

  // Header
  const header = document.createElement('div');
  header.className   = 'tl-reveal-header';
  header.textContent = 'Correct order';
  wrap.appendChild(header);

  // Correct order — numbered list
  const correctList = document.createElement('ol');
  correctList.className = 'seq-reveal-list';
  correctOrder.forEach(text => {
    const li = document.createElement('li');
    li.className   = 'seq-reveal-item seq-reveal-correct';
    li.textContent = text;
    correctList.appendChild(li);
  });
  wrap.appendChild(correctList);

  // Per-player blocks — stagger in one by one
  playerAnswers.forEach((pa, pi) => {
    setTimeout(() => {
      const block = document.createElement('div');
      block.className = 'seq-reveal-player' + (pa.nickname === myNickname ? ' seq-reveal-me' : '');

      const nameRow = document.createElement('div');
      nameRow.className   = 'seq-reveal-name';
      nameRow.textContent = `${pa.nickname} — ${pa.correctCount}/${correctOrder.length}`;
      block.appendChild(nameRow);

      const grid = document.createElement('div');
      grid.className = 'seq-reveal-grid';
      correctOrder.forEach((correctText, i) => {
        const playerText = pa.playerOrder[i] || '—';
        const isMatch    = playerText === correctText;
        const cell       = document.createElement('div');
        cell.className   = 'seq-reveal-cell ' + (isMatch ? 'seq-cell-match' : 'seq-cell-miss');
        cell.textContent = playerText;
        grid.appendChild(cell);
      });
      block.appendChild(grid);
      wrap.appendChild(block);
    }, 350 + pi * 280);
  });
}

// ── Answer result (player only) ───────────────────────────────────────────────
socket.on('answer-result', (data) => {
  stopTimer();

  if (data.type === 'slider' || data.type === 'timeline') {
    data.soundCorrect ? soundCorrect() : soundWrong();
    resultTimeout = setTimeout(() => showResultScreen(data), 800);

  } else if (data.type === 'map') {
    data.soundCorrect ? soundCorrect() : soundWrong();
    resultTimeout = setTimeout(() => showResultScreen(data), 800);

  } else if (data.type === 'sequence') {
    data.soundCorrect ? soundCorrect() : soundWrong();
    resultTimeout = setTimeout(() => showResultScreen(data), 800);

  } else {
    // Highlight correct/wrong buttons before navigating away
    document.querySelectorAll('.answer-btn').forEach((btn, i) => {
      btn.disabled = true;
      btn.style.animation = '';
      btn.classList.add(i === data.correctIndex ? 'correct' : 'wrong');
    });
    data.isCorrect ? soundCorrect() : soundWrong();
    resultTimeout = setTimeout(() => showResultScreen(data), 1500);
  }
});

// Renders the answer result screen.
function showResultScreen(data) {
  const icon        = document.getElementById('result-icon');
  const heading     = document.getElementById('result-heading');
  const subtitle    = document.getElementById('result-subtitle');
  const breakdown   = document.getElementById('score-breakdown');
  const zeroLine    = document.getElementById('score-zero');
  const flatLine    = document.getElementById('score-flat');
  const pendingLine = document.getElementById('score-pending');

  // Reset all optional elements
  subtitle.classList.add('hidden');
  breakdown.classList.add('hidden');
  zeroLine.classList.add('hidden');
  flatLine.classList.add('hidden');
  pendingLine.classList.add('hidden');
  const compareEl = document.getElementById('answer-compare');
  compareEl.innerHTML = '';
  compareEl.classList.add('hidden');

  if (data.type === 'slider' || data.type === 'timeline') {
    const fmt = v => data.unit
      ? `${v.toLocaleString('en-US')} ${data.unit}`
      : (data.type === 'timeline' ? String(Math.round(v)) : v.toLocaleString('en-US'));
    const pct = data.accuracyPct;

    if (pct >= 95) {
      icon.textContent = '🎯'; icon.style.color = 'var(--correct)';
      heading.textContent = 'Perfect!';
    } else if (pct >= 70) {
      icon.textContent = data.type === 'timeline' ? '📅' : '📏';
      icon.style.color = 'var(--gold)';
      heading.textContent = 'Very close!';
    } else if (pct >= 30) {
      icon.textContent = data.type === 'timeline' ? '📅' : '📏';
      icon.style.color = 'var(--gold-muted)';
      heading.textContent = 'Not quite…';
    } else {
      icon.textContent = '✗'; icon.style.color = 'var(--wrong)';
      heading.textContent = 'Way off!';
    }

    // Structured compare boxes: Your guess | Correct answer
    const u = data.unit ? ` ${data.unit}` : '';
    const diff = data.yourAnswer === data.correctValue
      ? 'Exact!'
      : `Off by ${data.type === 'timeline' ? String(Math.round(Math.abs(data.yourAnswer - data.correctValue))) : Math.abs(data.yourAnswer - data.correctValue).toLocaleString('en-US')}${u}`;
    compareEl.innerHTML = `
      <div class="compare-grid">
        <div class="compare-cell">
          <span class="compare-label">Your guess</span>
          <span class="compare-value">${fmt(data.yourAnswer)}</span>
        </div>
        <div class="compare-cell compare-correct">
          <span class="compare-label">Correct answer</span>
          <span class="compare-value">${fmt(data.correctValue)}</span>
        </div>
      </div>
      <div class="compare-diff">${diff}</div>`;
    compareEl.classList.remove('hidden');

    pendingLine.textContent = 'Rank points — see leaderboard';
    pendingLine.classList.remove('hidden');

  } else if (data.type === 'map') {
    const km = data.distanceKm;
    let tier;
    if (km < 10) {
      icon.textContent = '🎯'; icon.style.color = 'var(--correct)';
      heading.textContent = 'Pinpoint!';
      tier = 'Pinpoint accuracy';
    } else if (km < 50) {
      icon.textContent = '📍'; icon.style.color = 'var(--correct)';
      heading.textContent = 'Very close!';
      tier = 'Very close';
    } else if (km < 200) {
      icon.textContent = '📍'; icon.style.color = 'var(--gold)';
      heading.textContent = 'In the area';
      tier = 'In the area';
    } else if (km < 500) {
      icon.textContent = '📍'; icon.style.color = 'var(--gold-muted)';
      heading.textContent = 'Not quite…';
      tier = 'Not quite';
    } else {
      icon.textContent = '✗'; icon.style.color = 'var(--wrong)';
      heading.textContent = 'Way off!';
      tier = 'Way off';
    }

    // Structured compare boxes: Distance | Correct location
    compareEl.innerHTML = `
      <div class="compare-grid">
        <div class="compare-cell">
          <span class="compare-label">Distance</span>
          <span class="compare-value">${km.toLocaleString('en-US')} km</span>
          <span class="compare-diff">${tier}</span>
        </div>
        <div class="compare-cell compare-correct">
          <span class="compare-label">Correct location</span>
          <span class="compare-value compare-value-sm">${data.locationName}</span>
        </div>
      </div>`;
    compareEl.classList.remove('hidden');

    pendingLine.textContent = 'Rank points — see leaderboard';
    pendingLine.classList.remove('hidden');

  } else if (data.type === 'sequence') {
    const n = data.correctCount;
    const t = data.totalItems;

    if (n === t) {
      icon.textContent = '🎯'; icon.style.color = 'var(--correct)';
      heading.textContent = 'Perfect order!';
    } else if (n >= 3) {
      icon.textContent = '✓'; icon.style.color = 'var(--correct)';
      heading.textContent = 'Almost perfect!';
    } else if (n >= 2) {
      icon.textContent = '~'; icon.style.color = 'var(--gold)';
      heading.textContent = 'Halfway there';
    } else if (n === 1) {
      icon.textContent = '~'; icon.style.color = 'var(--gold-muted)';
      heading.textContent = 'One correct';
    } else {
      icon.textContent = '✗'; icon.style.color = 'var(--wrong)';
      heading.textContent = 'Wrong order';
    }

    // Show player's order vs correct, row by row
    const rows = data.correctOrder.map((correctText, i) => {
      const playerText = data.playerOrder[i] || '—';
      const isMatch    = playerText === correctText;
      return `
        <div class="seq-compare-row ${isMatch ? 'seq-match' : 'seq-mismatch'}">
          <span class="seq-pos">${i + 1}</span>
          <span class="seq-player-item">${playerText}</span>
          <span class="seq-tick">${isMatch ? '✓' : '✗'}</span>
        </div>`;
    }).join('');
    compareEl.innerHTML = `
      <div class="seq-compare">
        <div class="seq-compare-header">${n} / ${t} in correct position</div>
        ${rows}
      </div>`;
    compareEl.classList.remove('hidden');

    pendingLine.textContent = 'Rank points — see leaderboard';
    pendingLine.classList.remove('hidden');

  } else {
    // Multiple choice / flag
    if (data.isCorrect) {
      icon.textContent = '✓'; icon.style.color = 'var(--correct)';
      heading.textContent = 'Correct!';
      // Speed rank is deferred to leaderboard (can't know rank until all answers in)
      pendingLine.textContent = 'Speed rank — see leaderboard';
      pendingLine.classList.remove('hidden');
    } else {
      icon.textContent = '✗'; icon.style.color = 'var(--wrong)';
      heading.textContent = 'Incorrect';
      subtitle.textContent = `Correct answer: ${data.correctText}`;
      subtitle.classList.remove('hidden');
      zeroLine.classList.remove('hidden');
    }
  }

  resetAnimation(icon, 'pop-in');
  showScreen('screen-answer-result');
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
const CATEGORY_LABELS = {
  facts: 'Facts', science: 'Science', sports: 'Sports', entertainment: 'Entertainment',
  flags: 'Flags', estimation: 'Estimation', timeline: 'Timeline',
  'geo-natural': 'Natural Wonders', 'geo-built': 'Built World',
  'geo-cities': 'Cities', 'geo-history': 'Where in History',
  sequence: 'Sequence',
};

socket.on('show-leaderboard', ({ leaderboard, correctAnswer, questionType, questionNumber, totalQuestions, questionCategory, isLastQuestion, mapData, timelineData, sequenceData }) => {
  stopTimer();
  gamePaused = false;
  clearTimeout(resultTimeout);
  soundLeaderboard();
  // Switch pause button from question screen to leaderboard screen
  setPauseBtns('⏸ Pause', false);
  const pauseBtn   = document.getElementById('pause-btn');
  const pauseBtnLb = document.getElementById('pause-btn-lb');
  if (pauseBtn)   pauseBtn.classList.add('hidden');
  if (pauseBtnLb) pauseBtnLb.classList.toggle('hidden', !amHost || !gameAutoplay);
  if (leafletMap) { leafletMap.remove(); leafletMap = null; mapPin = null; }

  // Reset all special reveal sections first
  const lbMapWrap      = document.getElementById('leaderboard-map');
  const lbTimelineWrap = document.getElementById('leaderboard-timeline');
  const lbSequenceWrap = document.getElementById('leaderboard-sequence');
  const correctReveal  = document.getElementById('correct-reveal');
  lbMapWrap.classList.add('hidden');      lbMapWrap.innerHTML      = '';
  lbTimelineWrap.classList.add('hidden'); lbTimelineWrap.innerHTML = '';
  lbSequenceWrap.classList.add('hidden'); lbSequenceWrap.innerHTML = '';
  correctReveal.classList.add('hidden');

  // Update leaderboard header with round number and category
  const catLabel = CATEGORY_LABELS[questionCategory] || questionCategory;
  document.querySelector('#screen-leaderboard h2').textContent =
    `Round ${questionNumber} of ${totalQuestions}`;

  showScreen('screen-leaderboard');

  // Build a structured correct-reveal with category tag
  const crHtml = `<span class="cr-tag">${catLabel}</span><span class="cr-answer">✓ ${correctAnswer}</span>`;

  if (mapData) {
    showLeaderboardMap(mapData);
    // Map already shows the correct location; still show text label
    correctReveal.innerHTML = crHtml;
    correctReveal.classList.remove('hidden');
  } else if (timelineData) {
    showLeaderboardScale(timelineData);
    correctReveal.innerHTML = crHtml;
    correctReveal.classList.remove('hidden');
  } else if (sequenceData) {
    showLeaderboardSequence(sequenceData);
    // Don't show the long correctAnswer string — the sequence reveal itself is the answer
    correctReveal.innerHTML = `<span class="cr-tag">${CATEGORY_LABELS[questionCategory] || questionCategory}</span><span class="cr-answer">Correct order shown above</span>`;
    correctReveal.classList.remove('hidden');
  } else {
    correctReveal.innerHTML = crHtml;
    correctReveal.classList.remove('hidden');
  }

  renderLeaderboard(document.getElementById('leaderboard-list'), leaderboard, questionType);

  document.getElementById('next-hint').textContent =
    isLastQuestion ? 'Final results coming up…' : 'Next question in a moment…';

  document.getElementById('next-question-btn').classList.add('hidden');
});

// Host-only: autoplay is off — show the manual advance button
socket.on('waiting-for-host', () => {
  document.getElementById('next-hint').textContent = 'Ready when you are…';
  document.getElementById('next-question-btn').classList.remove('hidden');
});

// ── Game over ─────────────────────────────────────────────────────────────────
socket.on('game-over', ({ leaderboard }) => {
  stopTimer();
  gamePaused = false;
  clearTimeout(resultTimeout);
  soundGameOver();
  ['pause-btn', 'pause-btn-lb'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.add('hidden');
  });
  if (leafletMap)     { leafletMap.remove();     leafletMap = null;     mapPin = null; }
  if (leaderboardMap) { leaderboardMap.remove(); leaderboardMap = null; }

  renderFinalLeaderboard(document.getElementById('final-leaderboard'), leaderboard);
  showScreen('screen-game-over');
});

// ── Host left ─────────────────────────────────────────────────────────────────
socket.on('host-left', () => {
  stopTimer();
  clearTimeout(resultTimeout);
  alert('The host has left the game. Returning to home screen.');
  window.location.reload();
});

// ── Enter key support in join form ────────────────────────────────────────────
document.getElementById('input-nickname').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinGame();
});
document.getElementById('input-game-id').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinGame();
});
