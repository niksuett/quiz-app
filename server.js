// ─────────────────────────────────────────────────────────────────────────────
// server.js — backend: game logic, scoring, Socket.io events
// ─────────────────────────────────────────────────────────────────────────────

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const { db, rowToQuestion, questionToRow } = require('./db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Question bank ─────────────────────────────────────────────────────────────
function loadQuestions() {
  return db.prepare('SELECT * FROM questions').all().map(rowToQuestion);
}

// ── Admin API ─────────────────────────────────────────────────────────────────
app.get('/admin/questions', (req, res) => {
  res.json(loadQuestions());
});

app.post('/admin/questions', (req, res) => {
  const questions = req.body;
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'Expected an array' });

  const deleteAll = db.prepare('DELETE FROM questions');
  const insert    = db.prepare(`
    INSERT INTO questions (category, type, question, correct, image_url, extra)
    VALUES (@category, @type, @question, @correct, @image_url, @extra)
  `);

  const replaceAll = db.transaction(qs => {
    deleteAll.run();
    for (const q of qs) insert.run(questionToRow(q));
  });

  replaceAll(questions);
  res.json({ ok: true, count: questions.length });
});

let ALL_QUESTIONS = loadQuestions();

// ── Fisher-Yates shuffle (returns a new array, never mutates the original) ────
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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
// Single scoring mode: Rank + Speed
//   MC/Flag  : ranked by answer speed (fastest correct = 1st), wrong = 0
//   Proximity: ranked by closeness (slider/timeline/map) or correctCount (sequence)
//   Points by rank position: 1st=10, 2nd=8, 3rd=6, 4th=4, 5th=2, 6th+=1

const RANK_POINTS = [10, 8, 6, 4, 2, 1]; // by rank position (0-indexed: 0 = 1st place)

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
      nickname:     p.nickname,
      score:        p.score,
      roundPoints:  p.roundPoints  || 0,
      roundRank:    p.roundRank    || null,
      lastAnswer:   p.lastAnswer   || null,
      stats:        p.stats        || null,
      speedTiebreak:       p.speedTiebreak       || false,
      speedTiebreakedOut:  p.speedTiebreakedOut  || false,
    }))
    .sort((a, b) => b.score - a.score);
}

// ── Rank-based scoring — called at leaderboard time ───────────────────────────
// Calculates roundPoints for every player and adds them to player.score.
// Must be called AFTER all answers are stored on player objects.
function applyRoundScores(game, question) {
  const qType = question.type || 'text';

  if (qType === 'map') {
    // ── Map: rank by distance ascending; speed is tiebreaker on equal distance ─
    const answered = game.players
      .filter(p => p.mapAnswer)
      .sort((a, b) => {
        const diff = a.mapAnswer.distanceKm - b.mapAnswer.distanceKm;
        if (diff !== 0) return diff;
        return (a.answerTime || 999) - (b.answerTime || 999);
      });

    answered.forEach((p, i) => {
      p.speedTiebreak      = i + 1 < answered.length && answered[i + 1].mapAnswer.distanceKm === p.mapAnswer.distanceKm;
      p.speedTiebreakedOut = i > 0             && answered[i - 1].mapAnswer.distanceKm === p.mapAnswer.distanceKm;
    });

    answered.forEach((p, rank) => {
      const pts = RANK_POINTS[Math.min(rank, RANK_POINTS.length - 1)];
      p.roundPoints = pts;
      p.roundRank   = rank + 1;
      p.score      += pts;
      p.stats.roundsAnswered++;
      if (rank === 0) p.stats.roundsFirst++;
      if (pts > p.stats.bestRound) p.stats.bestRound = pts;
    });
    game.players.filter(p => !p.mapAnswer).forEach(p => { p.roundPoints = 0; p.roundRank = null; });

  } else if (qType === 'slider' || qType === 'timeline') {
    // ── Proximity: rank by absolute error ascending; speed is tiebreaker ──────
    const answered = game.players
      .filter(p => p.lastAnswer && p.lastAnswer.type === qType && p.lastAnswer.diff !== undefined)
      .sort((a, b) => {
        const diff = a.lastAnswer.diff - b.lastAnswer.diff;
        if (diff !== 0) return diff;
        return (a.answerTime || 999) - (b.answerTime || 999);
      });

    answered.forEach((p, i) => {
      p.speedTiebreak      = i + 1 < answered.length && answered[i + 1].lastAnswer.diff === p.lastAnswer.diff;
      p.speedTiebreakedOut = i > 0             && answered[i - 1].lastAnswer.diff === p.lastAnswer.diff;
    });

    answered.forEach((p, rank) => {
      const pts = RANK_POINTS[Math.min(rank, RANK_POINTS.length - 1)];
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

  } else if (qType === 'sequence') {
    // ── Sequence: rank by correctCount desc; speed is tiebreaker when tied ────
    const answered = game.players
      .filter(p => p.lastAnswer && p.lastAnswer.type === 'sequence')
      .sort((a, b) => {
        const diff = b.lastAnswer.correctCount - a.lastAnswer.correctCount;
        if (diff !== 0) return diff;
        return (a.answerTime || 999) - (b.answerTime || 999);
      });

    answered.forEach((p, i) => {
      p.speedTiebreak      = i + 1 < answered.length && answered[i + 1].lastAnswer.correctCount === p.lastAnswer.correctCount;
      p.speedTiebreakedOut = i > 0             && answered[i - 1].lastAnswer.correctCount === p.lastAnswer.correctCount;
    });

    answered.forEach((p, rank) => {
      const pts = RANK_POINTS[Math.min(rank, RANK_POINTS.length - 1)];
      p.roundPoints = pts;
      p.roundRank   = rank + 1;
      p.score      += pts;
      p.stats.roundsAnswered++;
      if (rank === 0) p.stats.roundsFirst++;
      if (pts > p.stats.bestRound) p.stats.bestRound = pts;
    });
    game.players
      .filter(p => !p.lastAnswer || p.lastAnswer.type !== 'sequence')
      .forEach(p => { p.roundPoints = 0; p.roundRank = null; });

  } else {
    // ── MC / Flag: rank by answer speed (fastest correct = most points) ───────
    const correct = game.players
      .filter(p => p.lastAnswer && p.lastAnswer.isCorrect)
      .sort((a, b) => (a.answerTime || 999) - (b.answerTime || 999));
    const wrong = game.players.filter(p => !p.lastAnswer || !p.lastAnswer.isCorrect);

    correct.forEach((p, rank) => {
      const pts = RANK_POINTS[Math.min(rank, RANK_POINTS.length - 1)];
      p.roundPoints = pts;
      p.roundRank   = rank + 1;
      p.score      += pts;
      p.stats.roundsAnswered++;
      if (rank === 0) p.stats.roundsFirst++;
      if (pts > p.stats.bestRound) p.stats.bestRound = pts;
    });
    wrong.forEach(p => {
      p.roundPoints = 0; p.roundRank = null;
      if (p.lastAnswer) p.stats.roundsAnswered++;
    });
  }
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Browser connected:', socket.id);

  // ── HOST creates a game ────────────────────────────────────────────────────
  socket.on('create-game', ({ rounds, categories, autoplay, gameMode } = {}) => {
    rounds     = rounds     || '5';
    categories = categories || ['facts'];
    autoplay   = autoplay   !== false; // default true
    gameMode   = (gameMode === 'tv') ? 'tv' : 'mobile'; // 'mobile' | 'tv'

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
      gameMode,
      timer:             null,
      questionStartTime: null,
    };

    socket.gameId = gameId;
    socket.role   = 'host';
    socket.join(gameId);

    socket.emit('game-created', { gameId, gameMode, autoplay });
    console.log(`Game ${gameId} | ${numRounds} rounds | categories: ${categories.join(',')} | autoplay: ${autoplay} | mode: ${gameMode}`);
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
  socket.on('start-game', ({ hostNickname } = {}) => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host') return;

    if (game.gameMode === 'mobile') {
      // In mobile mode the host joins as a player with their own nickname
      hostNickname = (hostNickname || '').trim();
      if (!hostNickname)
        return socket.emit('start-error', 'Enter your nickname to join the game.');
      if (hostNickname.length > 16)
        return socket.emit('start-error', 'Nickname must be 16 characters or less.');
      if (game.players.find(p => p.nickname.toLowerCase() === hostNickname.toLowerCase()))
        return socket.emit('start-error', 'That nickname is already taken. Try another.');
      game.players.push({
        id: socket.id, nickname: hostNickname, score: 0, answered: false,
        stats: { roundsAnswered: 0, roundsFirst: 0, bestRound: 0 },
      });
      console.log(`Host "${hostNickname}" joined ${game.id} as a player (mobile mode)`);
    } else {
      // TV mode: need at least one player on their own device
      if (game.players.length === 0)
        return socket.emit('start-error', 'You need at least 1 player to start!');
    }

    sendNextQuestion(game);
  });

  // ── PLAYER submits an answer ───────────────────────────────────────────────
  // NOTE: Scoring is NOT applied here. We store raw answer data (accuracy, timing)
  // and defer all point calculations to showLeaderboard(), once all answers are in.
  socket.on('submit-answer', ({ answerIndex, answerValue, answerLat, answerLng, answerSequence }) => {
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

    player.answerTime = elapsed;

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

      socket.emit('answer-result', {
        type:        qType,
        soundCorrect: accuracyRaw > 0,
        accuracyPct:  Math.round(accuracyRaw * 100),
        yourAnswer:   answerValue,
        correctValue: question.correct,
        unit:         question.unit,
      });

    } else if (qType === 'map') {
      const dist       = haversineKm(answerLat, answerLng, question.correctLat, question.correctLng);
      const accuracyRaw = Math.exp(-Math.pow(dist / 50, 0.6));

      player.accuracyRaw = accuracyRaw;
      player.mapAnswer   = { lat: answerLat, lng: answerLng, distanceKm: Math.round(dist) };
      player.lastAnswer  = { type: 'map', distanceKm: Math.round(dist) };

      socket.emit('answer-result', {
        type:        'map',
        soundCorrect: dist < 2000,
        distanceKm:   Math.round(dist),
        locationName: question.locationName,
      });

    } else if (qType === 'sequence') {
      const correctOrder  = question.items;
      const playerOrder   = answerSequence || [];
      const correctCount  = playerOrder.filter((item, i) => item === correctOrder[i]).length;
      const accuracyRaw   = correctCount / correctOrder.length;

      player.accuracyRaw = accuracyRaw;
      player.lastAnswer  = {
        type:         'sequence',
        playerOrder,
        correctCount,
        correctOrder,
      };

      socket.emit('answer-result', {
        type:         'sequence',
        soundCorrect: correctCount >= Math.ceil(correctOrder.length / 2),
        correctCount,
        totalItems:   correctOrder.length,
        correctOrder,
        playerOrder,
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

      // Points depend on final speed rank — deferred to leaderboard time
      socket.emit('answer-result', {
        type:         qType,
        soundCorrect: isCorrect,
        isCorrect,
        correctIndex: question.correct,
        correctText:  (question.answers || [])[question.correct] || '—',
        yourText:     (question.answers || [])[answerIndex]      || '—',
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
                       : game.currentQuestionType === 'sequence'                                               ? 4000
                       : 3000;
      clearTimeout(game.timer);
      game.timerEndAt = Date.now() + earlyPause;
      game.timer = setTimeout(() => showLeaderboard(game), earlyPause);
    }
  });

  // ── HOST manually advances (autoplay off) ──────────────────────────────────
  socket.on('next-question', () => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host') return;
    sendNextQuestion(game);
  });

  // ── HOST pauses / resumes ──────────────────────────────────────────────────
  socket.on('pause-game', () => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host' || (game.state !== 'question' && game.state !== 'leaderboard') || game.isPaused || !game.timer) return;

    game.pausedRemainingMs = Math.max(1000, game.timerEndAt - Date.now());
    clearTimeout(game.timer);
    game.timer    = null;
    game.isPaused = true;

    io.to(game.id).emit('game-paused', { remainingMs: game.pausedRemainingMs });
    console.log(`Game ${game.id} paused (${Math.round(game.pausedRemainingMs / 1000)}s remaining)`);
  });

  socket.on('resume-game', () => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host' || !game.isPaused) return;

    game.isPaused   = false;
    const remaining = game.pausedRemainingMs || 5000;
    game.timerEndAt = Date.now() + remaining;
    game.timer      = setTimeout(() => showLeaderboard(game), remaining);

    io.to(game.id).emit('game-resumed', { remainingMs: remaining });
    console.log(`Game ${game.id} resumed (${Math.round(remaining / 1000)}s remaining)`);
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
                  : qType === 'sequence'                         ? 30
                  : 15;

  game.currentTimeLimit    = timeLimit;
  game.currentQuestionType = qType;
  game.isPaused            = false;
  game.timerEndAt          = Date.now() + timeLimit * 1000;

  io.to(game.id).emit('new-question', {
    questionNumber: game.currentIndex + 1,
    totalQuestions: game.questions.length,
    question:       q.question,
    answers:        q.answers,
    timeLimit,
    type:           qType,
    // Slider/timeline fields:
    min:  q.min,
    max:  q.max,
    step: q.step || 1,
    unit: q.unit,
    // Optional photo:
    imageUrl: q.imageUrl || null,
    // Sequence: items shuffled so correct order isn't obvious
    items: qType === 'sequence' ? shuffleArray(q.items) : undefined,
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

  const correctAnswer = q.type === 'sequence'
    ? q.items.map((item, i) => `${i + 1}. ${item}`).join(' → ')
    : (q.type === 'slider' || q.type === 'timeline')
      ? (q.unit ? `${q.correct.toLocaleString('en-US')} ${q.unit}` : `${q.correct}`)
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

  const sequenceData = q.type === 'sequence' ? {
    correctOrder:  q.items,
    playerAnswers: game.players
      .filter(p => p.lastAnswer && p.lastAnswer.type === 'sequence')
      .map(p => ({
        nickname:     p.nickname,
        playerOrder:  p.lastAnswer.playerOrder,
        correctCount: p.lastAnswer.correctCount,
      })),
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
    sequenceData,
  });

  const baseLeaderboardPause = q.type === 'map'                               ? 10
                             : (q.type === 'slider' || q.type === 'timeline') ? 8
                             : q.type === 'sequence'                          ? 8
                             : LEADERBOARD_PAUSE;
  const leaderboardPause = Math.min(20, baseLeaderboardPause + (game.players.length - 1) * 0.5);

  if (game.autoplay) {
    game.timerEndAt = Date.now() + leaderboardPause * 1000;
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
