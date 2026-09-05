// ─────────────────────────────────────────────────────────────────────────────
// games/compass.js — "Compass": point the needle from city A towards city B.
//
// The answer is the INITIAL great-circle bearing (0° = north, clockwise). This
// is surprisingly hard: on a globe the shortest path from London to Tokyo starts
// out heading north-east, not east, because great circles curve towards the pole.
//
// Data: data/cities.json (built by tools/build-compass.js) is only used to fill in
// missing coordinates when a question references a city by id; the question
// JSON normally carries full from/to objects so the module works without it.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const { validateCommon, clamp, haversineKm, bearingDeg } = require('./_shared');

// ── Static data (loaded once at require time) ─────────────────────────────────
let CITIES = {};
try { CITIES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cities.json'), 'utf8')); }
catch (e) { CITIES = {}; }   // the module still works — questions carry their own coordinates

// ── Compass maths ─────────────────────────────────────────────────────────────
const POINTS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const LONG_NAMES = {
  N: 'north', NNE: 'north-north-east', NE: 'north-east', ENE: 'east-north-east', E: 'east', ESE: 'east-south-east',
  SE: 'south-east', SSE: 'south-south-east', S: 'south', SSW: 'south-south-west', SW: 'south-west', WSW: 'west-south-west',
  W: 'west', WNW: 'west-north-west', NW: 'north-west', NNW: 'north-north-west',
};

function normalize(deg) { return ((deg % 360) + 360) % 360; }            // → [0, 360)
function compassPoint(deg) { return POINTS16[Math.round(normalize(deg) / 22.5) % 16]; }
function compassName(deg)  { return LONG_NAMES[compassPoint(deg)]; }
// Smallest angle between two bearings, always 0–180.
function angularError(a, b) { const d = Math.abs(normalize(a) - normalize(b)); return Math.min(d, 360 - d); }

// Perfect within 4°, then a straight line down to 0 at 90° off (or worse).
const PERFECT_DEG = 4, ZERO_DEG = 90;
function bearingQuality(err) {
  if (err <= PERFECT_DEG) return 1;
  return clamp(1 - (err - PERFECT_DEG) / (ZERO_DEG - PERFECT_DEG), 0, 1);
}

// A city can be given as { id } only — fill name/lat/lng from data/cities.json.
function resolveCity(c) {
  if (!c || typeof c !== 'object') return null;
  const base = c.id && CITIES[c.id] ? CITIES[c.id] : {};
  const out = { id: c.id, name: c.name ?? base.name, lat: c.lat ?? base.lat, lng: c.lng ?? base.lng };
  if (typeof out.name !== 'string' || !out.name.trim()) return null;
  if (typeof out.lat !== 'number' || typeof out.lng !== 'number' || Number.isNaN(out.lat) || Number.isNaN(out.lng)) return null;
  if (out.lat < -90 || out.lat > 90 || out.lng < -180 || out.lng > 180) return null;
  return out;
}
const publicCity = c => ({ name: c.name, lat: c.lat, lng: c.lng });
const trueBearingOf = q => Math.round(bearingDeg(q.from.lat, q.from.lng, q.to.lat, q.to.lng) * 10) / 10;

// ── Difficulty tiers ────────────────────────────────────────────────────────
// How much of the "from" city the payload gives away, driven by the host's
// difficulty pick (game.setup.difficulty). The truth and the scoring never
// change — evaluate()/reveal() read q.from/q.to straight off the stored
// question, never off the payload — only what the player sees before they
// aim the needle changes.
//
//   casual  → today's coordinates (so the locator map can be drawn) PLUS a
//             distanceKm hint ("about 1,200 km away").
//   mixed   → today's coordinates, no distance hint. This was the only
//             behaviour before difficulty tiers existed.
//   expert  → no coordinates at all for the "from" city (just its name) — no
//             locator map, no distance. The player has to know where BOTH
//             cities are, not just aim from a map pin.
// 'normal' exists in the type system (§2 of ARCHITECTURE.md) but is not
// offered on the config screen; it is treated the same as 'mixed'.
function tierFor(game) {
  const d = game && game.setup && game.setup.difficulty;
  if (d === 'casual') return 'casual';
  if (d === 'expert') return 'expert';
  return 'mixed';
}

module.exports = {
  type: 'compass',
  categories: [
    { id: 'compass', label: 'Compass', emoji: '🧭', group: 'draw', order: 40,
      blurb: 'Which way is Tokyo from here? Point the needle.',
      howTo:  'Rotate the needle to point from the first city towards the second (great-circle direction), then lock in.' },
  ],
  timeLimit: 20,
  revealPause: 9,
  earlyPause: 4000,
  speedScored: false,
  usesRegion: true,

  // ── Validation (import.js / admin) ─────────────────────────────────────────
  validate(q) {
    const errors = validateCommon(q);
    const from = resolveCity(q.from), to = resolveCity(q.to);
    if (!from) errors.push('"from" must be { name, lat, lng } (or { id } of a city in data/cities.json)');
    if (!to)   errors.push('"to" must be { name, lat, lng } (or { id } of a city in data/cities.json)');
    if (from && to) {
      const km = haversineKm(from.lat, from.lng, to.lat, to.lng);
      if (km < 50)    errors.push(`"from" and "to" are only ${Math.round(km)} km apart — bearing is meaningless`);
      if (km > 18500) errors.push(`"from" and "to" are ${Math.round(km)} km apart — near-antipodal, bearing is ill-defined`);
    }
    return errors;
  },

  // ── DB serialisation ───────────────────────────────────────────────────────
  // Coordinates are stored in full so the DB never depends on data/cities.json.
  toRow(q) {
    const from = resolveCity(q.from), to = resolveCity(q.to);
    const strip = c => { const o = { name: c.name, lat: c.lat, lng: c.lng }; if (c.id) o.id = c.id; return o; };
    return { correct: null, extra: { from: strip(from), to: strip(to) } };
  },
  fromRow(row, extra) {
    return { from: resolveCity(extra.from) || extra.from, to: resolveCity(extra.to) || extra.to };
  },

  // ── What every client receives when the question starts ────────────────────
  // The target's position is always the secret. Whether the FROM city's
  // coordinates (and a distance hint) are included depends on the difficulty
  // tier — see tierFor() above and docs/games/compass.md §"Difficulty tiers".
  payload(q, game) {
    const tier = tierFor(game);
    const out = {
      question: q.question,
      from: tier === 'expert' ? { name: q.from.name } : publicCity(q.from),
      to: { name: q.to.name },
      tier,
    };
    if (tier === 'casual') out.distanceKm = Math.round(haversineKm(q.from.lat, q.from.lng, q.to.lat, q.to.lng));
    return out;
  },

  // ── Judge one answer: { bearing } in degrees ───────────────────────────────
  evaluate(q, answer) {
    const raw = answer && typeof answer === 'object' ? Number(answer.bearing) : NaN;
    if (!Number.isFinite(raw)) return null;
    const bearing     = Math.round(normalize(raw) * 10) / 10;
    const trueBearing = trueBearingOf(q);
    const err         = Math.round(angularError(bearing, trueBearing) * 10) / 10;
    const quality     = bearingQuality(err);
    const distanceKm  = Math.round(haversineKm(q.from.lat, q.from.lng, q.to.lat, q.to.lng));
    return {
      quality,
      detail: { bearing, err },
      result: {
        trueBearing, yourBearing: bearing, err, distanceKm,
        trueName: compassPoint(trueBearing), yourName: compassPoint(bearing),
        from: publicCity(q.from), to: publicCity(q.to),
        score: Math.round(quality * 100),
      },
    };
  },

  // ── Leaderboard reveal (everyone) ──────────────────────────────────────────
  reveal(q, answers) {
    const trueBearing = trueBearingOf(q);
    return {
      from: publicCity(q.from), to: publicCity(q.to),
      trueBearing, trueName: compassPoint(trueBearing),
      distanceKm: Math.round(haversineKm(q.from.lat, q.from.lng, q.to.lat, q.to.lng)),
      arrows: answers.map(a => ({ nickname: a.nickname, bearing: a.detail.bearing, err: a.detail.err })),
    };
  },

  correctText(q) {
    const b = trueBearingOf(q);
    return `${q.to.name} is ${Math.round(b)}° (${compassName(b)}) from ${q.from.name}`;
  },

  sampleAnswer() { return { bearing: Math.random() * 360 }; },

  // exported for tests / other tools
  _compassPoint: compassPoint,
  _angularError: angularError,
  _bearingQuality: bearingQuality,
};
