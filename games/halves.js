// ─────────────────────────────────────────────────────────────────────────────
// games/halves.js — "Population Split": a straight line lies across a country;
// move and rotate it until HALF the population is on each side.
//
// Area and population look nothing alike: 95 % of Egypt lives on 5 % of its
// land, a third of Argentina lives around Buenos Aires, and half of Australia
// fits into a thin strip along the south-east coast. That is the fun.
//
// Data: data/halves/<ISO3>.json (built by tools/build-halves.js) holds a coarse
// population grid per country (≤ 160 × 160 cells, WorldPop 2020) plus the
// country outline. The grid is the secret — the client only ever gets the
// outline. After the round a low-resolution "heat" version of the grid is
// revealed so everyone can see where the people actually are.
//
// The answer is two points { a:[lng,lat], b:[lng,lat] } defining an infinite
// line. Side "A" is the LEFT side when walking from a to b. Quality is 1 for a
// perfect 50/50, 0.5 for 70/30 and 0 for 90/10 or worse.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const { validateCommon, clamp, haversineKm } = require('./_shared');

const DATA_DIR = path.join(__dirname, '..', 'data', 'halves');
const HEAT_MAX = 64;   // heat grid side (cells) revealed after the round
const RAD      = Math.PI / 180;

// ── Static data (loaded once at require time) ─────────────────────────────────
const COUNTRIES = {};
let INDEX = [];
try { INDEX = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8')); } catch (e) { INDEX = []; }
for (const entry of INDEX) {
  try { COUNTRIES[entry.id] = prepare(JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${entry.id}.json`), 'utf8'))); }
  catch (e) { console.warn(`halves: could not load data/halves/${entry.id}.json — ${e.message}`); }
}

// Pre-compute everything evaluate() needs so a round costs a few milliseconds:
//  • the centre of every populated cell in "scaled" coordinates (see below)
//  • the low-resolution heat grid for the reveal
function prepare(c) {
  const [minLng, minLat, maxLng, maxLat] = c.bbox;
  const cellW = (maxLng - minLng) / c.cols, cellH = (maxLat - minLat) / c.rows;
  const midLat = (minLat + maxLat) / 2;
  // Longitude degrees shrink towards the poles: multiply lng by cos(midLat) so
  // that one unit is roughly the same distance in both directions.
  const cos = Math.cos(midLat * RAD);

  let n = 0;
  for (let i = 0; i < c.pop.length; i++) if (c.pop[i] > 0) n++;
  const cx = new Float64Array(n), cy = new Float64Array(n), w = new Float64Array(n);
  let k = 0, total = 0;
  for (let r = 0; r < c.rows; r++) {
    for (let col = 0; col < c.cols; col++) {
      const p = c.pop[r * c.cols + col];
      if (p <= 0) continue;
      cx[k] = (minLng + (col + 0.5) * cellW) * cos;
      cy[k] = maxLat - (r + 0.5) * cellH;
      w[k]  = p; total += p; k++;
    }
  }

  // Heat grid: sum blocks of hf × hf cells, then scale 0–255 by square root so
  // that cities pop out without drowning everything else.
  const hf = Math.ceil(Math.max(c.cols, c.rows) / HEAT_MAX);
  const hcols = Math.ceil(c.cols / hf), hrows = Math.ceil(c.rows / hf);
  const sums = new Float64Array(hcols * hrows);
  for (let r = 0; r < c.rows; r++) for (let col = 0; col < c.cols; col++)
    sums[Math.floor(r / hf) * hcols + Math.floor(col / hf)] += c.pop[r * c.cols + col];
  let max = 0; for (const v of sums) if (v > max) max = v;
  const values = Array.from(sums, v => max ? Math.round(255 * Math.sqrt(v / max)) : 0);
  const heat = { cols: hcols, rows: hrows, values, bbox: [minLng, +(maxLat - hrows * hf * cellH).toFixed(4), +(minLng + hcols * hf * cellW).toFixed(4), maxLat] };

  // Population hubs for the casual tier: the centres of the densest heat cells,
  // translated back into lat/lng. `sums` (pre-sqrt) sorts the same way `values`
  // would since the sqrt scaling is monotonic, so we can rank on it directly.
  // A candidate is skipped if it lands within HUB_MIN_KM of the capital or of a
  // hub already picked — otherwise one sprawling city (many dense cells side by
  // side) would hand out three markers stacked on top of each other instead of
  // three markers that actually spread the player's attention around the map.
  const HUB_MIN_KM = 80, HUB_COUNT = 3;
  const cellCandidates = [];
  for (let r = 0; r < hrows; r++) {
    for (let col = 0; col < hcols; col++) {
      const v = sums[r * hcols + col];
      if (v > 0) cellCandidates.push({ v, lat: maxLat - (r + 0.5) * hf * cellH, lng: minLng + (col + 0.5) * hf * cellW });
    }
  }
  cellCandidates.sort((a, b) => b.v - a.v);
  const hubs = [];
  for (const cand of cellCandidates) {
    if (hubs.length >= HUB_COUNT) break;
    const tooCloseToCapital = c.capital && haversineKm(c.capital.lat, c.capital.lng, cand.lat, cand.lng) < HUB_MIN_KM;
    const tooCloseToHub = hubs.some(h => haversineKm(h.lat, h.lng, cand.lat, cand.lng) < HUB_MIN_KM);
    if (!tooCloseToCapital && !tooCloseToHub) hubs.push({ lat: +cand.lat.toFixed(4), lng: +cand.lng.toFixed(4) });
  }

  return { ...c, total, cos, cx, cy, w, heat, hubs, cellWs: cellW * cos, cellH };
}

// ── Line maths ────────────────────────────────────────────────────────────────
// Turn the answer into a unit direction + unit normal in scaled coordinates.
// Returns null when the two points are (almost) the same.
function lineFrame(c, a, b) {
  const ax = a[0] * c.cos, ay = a[1], bx = b[0] * c.cos, by = b[1];
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) return null;
  // Normal points to the LEFT of the direction a → b
  return { ax, ay, dx: dx / len, dy: dy / len, nx: -dy / len, ny: dx / len };
}

// Where does the infinite line a→b (lng/lat) cross the rectangle? Liang–Barsky.
// Returns two points, or the original points if the line misses the rectangle.
function clipLineToRect(a, b, [x0, y0, x1, y1]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = -Infinity, t1 = Infinity;
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
    if (p === 0) { if (q < 0) return [a, b]; continue; }
    const t = q / p;
    if (p < 0) { if (t > t0) t0 = t; } else { if (t < t1) t1 = t; }
  }
  if (t0 >= t1 || !Number.isFinite(t0) || !Number.isFinite(t1)) return [a, b];
  const r4 = v => +v.toFixed(4);
  return [[r4(a[0] + t0 * dx), r4(a[1] + t0 * dy)], [r4(a[0] + t1 * dx), r4(a[1] + t1 * dy)]];
}

// The bbox grown by 15 % on every side — the ideal line is drawn across this.
function drawRect(c) {
  const [x0, y0, x1, y1] = c.bbox, px = (x1 - x0) * 0.15, py = (y1 - y0) * 0.15;
  return [x0 - px, y0 - py, x1 + px, y1 + py];
}

// The core: population on each side of the line, plus the "ideal" parallel line.
//
// Each cell is treated as a thin slab of thickness `cs` (its width measured
// across the line): a cell far from the line counts fully for one side, a cell
// the line passes through is split in proportion to how far across it the line
// runs. This makes the score change smoothly as the player nudges the line
// instead of jumping whenever a dense city cell flips sides.
function split(c, a, b) {
  const f = lineFrame(c, a, b);
  if (!f) return null;
  const n = c.w.length;
  const cs = Math.abs(f.nx) * c.cellWs + Math.abs(f.ny) * c.cellH;   // slab thickness across the line
  const s  = new Float64Array(n);                                    // signed offset of each cell centre
  let sMin = Infinity, sMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = (c.cx[i] - f.ax) * f.nx + (c.cy[i] - f.ay) * f.ny;
    s[i] = d;
    if (d < sMin) sMin = d;
    if (d > sMax) sMax = d;
  }
  // Population on side A (left of a→b) if the line were shifted by t along the normal
  const popAAt = t => {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const u = (s[i] - t) / cs + 0.5;                 // 0 = fully on side B … 1 = fully on side A
      sum += c.w[i] * (u <= 0 ? 0 : u >= 1 ? 1 : u);
    }
    return sum;
  };
  const popA = popAAt(0), popB = c.total - popA;

  // Ideal line with the same direction: binary-search the sideways shift t until
  // side A holds exactly half. popAAt(t) decreases monotonically as t grows.
  const half = c.total / 2;
  let lo = sMin - cs, hi = sMax + cs;
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    if (popAAt(mid) > half) lo = mid; else hi = mid;
  }
  const t = (lo + hi) / 2;
  // Shift a and b by t along the normal (scaled coords), then unscale longitude
  const ia = [(f.ax + t * f.nx) / c.cos, f.ay + t * f.ny];
  const ib = [(f.ax + f.dx + t * f.nx) / c.cos, f.ay + f.dy + t * f.ny];
  const [idealA, idealB] = clipLineToRect(ia, ib, drawRect(c));

  const pctA = c.total ? popA / c.total * 100 : 0;
  return {
    popA: Math.round(popA), popB: Math.round(popB), pctA: +pctA.toFixed(1), pctB: +(100 - pctA).toFixed(1),
    imbalance: c.total ? Math.abs(popA - popB) / c.total : 1,
    ideal: { a: idealA, b: idealB },
    shiftKm: Math.abs(t) * 111.32,    // how far the ideal line is from the player's (for tools / docs)
  };
}

function imbalanceQuality(imbalance) { return clamp(1 - imbalance / 0.8, 0, 1); }

// ── Difficulty tiers ────────────────────────────────────────────────────────
// How much of the population pattern the payload gives away before the player
// draws, driven by the host's difficulty pick (game.setup.difficulty). The
// truth and the scoring never change — evaluate()/reveal() always work from
// the real population grid — only what the player sees beforehand changes.
//
//   casual  → capital marker + up to 3 unlabelled "population hub" dots (the
//             centres of the densest cells of the heat grid, spread apart —
//             see prepare() above), so the player can reason about several
//             population centres at once, not just the capital.
//   mixed   → capital marker only (this was the only behaviour before tiers
//             existed, so it stays the default).
//   expert  → outline only. No capital, no hubs — the player has to know
//             where a country's people actually live from memory.
// 'normal' exists in the type system (§2 of ARCHITECTURE.md) but is not
// offered on the config screen; it is treated the same as 'mixed'.
function tierFor(game) {
  const d = game && game.setup && game.setup.difficulty;
  if (d === 'casual') return 'casual';
  if (d === 'expert') return 'expert';
  return 'mixed';
}

// Answer sanitising: two distinct [lng, lat] points with finite numbers.
function readPoint(p) {
  if (!Array.isArray(p) || p.length < 2) return null;
  const lng = Number(p[0]), lat = Number(p[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 360 || Math.abs(lat) > 90) return null;
  return [+lng.toFixed(4), +lat.toFixed(4)];
}

const publicShape = c => ({ regionId: c.id, name: c.name, bbox: c.bbox, outline: c.outline, total: c.total, capital: c.capital });

module.exports = {
  type: 'halves',
  categories: [
    { id: 'halves', label: 'Population Split', emoji: '🧮', group: 'draw', order: 30,
      blurb: 'Slice a country so half its people are on each side.',
      howTo:  "Drag the line's ends to move and rotate it until the population is split 50/50, then lock in." },
  ],
  timeLimit: 40,
  revealPause: 12,
  earlyPause: 5000,
  speedScored: false,
  usesRegion: true,

  // ── Validation (import.js / admin) ─────────────────────────────────────────
  validate(q) {
    const errors = validateCommon(q);
    if (typeof q.regionId !== 'string' || !q.regionId.trim()) errors.push('"regionId" must be an ISO3 code like "EGY"');
    else if (!INDEX.length) errors.push('data/halves/index.json is missing — run node tools/build-halves.js');
    else if (!COUNTRIES[q.regionId]) errors.push(`"regionId" ${q.regionId} has no data/halves/${q.regionId}.json`);
    // A grid that exists but sums to zero collapses split()'s binary search to
    // NaN, and those NaN coordinates end up in the reveal broadcast to everyone.
    // Catch it at import time rather than mid-game.
    else if (!(COUNTRIES[q.regionId].total > 0)) errors.push(`data/halves/${q.regionId}.json has an empty population grid — re-run node tools/build-halves.js`);
    return errors;
  },

  // ── DB serialisation ───────────────────────────────────────────────────────
  toRow(q)            { return { correct: null, extra: { regionId: q.regionId } }; },
  fromRow(row, extra) { return { regionId: extra.regionId }; },

  // ── What every client receives when the question starts ────────────────────
  // Shape always; capital and hubs depend on the tier — see tierFor() above.
  // NEVER the population grid itself, at any tier.
  payload(q, game) {
    const c = COUNTRIES[q.regionId];
    if (!c) throw new Error(`no halves data for ${q.regionId}`);
    const tier = tierFor(game);
    const out = { question: q.question, ...publicShape(c), tier };
    if (tier === 'expert') {
      out.capital = null;               // draw the whole thing from memory
    } else if (tier === 'casual') {
      out.hubs = c.hubs;                // capital already included via publicShape()
    }
    return out;
  },

  // ── Judge one answer: { a:[lng,lat], b:[lng,lat] } ─────────────────────────
  evaluate(q, answer) {
    const c = COUNTRIES[q.regionId];
    if (!c || !answer || typeof answer !== 'object') return null;
    const a = readPoint(answer.a), b = readPoint(answer.b);
    if (!a || !b) return null;
    const s = split(c, a, b);
    if (!s) return null;   // both points identical → no line
    const quality = imbalanceQuality(s.imbalance);
    return {
      quality,
      detail: { a, b, pctA: s.pctA, pctB: s.pctB, popA: s.popA, popB: s.popB, imbalance: +s.imbalance.toFixed(4) },
      result: {
        pctA: s.pctA, pctB: s.pctB, popA: s.popA, popB: s.popB,
        ideal: s.ideal, total: c.total, score: Math.round(quality * 100),
        name: c.name, bbox: c.bbox, outline: c.outline, yourLine: { a, b },
      },
    };
  },

  // ── Leaderboard reveal (everyone) — now the heat map may be shown ──────────
  reveal(q, answers) {
    const c = COUNTRIES[q.regionId];
    if (!c) return null;
    return {
      ...publicShape(c),
      heat: c.heat,
      lines: answers.map(a => {
        const d = a.detail || {};
        const s = d.a && d.b ? split(c, d.a, d.b) : null;
        return { nickname: a.nickname, a: d.a, b: d.b, pctA: d.pctA, pctB: d.pctB, ideal: s ? s.ideal : null };
      }),
    };
  },

  correctText() { return 'Where the people are: 50 / 50 split'; },

  // A random line through a random interior point of the bbox.
  sampleAnswer(p) {
    const [x0, y0, x1, y1] = p.bbox, w = x1 - x0, h = y1 - y0;
    const px = x0 + w * (0.2 + Math.random() * 0.6), py = y0 + h * (0.2 + Math.random() * 0.6);
    const ang = Math.random() * Math.PI, dx = Math.cos(ang) * w / 4, dy = Math.sin(ang) * h / 4;
    return { a: [px - dx, py - dy], b: [px + dx, py + dy] };
  },

  // exported for tools / tests
  _country: id => COUNTRIES[id] || null,
  _ids: () => Object.keys(COUNTRIES),
  _split: split,
  _quality: imbalanceQuality,
  _haversineKm: haversineKm,
};
