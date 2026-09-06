// ─────────────────────────────────────────────────────────────────────────────
// games/trace.js — "draw a line on a blank map". Two categories:
//
//   borders  🖊️  Border Draw — two neighbouring countries are shown as ONE filled
//                blob (the border between them is missing) and the player draws
//                where they think the border runs.
//   rivers   🌊  River Run   — a coastline map with two markers (mouth + source);
//                the player traces the river's course between them.
//
// Both work the same way once an answer arrives: we compare the player's polyline
// with the true polyline and turn the average distance between them into a score.
//
// The geometry lives in two files built by tools/build-borders.js and
// tools/build-rivers.js. They are read once, when this file is first required.
//
// IMPORTANT: data/borders.json and data/rivers.json contain the answer keys
// (`shapes` / `border` / `path`). They must NOT be reachable through the public
// /data/ static route — see docs/games/trace.md.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const { validateCommon } = require('./_shared');

// ── Load the geometry once at require time ────────────────────────────────────
function loadData(file) {
  const full = path.join(__dirname, '..', 'data', file);
  try { return JSON.parse(fs.readFileSync(full, 'utf8')); }
  catch (err) {
    console.warn(`[trace] could not read data/${file} (${err.code || err.message}) — run its build script in tools/`);
    return {};
  }
}
const BORDERS = loadData('borders.json');
const RIVERS  = loadData('rivers.json');

// ── Tuning ────────────────────────────────────────────────────────────────────
const SAMPLES       = 120;   // both lines are resampled to this many evenly spaced points
const MAX_ANSWER_PTS = 600;  // more than this and we reject the answer as junk
const TOL_MIN_KM    = 20;    // the error tolerance T is never stricter than this…
const TOL_SHARE     = 0.08;  // …otherwise 8 % of the line's length…
const TOL_MAX_KM    = 150;   // …and never looser than this (without the cap a 5 000 km
                             //   border would hand out 80 points for a straight line)
const PERFECT_SHARE = 0.02;  // an error below 2 % of T counts as a perfect trace
const CUTOFF        = 3;     // an error above 3 × T scores nothing at all
const SHORT_SHARE   = 0.25;  // a line covering less than 25 % of the length is penalised…
const SHORT_PENALTY = 0.3;   // …by this factor (stops people scribbling a dot)

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
//
// Everything is measured in a local flat "kilometre" frame instead of on the
// sphere: at the scale of one country the error of that shortcut is far below the
// precision of a finger-drawn line, and it makes the maths (and the code) simple.
// x = degrees of longitude × 111.32 × cos(latitude of the map centre)
// y = degrees of latitude  × 110.57
// ─────────────────────────────────────────────────────────────────────────────
function makeProjection(midLat) {
  const kx = 111.32 * Math.cos(midLat * Math.PI / 180), ky = 110.57;
  return p => [p[0] * kx, p[1] * ky];
}

function segLength(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }

// Distance from point p to the segment a→b (all already in km space).
function pointSegDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
// Distance from point p to the nearest point anywhere on the polyline.
function pointPolyDist(p, poly) {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const d = pointSegDist(p, poly[i - 1], poly[i]);
    if (d < best) best = d;
  }
  return best;
}
// n points spread evenly along the polyline by arc length (first and last kept).
function resample(line, n) {
  if (line.length === 1) return new Array(n).fill(line[0]);
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + segLength(line[i - 1], line[i]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) return new Array(n).fill(line[0]);
  const out = [];
  let seg = 1;
  for (let i = 0; i < n; i++) {
    const target = total * i / (n - 1);
    while (seg < line.length - 1 && cum[seg] < target) seg++;
    const a = line[seg - 1], b = line[seg];
    const spanLen = cum[seg] - cum[seg - 1];
    const t = spanLen > 0 ? (target - cum[seg - 1]) / spanLen : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}
function polylineLength(line) { let s = 0; for (let i = 1; i < line.length; i++) s += segLength(line[i - 1], line[i]); return s; }

// Keep at most `max` points of a line for storage (evenly picked, ends kept).
function thin(line, max) {
  if (line.length <= max) return line;
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(line[Math.round(i * (line.length - 1) / (max - 1))]);
  out.push(line[line.length - 1]);
  return out;
}

// ── Which "thing" does a question point at? ───────────────────────────────────
function subjectOf(q) {
  if (q.category === 'rivers') return RIVERS[q.riverId] || null;
  return BORDERS[q.pairId] || null;
}
function truthLine(q) {
  const s = subjectOf(q);
  if (!s) return null;
  return q.category === 'rivers' ? s.path : s.border;
}

// ── Difficulty tiers ────────────────────────────────────────────────────────
// How much of the answer's shape the payload gives away, driven by the host's
// difficulty pick (game.setup.difficulty). The truth and the scoring never
// change — evaluate()/reveal() read the geometry straight from data/*.json,
// not from the payload — only what the player sees before they draw changes.
//
//   casual          → everything we show today: start/end marks (or mouth +
//                      source), and the lengthKm hint.
//   mixed | normal   → the marks stay (the player still knows where to start
//                      and finish) but the lengthKm hint is dropped.
//   expert           → borders: no start/end marks at all — draw the whole
//                      thing from memory. `closed` (a full-loop border) is a
//                      fact ABOUT the two marks, so with no marks to draw it
//                      would say nothing the player could act on — it is
//                      dropped too, rather than sent unused.
//                      rivers: only the mouth stays (a river has to reach the
//                      sea *somewhere*, so that much is always fair to show);
//                      the source and the length are hidden.
// 'normal' exists in the type system (§2 of ARCHITECTURE.md) but is not
// offered on the config screen; it is treated the same as 'mixed'.
function tierFor(game) {
  const d = game && game.setup && game.setup.difficulty;
  if (d === 'casual') return 'casual';
  if (d === 'expert') return 'expert';
  return 'mixed';
}

// Fun name for the accuracy reached, shown big on the result screen.
function ratingFor(score) {
  if (score >= 90) return 'Master Cartographer';
  if (score >= 75) return 'Chief Surveyor';
  if (score >= 55) return 'Border Guard';
  if (score >= 35) return 'Weekend Hiker';
  if (score >= 15) return 'Lost Tourist';
  return 'Wrong Continent?';
}

module.exports = {
  type: 'trace',
  categories: [
    { id: 'borders', label: 'Border Draw', emoji: '🖊️', group: 'draw', order: 20,
      blurb: 'Two neighbours, one missing border. Draw it.',
      howTo: 'Draw one line where the border runs, then lock in.' },
    { id: 'rivers',  label: 'River Run',   emoji: '🌊', group: 'draw', order: 25,
      blurb: 'Trace a famous river from mouth to source.',
      howTo: "Draw the river's course between the two markers, then lock in." },
  ],
  timeLimit: 45,
  revealPause: 12,
  earlyPause: 5000,
  speedScored: false,
  usesRegion: true,

  // ── Validation (import.js / admin) ──────────────────────────────────────────
  validate(q) {
    const errors = validateCommon(q);
    let subject = null;
    if (q.category === 'rivers') {
      if (typeof q.riverId !== 'string' || !q.riverId) errors.push('"riverId" must be a non-empty string');
      else if (!RIVERS[q.riverId]) errors.push(`unknown riverId "${q.riverId}" — not in data/rivers.json`);
      else subject = RIVERS[q.riverId];
    } else if (q.category === 'borders') {
      if (typeof q.pairId !== 'string' || !q.pairId) errors.push('"pairId" must be a non-empty string');
      else if (!BORDERS[q.pairId]) errors.push(`unknown pairId "${q.pairId}" — not in data/borders.json`);
      else subject = BORDERS[q.pairId];
    } else {
      errors.push(`category "${q.category}" is not handled by the trace module`);
    }
    // evaluate() projects through subject.bbox, so a record that exists but has
    // no bbox throws for every player who answers. Fail at import instead.
    if (subject && !(Array.isArray(subject.bbox) && subject.bbox.length === 4))
      errors.push(`"${q.riverId || q.pairId}" has no usable bbox — re-run its tools/build-*.js`);
    return errors;
  },

  // ── Database serialisation ──────────────────────────────────────────────────
  toRow(q) {
    return { correct: null, extra: q.category === 'rivers' ? { riverId: q.riverId } : { pairId: q.pairId } };
  },
  fromRow(row, extra) {
    return extra.riverId ? { riverId: extra.riverId } : { pairId: extra.pairId };
  },

  // ── What every client receives when the question starts ─────────────────────
  // Contains NO trace of the hidden line. For borders the countries are sent as
  // `blob` — the same rings, but with the shared border flattened to a straight
  // chord — so filling them all in one colour draws the correct silhouette while
  // the border's real shape is nowhere in the payload.
  //
  // `endpoints` / `source` / `lengthKm` are now OPTIONAL — see tierFor() above.
  // The client module must cope with any of them being absent (docs/games/trace.md §3).
  payload(q, game) {
    const s = subjectOf(q);
    if (!s) throw new Error(`trace: no geometry for ${q.pairId || q.riverId}`);
    const tier = tierFor(game);
    if (q.category === 'rivers') {
      const out = {
        mode: 'river',
        question: q.question,
        name: s.name,
        bbox: s.bbox,
        context: s.context,
        mouth: s.mouth,                   // always shown — a river must reach the sea somewhere
        tier,
      };
      if (tier !== 'expert') out.source = s.source;
      if (tier === 'casual') out.lengthKm = s.lengthKm;
      return out;
    }
    const out = {
      mode: 'border',
      question: q.question,
      bbox: s.bbox,
      blob: s.blob,                       // fill these rings in ONE colour
      outline: s.outline,                 // real coast / third-country edges — stroke these
      known: s.known,                     // parts of this border that are given away
      names: { a: s.a.name, b: s.b.name },
      clipped: !!s.clipped,               // the giant neighbour was cropped to the window
      tier,
    };
    if (tier !== 'expert') {
      out.endpoints = s.endpoints;        // where the missing border starts and ends
      out.closed = !!s.closed;            // true = the border is a full loop (Lesotho)
    }
    if (tier === 'casual') out.lengthKm = s.lengthKm;
    return out;
  },

  // ── Score one drawn line ────────────────────────────────────────────────────
  // Two averages, because either one alone can be cheated:
  //   d1  how far each point of the TRUE line is from the player's line  (coverage —
  //       catches a short scribble sitting on top of one corner)
  //   d2  how far each point of the PLAYER's line is from the true line  (precision —
  //       catches someone who scribbles all over the map)
  // The error is the average of the two, in kilometres.
  evaluate(q, answer) {
    const truth = truthLine(q);
    const subject = subjectOf(q);
    if (!truth || truth.length < 2) return null;

    // — defensive parsing: anything odd and the answer is rejected —
    if (!answer || !Array.isArray(answer.line)) return null;
    const raw = answer.line;
    if (raw.length < 2 || raw.length > MAX_ANSWER_PTS) return null;
    const line = [];
    for (const p of raw) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const lng = Number(p[0]), lat = Number(p[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
      const last = line[line.length - 1];
      if (last && last[0] === lng && last[1] === lat) continue;   // drop repeated points
      line.push([lng, lat]);
    }
    if (line.length < 2) return null;

    // — measure —
    const midLat = (subject.bbox[1] + subject.bbox[3]) / 2;
    const project = makeProjection(midLat);
    const truthKm  = truth.map(project);
    const playerKm = line.map(project);

    const truthSamples  = resample(truthKm,  SAMPLES);
    const playerSamples = resample(playerKm, SAMPLES);
    let d1 = 0, d2 = 0;
    for (const p of truthSamples)  d1 += pointPolyDist(p, playerKm);
    for (const p of playerSamples) d2 += pointPolyDist(p, truthKm);
    const errKm = 0.5 * (d1 / SAMPLES + d2 / SAMPLES);

    // — turn the error into a 0…1 quality —
    const lengthKm = subject.lengthKm || polylineLength(truthKm) || 1;
    const T = Math.min(TOL_MAX_KM, Math.max(TOL_MIN_KM, TOL_SHARE * lengthKm));
    let quality;
    if (errKm <= PERFECT_SHARE * T) quality = 1;
    else if (errKm > CUTOFF * T)    quality = 0;
    else quality = Math.exp(-Math.pow(errKm / T, 1.2));
    if (polylineLength(playerKm) < SHORT_SHARE * lengthKm) quality *= SHORT_PENALTY;
    quality = Math.max(0, Math.min(1, quality));

    const score = Math.round(quality * 100);
    const rounded = +errKm.toFixed(1);
    const thinLine = thin(line, 100);
    return {
      quality,
      detail: { errKm: rounded, line: thinLine, score },
      result: {
        score, errKm: rounded, rating: ratingFor(score),
        truth, bbox: subject.bbox, mode: q.category === 'rivers' ? 'river' : 'border',
        // The player's own line goes back to them as well. The browser module
        // keeps the drawn stroke in memory, but that memory is gone after a
        // reconnect (page reload mid-question) — this is what lets it redraw
        // the line on the frozen question screen and on the result screen.
        line: thinLine,
      },
    };
  },

  // ── Leaderboard reveal: the true line plus everybody's attempt ──────────────
  reveal(q, answers) {
    const s = subjectOf(q);
    const isRiver = q.category === 'rivers';
    const base = {
      mode: isRiver ? 'river' : 'border',
      bbox: s ? s.bbox : [-180, -90, 180, 90],
      truth: truthLine(q) || [],
      lines: answers.map(a => ({
        nickname: a.nickname,
        line:  a.detail && a.detail.line  ? a.detail.line  : [],
        score: a.detail && a.detail.score != null ? a.detail.score : 0,
        errKm: a.detail && a.detail.errKm != null ? a.detail.errKm : null,
      })).sort((x, y) => y.score - x.score),
    };
    if (isRiver) return { ...base, name: s ? s.name : '', context: s ? s.context : [], mouth: s && s.mouth, source: s && s.source };
    // For the reveal the two countries may finally be drawn apart — `shapes` are
    // the real rings, border included.
    return { ...base, shapes: s ? s.shapes : { a: [], b: [] }, outline: s ? s.outline : [],
             known: s ? s.known : [], names: s ? { a: s.a.name, b: s.b.name } : { a: '', b: '' } };
  },

  correctText(q) {
    const s = subjectOf(q);
    if (!s) return q.question;
    if (q.category === 'rivers') return s.name.charAt(0).toUpperCase() + s.name.slice(1);
    return `${s.a.name} – ${s.b.name} border`;
  },

  // ── A plausible random answer, used by test/simulate.js ─────────────────────
  // A wobbly line from one marker to the other: what a hurried player would draw.
  // At the expert tier some markers are missing from the payload (see tierFor
  // above): a border with no endpoints falls all the way back to a bbox
  // diagonal below; a river still has its mouth, so it gets a wobbly line from
  // the mouth to a random point in the bbox instead of losing the mouth too.
  sampleAnswer(p) {
    const box  = p.bbox || [-10, -10, 10, 10];
    const isRiver = p.mode === 'river';
    const from = isRiver ? p.mouth : (p.endpoints && p.endpoints[0]);
    let to     = isRiver ? p.source : (p.endpoints && p.endpoints[1]);
    if (isRiver && from && !to) {
      to = [box[0] + Math.random() * (box[2] - box[0]), box[1] + Math.random() * (box[3] - box[1])];
    }
    const jitter = Math.max(0.05, 0.06 * Math.hypot(box[2] - box[0], box[3] - box[1]));
    if (!from || !to) return { line: [[box[0], box[1]], [box[2], box[3]]] };
    const n = 10 + Math.floor(Math.random() * 12);
    const line = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const wobble = i === 0 || i === n - 1 ? 0 : (Math.random() - 0.5) * 2 * jitter;
      line.push([
        from[0] + (to[0] - from[0]) * t + wobble,
        from[1] + (to[1] - from[1]) * t + wobble,
      ]);
    }
    return { line };
  },
};
