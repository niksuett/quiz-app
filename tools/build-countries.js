#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// tools/build-countries.js — builds the data for the "Shape of Nations"
// (silhouette) game from Natural Earth.
//
//   node tools/build-countries.js
//
// Produces two files (both committed to git):
//   data/countries.json        one entry per country: simplified outline rings,
//                              bounding box, centroid, area, region, names
//   content/silhouettes.json   the question list for import.js (one question per
//                              recognisable country, 3 same-continent distractors)
//
// The raw Natural Earth file (ne_50m_admin_0_countries.geojson) is downloaded
// once into tools/raw/ (gitignored) by tools/lib/geo.js.
//
// The script is idempotent: it uses a seeded random generator, so running it
// twice produces byte-identical output. Change SEED to get a different shuffle.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const { loadNaturalEarth, regionForCountry } = require('./lib/geo');

const ROOT         = path.join(__dirname, '..');
const DATA_OUT     = path.join(ROOT, 'data', 'countries.json');
const CONTENT_OUT  = path.join(ROOT, 'content', 'silhouettes.json');
const SEED         = 20260903;

// ═════════════════════════════════════════════════════════════════════════════
// 1. CONFIGURATION — which countries, which rings, which names
// ═════════════════════════════════════════════════════════════════════════════

// Natural Earth TYPE values we keep. "Dependency", "Indeterminate" (Antarctica,
// Western Sahara, Palestine, Siachen) and "Lease" are dropped.
const KEEP_TYPES = new Set(['Sovereign country', 'Country', 'Sovereignty', 'Disputed']);

// Entries of a kept TYPE that are really parts of another state (Jersey, Aruba,
// Hong Kong, Falklands …) are dropped when SOVEREIGNT ≠ ADMIN — except these.
const KEEP_DESPITE_SOVEREIGN = new Set(['GRL']);   // Greenland is famous enough

// De-facto states that Natural Earth draws separately but that we fold back into
// the country most people picture: the merged ring becomes one outline.
const MERGE_INTO = { CYP: ['CYN'], SOM: ['SOL'] };

// Rings to drop by hand, on top of the automatic 3 % rule (see keepRings()).
// Each entry is a predicate on the ring's centre [lng, lat].
const DROP_RINGS = {
  NOR: ([, lat]) => lat > 74,        // Svalbard: keeps the mainland big in the frame
  ECU: ([lng])   => lng < -85,       // Galápagos: 1 000 km out at sea, would shrink the mainland
};

// Famous islands that are smaller than 3 % of the mainland but belong to the
// picture people have of the country. Predicate on the ring's centre [lng, lat]
// plus a minimum area so we do not pull in every rock nearby.
const KEEP_RINGS = {
  USA: ([lng, lat], area) => lat < 23 && lng < -150 && area > 1000,          // Hawaii (the big islands)
  FRA: ([lng, lat])       => lng > 8 && lat > 41 && lat < 43.5,              // Corsica
  ESP: ([lng, lat], area) => lng > 1 && lat < 40.5 && area > 500,            // Balearics (Mallorca, Menorca, Ibiza)
  AUS: ([, lat], area)    => lat < -40 && area > 10000,                       // Tasmania
  ARG: ([, lat], area)    => lat < -52 && area > 5000,                        // Argentine Tierra del Fuego
  RUS: ([lng, lat], area) => area > 40000 || (lng > 140 && lat > 45 && area > 30000),  // Novaya Zemlya, Sakhalin
};

// Countries whose shape is defined by many islands: use a lower share threshold
// than MIN_RING_SHARE so the Arctic archipelago / big islands survive.
const RING_SHARE_OVERRIDES = {
  CAN: 0.003,   // ≥ ~30 000 km²: Baffin, Victoria, Ellesmere, Newfoundland, Banks, Devon, … Vancouver Island
};

// Natural Earth CONTINENT is "Seven seas (open ocean)" for island states.
const REGION_OVERRIDES = { MDV: 'asia', MUS: 'africa', SYC: 'africa' };

// Display names where Natural Earth's NAME_EN is too formal or unusual.
const NAME_OVERRIDES = {
  CHN: 'China', CZE: 'Czechia', CIV: 'Ivory Coast', COD: 'DR Congo', COG: 'Republic of the Congo',
  GMB: 'Gambia', BHS: 'Bahamas', USA: 'United States', TLS: 'Timor-Leste', FSM: 'Micronesia',
};

// Point budget per country after simplification.
const MAX_POINTS       = 350;
const MAX_POINTS_LARGE = 600;   // giants (> 2 M km²) and many-ring countries above LARGE_AREA_KM2
const LARGE_AREA_KM2   = 300000;
const MIN_RING_SHARE   = 0.03;  // keep rings with area ≥ 3 % of the largest ring
const COORD_DECIMALS   = 3;     // ~100 m — plenty for a silhouette

// ── Which countries become questions, and how hard they are ──────────────────
// 1 = iconic shape most people know, 2 = solid trivia, 3 = expert.
// Countries not listed here still go into data/countries.json (they are used as
// distractors) but get no question. Reasons for leaving a country out:
//   • the outline is a featureless blob (Burkina Faso, Burundi, Rwanda, Lesotho,
//     Eswatini, Djibouti, Equatorial Guinea, Guinea-Bissau, Moldova, Kosovo,
//     Luxembourg, El Salvador, Belize, Turkmenistan, Armenia, Bhutan, Timor-Leste,
//     Albania, Bosnia, Slovenia, Montenegro, North Macedonia, Gabon, Congo,
//     Central African Republic, South Sudan, Eritrea, Sierra Leone, Liberia)
//   • it is a scatter of small islands (Bahamas, Fiji, Solomon Islands, Vanuatu,
//     Maldives, Kiribati, Micronesia, Marshall Islands, Tonga, Samoa, Comoros,
//     Cape Verde, São Tomé, Seychelles, Mauritius, all Caribbean micro-states)
//   • it is a micro-state (Vatican, Monaco, San Marino, Liechtenstein, Andorra,
//     Malta, Singapore, Bahrain, Brunei)
const QUESTIONS = {
  // Europe
  ITA: 1, GBR: 1, NOR: 1, ESP: 1, FRA: 1, DEU: 1, SWE: 1, FIN: 1, IRL: 1, ISL: 1, GRC: 1, PRT: 1, DNK: 1,
  NLD: 2, POL: 2, UKR: 2, ROU: 2, CHE: 2, AUT: 2, BEL: 2, CZE: 2, HUN: 2, HRV: 2, BGR: 2, EST: 2, LVA: 2,
  LTU: 2, BLR: 2, SRB: 2, SVK: 3,
  // Asia (Russia, Turkey, Cyprus and the Caucasus count as Asia — see tools/lib/geo.js)
  RUS: 1, IND: 1, JPN: 1, CHN: 1, IDN: 1, KOR: 1, THA: 1, VNM: 1, PHL: 1, SAU: 1, TUR: 1, LKA: 1,
  PAK: 2, IRN: 2, IRQ: 2, MYS: 2, MMR: 2, MNG: 2, KAZ: 2, NPL: 2, BGD: 2, KHM: 2, LAO: 2, PRK: 2, AFG: 2,
  YEM: 2, OMN: 2, ARE: 2, JOR: 2, SYR: 2, TWN: 2, ISR: 2, CYP: 2, QAT: 2, GEO: 3, AZE: 3, LBN: 3, UZB: 3,
  KGZ: 3, TJK: 3,
  // Africa
  EGY: 1, ZAF: 1, MDG: 1, SOM: 2,
  NGA: 2, KEN: 2, TZA: 2, ETH: 2, MAR: 2, DZA: 2, LBY: 2, TUN: 2, SDN: 2, MOZ: 2, NAM: 2, AGO: 2, COD: 2,
  MLI: 2, TCD: 2, NER: 2, GHA: 2, CMR: 2, ZMB: 2, ZWE: 2, BWA: 2, SEN: 2, MWI: 2, GMB: 2,
  MRT: 3, UGA: 3, CIV: 3, GIN: 3, BEN: 3, TGO: 3,
  // North America
  USA: 1, CAN: 1, MEX: 1, CUB: 1, GRL: 1,
  GTM: 2, HND: 2, NIC: 2, CRI: 2, PAN: 2, DOM: 2, HTI: 2, JAM: 2,
  // South America
  BRA: 1, ARG: 1, CHL: 1,
  PER: 2, COL: 2, VEN: 2, BOL: 2, ECU: 2, URY: 2, PRY: 2, GUY: 3, SUR: 3,
  // Oceania
  AUS: 1, NZL: 1, PNG: 2,
};

// Distractors are drawn from countries of the same region with at least this area,
// so micro-states never show up as obviously-wrong options. Candidates are ranked
// by a mix of size similarity |log(area ratio)| and distance (neighbours make
// better distractors than a same-sized country on the other side of the continent),
// then 3 are picked at random from the best DISTRACTOR_POOL_SIZE.
const MIN_DISTRACTOR_AREA_KM2 = 2000;
const DISTRACTOR_POOL_SIZE    = 8;
const DISTRACTOR_DIST_SCALE   = 2500;   // km that count as much as an area factor of e (~2.7×)
const OTHER_REGION_PENALTY    = 1.5;    // Oceania has few countries: let nearby Asian ones compete

// ═════════════════════════════════════════════════════════════════════════════
// 2. GEOMETRY HELPERS
// ═════════════════════════════════════════════════════════════════════════════
const EARTH_R = 6371;
const rad = d => d * Math.PI / 180;

// Area of a lng/lat ring in km² (spherical formula, same as turf.js).
function ringAreaKm2(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i], p2 = ring[(i + 1) % n], p3 = ring[(i + 2) % n];
    total += (rad(p3[0]) - rad(p1[0])) * Math.sin(rad(p2[1]));
  }
  return Math.abs(total * EARTH_R * EARTH_R / 2);
}

// Drop the closing point GeoJSON repeats at the end of every ring.
function openRing(ring) {
  const r = ring.slice();
  while (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  return r;
}

function bboxOf(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

// Area-weighted centroid of a set of rings (planar shoelace — fine for our use).
function centroidOf(rings) {
  let sx = 0, sy = 0, sa = 0;
  for (const ring of rings) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
      const f = x1 * y2 - x2 * y1;
      a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
    }
    if (a === 0) continue;
    a /= 2; cx /= 6 * a; cy /= 6 * a;
    const w = Math.abs(a);
    sx += cx * w; sy += cy * w; sa += w;
  }
  if (!sa) { const b = bboxOf(rings); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
  return [sx / sa, sy / sa];
}

// Rough great-circle distance for the "is this ring far away" test.
function distKm(a, b) {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

// ── Antimeridian handling ────────────────────────────────────────────────────
// Russia, Fiji, the Aleutians etc. straddle ±180°. We shift longitudes so the
// shape is contiguous: whichever of {no shift, negatives +360, positives −360}
// gives the narrowest bounding box wins. Longitudes may therefore be > 180 or
// < −180 in the output — the client must not wrap them.
function unwrapAntimeridian(rings) {
  const span = rs => { const b = bboxOf(rs); return b[2] - b[0]; };
  if (span(rings) <= 180) return rings;
  const up   = rings.map(r => r.map(([x, y]) => [x < 0 ? x + 360 : x, y]));
  const down = rings.map(r => r.map(([x, y]) => [x > 0 ? x - 360 : x, y]));
  // Narrowest box wins; on a tie, the variant that moved the fewest points
  // (so a mostly-western country stays negative, a mostly-eastern one positive).
  const moved = rs => rs.reduce((n, r) => n + r.filter(([x]) => x > 180 || x < -180).length, 0);
  return [rings, up, down].sort((a, b) => (span(a) - span(b)) || (moved(a) - moved(b)))[0];
}

// After small far-away rings have been dropped, the remaining shape may fit
// back inside ±180° (the USA once the western Aleutians are gone). Shift it
// back so only genuinely straddling countries (Russia, Fiji) keep lng > 180.
function renormalizeLongitudes(rings) {
  const b = bboxOf(rings);
  if (b[0] >= 180)  return rings.map(r => r.map(([x, y]) => [x - 360, y]));
  if (b[2] <= -180) return rings.map(r => r.map(([x, y]) => [x + 360, y]));
  return rings;
}

// ── Stitching two rings that share a boundary ────────────────────────────────
// Natural Earth cuts polygons at the antimeridian and draws de-facto states
// (Northern Cyprus, Somaliland) as separate polygons. This joins two rings
// along their shared run: the run is removed and the two outer paths are
// connected into one ring. Two ways of recognising "shared":
//   • exact  — identical vertices in both rings (de-facto states: same topology)
//   • meridian — both rings have a straight run on lng = 180 (after unwrapping);
//     the vertex sets differ (one side has 2 points, the other 16) but the two
//     runs cover about the same latitude interval, so only the end points must match.
// Returns null if there is no single contiguous shared run of ≥ 2 vertices.
const MERIDIAN_EPS = 1e-6;
const onMeridian   = p => Math.abs(p[0] - 180) < MERIDIAN_EPS;

function stitchRings(a, b, mode) {
  const key = p => `${p[0]},${p[1]}`;
  let sharedA, sharedB, same;
  if (mode === 'meridian') {
    sharedA = a.map(onMeridian); sharedB = b.map(onMeridian);
    // The two sides do not always end at the same latitude (Russia: 68.74° vs 68.98°),
    // so allow half a degree — the join then adds one tiny diagonal segment.
    same = (p, q) => onMeridian(p) && onMeridian(q) && Math.abs(p[1] - q[1]) < 0.5;
  } else {
    const inB = new Set(b.map(key)), inA = new Set(a.map(key));
    sharedA = a.map(p => inB.has(key(p))); sharedB = b.map(p => inA.has(key(p)));
    same = (p, q) => key(p) === key(q);
  }
  // Split a ring into (its non-shared path, first shared vertex, last shared vertex),
  // rotated so the shared run sits at the end. null if the run is not one contiguous block.
  function split(ring, shared) {
    const m = shared.filter(Boolean).length;
    if (m < 2 || m === ring.length) return null;
    let start = -1;
    for (let i = 0; i < ring.length; i++) if (!shared[i] && shared[(i - 1 + ring.length) % ring.length]) { start = i; break; }
    if (start < 0) return null;
    const rot  = ring.slice(start).concat(ring.slice(0, start));
    const rotS = shared.slice(start).concat(shared.slice(0, start));
    const k = rotS.indexOf(true);
    if (rotS.slice(k).some(s => !s)) return null;
    return { outside: rot.slice(0, k), first: rot[k], last: rot[rot.length - 1] };
  }
  const A = split(a, sharedA), B = split(b, sharedB);
  if (!A || !B) return null;

  // Walk A's outside, then B's outside, joining at the shared end points.
  let merged;
  if (same(B.last, A.first) && same(B.first, A.last))      merged = [...A.outside, A.first, ...B.outside, A.last];
  else if (same(B.first, A.first) && same(B.last, A.last)) merged = [...A.outside, A.first, ...B.outside.slice().reverse(), A.last];
  else return null;

  // Sanity: the union must be about as big as the two parts together.
  const areaSum = ringAreaKm2(a) + ringAreaKm2(b);
  if (Math.abs(ringAreaKm2(merged) - areaSum) > 0.05 * areaSum) return null;
  return merged;
}

// Try to stitch any pair of rings sharing a boundary, until nothing changes.
function stitchAll(rings) {
  let out = rings.slice();
  for (const mode of ['exact', 'meridian']) {
    let changed = true;
    while (changed) {
      changed = false;
      outer: for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const merged = stitchRings(out[i], out[j], mode);
          if (merged) { out.splice(j, 1); out.splice(i, 1, merged); changed = true; break outer; }
        }
      }
    }
  }
  return out;
}

// ── Douglas–Peucker simplification ───────────────────────────────────────────
// Works on x = lng·cos(lat₀), y = lat so the tolerance means the same thing in
// both directions. Returns the surviving points (original coordinates).
function simplifyRing(ring, tolerance, cosLat) {
  if (ring.length <= 4) return ring;
  const pts = ring.map(([x, y]) => [x * cosLat, y]);
  const keep = new Array(pts.length).fill(false);
  keep[0] = true; keep[pts.length - 1] = true;
  const segDist2 = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const ex = a[0] + t * dx - p[0], ey = a[1] + t * dy - p[1];
    return ex * ex + ey * ey;
  };
  const stack = [[0, pts.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [s, e] = stack.pop();
    let best = -1, bestD = tol2;
    for (let i = s + 1; i < e; i++) {
      const d = segDist2(pts[i], pts[s], pts[e]);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = true; stack.push([s, best], [best, e]); }
  }
  // A ring is closed: also make sure the point farthest from the start survives,
  // otherwise a round island can collapse into a line.
  let far = 0, farD = -1;
  for (let i = 0; i < pts.length; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > farD) { farD = d; far = i; } }
  keep[far] = true;
  return ring.filter((_, i) => keep[i]);
}

// Increase the tolerance until the whole country fits the point budget.
function simplifyCountry(rings, budget, cosLat) {
  let tol = 0.002;
  let out = rings.map(r => simplifyRing(r, tol, cosLat));
  const count = rs => rs.reduce((n, r) => n + r.length, 0);
  while (count(out) > budget && tol < 5) {
    tol *= 1.3;
    out = rings.map(r => simplifyRing(r, tol, cosLat));
  }
  return out.filter(r => r.length >= 4);
}

const round = n => Math.round(n * 10 ** COORD_DECIMALS) / 10 ** COORD_DECIMALS;

// ═════════════════════════════════════════════════════════════════════════════
// 3. BUILD ONE COUNTRY
// ═════════════════════════════════════════════════════════════════════════════
function outerRings(feature) {
  const g = feature.geometry;
  if (!g) return [];
  if (g.type === 'Polygon')      return [openRing(g.coordinates[0])];
  if (g.type === 'MultiPolygon') return g.coordinates.map(poly => openRing(poly[0]));
  return [];
}

// Keep the mainland plus rings that are big enough and not on the other side of
// the planet (French Guiana must not appear next to France). The distance test is
// relative to the mainland's size but never below 3 500 km, so an archipelago
// like Indonesia (Papua is 3 500 km from Sumatra) stays whole.
function keepRings(iso3, rings) {
  const withArea = rings.map(r => ({ ring: r, area: ringAreaKm2(r), centre: centroidOf([r]) }))
                        .sort((a, b) => b.area - a.area);
  const main = withArea[0];
  const mainBox = bboxOf([main.ring]);
  const mainDiag = distKm([mainBox[0], mainBox[1]], [mainBox[2], mainBox[3]]);
  const drop  = DROP_RINGS[iso3];
  const keep  = KEEP_RINGS[iso3];
  const share = RING_SHARE_OVERRIDES[iso3] || MIN_RING_SHARE;
  return withArea.filter((r, i) => {
    if (i === 0) return true;
    if (drop && drop(r.centre, r.area)) return false;
    if (keep && keep(r.centre, r.area)) return true;         // famous island: always in
    if (r.area < share * main.area) return false;
    if (distKm(r.centre, main.centre) > Math.max(1.2 * mainDiag, 3500)) return false;
    return true;
  }).map(r => r.ring);
}

// Point budget: 350 normally; 600 for the giants and for big many-island countries
// (Canada, Indonesia, Japan, the Philippines) so the extra rings do not starve the mainland.
function pointBudget(rings, areaKm2) {
  if (areaKm2 > 2_000_000) return MAX_POINTS_LARGE;
  if (rings.length >= 3 && areaKm2 > LARGE_AREA_KM2) return MAX_POINTS_LARGE;
  return MAX_POINTS;
}

function buildCountry(feature, extraFeatures) {
  const p = feature.properties;
  const iso3 = p.ADM0_A3;

  // Collect outer rings (plus those of merged de-facto states), unwrap ±180°, stitch.
  let rings = outerRings(feature);
  for (const f of extraFeatures) rings = rings.concat(outerRings(f));
  rings = unwrapAntimeridian(rings);
  rings = stitchAll(rings);

  const areaKm2 = Math.round(rings.reduce((s, r) => s + ringAreaKm2(r), 0));
  rings = keepRings(iso3, rings);
  rings = renormalizeLongitudes(rings);   // back inside ±180° when the straddling bits are gone

  const centroid = centroidOf(rings);
  const cosLat   = Math.max(0.2, Math.cos(rad(centroid[1])));
  const budget   = pointBudget(rings, areaKm2);
  rings = simplifyCountry(rings, budget, cosLat).map(r => r.map(([x, y]) => [round(x), round(y)]));

  const iso2 = p.ISO_A2_EH && p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : null;
  const region = REGION_OVERRIDES[iso3] || regionForCountry(feature, centroid[0]);
  return {
    iso3, iso2,
    name: NAME_OVERRIDES[iso3] || p.NAME_EN || p.NAME,
    region,
    rings,
    bbox: bboxOf(rings).map(round),
    centroid: centroid.map(round),
    areaKm2,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. QUESTION GENERATION
// ═════════════════════════════════════════════════════════════════════════════
// Small seeded random generator (mulberry32) so output is reproducible.
function makeRng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleWith(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function buildQuestions(countries, rng) {
  const all = Object.values(countries);
  // Deterministic order, then shuffled, so correct-index assignment is even but unpredictable.
  const ids = shuffleWith(rng, Object.keys(QUESTIONS).filter(id => countries[id]).sort());
  const questions = [];
  ids.forEach((iso3, i) => {
    const c = countries[iso3];
    // Candidates ranked by size similarity + distance (+ penalty for another region)
    const pool = all
      .filter(o => o.iso3 !== iso3 && o.areaKm2 >= MIN_DISTRACTOR_AREA_KM2)
      .map(o => ({ o, d: Math.abs(Math.log(o.areaKm2 / c.areaKm2)) + distKm(o.centroid, c.centroid) / DISTRACTOR_DIST_SCALE
                        + (o.region === c.region ? 0 : OTHER_REGION_PENALTY) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, DISTRACTOR_POOL_SIZE)
      .map(x => x.o.name);
    if (pool.length < 3) throw new Error(`not enough distractors for ${iso3}`);
    const distractors = shuffleWith(rng, pool).slice(0, 3);
    const correct = i % 4;
    const answers = distractors.slice();
    answers.splice(correct, 0, c.name);
    questions.push({
      type: 'silhouette', category: 'silhouettes',
      question: c.name, iso3, answers, correct,
      region: c.region, difficulty: QUESTIONS[iso3],
    });
  });
  return questions;
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. MAIN
// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  const ne = await loadNaturalEarth('ne_50m_admin_0_countries');
  const byId = Object.fromEntries(ne.features.map(f => [f.properties.ADM0_A3, f]));
  const absorbed = new Set(Object.values(MERGE_INTO).flat());

  const countries = {};
  for (const f of ne.features) {
    const p = f.properties;
    if (!KEEP_TYPES.has(p.TYPE)) continue;
    if (absorbed.has(p.ADM0_A3)) continue;
    if (p.SOVEREIGNT !== p.ADMIN && !KEEP_DESPITE_SOVEREIGN.has(p.ADM0_A3)) continue;
    const extras = (MERGE_INTO[p.ADM0_A3] || []).map(id => byId[id]).filter(Boolean);
    const c = buildCountry(f, extras);
    if (!c.rings.length) { console.warn(`skip ${c.iso3}: no rings survived`); continue; }
    countries[c.iso3] = c;
  }

  // Sorted keys → stable output
  const sorted = Object.fromEntries(Object.keys(countries).sort().map(k => [k, countries[k]]));
  fs.mkdirSync(path.dirname(DATA_OUT), { recursive: true });
  fs.writeFileSync(DATA_OUT, JSON.stringify(sorted));

  const questions = buildQuestions(sorted, makeRng(SEED));
  fs.mkdirSync(path.dirname(CONTENT_OUT), { recursive: true });
  fs.writeFileSync(CONTENT_OUT, JSON.stringify(questions, null, 2) + '\n');

  // Report
  const n = Object.keys(sorted).length;
  const pts = Object.values(sorted).map(c => c.rings.reduce((s, r) => s + r.length, 0));
  const kb = (fs.statSync(DATA_OUT).size / 1024).toFixed(0);
  console.log(`data/countries.json: ${n} countries, ${pts.reduce((a, b) => a + b, 0)} points (max ${Math.max(...pts)}), ${kb} KB`);
  const missing = Object.keys(QUESTIONS).filter(id => !sorted[id]);
  if (missing.length) console.warn('QUESTIONS lists unknown iso3:', missing.join(', '));
  const dist = [0, 0, 0, 0]; questions.forEach(q => dist[q.correct]++);
  const diff = {}; questions.forEach(q => diff[q.difficulty] = (diff[q.difficulty] || 0) + 1);
  const reg  = {}; questions.forEach(q => reg[q.region] = (reg[q.region] || 0) + 1);
  console.log(`content/silhouettes.json: ${questions.length} questions — correct index ${dist.join('/')}, difficulty`, diff, 'regions', reg);
})().catch(e => { console.error(e); process.exit(1); });
