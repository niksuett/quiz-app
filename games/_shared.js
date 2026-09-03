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
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
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

// Evaluate an MC answer. answer = { index }. Returns the contract object.
function evaluateMC(q, answer) {
  const index = answer && Number.isInteger(answer.index) ? answer.index : -1;
  if (index < 0 || index > 3) return null;
  const isCorrect = index === q.correct;
  return {
    quality: isCorrect ? 1 : null,
    detail:  { isCorrect, index, answerText: q.answers[index] },
    result:  {
      isCorrect,
      correctIndex: q.correct,
      correctText:  q.answers[q.correct],
      yourText:     q.answers[index],
    },
  };
}

// Reveal for MC types: how many players picked each option.
function revealMC(q, answers) {
  const counts = [0, 0, 0, 0];
  const pickedBy = [[], [], [], []];
  for (const a of answers) {
    const i = a.detail && a.detail.index;
    if (Number.isInteger(i) && i >= 0 && i < 4) { counts[i]++; pickedBy[i].push(a.nickname); }
  }
  return { answers: q.answers, correctIndex: q.correct, counts, pickedBy };
}

module.exports = { shuffle, clamp, haversineKm, bearingDeg, formatYear, REGIONS, validateMC, validateCommon, evaluateMC, revealMC };
