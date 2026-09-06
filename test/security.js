// ─────────────────────────────────────────────────────────────────────────────
// test/security.js — the checks that protect the two things a player must not be
// able to do: read an answer they haven't earned, and touch the question bank.
//
//   node test/security.js
//
// Runs against a COPY of quiz.db in the temp directory, so it can exercise the
// destructive admin save path without risking the real database. Exit code 0 = pass.
//
// Why these two areas have their own file rather than living in simulate.js:
// simulate.js plays the game, and neither of these is reachable by playing it —
// they are things you only find by acting like an attacker with devtools open.
// ─────────────────────────────────────────────────────────────────────────────
process.env.QUIZ_TEST = '1';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Point the server at a throwaway copy BEFORE requiring it (db.js reads QUIZ_DB
// at require-time). The admin tests delete and reinsert every row.
const realDb = path.join(__dirname, '..', 'quiz.db');
const tmpDb  = path.join(os.tmpdir(), `quizblast-security-test-${process.pid}.db`);
fs.copyFileSync(realDb, tmpDb);
process.env.QUIZ_DB = tmpDb;
process.env.ADMIN_PASSWORD = 'a-deliberately-non-default-password';

const { io: Client } = require('socket.io-client');
const { start, server } = require('../server');

const PASSWORD = process.env.ADMIN_PASSWORD;
const results = [];
let failures = 0;

function check(name, pass, detail = '') {
  results.push({ check: name, result: pass ? 'pass' : 'FAIL', detail });
  if (!pass) failures++;
}
const once = (s, ev) => new Promise(r => s.once(ev, r));

function cleanup() {
  try { server.close(); } catch (e) { /* already closed */ }
  try { fs.unlinkSync(tmpDb); } catch (e) { /* best effort */ }
}

// ── 1. Satellite tile proxy ──────────────────────────────────────────────────
// Bird's Eye shows a satellite close-up and proxies the tiles so the browser
// never learns the real coordinates before the reveal. Every tile is *centred*
// on the secret point, so the zoom must be pinned to the one the question was
// authored at — otherwise a player reads the token straight out of the question
// payload, asks for zoom 3, and gets a continent-scale view centred on the answer.
async function testTileProxy(base, port) {
  const mk = async () => { const s = Client(`http://localhost:${port}`, { transports: ['websocket'] }); await once(s, 'connect'); return s; };
  const host = await mk();
  host.emit('create-game', { rounds: 1, categories: ['birdseye'], autoplay: true, gameMode: 'tv', intros: false, testFast: true });
  const created = await once(host, 'game-created');
  const bot = await mk();
  bot.emit('join-game', { gameId: created.gameId, nickname: 'Mallory' });
  await once(bot, 'join-success');

  const questionArrived = once(bot, 'new-question');
  host.emit('start-game', {});
  const q = await questionArrived;
  const sat = q.payload && q.payload.satellite;

  if (!sat) {
    check('tile proxy: got a satellite question to test', false, 'no satellite in payload');
    host.close(); bot.close();
    return;
  }

  const status = async (z, dx = 0, dy = 0) => (await fetch(`${base}/map/sat/${sat.token}/${z}/${dx}/${dy}`)).status;

  const offZoom = [3, 5, 8, 10].filter(z => z !== sat.zoom);
  const served = [];
  for (const z of offZoom) if (await status(z) === 200) served.push(z);
  check('tile proxy: refuses zooms other than the authored one', served.length === 0,
        served.length ? `served zoom(s) ${served.join(', ')} for a question authored at ${sat.zoom}` : `tried ${offZoom.join(', ')}`);

  check('tile proxy: still serves the authored zoom', await status(sat.zoom) === 200, `zoom ${sat.zoom}`);
  check('tile proxy: rejects a non-numeric offset', await status(sat.zoom, 'abc', 0) === 400);
  check('tile proxy: rejects an out-of-range offset', await status(sat.zoom, 9, 0) === 400);
  check('tile proxy: rejects an unknown token',
        (await fetch(`${base}/map/sat/deadbeefdeadbeef/${sat.zoom}/0/0`)).status === 404);

  host.close(); bot.close();
}

// ── 2. Admin auth and the question bank ──────────────────────────────────────
async function testAdmin(base) {
  const login = (pw) => fetch(`${base}/admin-auth`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pw }),
  });

  check('admin API is closed without a session', (await fetch(`${base}/admin/questions`)).status === 401);

  // The cookie used to BE the password; make sure that shape is dead.
  check('a cookie containing the password is not a session',
        (await fetch(`${base}/admin/questions`, { headers: { Cookie: `adminAuth=${PASSWORD}` } })).status === 401);

  check('wrong password is refused', (await login('not-it')).status === 401);

  // Deliberately a non-default password: admin.html used to compare the cookie
  // against a hard-coded default, so setting ADMIN_PASSWORD broke the editor.
  const res = await login(PASSWORD);
  const setCookie = res.headers.get('set-cookie') || '';
  const sid = (setCookie.match(/adminAuth=([^;]+)/) || [])[1];
  check('the configured password logs in', res.status === 200 && !!sid, `status ${res.status}`);
  check('the session cookie is not the password', sid !== PASSWORD && (sid || '').length >= 40);
  check('the session cookie is HttpOnly', /HttpOnly/i.test(setCookie));

  const auth = { Cookie: `adminAuth=${sid}` };
  const listRes = await fetch(`${base}/admin/questions`, { headers: auth });
  const all = listRes.ok ? await listRes.json() : [];
  check('a session can read the question list', listRes.ok && all.length > 0, `${all.length} questions`);

  // POST is a whole-table replace, so an empty array is a one-request wipe.
  const wipe = await fetch(`${base}/admin/questions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '[]' });
  check('an empty save (wipe) is refused', wipe.status === 409, `status ${wipe.status}`);
  check('…and nothing was deleted', (await (await fetch(`${base}/admin/questions`, { headers: auth })).json()).length === all.length);

  const save = await fetch(`${base}/admin/questions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(all) });
  const saved = await save.json().catch(() => ({}));
  check('a normal full save still works', save.ok && saved.count === all.length, `status ${save.status}, count ${saved.count}`);

  // import.js parity: a category is declared with one type, and a row whose type
  // disagrees plays a different mechanic than its intro promises.
  const mismatched = all.map((q, i) => (i === 0 ? { ...q, category: q.category === 'trivia' ? 'birdseye' : 'trivia' } : q));
  check('a type/category mismatch is rejected',
        (await fetch(`${base}/admin/questions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(mismatched) })).status === 400);

  await fetch(`${base}/admin-logout`, { headers: auth, redirect: 'manual' });
  check('logout kills the session server-side', (await fetch(`${base}/admin/questions`, { headers: auth })).status === 401);

  let throttled = false;
  for (let i = 0; i < 15 && !throttled; i++) throttled = (await login(`guess-${i}`)).status === 429;
  check('password guessing gets throttled', throttled);

  const big = await fetch(`${base}/api/games`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(300000) }) });
  check('a large anonymous body is not parsed', big.status === 413 || big.status === 404, `status ${big.status}`);
}

// ── 3. Static exposure ───────────────────────────────────────────────────────
// data/ and quiz.db hold the answers; one served file would defeat every geo
// question at once.
async function testStatic(base) {
  // Only public/ is served. Note /games/<type>.js IS served and should be — that
  // path resolves to public/games/<type>.js, the browser module. The server-side
  // module of the same name lives at the repo root and must not be; games/_shared.js
  // has no public counterpart, so it is the unambiguous probe for that directory.
  const mustNotBeServed = [
    '/quiz.db', '/quiz.db-wal',
    '/data/borders.json', '/data/cities.json', '/data/halves/EGY.json',
    '/content/fakes-2.json',
    '/games/_shared.js', '/server.js', '/db.js', '/scoring.js', '/import.js',
    '/package.json', '/.git/config', '/CLAUDE.md',
  ];
  for (const p of mustNotBeServed) {
    const status = (await fetch(base + p)).status;
    check(`not served over HTTP: ${p}`, status === 404, status === 404 ? '' : `status ${status}`);
  }
}

(async () => {
  const port = await start(0);
  const base = `http://localhost:${port}`;
  try {
    await testTileProxy(base, port);
    await testAdmin(base);
    await testStatic(base);
  } catch (e) {
    check('suite ran to completion', false, e.message);
  }
  console.table(results);
  cleanup();
  if (failures) { console.error(`\n❌ security: ${failures} check(s) failed`); process.exit(1); }
  console.log('\n✅ security: all checks passed');
  process.exit(0);
})().catch(e => { console.error('❌', e); cleanup(); process.exit(1); });
