// ─────────────────────────────────────────────────────────────────────────────
// games/silhouette.js — "Shape of Nations": a country's outline + 4 names.
//
// Mechanically this is a flag question with a drawing instead of an image:
// the client renders the outline (north is up) and shows four buttons.
// Fastest correct answer scores most (speedScored).
//
// Shapes come from data/countries.json (built by tools/build-countries.js from
// Natural Earth). A question only stores the ISO-3 code; the geometry is looked
// up here at question time and sent to the clients in the payload — WITHOUT the
// country name or code, so nothing in the payload gives the answer away.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const { validateMC, validateCommon, mcAnswers, evaluateMC, revealMC } = require('./_shared');

// ── Load the shape data once, synchronously, when the server starts ──────────
// { FRA: { iso3, iso2, name, region, rings, bbox, centroid, areaKm2 }, … } ≈ 0.7 MB
const DATA_FILE = path.join(__dirname, '..', 'data', 'countries.json');
let COUNTRIES = {};
try {
  COUNTRIES = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  console.warn(`games/silhouette.js: could not read ${DATA_FILE} — run "node tools/build-countries.js" (${e.message})`);
}

const PROMPT = 'Which country is this?';

function shapeFor(q) {
  const c = q && COUNTRIES[q.iso3];
  if (!c) throw new Error(`silhouette: no shape for iso3 "${q && q.iso3}" in data/countries.json`);
  return c;
}

module.exports = {
  type: 'silhouette',
  categories: [
    { id: 'silhouettes', label: 'Shape of Nations', emoji: '🗺️', group: 'classic', order: 30,
      blurb: "A country's outline. Which one is it?",
      howTo:  'Look at the shape (north is up) and tap the country. Fastest correct answer scores most.' },
  ],
  timeLimit: 15,
  revealPause: 7,
  earlyPause: 3000,
  speedScored: true,
  usesRegion: true,

  // ── Validation (import.js / admin) ─────────────────────────────────────────
  validate(q) {
    const errors = [...validateCommon(q), ...validateMC(q)];
    if (typeof q.iso3 !== 'string' || !/^[A-Z]{3}$/.test(q.iso3)) errors.push('"iso3" must be a 3-letter upper-case code (e.g. "FRA")');
    else if (!COUNTRIES[q.iso3]) errors.push(`"iso3" ${q.iso3} is not in data/countries.json`);
    if (!errors.length && Array.isArray(q.answers) && q.answers[q.correct] !== q.question)
      errors.push(`answers[correct] ("${q.answers[q.correct]}") must equal "question" ("${q.question}")`);
    return errors;
  },

  // ── DB (de)serialisation of the type-specific fields ───────────────────────
  toRow(q)            { return { correct: String(q.correct), extra: { answers: q.answers, iso3: q.iso3 } }; },
  fromRow(row, extra) { return { answers: extra.answers, iso3: extra.iso3, correct: parseInt(row.correct, 10) }; },

  // ── What every client gets when the question starts (no name, no code!) ────
  payload(q, game) {
    const c = shapeFor(q);
    return { prompt: PROMPT, rings: c.rings, bbox: c.bbox, answers: mcAnswers(q, game) };   // options shuffled per game
  },

  // ── One player's answer: { index: 0–3 } ────────────────────────────────────
  // evaluateMC returns null for anything that is not an integer 0–3.
  evaluate(q, answer, ctx) {
    const out = evaluateMC(q, answer, ctx && ctx.game);
    if (!out) return null;
    const c = COUNTRIES[q.iso3] || {};
    out.result = { ...out.result, name: c.name || q.question, iso2: c.iso2 || null, rings: c.rings || [], bbox: c.bbox || null };
    return out;
  },

  // ── Leaderboard reveal (everyone) ──────────────────────────────────────────
  reveal(q, answers, game) {
    const c = COUNTRIES[q.iso3] || {};
    return { ...revealMC(q, answers, game), rings: c.rings || [], bbox: c.bbox || null, name: c.name || q.question, iso2: c.iso2 || null };
  },

  correctText(q) { const c = COUNTRIES[q.iso3]; return (c && c.name) || q.answers[q.correct]; },
  sampleAnswer()  { return { index: Math.floor(Math.random() * 4) }; },

  // Exposed for tools / tests (not part of the contract).
  _countries: COUNTRIES,
};
