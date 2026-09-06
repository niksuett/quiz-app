// ─────────────────────────────────────────────────────────────────────────────
// server.js — backend: lobby, game loop, reconnect, host controls, Socket.io
//
// Game-type specific logic (what a question looks like, how an answer is
// judged) lives in games/<type>.js. This file only orchestrates:
//   create game → players join → intro → question → result → leaderboard → … → game over
// Scoring rules live in scoring.js.
// ─────────────────────────────────────────────────────────────────────────────

const express      = require('express');
const http         = require('http');
const path         = require('path');
const crypto       = require('crypto');
const { Server }   = require('socket.io');
const cookieParser = require('cookie-parser');
const compression  = require('compression');
const QRCode       = require('qrcode');

const registry = require('./games');
const scoring  = require('./scoring');
const { db, questionToRow, loadAllQuestions, getQuestionById, countsByCategory } = require('./db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { maxHttpBufferSize: 2e6 });

const IS_TEST = process.env.QUIZ_TEST === '1';

// Railway (and most hosts) terminate TLS in front of us, so without this req.secure
// is always false and req.ip is the proxy's address — which would make the admin
// cookie's `secure` flag and the login throttle useless in production.
app.set('trust proxy', 1);

app.use(compression());
// Small default body limit; the admin bulk-save is the only route that
// legitimately posts anything big, and it carries its own 25 MB parser. The
// 25 MB limit used to be global and ran *before* any auth check, so an anonymous
// client could make the server parse 25 MB of JSON on any URL. This parser has to
// step aside for that one route, or it would reject the body first.
const ADMIN_SAVE_PATH = '/admin/questions';
const smallJson = express.json({ limit: '100kb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === ADMIN_SAVE_PATH) return next();
  smallJson(req, res, next);
});
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
// NOTE: data/ is intentionally NOT served — files like borders.json and halves/*.json contain the answers.
// Game modules send exactly what the client needs inside each question payload.

// ── Admin auth ────────────────────────────────────────────────────────────────
// The cookie holds an opaque, server-generated session id — never the password.
// It used to hold the password itself, which meant (a) any XSS on the origin
// handed over the real credential rather than just a session, (b) "log out" only
// cleared the browser's copy while the value stayed valid, and (c) admin.html
// compared the cookie against a hard-coded 'ilikehistory99', so setting
// ADMIN_PASSWORD — exactly what you are told to do before deploying — locked the
// editor into a redirect loop.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ilikehistory99';
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const adminSessions = new Map();   // sessionId -> expiry timestamp

function newAdminSession() {
  const id = crypto.randomBytes(24).toString('hex');
  adminSessions.set(id, Date.now() + ADMIN_SESSION_MS);
  return id;
}
function adminSessionValid(id) {
  if (!id) return false;
  const expires = adminSessions.get(id);
  if (!expires) return false;
  if (expires < Date.now()) { adminSessions.delete(id); return false; }
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, exp] of adminSessions) if (exp < now) adminSessions.delete(id);
}, 30 * 60 * 1000).unref();

// Constant-time compare so the password can't be recovered a character at a time.
function passwordMatches(given) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(ADMIN_PASSWORD, 'utf8');
  // timingSafeEqual throws on a length mismatch, so hash both to a fixed width first.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Crude per-IP throttle: there is no other brake on guessing the password.
const loginAttempts = new Map();   // ip -> { count, resetAt }
const LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_MAX_TRIES = 10;
function loginThrottled(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) { loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS }); return false; }
  rec.count++;
  return rec.count > LOGIN_MAX_TRIES;
}

function adminCookieOptions(req) {
  return {
    maxAge: ADMIN_SESSION_MS,
    httpOnly: true,                  // script can no longer read it
    sameSite: 'lax',
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
  };
}

// POST, not GET: the password used to travel in a query string, which lands in
// proxy access logs and browser history in plain text.
app.post('/admin-auth', (req, res) => {
  const ip = req.ip || 'unknown';
  if (loginThrottled(ip)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  if (!passwordMatches(req.body && req.body.pw)) return res.status(401).json({ error: 'Incorrect password.' });
  loginAttempts.delete(ip);
  res.cookie('adminAuth', newAdminSession(), adminCookieOptions(req));
  res.json({ ok: true });
});

app.get('/admin-logout', (req, res) => {
  const id = req.cookies && req.cookies.adminAuth;
  if (id) adminSessions.delete(id);          // kill it server-side, not just in this browser
  res.clearCookie('adminAuth');
  res.redirect('/');
});

function requireAdmin(req, res, next) {
  if (req.cookies && adminSessionValid(req.cookies.adminAuth)) return next();
  res.status(401).json({ error: 'Not authorised' });
}

// ── Admin API ─────────────────────────────────────────────────────────────────
app.get('/admin/questions', requireAdmin, (req, res) => res.json(loadAllQuestions()));

// This route is a whole-table replace, so it is the one place a big body is
// legitimate — hence its own limit rather than a 25 MB limit on every URL.
app.post('/admin/questions', requireAdmin, express.json({ limit: '25mb' }), (req, res) => {
  const questions = req.body;
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'Expected an array' });

  // The save is "DELETE FROM questions, then insert what was posted", so an empty
  // or near-empty array silently destroys the question bank in one request. A real
  // save never shrinks the library by more than a few rows at a time; require an
  // explicit ?force=1 for anything that looks like a wipe.
  const existing = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
  const forced = req.query.force === '1';
  if (!forced && existing > 0 && questions.length < existing * 0.5) {
    return res.status(409).json({
      error: `Refusing to save: this would cut the library from ${existing} questions to ${questions.length}. `
           + `If that is really what you want, repeat the request with ?force=1.`,
    });
  }

  const errors = [];
  questions.forEach((q, i) => {
    const mod = registry.get(q.type || 'mc');
    if (!mod) { errors.push(`#${i + 1}: unknown type "${q.type}"`); return; }
    const cat = registry.categoryById[q.category];
    if (!cat) errors.push(`#${i + 1}: unknown category "${q.category}"`);
    // Same check import.js makes: a category is declared with one type, and a row
    // whose type disagrees plays with a different mechanic than its intro claims.
    else if (cat.type !== (q.type || 'mc')) errors.push(`#${i + 1}: category "${q.category}" is type "${cat.type}", not "${q.type || 'mc'}"`);
    for (const e of mod.validate({ ...q, type: q.type || 'mc' })) errors.push(`#${i + 1}: ${e}`);
  });
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors.slice(0, 50) });

  const deleteAll = db.prepare('DELETE FROM questions');
  const insert    = db.prepare(`INSERT INTO questions (id, category, type, question, correct, image_url, extra)
                                VALUES (@id, @category, @type, @question, @correct, @image_url, @extra)`);
  db.transaction(qs => {
    deleteAll.run();
    for (const q of qs) insert.run({ id: Number.isInteger(q.id) ? q.id : null, ...questionToRow(q) });
  })(questions);
  res.json({ ok: true, count: questions.length });
});

// ── Public API: what games exist (config screen is built from this) ──────────
app.get('/api/games', (req, res) => {
  const counts = countsByCategory();
  res.json({
    types: registry.all().map(m => ({ type: m.type, timeLimit: m.timeLimit, speedScored: m.speedScored, usesRegion: m.usesRegion })),
    categories: registry.categories.map(c => ({ ...c, count: counts[c.id] || 0 })),
    groups:  registry.GROUPS,
    regions: registry.REGIONS,
    presets: registry.PRESETS,
  });
});

// QR code for the join link (SVG). Players scan it in the lobby.
app.get('/qr/:gameId', async (req, res) => {
  const gameId = String(req.params.gameId || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    const svg = await QRCode.toString(`${origin}/?join=${gameId}`, { type: 'svg', margin: 1, color: { dark: '#1a1208', light: '#00000000' } });
    res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
  } catch (e) { res.status(500).end(); }
});

// Extra routes provided by game modules (e.g. the satellite tile proxy)
for (const mod of registry.all()) if (typeof mod.routes === 'function') mod.routes(app, { getGame: id => games[id] });

// ── Helpers ───────────────────────────────────────────────────────────────────
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function generateGameId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}
function newToken() { return crypto.randomBytes(12).toString('hex'); }
function categoryMeta(catId) {
  const c = registry.categoryById[catId];
  return c ? { id: c.id, label: c.label, emoji: c.emoji, group: c.group, howTo: c.howTo, blurb: c.blurb }
           : { id: catId, label: catId, emoji: '❔', group: 'classic', howTo: '', blurb: '' };
}

// Pick the questions for a game: round-robin across the chosen categories so a
// game is varied, filtered by region / difficulty when the host asked for it.
function pickQuestions(all, { categories, regions, difficulty, rounds }) {
  const pools = {};
  for (const cat of categories) {
    let pool = all.filter(q => q.category === cat);
    if (regions && regions.length) pool = pool.filter(q => !q.region || regions.includes(q.region));
    if (difficulty === 'casual') pool = pool.filter(q => (q.difficulty || 2) <= 2);
    if (difficulty === 'expert') pool = pool.filter(q => (q.difficulty || 2) >= 2);
    if (pool.length) pools[cat] = shuffle(pool);
  }
  const active = Object.keys(pools);
  if (!active.length) return [];
  const target = rounds === 'infinite' ? Infinity : rounds;
  const picked = [];
  let last = null;
  while (picked.length < target) {
    let cycle = shuffle(active.filter(c => pools[c].length));
    if (!cycle.length) break;
    // avoid repeating the previous category at a cycle boundary when we can
    if (cycle.length > 1 && cycle[0] === last) cycle.push(cycle.shift());
    for (const cat of cycle) {
      if (picked.length >= target) break;
      const q = pools[cat].pop();
      if (q) { picked.push(q); last = cat; }
    }
  }
  return picked;
}

// ── Game state ────────────────────────────────────────────────────────────────
const games  = {};   // gameId → game
const tokens = {};   // token → { gameId, role: 'host'|'player', nickname }
// Ceiling on live games. Creating one needs no auth and an abandoned lobby is
// only swept after 3 hours, so this is the only thing standing between the
// server and an unbounded `games` map. Far above any real party's needs.
const MAX_LIVE_GAMES = 500;

function makePlayer(socketId, nickname) {
  return { id: socketId, token: newToken(), nickname, score: 0, streak: 0, connected: true,
           answer: null, round: scoring.newRound(), stats: scoring.newStats() };
}

function buildLeaderboard(game) {
  return game.players
    .map(p => ({
      nickname: p.nickname, score: p.score, connected: p.connected, streak: p.streak,
      roundPoints: p.round.roundPoints, roundRank: p.round.roundRank,
      accuracyPts: p.round.accuracyPts, rankBonus: p.round.rankBonus, streakBonus: p.round.streakBonus,
      speedTiebreak: p.round.speedTiebreak, speedTiebreakedOut: p.round.speedTiebreakedOut,
      quality: p.answer ? p.answer.quality : null,
      detail:  p.answer ? p.answer.detail  : null,
      elapsed: p.answer ? Math.round(p.answer.elapsed * 10) / 10 : null,
      stats: { answered: p.stats.answered, firsts: p.stats.firsts, bestRound: p.stats.bestRound,
               avgAccuracy: p.stats.answered ? Math.round(p.stats.sumAccuracy / p.stats.answered) : 0,
               perfects: p.stats.perfects, longestStreak: p.stats.longestStreak },
    }))
    .sort((a, b) => b.score - a.score);
}

function lobbyPlayers(game) { return game.players.map(p => ({ nickname: p.nickname, connected: p.connected })); }
function emitLobby(game)    { io.to(game.id).emit('lobby-update', { players: lobbyPlayers(game) }); }
function connectedPlayers(game) { return game.players.filter(p => p.connected); }

function clearGameTimer(game) { if (game.timer) { clearTimeout(game.timer); game.timer = null; } }
function scaleMs(game, ms)    { return game.options.fast ? Math.min(ms, 150) : ms; }

// ── Pacing ───────────────────────────────────────────────────────────────────
// Every pause that is not the question timer itself lives here, so the rhythm
// of a game can be tuned in one place. The host's "pace" option (brisk / normal
// / relaxed) scales all of them; the per-type answering time never changes.
const PACE_FACTOR = { brisk: 0.7, normal: 1, relaxed: 1.4 };
const TIMING = {
  introFirstMs:     5000,   // first time a category appears — long enough to read the how-to
  introRepeatMs:    2200,   // later rounds of a known category — just the round number
  buzzerMs:         2500,   // after "time's up": whoever answered at the last second still sees their result
  earlyMinMs:       4000,   // once everyone has answered, the last one still gets this long on the result screen
  revealMinS:       8,      // a leaderboard never disappears faster than this (its own animation takes ~4 s)
  revealMaxS:       30,
  revealPerPlayerS: 0.5,    // more players = more pins / lines / bars to look at
};
function paceMs(game, ms) { return scaleMs(game, Math.round(ms * (PACE_FACTOR[game.options.pace] || 1))); }

// Everyone (still connected) has answered → close the question early, but leave
// the personal result screens up for a moment first.
function everyoneAnswered(game) {
  clearGameTimer(game);
  game.answersClosed = true;
  const wait = paceMs(game, Math.max(TIMING.earlyMinMs, game.currentModule.earlyPause));
  game.timerEndAt = Date.now() + wait;
  game.timer = setTimeout(() => showLeaderboard(game), wait);
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // HOST creates a game ───────────────────────────────────────────────────────
  socket.on('create-game', (opts = {}) => {
    // Nothing about creating a game is authenticated, and abandoned lobbies are
    // only swept after 3 hours — so without a ceiling a scripted client can grow
    // the in-memory `games` map until the process runs out of memory.
    if (Object.keys(games).length >= MAX_LIVE_GAMES) return socket.emit('create-error', 'Too many games are running right now. Try again in a few minutes.');
    const rounds     = opts.rounds === 'infinite' ? 'infinite' : Math.max(1, Math.min(100, parseInt(opts.rounds, 10) || 10));
    const categories = (Array.isArray(opts.categories) ? opts.categories : []).filter(c => registry.categoryById[c]);
    const regions    = Array.isArray(opts.regions) ? opts.regions.filter(r => registry.REGIONS.some(x => x.id === r)) : null;
    const difficulty = ['casual', 'normal', 'expert', 'mixed'].includes(opts.difficulty) ? opts.difficulty : 'mixed';
    const options = {
      autoplay:    opts.autoplay !== false,
      gameMode:    opts.gameMode === 'tv' ? 'tv' : 'mobile',
      finalDouble: opts.finalDouble !== false,
      intros:      opts.intros !== false,
      pace:        PACE_FACTOR[opts.pace] ? opts.pace : 'normal',
      fast:        IS_TEST && !!opts.testFast,
    };

    let questions;
    if (opts.testIds) {
      const ids = String(opts.testIds).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      questions = ids.map(getQuestionById).filter(Boolean);
      if (!questions.length) return socket.emit('create-error', 'No valid question IDs found in testIds.');
    } else {
      if (!categories.length) return socket.emit('create-error', 'Please pick at least one category.');
      questions = pickQuestions(loadAllQuestions(), { categories, regions, difficulty, rounds });
      if (!questions.length) return socket.emit('create-error', 'No questions match those categories and filters. Try widening the geographic focus.');
    }

    let gameId;
    do { gameId = generateGameId(); } while (games[gameId]);

    const game = {
      id: gameId, hostId: socket.id, hostToken: newToken(), hostConnected: true, hostGraceTimer: null,
      players: [], questions, currentIndex: -1, state: 'lobby', options,
      timer: null, timerEndAt: 0, isPaused: false, pausedRemainingMs: 0, pauseStartedAt: 0, pausedAccumMs: 0,
      questionStartTime: 0, seenCategories: new Set(), lastLeaderboard: null, lastGameOver: null,
      currentModule: null, currentPayload: null, createdAt: Date.now(),
      setup: { rounds, categories, regions, difficulty },
    };
    games[gameId] = game;
    tokens[game.hostToken] = { gameId, role: 'host', nickname: null };

    socket.gameId = gameId; socket.role = 'host';
    socket.join(gameId);
    socket.emit('game-created', { gameId, gameMode: options.gameMode, autoplay: options.autoplay, hostToken: game.hostToken, totalQuestions: questions.length });
    console.log(`Game ${gameId} | ${questions.length} rounds | ${opts.testIds ? 'testIds' : categories.join(',')} | regions: ${regions && regions.length ? regions.join(',') : 'all'} | ${difficulty} | ${options.gameMode}`);
  });

  // PLAYER joins ──────────────────────────────────────────────────────────────
  socket.on('join-game', ({ gameId, nickname } = {}) => {
    gameId   = String(gameId || '').trim().toUpperCase();
    nickname = String(nickname || '').trim().replace(/\s+/g, ' ');
    const game = games[gameId];
    // One connection = one player. Without this a single socket could join the
    // same game repeatedly under different nicknames, and on disconnect only the
    // first record got marked disconnected — the leftover "ghost" then kept the
    // everyone-has-answered check from ever completing, stalling every round
    // until its timer ran out.
    if (socket.gameId && games[socket.gameId])
                                        return socket.emit('join-error', 'You are already in a game on this device.');
    if (!game)                          return socket.emit('join-error', 'Game not found. Double-check the Game ID.');
    if (game.state !== 'lobby')         return socket.emit('join-error', 'Sorry, this game has already started.');
    if (!nickname)                      return socket.emit('join-error', 'Please enter a nickname.');
    if (nickname.length > 16)           return socket.emit('join-error', 'Nickname must be 16 characters or less.');
    if (game.players.find(p => p.nickname.toLowerCase() === nickname.toLowerCase()))
                                        return socket.emit('join-error', 'That nickname is already taken. Try another.');
    if (game.players.length >= 60)      return socket.emit('join-error', 'This game is full.');

    const player = makePlayer(socket.id, nickname);
    game.players.push(player);
    tokens[player.token] = { gameId, role: 'player', nickname };
    socket.gameId = gameId; socket.role = 'player';
    socket.join(gameId);
    socket.emit('join-success', { gameId, nickname, playerToken: player.token });
    emitLobby(game);
    console.log(`"${nickname}" joined ${gameId}`);
  });

  // Anyone reconnects with a token (page refresh, lost connection) ────────────
  socket.on('rejoin', ({ token } = {}) => {
    const t = tokens[token];
    const game = t && games[t.gameId];
    if (!t || !game) return socket.emit('rejoin-error', 'That game is no longer running.');

    socket.gameId = game.id;
    socket.join(game.id);
    let nickname = t.nickname;

    if (t.role === 'host') {
      socket.role = 'host';
      game.hostId = socket.id; game.hostConnected = true;
      if (game.hostGraceTimer) { clearTimeout(game.hostGraceTimer); game.hostGraceTimer = null; }
      // In mobile mode the host is also a player — re-link that player record too
      const hp = game.players.find(p => p.token === game.hostPlayerToken);
      if (hp) { hp.id = socket.id; hp.connected = true; nickname = hp.nickname; }
    } else {
      const p = game.players.find(pl => pl.token === token);
      if (!p) return socket.emit('rejoin-error', 'You are no longer part of that game.');
      socket.role = 'player';
      p.id = socket.id; p.connected = true;
    }

    socket.emit('rejoin-success', { role: socket.role, gameId: game.id, nickname, gameMode: game.options.gameMode,
                                    autoplay: game.options.autoplay, state: game.state, totalQuestions: game.questions.length });
    emitLobby(game);
    sendStateSnapshot(socket, game);
  });

  // HOST starts ───────────────────────────────────────────────────────────────
  socket.on('start-game', ({ hostNickname } = {}) => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host' || game.state !== 'lobby') return;

    const hostAlreadyIn = !!(game.hostPlayerToken && game.players.find(p => p.token === game.hostPlayerToken));
    if (game.options.gameMode === 'mobile' && !hostAlreadyIn) {
      hostNickname = String(hostNickname || '').trim().replace(/\s+/g, ' ');
      if (!hostNickname)               return socket.emit('start-error', 'Enter your nickname to join the game.');
      if (hostNickname.length > 16)    return socket.emit('start-error', 'Nickname must be 16 characters or less.');
      if (game.players.find(p => p.nickname.toLowerCase() === hostNickname.toLowerCase()))
                                       return socket.emit('start-error', 'That nickname is already taken. Try another.');
      const hp = makePlayer(socket.id, hostNickname);
      game.players.push(hp);
      game.hostPlayerToken = hp.token;
      tokens[game.hostToken].nickname = hostNickname;
    } else if (!connectedPlayers(game).length) {
      return socket.emit('start-error', 'You need at least 1 player to start!');
    }
    startQuestion(game);
  });

  // PLAYER answers ────────────────────────────────────────────────────────────
  socket.on('submit-answer', ({ answer } = {}) => {
    const game = games[socket.gameId];
    if (!game || game.state !== 'question' || game.isPaused || game.answersClosed) return;
    const player = game.players.find(p => p.id === socket.id);
    if (!player || player.answer) return;

    const q   = game.questions[game.currentIndex];
    const mod = game.currentModule;
    const elapsed = Math.max(0, (Date.now() - game.questionStartTime - game.pausedAccumMs) / 1000);

    let out = null;
    try { out = mod.evaluate(q, answer, { elapsed, timeLimit: mod.timeLimit, game }); }
    catch (e) { console.error(`evaluate() failed for ${mod.type}:`, e.message); }
    if (!out) return socket.emit('answer-rejected', 'That answer could not be read — try again.');

    const quality = (typeof out.quality === 'number' && !Number.isNaN(out.quality)) ? Math.max(0, Math.min(1, out.quality)) : null;
    player.answer = { quality, detail: out.detail || {}, result: out.result || {}, elapsed };

    socket.emit('answer-result', {
      type: mod.type, quality, elapsed: Math.round(elapsed * 10) / 10,
      soundCorrect: out.result && out.result.soundCorrect !== undefined ? out.result.soundCorrect : (quality !== null && quality >= 0.5),
      ...(out.result || {}),
    });

    const answered = game.players.filter(p => p.answer).length;
    io.to(game.hostId).emit('answer-progress', { answered, total: game.players.length, connected: connectedPlayers(game).length });

    // Everyone (who is still connected) has answered → show results early
    if (connectedPlayers(game).every(p => p.answer)) everyoneAnswered(game);
  });

  // HOST controls ─────────────────────────────────────────────────────────────
  socket.on('next-question', () => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host' || game.state !== 'leaderboard' || game.options.autoplay) return;
    startQuestion(game);
  });

  socket.on('skip-question', () => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host') return;
    // One tap = one step. Without this guard a double-tap chains: the first tap
    // moves question → leaderboard, and the second immediately matches the
    // 'leaderboard' branch below and starts the next question, so nobody ever
    // sees the reveal (or, on the last round, the final leaderboard).
    const now = Date.now();
    if (now - (game.lastSkipAt || 0) < 600) return;
    game.lastSkipAt = now;
    if (game.state === 'question' || game.state === 'intro') { game.isPaused = false; showLeaderboard(game); }
    else if (game.state === 'leaderboard') { startQuestion(game); }
  });

  socket.on('end-game', () => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host' || game.state === 'gameover') return;
    if (game.state === 'question') { game.isPaused = false; scoring.applyRoundScores(game, game.questions[game.currentIndex], game.currentModule); }
    endGame(game);
  });

  socket.on('kick-player', ({ nickname } = {}) => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host' || game.state !== 'lobby') return;
    const idx = game.players.findIndex(p => p.nickname === nickname);
    if (idx < 0) return;
    const [p] = game.players.splice(idx, 1);
    delete tokens[p.token];
    io.to(p.id).emit('kicked');
    const s = io.sockets.sockets.get(p.id);
    if (s) { s.leave(game.id); s.gameId = null; }
    emitLobby(game);
  });

  // Rematch: same players, same settings, fresh questions — nobody re-enters a code
  socket.on('rematch', () => {
    const old = games[socket.gameId];
    if (!old || socket.role !== 'host' || old.state !== 'gameover') return;
    const questions = pickQuestions(loadAllQuestions(), { ...old.setup, rounds: old.setup.rounds });
    if (!questions.length) return socket.emit('start-error', 'No questions available for a rematch.');
    let gameId;
    do { gameId = generateGameId(); } while (games[gameId]);
    const game = {
      ...old, id: gameId, questions, currentIndex: -1, state: 'lobby', timer: null, timerEndAt: 0, isPaused: false,
      pausedRemainingMs: 0, pauseStartedAt: 0, pausedAccumMs: 0, questionStartTime: 0, seenCategories: new Set(),
      lastLeaderboard: null, lastGameOver: null, currentModule: null, currentPayload: null, createdAt: Date.now(), hostGraceTimer: null,
      players: old.players.map(p => ({ ...p, score: 0, streak: 0, answer: null, round: scoring.newRound(), stats: scoring.newStats() })),
    };
    games[gameId] = game;
    tokens[game.hostToken] = { gameId, role: 'host', nickname: tokens[old.hostToken] ? tokens[old.hostToken].nickname : null };
    for (const p of game.players) tokens[p.token] = { gameId, role: 'player', nickname: p.nickname };
    // Move every socket into the new room
    for (const s of io.sockets.adapter.rooms.get(old.id) ? [...io.sockets.adapter.rooms.get(old.id)] : []) {
      const sock = io.sockets.sockets.get(s);
      if (sock) { sock.leave(old.id); sock.join(gameId); sock.gameId = gameId; }
    }
    delete games[old.id];
    io.to(gameId).emit('rematch', { gameId, gameMode: game.options.gameMode, autoplay: game.options.autoplay, totalQuestions: questions.length, players: lobbyPlayers(game) });
    console.log(`Rematch: ${old.id} → ${gameId}`);
  });

  socket.on('pause-game', () => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host' || game.isPaused || !game.timer) return;
    if (game.state !== 'question' && game.state !== 'leaderboard') return;
    game.pausedRemainingMs = Math.max(500, game.timerEndAt - Date.now());
    clearGameTimer(game);
    game.isPaused = true;
    game.pauseStartedAt = Date.now();
    io.to(game.id).emit('game-paused', { remainingMs: game.pausedRemainingMs, state: game.state });
  });

  socket.on('resume-game', () => {
    const game = games[socket.gameId];
    if (!game || socket.role !== 'host' || !game.isPaused) return;
    game.isPaused = false;
    if (game.state === 'question') game.pausedAccumMs += Date.now() - game.pauseStartedAt;
    const remaining = game.pausedRemainingMs || 3000;
    game.timerEndAt = Date.now() + remaining;
    game.timer = setTimeout(() => {
      if (game.state !== 'question') return startQuestion(game);
      return game.answersClosed ? showLeaderboard(game) : onTimeUp(game);
    }, remaining);
    io.to(game.id).emit('game-resumed', { remainingMs: remaining, state: game.state });
  });

  // Disconnect ────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const game = games[socket.gameId];
    if (!game) return;

    if (socket.role === 'host' && game.hostId === socket.id) {
      game.hostConnected = false;
      const hp = game.players.find(p => p.token === game.hostPlayerToken);
      if (hp) hp.connected = false;
      // Give the host a grace period to come back (page refresh, flaky wifi)
      game.hostGraceTimer = setTimeout(() => {
        if (game.hostConnected || !games[game.id]) return;
        clearGameTimer(game);
        io.to(game.id).emit('host-left');
        destroyGame(game);
      }, IS_TEST ? 2000 : 90 * 1000);
      if (game.state === 'lobby') emitLobby(game);
      return;
    }

    const p = game.players.find(pl => pl.id === socket.id);
    if (!p) return;
    if (game.state === 'lobby') {
      // In the lobby just drop them — they can join again
      game.players = game.players.filter(pl => pl !== p);
      delete tokens[p.token];
    } else {
      p.connected = false;   // keep their score; they can rejoin with their token
      // If everyone else already answered, don't wait for a ghost
      if (game.state === 'question' && !game.isPaused && !game.answersClosed && connectedPlayers(game).length && connectedPlayers(game).every(pl => pl.answer)) {
        everyoneAnswered(game);
      }
    }
    emitLobby(game);
  });
});

// ── Snapshot for reconnecting clients ────────────────────────────────────────
function sendStateSnapshot(socket, game) {
  if (game.state === 'lobby') return;
  if (game.state === 'intro' || game.state === 'question') {
    const q   = game.questions[game.currentIndex];
    const mod = game.currentModule;
    const me  = game.players.find(p => p.id === socket.id);
    const remainingMs = game.isPaused ? game.pausedRemainingMs : Math.max(0, game.timerEndAt - Date.now());
    if (game.state === 'intro') {
      socket.emit('question-intro', { questionNumber: game.currentIndex + 1, totalQuestions: game.questions.length, type: mod.type,
                                      category: categoryMeta(q.category), firstTime: false, durationMs: remainingMs });
      return;
    }
    socket.emit('new-question', {
      questionNumber: game.currentIndex + 1, totalQuestions: game.questions.length, type: mod.type,
      category: categoryMeta(q.category), timeLimit: mod.timeLimit, remainingMs, paused: game.isPaused,
      closed: !!game.answersClosed,      // time is up (or everyone answered) — the leaderboard is seconds away
      payload: game.currentPayload,
      isLast: game.currentIndex === game.questions.length - 1,
      multiplier: (game.options.finalDouble && game.currentIndex === game.questions.length - 1) ? 2 : 1,
      answered: !!(me && me.answer),
      myResult: me && me.answer ? { type: mod.type, quality: me.answer.quality, ...me.answer.result } : null,
    });
    if (socket.role === 'host') socket.emit('answer-progress', { answered: game.players.filter(p => p.answer).length, total: game.players.length, connected: connectedPlayers(game).length });
  } else if (game.state === 'leaderboard' && game.lastLeaderboard) {
    socket.emit('show-leaderboard', { ...game.lastLeaderboard, leaderboard: buildLeaderboard(game), remainingMs: game.isPaused ? game.pausedRemainingMs : Math.max(0, game.timerEndAt - Date.now()), paused: game.isPaused });
    if (socket.role === 'host' && !game.options.autoplay) socket.emit('waiting-for-host');
  } else if (game.state === 'gameover' && game.lastGameOver) {
    socket.emit('game-over', game.lastGameOver);
  }
}

// ── Game flow ─────────────────────────────────────────────────────────────────
function startQuestion(game) {
  clearGameTimer(game);
  game.isPaused = false;
  game.currentIndex++;
  if (game.currentIndex >= game.questions.length) return endGame(game);

  const q   = game.questions[game.currentIndex];
  const mod = registry.get(q.type);
  if (!mod) { console.error(`No module for type "${q.type}" — skipping question ${q.id}`); return startQuestion(game); }
  game.currentModule = mod;

  for (const p of game.players) { p.answer = null; p.round = scoring.newRound(); }

  const firstTime = !game.seenCategories.has(q.category);
  game.seenCategories.add(q.category);

  if (game.options.intros) {
    game.state = 'intro';
    const durationMs = paceMs(game, firstTime ? TIMING.introFirstMs : TIMING.introRepeatMs);
    game.timerEndAt = Date.now() + durationMs;
    io.to(game.id).emit('question-intro', {
      questionNumber: game.currentIndex + 1, totalQuestions: game.questions.length, type: mod.type,
      category: categoryMeta(q.category), firstTime, durationMs,
    });
    game.timer = setTimeout(() => beginQuestion(game), durationMs);
  } else {
    beginQuestion(game);
  }
}

function beginQuestion(game) {
  clearGameTimer(game);
  const q   = game.questions[game.currentIndex];
  const mod = game.currentModule;
  let payload;
  try { payload = mod.payload(q, game); }
  catch (e) { console.error(`payload() failed for ${mod.type} (question ${q.id}):`, e.message); return startQuestion(game); }

  game.state             = 'question';
  game.questionStartTime = Date.now();
  game.pausedAccumMs     = 0;
  game.answersClosed     = false;
  game.currentPayload    = payload;
  const timeLimitMs = scaleMs(game, mod.timeLimit * 1000);
  game.timerEndAt = Date.now() + timeLimitMs;

  io.to(game.id).emit('new-question', {
    questionNumber: game.currentIndex + 1, totalQuestions: game.questions.length, type: mod.type,
    category: categoryMeta(q.category), timeLimit: mod.timeLimit, remainingMs: timeLimitMs, payload,
    isLast: game.currentIndex === game.questions.length - 1,
    multiplier: (game.options.finalDouble && game.currentIndex === game.questions.length - 1) ? 2 : 1,
  });
  io.to(game.hostId).emit('answer-progress', { answered: 0, total: game.players.length, connected: connectedPlayers(game).length });
  game.timer = setTimeout(() => onTimeUp(game), timeLimitMs);
}

// The question timer ran out. Answers close now, but the leaderboard waits a
// beat: players who locked in at the last second get to see their own result
// screen, and everyone else sees "Time's up" instead of an abrupt jump.
function onTimeUp(game) {
  clearGameTimer(game);
  if (game.state !== 'question') return;
  game.answersClosed = true;
  io.to(game.id).emit('time-up');
  const wait = paceMs(game, TIMING.buzzerMs);
  game.timerEndAt = Date.now() + wait;
  game.timer = setTimeout(() => showLeaderboard(game), wait);
}

function showLeaderboard(game) {
  clearGameTimer(game);
  if (game.state === 'leaderboard' || game.state === 'gameover') return;
  game.state    = 'leaderboard';
  game.isPaused = false;

  const q      = game.questions[game.currentIndex];
  const mod    = game.currentModule;
  const isLast = game.currentIndex === game.questions.length - 1;

  const { multiplier } = scoring.applyRoundScores(game, q, mod);

  // Remember mid-game ranks for the "Comeback Kid" award
  if (game.currentIndex === Math.floor(game.questions.length / 2) - 1 && game.questions.length >= 4) {
    [...game.players].sort((a, b) => b.score - a.score).forEach((p, i) => { p.stats.midRank = i + 1; });
  }

  // Everyone who actually submitted a readable answer. `p.answer` is only set once
  // evaluate() accepted the answer, so this already excludes non-answerers. Do NOT
  // also filter on `quality !== null`: the mc-family types score a wrong answer as
  // quality null, so that would hide every wrong answer from the reveal — which is
  // exactly the interesting part ("2 of you said UK").
  const answers = game.players
    .filter(p => p.answer)
    .map(p => ({ nickname: p.nickname, detail: p.answer.detail, quality: p.answer.quality, elapsed: p.answer.elapsed, roundPoints: p.round.roundPoints }));
  let reveal = null;
  try { reveal = mod.reveal(q, answers, game); } catch (e) { console.error(`reveal() failed for ${mod.type}:`, e.message); }

  // How long the leaderboard stays: the type's own reveal time, longer with more
  // players, never shorter than the leaderboard animation itself, scaled by pace.
  const baseS = Math.max(TIMING.revealMinS, mod.revealPause) + Math.max(0, connectedPlayers(game).length - 1) * TIMING.revealPerPlayerS;
  const revealPause = Math.min(TIMING.revealMaxS, Math.round(baseS * (PACE_FACTOR[game.options.pace] || 1)));
  const payload = {
    leaderboard: buildLeaderboard(game),
    correctText: safe(() => mod.correctText(q), ''),
    type: mod.type, category: categoryMeta(q.category),
    questionNumber: game.currentIndex + 1, totalQuestions: game.questions.length,
    isLast, multiplier, reveal, autoplay: game.options.autoplay, revealSeconds: revealPause,
  };
  game.lastLeaderboard = payload;
  io.to(game.id).emit('show-leaderboard', payload);

  if (game.options.autoplay) {
    const wait = scaleMs(game, revealPause * 1000);
    game.timerEndAt = Date.now() + wait;
    game.timer = setTimeout(() => startQuestion(game), wait);
  } else {
    io.to(game.hostId).emit('waiting-for-host');
  }
}

function endGame(game) {
  clearGameTimer(game);
  game.state = 'gameover';
  const payload = { leaderboard: buildLeaderboard(game), awards: safe(() => scoring.computeAwards(game), []), totalQuestions: Math.min(game.currentIndex + 1, game.questions.length) };
  game.lastGameOver = payload;
  io.to(game.id).emit('game-over', payload);
  // Keep the game around so players can reload and still see the results
  setTimeout(() => destroyGame(game), IS_TEST ? 500 : 10 * 60 * 1000);
}

function destroyGame(game) {
  if (!games[game.id]) return;
  clearGameTimer(game);
  if (game.hostGraceTimer) clearTimeout(game.hostGraceTimer);
  delete tokens[game.hostToken];
  for (const p of game.players) delete tokens[p.token];
  delete games[game.id];
}

function safe(fn, fallback) { try { return fn(); } catch (e) { console.error(e.message); return fallback; } }

// Stale-game sweeper: drop lobbies nobody used for 3 hours
setInterval(() => {
  const now = Date.now();
  for (const g of Object.values(games)) if (g.state === 'lobby' && now - g.createdAt > 3 * 60 * 60 * 1000) destroyGame(g);
}, 10 * 60 * 1000).unref();

// ── Start ─────────────────────────────────────────────────────────────────────
function start(port) {
  return new Promise(resolve => server.listen(port, () => resolve(server.address().port)));
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  start(PORT).then(p => {
    console.log('\n✅ QuizBlast is running!');
    console.log(`   Open your browser and go to: http://localhost:${p}`);
    console.log(`   ${registry.categories.length} categories across ${registry.all().length} game types loaded.`);
    console.log('   Press Ctrl+C to stop the server.\n');
  });
}

module.exports = { app, server, io, start, games, registry };
