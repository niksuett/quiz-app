// ─────────────────────────────────────────────────────────────────────────────
// server.js — backend: game logic, scoring, Socket.io events
// ─────────────────────────────────────────────────────────────────────────────

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Question bank ─────────────────────────────────────────────────────────────
// Questions live in questions.json so they can be edited without touching code.

const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

function loadQuestions() {
  return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
}

// ── Admin API ─────────────────────────────────────────────────────────────────
app.get('/admin/questions', (req, res) => {
  res.json(loadQuestions());
});

app.post('/admin/questions', (req, res) => {
  const questions = req.body;
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'Expected an array' });
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2));
  res.json({ ok: true, count: questions.length });
});

let ALL_QUESTIONS = loadQuestions();

// ── Haversine distance formula ────────────────────────────────────────────────
// Calculates the straight-line distance in km between two lat/lng points on Earth
function haversineKm(lat1, lng1, lat2, lng2) {
  const R     = 6371;
  const toRad = deg => deg * Math.PI / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Game settings ─────────────────────────────────────────────────────────────
const QUESTION_TIME      = 20;   // seconds players have to answer
const LEADERBOARD_PAUSE  = 5;    // seconds leaderboard shows before next question (autoplay)
const POINTS_FOR_CORRECT = 100; // base points for a correct answer
const MAX_SPEED_BONUS    = 50;  // extra points for answering quickly

// ── Active games ──────────────────────────────────────────────────────────────
const games = {};

function generateGameId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function buildLeaderboard(game) {
  return game.players
    .map(p => ({ nickname: p.nickname, score: p.score, roundPoints: p.roundPoints || 0, lastAnswer: p.lastAnswer || null }))
    .sort((a, b) => b.score - a.score);
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Browser connected:', socket.id);

  // ── HOST creates a game ────────────────────────────────────────────────────
  // Receives the config the host chose on the setup screen
  socket.on('create-game', ({ rounds, categories, autoplay } = {}) => {
    rounds     = rounds     || '5';
    categories = categories || ['facts'];
    autoplay   = autoplay !== false; // default true

    let gameId;
    do { gameId = generateGameId(); } while (games[gameId]);

    // Reload questions from disk so admin edits take effect without restarting
    ALL_QUESTIONS = loadQuestions();

    // Filter question bank to only the chosen categories, then shuffle
    const pool = ALL_QUESTIONS
      .filter(q => categories.includes(q.category))
      .sort(() => Math.random() - 0.5);

    if (pool.length === 0) {
      return socket.emit('create-error', 'No questions found for the selected categories.');
    }

    // How many questions to actually use
    const numRounds = rounds === 'infinite'
      ? pool.length                                    // use everything available
      : Math.min(parseInt(rounds, 10), pool.length);  // respect the cap

    const questions = pool.slice(0, numRounds);

    games[gameId] = {
      id:                gameId,
      hostId:            socket.id,
      players:           [],
      questions,
      currentIndex:      -1,
      state:             'lobby',
      autoplay,
      timer:             null,
      questionStartTime: null,
    };

    socket.gameId = gameId;
    socket.role   = 'host';
    socket.join(gameId);

    socket.emit('game-created', { gameId });
    console.log(`Game ${gameId} | ${numRounds} rounds | categories: ${categories.join(',')} | autoplay: ${autoplay}`);
  });

  // ── PLAYER joins ───────────────────────────────────────────────────────────
  socket.on('join-game', ({ gameId, nickname }) => {
    gameId   = (gameId   || '').trim().toUpperCase();
    nickname = (nickname || '').trim();

    const game = games[gameId];
    if (!game)
      return socket.emit('join-error', 'Game not found. Double-check the Game ID.');
    if (game.state !== 'lobby')
      return socket.emit('join-error', 'Sorry, this game has already started.');
    if (!nickname)
      return socket.emit('join-error', 'Please enter a nickname.');
    if (nickname.length > 16)
      return socket.emit('join-error', 'Nickname must be 16 characters or less.');
    if (game.players.find(p => p.nickname.toLowerCase() === nickname.toLowerCase()))
      return socket.emit('join-error', 'That nickname is already taken. Try another.');

    game.players.push({ id: socket.id, nickname, score: 0, answered: false });
    socket.gameId = gameId;
    socket.role   = 'player';
    socket.join(gameId);

    socket.emit('join-success', { gameId, nickname });
    io.to(game.hostId).emit('lobby-update', {
      players: game.players.map(p => p.nickname),
    });
    console.log(`"${nickname}" joined ${gameId}`);
  });

  // ── HOST starts the game ───────────────────────────────────────────────────
  socket.on('start-game', () => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host') return;
    if (game.players.length === 0)
      return socket.emit('start-error', 'You need at least 1 player to start!');
    sendNextQuestion(game);
  });

  // ── PLAYER submits an answer ───────────────────────────────────────────────
  socket.on('submit-answer', ({ answerIndex, answerValue, answerLat, answerLng }) => {
    const game = games[socket.gameId];
    if (!game || game.state !== 'question') return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player || player.answered) return;

    player.answered   = true;
    player.lastAnswer = null; // will be set below per type

    const question  = game.questions[game.currentIndex];
    const elapsed   = (Date.now() - game.questionStartTime) / 1000;
    const remaining = Math.max(0, game.currentTimeLimit - elapsed);
    const qType     = question.type || 'text';
    let   pointsEarned = 0;

    if (qType === 'slider' || qType === 'timeline') {
      // Proximity scoring: full points if exact, scales to 0 at ±half-range away.
      // Speed bonus capped lower for estimation — accuracy matters more than speed here.
      const range       = question.max - question.min;
      const error       = Math.abs(answerValue - question.correct);
      const proximity   = Math.max(0, 1 - (error / (range * 0.5)));
      const speedCap    = Math.round(MAX_SPEED_BONUS * 0.3); // 30% of normal cap
      const speedBonus  = Math.round((remaining / game.currentTimeLimit) * speedCap * proximity);
      const basePoints  = Math.round(proximity * POINTS_FOR_CORRECT);
      pointsEarned        = basePoints + speedBonus;
      player.score       += pointsEarned;
      player.roundPoints  = pointsEarned;

      player.lastAnswer = {
        type:    qType,
        value:   answerValue,
        correct: question.correct,
        diff:    Math.abs(answerValue - question.correct),
        unit:    question.unit || '',
      };

      socket.emit('answer-result', {
        type:        qType,
        pointsEarned,
        basePoints,
        speedBonus,
        accuracyPct: Math.round(proximity * 100),
        yourAnswer:  answerValue,
        correctValue:question.correct,
        unit:        question.unit,
      });

    } else if (qType === 'map') {
      // Precision exponential decay: 90% at 10km, 59% at 50km, 12% at 200km.
      // Exact pin = full points; neighbouring city ≈ half; wrong region ≈ nothing.
      const dist        = haversineKm(answerLat, answerLng, question.correctLat, question.correctLng);
      // Stretched-exponential curve: steeper near 0 (same city ≠ same landmark),
      // but a longer gentle tail (right region still earns points).
      // ~5km→78pts, ~10km→68pts, ~50km→37pts, ~200km→10pts, ~500km→2pts
      const proximity   = Math.exp(-Math.pow(dist / 50, 0.6));
      const speedCap    = Math.round(MAX_SPEED_BONUS * 0.3); // 30% of normal cap — accuracy over speed
      const speedBonus  = Math.round((remaining / game.currentTimeLimit) * speedCap * proximity);
      const basePoints  = Math.round(proximity * POINTS_FOR_CORRECT);
      pointsEarned      = basePoints + speedBonus;
      player.score     += pointsEarned;
      // Store the guess so we can show it on the leaderboard map reveal
      player.mapAnswer   = { lat: answerLat, lng: answerLng, distanceKm: Math.round(dist) };
      player.lastAnswer  = { type: 'map', distanceKm: Math.round(dist) };
      player.roundPoints = pointsEarned;

      socket.emit('answer-result', {
        type:        'map',
        pointsEarned,
        basePoints,
        speedBonus,
        accuracyPct: Math.round(proximity * 100),
        distanceKm:  Math.round(dist),
        locationName:question.locationName,
      });

    } else {
      // Multiple choice (text or flag): exact match only
      const isCorrect  = (answerIndex === question.correct);
      const speedBonus = Math.round((remaining / game.currentTimeLimit) * MAX_SPEED_BONUS);
      if (isCorrect) {
        pointsEarned = POINTS_FOR_CORRECT + speedBonus;
        player.score += pointsEarned;
      }
      player.roundPoints = pointsEarned;
      player.lastAnswer  = {
        type:        qType,
        isCorrect,
        answerText:  (question.answers || [])[answerIndex] || '—',
        correctText: (question.answers || [])[question.correct] || '—',
      };
      socket.emit('answer-result', {
        type:        qType,
        isCorrect,
        pointsEarned,
        basePoints:  isCorrect ? POINTS_FOR_CORRECT : 0,
        speedBonus:  isCorrect ? speedBonus : 0,
        correctIndex:question.correct,
        correctText: (question.answers || [])[question.correct] || '—',
        yourText:    (question.answers || [])[answerIndex]      || '—',
      });
    }

    // Tell the host how many players have answered so far
    const answeredCount = game.players.filter(p => p.answered).length;
    io.to(game.hostId).emit('answer-progress', {
      answered: answeredCount,
      total:    game.players.length,
    });

    // If everyone has answered, move on early.
    // Give more time on complex types so players can read their result screen.
    if (answeredCount === game.players.length) {
      const earlyPause = game.currentQuestionType === 'map'                                          ? 5000
                       : (game.currentQuestionType === 'slider' || game.currentQuestionType === 'timeline') ? 4000
                       : 3000;
      clearTimeout(game.timer);
      game.timer = setTimeout(() => showLeaderboard(game), earlyPause);
    }
  });

  // ── HOST manually advances to next question (when autoplay is off) ─────────
  socket.on('next-question', () => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host') return;
    sendNextQuestion(game);
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('Browser disconnected:', socket.id);
    const game = games[socket.gameId];
    if (!game) return;

    if (socket.role === 'host') {
      clearTimeout(game.timer);
      delete games[game.id];
      io.to(game.id).emit('host-left');
    } else {
      game.players = game.players.filter(p => p.id !== socket.id);
      if (game.state === 'lobby') {
        io.to(game.hostId).emit('lobby-update', {
          players: game.players.map(p => p.nickname),
        });
      }
    }
  });
});

// ── Game flow ─────────────────────────────────────────────────────────────────

function sendNextQuestion(game) {
  game.currentIndex++;

  if (game.currentIndex >= game.questions.length) {
    game.state = 'gameover';
    io.to(game.id).emit('game-over', { leaderboard: buildLeaderboard(game) });
    setTimeout(() => delete games[game.id], 60 * 1000);
    return;
  }

  game.state             = 'question';
  game.questionStartTime = Date.now();
  game.players.forEach(p => { p.answered = false; delete p.mapAnswer; delete p.lastAnswer; delete p.roundPoints; });

  const q = game.questions[game.currentIndex];
  const qType = q.type || 'text';
  const timeLimit    = qType === 'map'                              ? 35
                     : (qType === 'slider' || qType === 'timeline') ? 20
                     : 15; // text, flag
  const speedBonusCap = (qType === 'slider' || qType === 'timeline' || qType === 'map')
                      ? Math.round(MAX_SPEED_BONUS * 0.3)
                      : MAX_SPEED_BONUS;
  game.currentTimeLimit    = timeLimit;
  game.currentQuestionType = qType;

  io.to(game.id).emit('new-question', {
    questionNumber: game.currentIndex + 1,
    totalQuestions: game.questions.length,
    question:  q.question,
    answers:   q.answers,
    timeLimit,
    speedBonusCap,
    type:      qType,
    // Slider-only fields (undefined for other types):
    min:  q.min,
    max:  q.max,
    step: q.step || 1,
    unit: q.unit,
    // Optional image (used by timeline questions with a photo)
    imageUrl: q.imageUrl || null,
  });

  game.timer = setTimeout(() => showLeaderboard(game), timeLimit * 1000);
}

function showLeaderboard(game) {
  clearTimeout(game.timer);
  game.timer = null;
  game.state = 'leaderboard';

  const q      = game.questions[game.currentIndex];
  const isLast = (game.currentIndex === game.questions.length - 1);

  // Build the "correct answer" string depending on question type
  const correctAnswer = (q.type === 'slider' || q.type === 'timeline')
    ? (q.unit ? `${q.correct.toLocaleString()} ${q.unit}` : `${q.correct}`)
    : q.type === 'map'
      ? q.locationName
      : q.answers[q.correct];

  // For map questions, collect every player's pin so the reveal can show them all
  const mapData = q.type === 'map' ? {
    playerPins:   game.players
                    .filter(p => p.mapAnswer)
                    .map(p => ({ nickname: p.nickname, lat: p.mapAnswer.lat, lng: p.mapAnswer.lng, distanceKm: p.mapAnswer.distanceKm })),
    correctLat:   q.correctLat,
    correctLng:   q.correctLng,
    locationName: q.locationName,
  } : null;

  // For timeline questions, collect every player's guess for the visual timeline reveal
  const timelineData = q.type === 'timeline' ? {
    correctValue:  q.correct,
    unit:          q.unit || '',
    playerGuesses: game.players
                     .filter(p => p.lastAnswer && p.lastAnswer.type === 'timeline')
                     .map(p => ({ nickname: p.nickname, value: p.lastAnswer.value, diff: p.lastAnswer.diff })),
  } : null;

  io.to(game.id).emit('show-leaderboard', {
    leaderboard:    buildLeaderboard(game),
    correctAnswer,
    questionType:   q.type || 'text',
    isLastQuestion: isLast,
    mapData,
    timelineData,
  });

  // Longer leaderboard pause for question types where comparing answers is more interesting
  const leaderboardPause = q.type === 'map'                                    ? 10
                         : (q.type === 'slider' || q.type === 'timeline')      ? 8
                         : LEADERBOARD_PAUSE; // 5s for MC / flags

  if (game.autoplay) {
    // Auto-advance after the pause
    game.timer = setTimeout(() => sendNextQuestion(game), leaderboardPause * 1000);
  } else {
    // Wait for the host to click "Next Question"
    io.to(game.hostId).emit('waiting-for-host');
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
// process.env.PORT is set by Railway (and most hosting platforms) at deploy time.
// Falls back to 3000 for local development.
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n✅ Quiz app is running!');
  console.log(`   Open your browser and go to: http://localhost:${PORT}`);
  console.log('   Press Ctrl+C to stop the server.\n');
});
