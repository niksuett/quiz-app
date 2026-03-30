// ─────────────────────────────────────────────────────────────────────────────
// client.js — runs in the browser: UI, animations, sounds, server communication
// ─────────────────────────────────────────────────────────────────────────────

const socket = io();

// ── State ─────────────────────────────────────────────────────────────────────
let myRole          = null;
let myNickname      = null;
let timerInterval   = null;
let resultTimeout   = null;
const MAX_SPEED_BONUS = 50;  // must match MAX_SPEED_BONUS in server.js
let currentSpeedCap  = 50;  // updated per-question from server

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
    el.textContent = Math.round(eased * target).toLocaleString();
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Builds and animates the leaderboard list, with staggered slide-ins
// and score count-up for each entry.
function renderLeaderboard(listEl, entries) {
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

    // Score area: current score + gain badge
    const scoreWrap = document.createElement('div');
    scoreWrap.className = 'lb-score-wrap';

    const gainSpan = document.createElement('span');
    gainSpan.className   = 'lb-gain';
    gainSpan.textContent = entry.roundPoints > 0 ? `+${entry.roundPoints}` : '';

    const scoreSpan = document.createElement('span');
    scoreSpan.className   = 'lb-score';

    const prev = (entry.score || 0) - (entry.roundPoints || 0);
    scoreSpan.textContent = prev.toLocaleString();

    scoreWrap.append(gainSpan, scoreSpan);
    li.append(nameCol, scoreWrap);
    listEl.append(li);

    // Step 1: show previous score immediately (already set above)
    // Step 2: pop in the gain badge
    const slideDelay = i * 90 + 300;
    if (entry.roundPoints > 0) {
      setTimeout(() => gainSpan.classList.add('lb-gain-pop'), slideDelay + 400);
      // Step 3: count up to new total, fade badge out
      setTimeout(() => {
        gainSpan.classList.add('lb-gain-fade');
        animateCount(scoreSpan, entry.score);
      }, slideDelay + 1100);
    }
  });
}

function formatAnswerStat(ans) {
  if (!ans) return 'No answer';
  if (ans.type === 'map') {
    return `📍 ${ans.distanceKm.toLocaleString()} km away`;
  }
  if (ans.type === 'slider' || ans.type === 'timeline') {
    const u    = ans.unit ? ` ${ans.unit}` : '';
    const diff = ans.diff === 0 ? 'exact!' : `off by ${ans.diff.toLocaleString()}${u}`;
    return `${ans.value.toLocaleString()}${u} — ${diff}`;
  }
  // MC / flag
  if (ans.isCorrect) return `✓ ${ans.answerText}`;
  return `✗ ${ans.answerText}  →  ${ans.correctText}`;
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
  const autoplay = document.getElementById('autoplay-toggle').checked;
  socket.emit('create-game', { rounds, categories, autoplay });
}

function startGame() {
  socket.emit('start-game');
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

// ── Config screen interactivity ───────────────────────────────────────────────
document.querySelectorAll('.round-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.round-btn').forEach(b => b.classList.remove('active'));
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

function updateTimer(remaining, total) {
  const pct  = (remaining / total) * 100;
  const fill = document.getElementById('timer-fill');
  const text = document.getElementById('timer-text');
  fill.style.width = pct + '%';
  text.textContent = remaining;

  const color = remaining > total * 0.5  ? '#34d399'
              : remaining > total * 0.25 ? '#fbbf24'
              :                            '#f87171';
  fill.style.backgroundColor = color;
  text.style.color            = color;

  // Update live speed bonus pill (player-only)
  const pill      = document.getElementById('speed-bonus-display');
  const bonusText = document.getElementById('speed-bonus-value');
  if (pill && !pill.classList.contains('hidden') && bonusText) {
    const bonus = Math.round((remaining / total) * currentSpeedCap);
    bonusText.textContent = `+${bonus}`;
    // Colour shifts green → amber → red as it drains
    if (bonus > 350) {
      pill.style.color = '#34d399'; pill.style.borderColor = 'rgba(52,211,153,.3)';
      pill.style.background = 'rgba(52,211,153,.08)';
    } else if (bonus > 150) {
      pill.style.color = '#fbbf24'; pill.style.borderColor = 'rgba(251,191,36,.25)';
      pill.style.background = 'rgba(234,179,8,.08)';
    } else {
      pill.style.color = '#f87171'; pill.style.borderColor = 'rgba(248,113,113,.25)';
      pill.style.background = 'rgba(239,68,68,.07)';
    }
  }
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

socket.on('game-created', ({ gameId }) => {
  document.getElementById('host-game-id').textContent = gameId;
  document.getElementById('player-count').textContent = '0';
  document.getElementById('player-list').innerHTML    = '';
  clearError('start-error');
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
socket.on('new-question', ({ questionNumber, totalQuestions, question, answers, timeLimit, speedBonusCap, type, min, max, step, unit }) => {
  currentSpeedCap = speedBonusCap ?? MAX_SPEED_BONUS;
  stopTimer();
  clearTimeout(resultTimeout);
  soundQuestionStart();
  // Clean up the leaderboard reveal map from the previous question
  if (leaderboardMap) { leaderboardMap.remove(); leaderboardMap = null; }

  document.getElementById('question-number').textContent =
    `Question ${questionNumber} / ${totalQuestions}`;

  // Render the question box based on type
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
    const midYear = Math.round((min + max) / 2);

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
    const midPoint = Math.round((min + max) / 2);
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
          <span>${min.toLocaleString()}${unit ? ' ' + unit : ''}</span>
          <span>${max.toLocaleString()}${unit ? ' ' + unit : ''}</span>
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
      document.getElementById('host-label').classList.remove('hidden');
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

  showScreen('screen-question');
  startTimer(timeLimit);

  // Show the live speed bonus pill for players; keep it hidden for the host
  const pill = document.getElementById('speed-bonus-display');
  if (pill) {
    if (myRole !== 'host') {
      pill.style.cssText = ''; // reset any inline colour overrides from the last question
      pill.classList.remove('hidden');
      document.getElementById('speed-bonus-value').textContent = `+${currentSpeedCap}`;
    } else {
      pill.classList.add('hidden');
    }
  }
});

// ── Answer progress (host only) ───────────────────────────────────────────────
socket.on('answer-progress', ({ answered, total }) => {
  document.getElementById('progress-text').textContent = `${answered} / ${total} answered`;
});

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
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors © CARTO',
    maxZoom: 18,
  }).addTo(leafletMap);
  // Faint label overlay — shows continent/country names at low opacity for orientation
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    maxZoom: 18, opacity: 0.25,
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

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
      maxZoom: 18,
    }).addTo(leaderboardMap);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
      maxZoom: 18, opacity: 0.35,
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
          .bindPopup(`<b>${pin.nickname}</b><br>${pin.distanceKm.toLocaleString()} km away`);

        // After the last pin lands, zoom to fit everything
        if (i === mapData.playerPins.length - 1) {
          setTimeout(() => {
            leaderboardMap.fitBounds(allLatLngs, { padding: [50, 50], maxZoom: 10 });
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

// Renders the post-question timeline reveal on the leaderboard screen.
// Shows a gold star at the correct year, then animates each player's guess
// onto the same axis, labelled with their nickname.
function showLeaderboardTimeline(timelineData) {
  const wrap = document.getElementById('leaderboard-timeline');
  wrap.innerHTML = '';
  wrap.classList.remove('hidden');

  const { correctValue, unit, playerGuesses } = timelineData;
  const fmt = v => unit ? `${v.toLocaleString()} ${unit}` : String(v);

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

// ── Answer result (player only) ───────────────────────────────────────────────
socket.on('answer-result', (data) => {
  stopTimer(); // also hides speed bonus pill

  if (data.type === 'slider' || data.type === 'timeline') {
    data.pointsEarned > 0 ? soundCorrect() : soundWrong();
    resultTimeout = setTimeout(() => showResultScreen(data), 800);

  } else if (data.type === 'map') {
    data.pointsEarned > 0 ? soundCorrect() : soundWrong();
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

// Renders the answer result screen with the score breakdown card.
function showResultScreen(data) {
  const icon      = document.getElementById('result-icon');
  const heading   = document.getElementById('result-heading');
  const subtitle  = document.getElementById('result-subtitle');
  const breakdown = document.getElementById('score-breakdown');
  const zeroLine  = document.getElementById('score-zero');

  // Reset all optional elements
  subtitle.classList.add('hidden');
  breakdown.classList.add('hidden');
  zeroLine.classList.add('hidden');

  if (data.type === 'slider' || data.type === 'timeline') {
    const fmt = v => data.unit ? `${v.toLocaleString()} ${data.unit}` : String(v);
    const pct = data.accuracyPct;

    if (pct >= 95) {
      icon.textContent = '🎯'; icon.style.color = '#34d399';
      heading.textContent = 'Perfect!';
    } else if (pct >= 70) {
      icon.textContent = data.type === 'timeline' ? '📅' : '📏';
      icon.style.color = '#fbbf24';
      heading.textContent = 'Very close!';
    } else if (pct >= 30) {
      icon.textContent = data.type === 'timeline' ? '📅' : '📏';
      icon.style.color = '#fb923c';
      heading.textContent = 'Not quite…';
    } else {
      icon.textContent = '✗'; icon.style.color = '#f87171';
      heading.textContent = 'Way off!';
    }

    subtitle.textContent = `Your guess: ${fmt(data.yourAnswer)}  ·  Correct: ${fmt(data.correctValue)}`;
    subtitle.classList.remove('hidden');
    showBreakdownCard(`${pct}% accuracy`, data.basePoints, data.speedBonus);

  } else if (data.type === 'map') {
    const km = data.distanceKm;
    if (km < 10) {
      icon.textContent = '🎯'; icon.style.color = '#34d399';
      heading.textContent = 'Pinpoint!';
    } else if (km < 50) {
      icon.textContent = '📍'; icon.style.color = '#34d399';
      heading.textContent = 'Very close!';
    } else if (km < 200) {
      icon.textContent = '📍'; icon.style.color = '#fbbf24';
      heading.textContent = 'In the area';
    } else if (km < 500) {
      icon.textContent = '📍'; icon.style.color = '#fb923c';
      heading.textContent = 'Not quite…';
    } else {
      icon.textContent = '✗'; icon.style.color = '#f87171';
      heading.textContent = 'Way off!';
    }

    subtitle.textContent = `${km.toLocaleString()} km from ${data.locationName}`;
    subtitle.classList.remove('hidden');
    showBreakdownCard(`${data.accuracyPct}% accuracy`, data.basePoints, data.speedBonus);

  } else {
    // Multiple choice
    if (data.isCorrect) {
      const tier = data.speedBonus > 40 ? '⚡ Lightning Fast!'
                 : data.speedBonus > 20 ? 'Quick Thinking!'
                 :                         'Correct!';
      icon.textContent = '✓'; icon.style.color = '#34d399';
      heading.textContent = tier;
      showBreakdownCard('Correct answer', data.basePoints, data.speedBonus);
    } else {
      icon.textContent = '✗'; icon.style.color = '#f87171';
      heading.textContent = 'Incorrect';
      subtitle.textContent = `Correct answer: ${data.correctText}`;
      subtitle.classList.remove('hidden');
      zeroLine.classList.remove('hidden');
    }
  }

  resetAnimation(icon, 'pop-in');
  showScreen('screen-answer-result');
}

// Fills in and reveals the score breakdown card.
function showBreakdownCard(baseLabel, basePoints, speedBonus) {
  document.getElementById('score-base-label').textContent = baseLabel;
  document.getElementById('score-base-pts').textContent   = basePoints.toLocaleString();
  document.getElementById('score-speed-pts').textContent  = `+${speedBonus.toLocaleString()}`;
  document.getElementById('score-total-pts').textContent  = `+${(basePoints + speedBonus).toLocaleString()}`;
  document.getElementById('score-breakdown').classList.remove('hidden');
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
socket.on('show-leaderboard', ({ leaderboard, correctAnswer, questionType, isLastQuestion, mapData, timelineData }) => {
  stopTimer();
  clearTimeout(resultTimeout);
  soundLeaderboard();
  if (leafletMap) { leafletMap.remove(); leafletMap = null; mapPin = null; }

  // Reset all special reveal sections first
  const lbMapWrap      = document.getElementById('leaderboard-map');
  const lbTimelineWrap = document.getElementById('leaderboard-timeline');
  const correctReveal  = document.getElementById('correct-reveal');
  lbMapWrap.classList.add('hidden');      lbMapWrap.innerHTML      = '';
  lbTimelineWrap.classList.add('hidden'); lbTimelineWrap.innerHTML = '';
  correctReveal.classList.add('hidden');

  showScreen('screen-leaderboard');

  if (mapData) {
    showLeaderboardMap(mapData);
  } else if (timelineData) {
    showLeaderboardTimeline(timelineData);
    // Still show the text "correct answer" label since it's useful alongside the visual
    correctReveal.textContent = `✓ Correct: ${correctAnswer}`;
    correctReveal.classList.remove('hidden');
  } else {
    correctReveal.textContent = `✓ Correct answer: ${correctAnswer}`;
    correctReveal.classList.remove('hidden');
  }

  renderLeaderboard(document.getElementById('leaderboard-list'), leaderboard);

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
  clearTimeout(resultTimeout);
  soundGameOver();
  if (leafletMap)     { leafletMap.remove();     leafletMap = null;     mapPin = null; }
  if (leaderboardMap) { leaderboardMap.remove(); leaderboardMap = null; }

  renderLeaderboard(document.getElementById('final-leaderboard'), leaderboard);
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
