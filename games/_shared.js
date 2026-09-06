// ─────────────────────────────────────────────────────────────────────────────
// games/_shared.js — small helpers shared by the server-side game modules.
// Files starting with "_" are ignored by the registry (they are not game types).
// ─────────────────────────────────────────────────────────────────────────────

// Fisher-Yates shuffle — returns a new array, never mutates the input.
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Great-circle distance in kilometres between two lat/lng points.
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  // Clamped to [0,1]: for near-antipodal points floating-point cancellation can
  // push `a` a hair above 1, and sqrt of a negative then makes the whole distance
  // NaN. haversineKm(-58, 0, 58, 179.99999999999943) used to do exactly that.
  const a = clamp(Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2, 0, 1);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Initial great-circle bearing (degrees, 0 = north, clockwise) from point 1 to point 2.
function bearingDeg(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Format a year: negative = BCE, 1–999 = "X CE", 1000+ = plain.
function formatYear(y) {
  const n = Math.round(y);
  if (n < 0)    return `${Math.abs(n)} BCE`;
  if (n < 1000) return `${n} CE`;
  return String(n);
}

// ── Multiple-choice helpers (used by mc, flag, silhouette, tune) ──────────────
const REGIONS = ['europe', 'asia', 'africa', 'north-america', 'south-america', 'oceania'];

function validateMC(q) {
  const errors = [];
  if (!Array.isArray(q.answers) || q.answers.length !== 4 || q.answers.some(a => typeof a !== 'string' || !a.trim()))
    errors.push('"answers" must be an array of exactly 4 non-empty strings');
  if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3)
    errors.push('"correct" must be an integer 0–3');
  return errors;
}

function validateCommon(q) {
  const errors = [];
  if (q.region !== undefined && !REGIONS.includes(q.region)) errors.push(`invalid region "${q.region}"`);
  if (q.difficulty !== undefined && ![1, 2, 3].includes(q.difficulty)) errors.push('difficulty must be 1, 2 or 3');
  return errors;
}

// ── Seeded shuffle ────────────────────────────────────────────────────────────
// FNV-1a string hash → 32-bit seed, then mulberry32 for a tiny deterministic
// random generator. Same seed in → same order out, every time. Used wherever a
// question's items must be shown in a random order that every client — and a
// reconnecting client — sees identically, without storing per-game state.
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// mulberry32: a deterministic 0..1 generator. Anything derived from it can be
// recomputed identically in payload(), evaluate() and reveal() without storing
// per-game state — which is what lets a reconnecting player see the same thing.
function seededRandom(seed) {
  let t = seed;
  return () => {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function seededOrder(n, seed) {
  const rnd = seededRandom(seed);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return order;
}

// The order in which the four options are SHOWN in this game: order[displayed]
// = stored index. Seeded by game id + question id so that every player, and a
// player who reconnects mid-question, gets the same buttons in the same places,
// while the same question is laid out differently in the next game — nobody
// can learn "the answer is always the second button". Without a game (dev
// harness, unit tests) the stored order is kept.
function mcOrder(q, game) {
  if (!game || !game.id) return [0, 1, 2, 3];
  return seededOrder(4, hashString(`${game.id}:${q.id !== undefined ? q.id : q.question}`));
}
// The answers as the players see them.
function mcAnswers(q, game) { return mcOrder(q, game).map(i => q.answers[i]); }

// Evaluate an MC answer. answer = { index } is the DISPLAYED position (0–3).
// Everything sent back to the client is in displayed positions too, so the
// module can highlight buttons without knowing about the shuffle.
function evaluateMC(q, answer, game) {
  const index = answer && Number.isInteger(answer.index) ? answer.index : -1;
  if (index < 0 || index > 3) return null;
  const order     = mcOrder(q, game);
  const stored    = order[index];
  const isCorrect = stored === q.correct;
  return {
    quality: isCorrect ? 1 : null,
    detail:  { isCorrect, index, answerText: q.answers[stored] },
    result:  {
      isCorrect,
      correctIndex: order.indexOf(q.correct),
      correctText:  q.answers[q.correct],
      yourText:     q.answers[stored],
    },
  };
}

// Reveal for MC types: how many players picked each (displayed) option.
function revealMC(q, answers, game) {
  const order  = mcOrder(q, game);
  const counts = [0, 0, 0, 0];
  const pickedBy = [[], [], [], []];
  for (const a of answers) {
    const i = a.detail && a.detail.index;
    if (Number.isInteger(i) && i >= 0 && i < 4) { counts[i]++; pickedBy[i].push(a.nickname); }
  }
  return { answers: order.map(i => q.answers[i]), correctIndex: order.indexOf(q.correct), counts, pickedBy };
}

module.exports = { shuffle, clamp, haversineKm, bearingDeg, formatYear, REGIONS, validateMC, validateCommon, hashString, seededRandom, seededOrder, mcOrder, mcAnswers, evaluateMC, revealMC };
