// ─────────────────────────────────────────────────────────────────────────────
// test/simulate.js — headless end-to-end test.
//
// Starts the server in-process (QUIZ_TEST=1 shrinks every pause to ~150 ms),
// creates a game, joins a few bots, and plays through every question using each
// game module's sampleAnswer(). Asserts the protocol and scoring invariants.
//
//   node test/simulate.js                       # all categories, 1 question each
//   node test/simulate.js --categories borders,halves --rounds 6 --bots 4
//   node test/simulate.js --ids 12,55,300       # specific question ids
// ─────────────────────────────────────────────────────────────────────────────
process.env.QUIZ_TEST = '1';

const { io: Client } = require('socket.io-client');
const { start, server, registry } = require('../server');

const args = process.argv.slice(2);
const opt  = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const categories = opt('categories', null) ? opt('categories').split(',') : registry.categories.map(c => c.id);
const rounds     = parseInt(opt('rounds', String(categories.length)), 10);
const bots       = parseInt(opt('bots', '3'), 10);
const testIds    = opt('ids', null);
const difficulty = opt('difficulty', null);   // optional: 'casual' | 'mixed' | 'expert' | 'normal' — passed straight through to create-game
const verbose    = args.includes('--verbose');

let failures = 0;
const fail = msg => { failures++; console.error('  ✗', msg); };
const ok   = msg => { if (verbose) console.log('  ✓', msg); };

function connect(port) {
  return new Promise((resolve, reject) => {
    const s = Client(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}
const once = (s, ev) => new Promise(resolve => s.once(ev, resolve));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Strings that would give away the answer if they appeared in a payload.
// Two kinds of fingerprint:
//   strict          — must not appear anywhere in the payload.
//   outsideQuestion — must not appear anywhere EXCEPT the prompt the player reads.
//                     A map question is allowed to name its own subject: "Where is
//                     the Caspian Sea?" has to say "Caspian Sea", and knowing the
//                     name is not knowing the coordinates. Checking those names
//                     against the whole payload made this test fail at random,
//                     depending only on which questions happened to be drawn.
function answerFingerprints(q) {
  const strict = [], outsideQuestion = [];
  if (q.type === 'mc' || q.type === 'flag' || q.type === 'silhouette' || q.type === 'tune') strict.push(`"correct":${q.correct}`);
  if (q.type === 'map') {
    strict.push(String(q.correctLat), String(q.correctLng));
    if (q.locationName) outsideQuestion.push(q.locationName);
  }
  if (q.type === 'slider' || q.type === 'timeline') strict.push(`"correct":${q.correct}`);
  if (q.type === 'fakes') strict.push('"fake":true');
  return { strict, outsideQuestion };
}

// ── Reveal checks ────────────────────────────────────────────────────────────
// The reveal is the payoff screen — the drawn lines, the dropped pins, the "2 of
// you said UK" bars. It used to be checked only for `!== undefined`, which meant
// two whole classes of bug sailed through: a reveal() that *threw* (the server
// catches it and sends null, which is not undefined) and a reveal that came back
// structurally fine but with the players missing from it. Both actually happened.
const answeredThisQuestion = new Map();   // questionNumber -> Set of nicknames the server accepted

// JSON.stringify turns NaN into null, so a NaN has to be hunted for directly.
function findNaN(value, path = 'reveal') {
  if (typeof value === 'number') return Number.isFinite(value) ? null : `${path} = ${value}`;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) { const hit = findNaN(value[i], `${path}[${i}]`); if (hit) return hit; }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) { const hit = findNaN(value[k], `${path}.${k}`); if (hit) return hit; }
    return null;
  }
  return null;
}

function checkReveal(data) {
  const where = `${data.type} (Q${data.questionNumber})`;
  if (data.reveal === undefined) fail(`no reveal for ${where}`);
  // null means reveal() threw and server.js swallowed it — the players see an
  // empty payoff screen with nothing in the logs but one console.error.
  if (data.reveal === null) fail(`reveal() returned null (it threw) for ${where}`);
  if (typeof data.reveal !== 'object') return fail(`reveal for ${where} is not an object`);

  if (typeof data.correctText !== 'string' || !data.correctText.trim()) {
    fail(`correctText missing/empty for ${where}`);
  }

  // Everyone whose answer the server accepted must be somewhere in the reveal.
  // Every module puts answering players in it under some key (pickedBy, pins,
  // lines, guesses, arrows, playerAnswers, scores…), so a name-presence check is
  // type-agnostic — and it is exactly the check that the mc-family types failed
  // when wrong answers were being filtered out before reveal() ever saw them.
  const answered = answeredThisQuestion.get(data.questionNumber);
  if (answered && answered.size) {
    const blob = JSON.stringify(data.reveal);
    const missing = [...answered].filter(n => !blob.includes(`"${n}"`));
    if (missing.length) fail(`reveal for ${where} omits ${missing.length} of ${answered.size} answering player(s): ${missing.join(', ')}`);
  }
  answeredThisQuestion.delete(data.questionNumber);
}

// NaN does not survive the socket: socket.io serialises with JSON, which turns it
// into null, so by the time a payload/reveal reaches the client the evidence is
// gone. The server runs in-process here, so wrap the modules and look at what
// they actually returned, before it goes on the wire.
function watchForNaN() {
  for (const mod of registry.all()) {
    for (const fn of ['payload', 'reveal']) {
      if (typeof mod[fn] !== 'function') continue;
      const orig = mod[fn].bind(mod);
      mod[fn] = (...args) => {
        const out = orig(...args);
        const hit = findNaN(out, `${mod.type}.${fn}()`);
        if (hit) fail(`${mod.type} ${fn}() produced a non-finite number: ${hit}`);
        return out;
      };
    }
  }
}

(async () => {
  const port = await start(0);
  watchForNaN();
  console.log(`Server on :${port} — categories: ${categories.join(', ')}`);

  const host = await connect(port);
  const botSockets = [];
  for (let i = 0; i < bots; i++) botSockets.push(await connect(port));

  host.emit('create-game', { rounds, categories, autoplay: true, gameMode: 'tv', finalDouble: true, intros: true, testFast: true, testIds, ...(difficulty ? { difficulty } : {}) });
  const created = await Promise.race([once(host, 'game-created'), once(host, 'create-error').then(m => { throw new Error('create-error: ' + m); })]);
  ok(`game ${created.gameId} with ${created.totalQuestions} questions`);
  if (created.totalQuestions === 0) fail('no questions');

  for (let i = 0; i < bots; i++) {
    botSockets[i].emit('join-game', { gameId: created.gameId, nickname: `Bot${i + 1}` });
    const res = await Promise.race([once(botSockets[i], 'join-success'), once(botSockets[i], 'join-error').then(m => { throw new Error('join-error: ' + m); })]);
    ok(`${res.nickname} joined`);
  }

  // Per-question bookkeeping
  const seen = { intro: 0, question: 0, leaderboard: 0 };
  const scores = {};
  let questionsById = null;
  const allQuestions = require('../db').loadAllQuestions();
  questionsById = Object.fromEntries(allQuestions.map(q => [q.id, q]));

  host.on('question-intro', () => { seen.intro++; });
  host.on('new-question', (data) => {
    seen.question++;
    const mod = registry.get(data.type);
    if (!mod) fail(`unknown type ${data.type}`);
    if (!data.payload) fail(`no payload for ${data.type}`);
    const json = JSON.stringify(data.payload);
    const { question: _prompt, ...payloadRest } = data.payload;
    const jsonNoPrompt = JSON.stringify(payloadRest);
    // leak check: find the question by matching module + payload
    const candidates = allQuestions.filter(q => q.type === data.type && q.category === data.category.id);
    for (const q of candidates) {
      if (q.question && data.payload.question === q.question) {
        const { strict, outsideQuestion } = answerFingerprints(q);
        for (const fp of strict) if (fp && fp.length > 2 && json.includes(fp)) fail(`payload for "${q.question}" leaks "${fp}"`);
        for (const fp of outsideQuestion) if (fp && fp.length > 2 && jsonNoPrompt.includes(fp)) fail(`payload for "${q.question}" leaks "${fp}" outside the prompt`);
      }
    }
    if (verbose) console.log(`  Q${data.questionNumber}/${data.totalQuestions} ${data.type}/${data.category.id} — ${String(data.payload.question || '').slice(0, 60)}`);
  });
  host.on('show-leaderboard', (data) => {
    seen.leaderboard++;
    if (!Array.isArray(data.leaderboard)) fail('leaderboard missing');
    for (const e of data.leaderboard) {
      if (e.score < 0) fail(`negative score for ${e.nickname}`);
      if (scores[e.nickname] !== undefined && e.score < scores[e.nickname]) fail(`score decreased for ${e.nickname}`);
      scores[e.nickname] = e.score;
      if (e.roundPoints < 0) fail('negative round points');
      if (e.quality !== null && (e.quality < 0 || e.quality > 1)) fail(`quality out of range: ${e.quality}`);
    }
    checkReveal(data);
    if (verbose) console.log(`     → ${data.type}: ${data.leaderboard.map(e => `${e.nickname}=${e.score}(+${e.roundPoints}${e.quality !== null ? ' q' + e.quality.toFixed(2) : ' —'})`).join('  ')}`);
  });

  // Bots answer every question with a sample answer
  for (let i = 0; i < botSockets.length; i++) {
    const s = botSockets[i];
    const nickname = `Bot${i + 1}`;
    let currentQ = 0;
    s.on('new-question', (data) => {
      currentQ = data.questionNumber;
      const mod = registry.get(data.type);
      if (!mod) return;
      let answer;
      try { answer = mod.sampleAnswer(data.payload); } catch (e) { fail(`sampleAnswer threw for ${data.type}: ${e.message}`); return; }
      setTimeout(() => s.emit('submit-answer', { answer }), 20 + Math.random() * 60);
    });
    s.on('answer-rejected', (m) => fail(`answer rejected: ${m}`));
    s.on('answer-result', (r) => {
      if (r.quality !== null && (r.quality < 0 || r.quality > 1)) fail('result quality out of range');
      // answer-result is only emitted once the server has accepted and stored the
      // answer, so this is the authoritative "who answered" set for the reveal
      // check. Note it must NOT be derived from quality: the mc-family types
      // score a wrong answer as null, and those are the ones that went missing.
      if (!answeredThisQuestion.has(currentQ)) answeredThisQuestion.set(currentQ, new Set());
      answeredThisQuestion.get(currentQ).add(nickname);
    });
  }

  host.emit('start-game', {});
  const over = await Promise.race([once(host, 'game-over'), sleep(120000).then(() => { throw new Error('timeout waiting for game-over'); })]);

  if (seen.question !== created.totalQuestions) fail(`expected ${created.totalQuestions} questions, saw ${seen.question}`);
  if (seen.leaderboard !== created.totalQuestions) fail(`expected ${created.totalQuestions} leaderboards, saw ${seen.leaderboard}`);
  if (!Array.isArray(over.awards)) fail('awards missing');
  console.log(`Played ${seen.question} questions, ${seen.leaderboard} leaderboards, ${over.awards.length} awards. Final: ${over.leaderboard.map(e => `${e.nickname}=${e.score}`).join(', ')}`);

  host.close(); botSockets.forEach(s => s.close());
  server.close();
  if (failures) { console.error(`\n❌ ${failures} failure(s)`); process.exit(1); }
  console.log('\n✅ simulate: all checks passed');
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
