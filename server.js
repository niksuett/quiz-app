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

// ── Haversine distance ────────────────────────────────────────────────────────
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
const LEADERBOARD_PAUSE = 5; // seconds leaderboard auto-advances (for MC/flag)

// ── Scoring constants ─────────────────────────────────────────────────────────
//
// Option A — "Rank": pure rank-based
//   MC/Flag  : correct = RANK_POINTS[0] flat (everyone correct = same), wrong = 0
//   Proximity: ranked by closeness, points by position in RANK_POINTS
//
// Option B — "Accuracy + Rank": accuracy base + rank bonus
//   MC/Flag  : correct = ACC_BASE_MAX + speed-rank bonus (ACC_RANK_BONUS[rank]), wrong = 0
//   Proximity: accuracy score (0–ACC_BASE_MAX) + closeness-rank bonus (ACC_RANK_BONUS[rank])
//
// Both options have a max of ACC_BASE_MAX + ACC_RANK_BONUS[0] = 10 pts per question.

const RANK_POINTS    = [10, 8, 6, 4, 2, 1]; // by rank position (0 = 1st place)
const ACC_BASE_MAX   = 6;                    // max accuracy points in Option B
const ACC_RANK_BONUS = [4, 3, 2, 1, 0];     // rank bonus by position (0 = 1st place)

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
    .map(p => ({
      nickname:    p.nickname,
      score:       p.score,
      roundPoints: p.roundPoints || 0,
      roundRank:   p.roundRank   || null,
      lastAnswer:  p.lastAnswer  || null,
      stats:       p.stats       || null,
    }))
    .sort((a, b) => b.score - a.score);
}

// ── Rank-based scoring — called at leaderboard time ───────────────────────────
// Calculates roundPoints for every player and adds them to player.score.
// Must be called AFTER all answers are stored on player objects.
function applyRoundScores(game, question) {
  const qType  = question.type || 'text';
  const system = game.scoringSystem; // 'rank' | 'accuracy-rank'

  if (qType === 'map') {
    // ── Map: rank by distance ascending (closest = best) ──────────────────────
    const answered = game.players
      .filter(p => p.mapAnswer)
      .sort((a, b) => a.mapAnswer.distanceKm - b.mapAnswer.distanceKm);

    answered.forEach((p, rank) => {
      let pts;
      if (system === 'rank') {
        pts = RANK_POINTS[Math.min(rank, RANK_POINTS.length - 1)];
      } else {
        const accPts = Math.round(ACC_BASE_MAX * (p.accuracyRaw || 0));
        const bonus  = ACC_RANK_BONUS[Math.min(rank, ACC_RANK_BONUS.length - 1)] ?? 0;
        pts = accPts + bonus;
      }
      p.roundPoints = pts;
      p.roundRank   = rank + 1; // 1-based
      p.score      += pts;
      p.stats.roundsAnswered++;
      if (rank === 0) p.stats.roundsFirst++;
      if (pts > p.stats.bestRound) p.stats.bestRound = pts;
    });
    game.players.filter(p => !p.mapAnswer).forEach(p => { p.roundPoints = 0; p.roundRank = null; });

  } else if (qType === 'slider' || qType === 'timeline') {
    // ── Proximity: rank by absolute error ascending (closest = best) ──────────
    const answered = game.players
      .filter(p => p.lastAnswer && p.lastAnswer.type === qType && p.lastAnswer.diff !== undefined)
      .sort((a, b) => a.lastAnswer.diff - b.lastAnswer.diff);

    answered.forEach((p, rank) => {
      let pts;
      if (system === 'rank') {
        pts = RANK_POINTS[Math.min(rank, RANK_POINTS.length - 1)];
      } else {
        const accPts = Math.round(ACC_BASE_MAX * (p.accuracyRaw || 0));
        const bonus  = ACC_RANK_BONUS[Math.min(rank, ACC_RANK_BONUS.length - 1)] ?? 0;
        pts = accPts + bonus;
      }
      p.roundPoints = pts;
      p.roundRank   = rank + 1;
      p.score      += pts;
      p.stats.roundsAnswered++;
      if (rank === 0) p.stats.roundsFirst++;
      if (pts > p.stats.bestRound) p.stats.bestRound = pts;
    });
    game.players
      .filter(p => !p.lastAnswer || p.lastAnswer.type !== qType)
      .forEach(p => { p.roundPoints = 0; p.roundRank = null; });

  } else {
    // ── MC / Flag ─────────────────────────────────────────────────────────────
    const correct = game.players
      .filter(p => p.lastAnswer && p.lastAnswer.isCorrect)
      .sort((a, b) => (a.answerTime || 999) - (b.answerTime || 999)); // fastest first
    const wrong   = game.players.filter(p => !p.lastAnswer || !p.lastAnswer.isCorrect);

    if (system === 'rank') {
      // All correct players get the same flat points — no speed differentiation
      correct.forEach(p => {
        p.roundPoints = RANK_POINTS[0];
        p.roundRank   = 1; // everyone correct is equally "1st" in pure rank mode
        p.score      += RANK_POINTS[0];
        p.stats.roundsAnswered++;
        p.stats.roundsFirst++;
        if (RANK_POINTS[0] > p.stats.bestRound) p.stats.bestRound = RANK_POINTS[0];
      });
    } else {
      // Accuracy-rank: correct = ACC_BASE_MAX base + speed-rank bonus
      correct.forEach((p, rank) => {
        const bonus = ACC_RANK_BONUS[Math.min(rank, ACC_RANK_BONUS.length - 1)] ?? 0;
        const pts   = ACC_BASE_MAX + bonus;
        p.roundPoints = pts;
        p.roundRank   = rank + 1;
        p.score      += pts;
        p.stats.roundsAnswered++;
        if (rank === 0) p.stats.roundsFirst++;
        if (pts > p.stats.bestRound) p.stats.bestRound = pts;
      });
    }
    wrong.forEach(p => {
      p.roundPoints = 0; p.roundRank = null;
      // Count as answered if they submitted a wrong answer (vs. not answering at all)
      if (p.lastAnswer) p.stats.roundsAnswered++;
    });
  }
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Browser connected:', socket.id);

  // ── HOST creates a game ────────────────────────────────────────────────────
  socket.on('create-game', ({ rounds, categories, autoplay, scoringSystem } = {}) => {
    rounds        = rounds        || '5';
    categories    = categories    || ['facts'];
    autoplay      = autoplay      !== false; // default true
    scoringSystem = scoringSystem || 'rank'; // 'rank' | 'accuracy-rank'

    let gameId;
    do { gameId = generateGameId(); } while (games[gameId]);

    ALL_QUESTIONS = loadQuestions();

    const pool = ALL_QUESTIONS
      .filter(q => categories.includes(q.category))
      .sort(() => Math.random() - 0.5);

    if (pool.length === 0) {
      return socket.emit('create-error', 'No questions found for the selected categories.');
    }

    const numRounds = rounds === 'infinite'
      ? pool.length
      : Math.min(parseInt(rounds, 10), pool.length);

    const questions = pool.slice(0, numRounds);

    games[gameId] = {
      id:                gameId,
      hostId:            socket.id,
      players:           [],
      questions,
      currentIndex:      -1,
      state:             'lobby',
      autoplay,
      scoringSystem,
      timer:             null,
      questionStartTime: null,
    };

    socket.gameId = gameId;
    socket.role   = 'host';
    socket.join(gameId);

    socket.emit('game-created', { gameId });
    console.log(`Game ${gameId} | ${numRounds} rounds | categories: ${categories.join(',')} | autoplay: ${autoplay} | scoring: ${scoringSystem}`);
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

    game.players.push({
      id: socket.id, nickname, score: 0, answered: false,
      stats: { roundsAnswered: 0, roundsFirst: 0, bestRound: 0 },
    });
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
  // NOTE: Scoring is NOT applied here. We store raw answer data (accuracy, timing)
  // and defer all point calculations to showLeaderboard(), once all answers are in.
  socket.on('submit-answer', ({ answerIndex, answerValue, answerLat, answerLng }) => {
    const game = games[socket.gameId];
    if (!game || game.state !== 'question') return;

    const player = game.players.find(p => p.id === socket.id);
    if (!player || player.answered) return;

    player.answered   = true;
    player.lastAnswer = null;
    player.accuracyRaw = null;

    const question = game.questions[game.currentIndex];
    const elapsed  = (Date.now() - game.questionStartTime) / 1000;
    const qType    = question.type || 'text';

    player.answerTime = elapsed; // needed for MC speed-rank in accuracy-rank mode

    if (qType === 'slider' || qType === 'timeline') {
      const range      = question.max - question.min;
      const error      = Math.abs(answerValue - question.correct);
      const accuracyRaw = Math.max(0, 1 - (error / (range * 0.5)));

      player.accuracyRaw = accuracyRaw;
      player.lastAnswer  = {
        type:    qType,
        value:   answerValue,
        correct: question.correct,
        diff:    error,
        unit:    question.unit || '',
      };

      const accuracyPts = game.scoringSystem === 'accuracy-rank'
        ? Math.round(ACC_BASE_MAX * accuracyRaw)
        : null; // Option A: rank determines all points, unknown until leaderboard

      socket.emit('answer-result', {
        type:          qType,
        soundCorrect:  accuracyRaw > 0,
        scoringSystem: game.scoringSystem,
        accuracyPct:   Math.round(accuracyRaw * 100),
        yourAnswer:    answerValue,
        correctValue:  question.correct,
        unit:          question.unit,
        accuracyPts,               // null for Option A; 0–6 for Option B
        rankBonusPending: true,    // always: rank bonus added on leaderboard
      });

    } else if (qType === 'map') {
      const dist       = haversineKm(answerLat, answerLng, question.correctLat, question.correctLng);
      const accuracyRaw = Math.exp(-Math.pow(dist / 50, 0.6));

      player.accuracyRaw = accuracyRaw;
      player.mapAnswer   = { lat: answerLat, lng: answerLng, distanceKm: Math.round(dist) };
      player.lastAnswer  = { type: 'map', distanceKm: Math.round(dist) };

      const accuracyPts = game.scoringSystem === 'accuracy-rank'
        ? Math.round(ACC_BASE_MAX * accuracyRaw)
        : null;

      socket.emit('answer-result', {
        type:          'map',
        soundCorrect:  dist < 2000,
        scoringSystem: game.scoringSystem,
        distanceKm:    Math.round(dist),
        locationName:  question.locationName,
        accuracyPts,
        rankBonusPending: true,
      });

    } else {
      // Multiple choice / flag — binary correct / wrong
      const isCorrect = (answerIndex === question.correct);

      player.lastAnswer = {
        type:        qType,
        isCorrect,
        answerText:  (question.answers || [])[answerIndex] || '—',
        correctText: (question.answers || [])[question.correct] || '—',
      };

      // For Option A: flat RANK_POINTS[0] for correct, 0 for wrong — can show immediately
      // For Option B: ACC_BASE_MAX for correct (+ rank bonus later), 0 for wrong — can show base immediately
      const immediatePoints = isCorrect
        ? (game.scoringSystem === 'rank' ? RANK_POINTS[0] : ACC_BASE_MAX)
        : 0;

      socket.emit('answer-result', {
        type:              qType,
        soundCorrect:      isCorrect,
        scoringSystem:     game.scoringSystem,
        isCorrect,
        correctIndex:      question.correct,
        correctText:       (question.answers || [])[question.correct] || '—',
        yourText:          (question.answers || [])[answerIndex]      || '—',
        immediatePoints,
        // Rank bonus is pending for accuracy-rank mode (ranked by speed);
        // in rank mode everyone correct gets the same flat amount, no pending bonus.
        rankBonusPending:  game.scoringSystem === 'accuracy-rank' && isCorrect,
      });
    }

    // Tell host how many players have answered
    const answeredCount = game.players.filter(p => p.answered).length;
    io.to(game.hostId).emit('answer-progress', {
      answered: answeredCount,
      total:    game.players.length,
    });

    // All answered → advance early
    if (answeredCount === game.players.length) {
      const earlyPause = game.currentQuestionType === 'map'                                                    ? 5000
                       : (game.currentQuestionType === 'slider' || game.currentQuestionType === 'timeline')    ? 4000
                       : 3000;
      clearTimeout(game.timer);
      game.timer = setTimeout(() => showLeaderboard(game), earlyPause);
    }
  });

  // ── HOST manually advances (autoplay off) ──────────────────────────────────
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
  game.players.forEach(p => {
    p.answered    = false;
    p.answerTime  = null;
    p.accuracyRaw = null;
    delete p.mapAnswer;
    delete p.lastAnswer;
    delete p.roundPoints;
  });

  const q     = game.questions[game.currentIndex];
  const qType = q.type || 'text';
  const timeLimit = qType === 'map'                              ? 35
                  : (qType === 'slider' || qType === 'timeline') ? 20
                  : 15;

  game.currentTimeLimit    = timeLimit;
  game.currentQuestionType = qType;

  io.to(game.id).emit('new-question', {
    questionNumber: game.currentIndex + 1,
    totalQuestions: game.questions.length,
    question:       q.question,
    answers:        q.answers,
    timeLimit,
    type:           qType,
    scoringSystem:  game.scoringSystem,
    // Slider/timeline fields:
    min:  q.min,
    max:  q.max,
    step: q.step || 1,
    unit: q.unit,
    // Optional photo:
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

  // Apply rank-based scores now that all answers are in
  applyRoundScores(game, q);

  const correctAnswer = (q.type === 'slider' || q.type === 'timeline')
    ? (q.unit ? `${q.correct.toLocaleString()} ${q.unit}` : `${q.correct}`)
    : q.type === 'map'
      ? q.locationName
      : q.answers[q.correct];

  const mapData = q.type === 'map' ? {
    playerPins:   game.players
                    .filter(p => p.mapAnswer)
                    .map(p => ({ nickname: p.nickname, lat: p.mapAnswer.lat, lng: p.mapAnswer.lng, distanceKm: p.mapAnswer.distanceKm })),
    correctLat:   q.correctLat,
    correctLng:   q.correctLng,
    locationName: q.locationName,
  } : null;

  const timelineData = (q.type === 'timeline' || q.type === 'slider') ? {
    correctValue:  q.correct,
    unit:          q.unit || '',
    playerGuesses: game.players
                     .filter(p => p.lastAnswer && (p.lastAnswer.type === 'timeline' || p.lastAnswer.type === 'slider'))
                     .map(p => ({ nickname: p.nickname, value: p.lastAnswer.value, diff: p.lastAnswer.diff })),
  } : null;

  io.to(game.id).emit('show-leaderboard', {
    leaderboard:      buildLeaderboard(game),
    correctAnswer,
    questionType:     q.type || 'text',
    questionNumber:   game.currentIndex + 1,
    totalQuestions:   game.questions.length,
    questionCategory: q.category || '',
    isLastQuestion:   isLast,
    mapData,
    timelineData,
    scoringSystem:    game.scoringSystem,
  });

  const leaderboardPause = q.type === 'map'                               ? 10
                         : (q.type === 'slider' || q.type === 'timeline') ? 8
                         : LEADERBOARD_PAUSE;

  if (game.autoplay) {
    game.timer = setTimeout(() => sendNextQuestion(game), leaderboardPause * 1000);
  } else {
    io.to(game.hostId).emit('waiting-for-host');
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n✅ Quiz app is running!');
  console.log(`   Open your browser and go to: http://localhost:${PORT}`);
  console.log('   Press Ctrl+C to stop the server.\n');
});
