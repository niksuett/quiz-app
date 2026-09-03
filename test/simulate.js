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
function answerFingerprints(q) {
  const out = [];
  if (q.type === 'mc' || q.type === 'flag' || q.type === 'silhouette' || q.type === 'tune') out.push(`"correct":${q.correct}`);
  if (q.type === 'map') { out.push(String(q.correctLat), String(q.correctLng)); if (q.locationName) out.push(q.locationName); }
  if (q.type === 'slider' || q.type === 'timeline') out.push(`"correct":${q.correct}`);
  if (q.type === 'fakes') out.push('"fake":true');
  return out;
}

(async () => {
  const port = await start(0);
  console.log(`Server on :${port} — categories: ${categories.join(', ')}`);

  const host = await connect(port);
  const botSockets = [];
  for (let i = 0; i < bots; i++) botSockets.push(await connect(port));

  host.emit('create-game', { rounds, categories, autoplay: true, gameMode: 'tv', finalDouble: true, intros: true, testFast: true, testIds });
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
    // leak check: find the question by matching module + payload
    const candidates = allQuestions.filter(q => q.type === data.type && q.category === data.category.id);
    for (const q of candidates) {
      if (q.question && data.payload.question === q.question) {
        for (const fp of answerFingerprints(q)) if (fp && fp.length > 2 && json.includes(fp)) fail(`payload for "${q.question}" leaks "${fp}"`);
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
    if (data.reveal === undefined) fail(`no reveal for ${data.type}`);
    if (verbose) console.log(`     → ${data.type}: ${data.leaderboard.map(e => `${e.nickname}=${e.score}(+${e.roundPoints}${e.quality !== null ? ' q' + e.quality.toFixed(2) : ' —'})`).join('  ')}`);
  });

  // Bots answer every question with a sample answer
  for (const s of botSockets) {
    s.on('new-question', (data) => {
      const mod = registry.get(data.type);
      if (!mod) return;
      let answer;
      try { answer = mod.sampleAnswer(data.payload); } catch (e) { fail(`sampleAnswer threw for ${data.type}: ${e.message}`); return; }
      setTimeout(() => s.emit('submit-answer', { answer }), 20 + Math.random() * 60);
    });
    s.on('answer-rejected', (m) => fail(`answer rejected: ${m}`));
    s.on('answer-result', (r) => { if (r.quality !== null && (r.quality < 0 || r.quality > 1)) fail('result quality out of range'); });
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
