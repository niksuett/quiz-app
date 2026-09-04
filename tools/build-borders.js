// ─────────────────────────────────────────────────────────────────────────────
// tools/build-borders.js — builds the data + questions for "Border Draw"
// (game type "trace", category "borders").
//
//   node tools/build-borders.js            # writes data/borders.json + content/borders.json
//   node tools/build-borders.js --verbose  # also lists every pair that was skipped and why
//
// The idea of the game (borrowed from reborder.app): two neighbouring countries
// are shown as ONE filled blob — the border between them is missing — and the
// player draws where they think it runs.
//
// Where the data comes from
//   tools/raw/ne_50m_admin_0_countries.geojson (Natural Earth, 1:50m). Downloaded
//   once by tools/lib/geo.js if it is missing. Neighbouring countries share the
//   EXACT same vertices along their common border in Natural Earth, which is the
//   whole trick: "border A–B" = the vertices that occur in both A and B.
//
// What it produces (both committed to git)
//   data/borders.json     { "ESP-FRA": { id, a, b, region, bbox, clipped, shapes, outline, known,
//                                        border, endpoints, closed, lengthKm, knownKm } }
//   content/borders.json  one question per pair in CURATED below (for import.js)
//
// Rules applied (see "Config" below for the numbers)
//   • skip Antarctica, "Indeterminate" / "Lease" features and micro-states < 1000 km²;
//     Somaliland / Northern Cyprus are merged back into Somalia / Cyprus
//   • a pair needs one dominant border run: the longest run must be ≥ MIN_BORDER_KM
//     and ≥ 60 % of everything the two countries share (USA–Canada keeps the long
//     49th-parallel run as the hidden border; the Alaska run becomes a "known" line)
//   • two runs separated only by an excluded micro-state (France–Spain around
//     Andorra) are bridged with a straight line so the border stays in one piece
//   • a giant neighbour (Russia next to Finland) is clipped to a window around the
//     smaller country so the border fills the screen; such pairs carry clipped:true
//   • geometry is simplified (Douglas–Peucker) so a pair stays under ~800 points;
//     the hidden border itself is kept much more precise (it is the answer key)
//
// The script is idempotent: it always rewrites both output files from scratch.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const geo  = require('./lib/geo');

const ROOT     = path.join(__dirname, '..');
const OUT_DATA = path.join(ROOT, 'data', 'borders.json');
const OUT_QS   = path.join(ROOT, 'content', 'borders.json');
const VERBOSE  = process.argv.includes('--verbose');

// ── Config ────────────────────────────────────────────────────────────────────
const EXCLUDE_TYPES   = ['Indeterminate', 'Lease'];
const EXCLUDE_IDS     = ['ATA'];                   // Antarctica
const MERGE_INTO      = { SOL: 'SOM', CYN: 'CYP' }; // de-facto territories folded into their country
const MIN_AREA_KM2    = 1000;                      // micro-states below this are skipped
const MIN_BORDER_KM   = 70;                        // the hidden run must be at least this long (Germany–Denmark is 73 km at 1:50m)
const MIN_SHARE       = 0.60;                      // … and at least this share of all shared border length
const BRIDGE_KM       = 60;                        // max gap bridged across an excluded micro-state
const MAX_SHAPE_PTS   = 800;                       // both country outlines together
const SHAPE_TOL       = 0.0025;                    // Douglas–Peucker tolerance as a share of the bbox diagonal
const BORDER_TOL      = 0.0004;                    // the hidden border is kept ~6× more precise
const TINY_RING_SHARE = 0.01;                      // islands smaller than 1 % of the biggest ring are dropped
const MAX_BBOX_GROWTH = 1.6;                       // optional rings may not grow the bbox diagonal by more than this factor
const CLIP_RATIO      = 2.2;                       // clip a neighbour whose diagonal is > this × the focus window's
const CLIP_PAD        = 0.5;                       // focus window = smaller country + border, padded by this share

// Display names: Natural Earth's NAME_EN is fine for most; these read better in a prompt.
const NAME_OVERRIDE = {
  USA: 'United States', GBR: 'United Kingdom', RUS: 'Russia', KOR: 'South Korea', PRK: 'North Korea',
  COD: 'DR Congo', COG: 'Republic of the Congo', CIV: "Côte d'Ivoire", LAO: 'Laos', BRN: 'Brunei',
  CZE: 'Czechia', SWZ: 'Eswatini', MKD: 'North Macedonia', BIH: 'Bosnia and Herzegovina', TZA: 'Tanzania',
  SYR: 'Syria', IRN: 'Iran', VNM: 'Vietnam', BOL: 'Bolivia', VEN: 'Venezuela', MDA: 'Moldova', TLS: 'Timor-Leste',
  PSX: 'Palestine', SDS: 'South Sudan', CAF: 'Central African Republic', GNQ: 'Equatorial Guinea', ARE: 'United Arab Emirates',
  GMB: 'The Gambia', MMR: 'Myanmar', TUR: 'Türkiye', SOM: 'Somalia', CYP: 'Cyprus',
};
// Names that take "the" in a sentence ("the border between Canada and the United States")
const THE = new Set(['USA', 'GBR', 'NLD', 'COD', 'COG', 'CAF', 'ARE', 'PHL', 'DOM', 'BHS']);

// Region of a pair = region of country A (alphabetically first). A few pairs sit on
// another continent than country A's home (French Guiana!) — fix those here.
const REGION_OVERRIDE = {
  'BRA-FRA': 'south-america', 'FRA-SUR': 'south-america',
  'EGY-ISR': 'asia', 'IDN-PNG': 'oceania',
};

// ── Curated question list: pair id → difficulty (1 famous … 3 obscure) ────────
// Ids are alphabetical ("ESP-FRA", never "FRA-ESP"). Only pairs listed here become
// questions; the data file still contains every pair that passed the rules, so
// more can be added later without rebuilding.
const CURATED = {
  // Europe
  'ESP-FRA': 1, 'ESP-PRT': 1, 'DEU-FRA': 1, 'DEU-POL': 1, 'AUT-DEU': 1, 'FRA-ITA': 1, 'CHE-FRA': 1,
  'CHE-ITA': 1, 'CHE-DEU': 1, 'AUT-ITA': 2, 'BEL-FRA': 1, 'BEL-NLD': 1, 'DEU-NLD': 1, 'BEL-DEU': 2, 'BEL-LUX': 2,
  'DEU-LUX': 2, 'DEU-DNK': 1, 'CZE-DEU': 1, 'AUT-CZE': 2, 'CZE-POL': 2, 'CZE-SVK': 1, 'POL-SVK': 2,
  'AUT-HUN': 2, 'HUN-SVK': 2, 'AUT-SVN': 2, 'HRV-SVN': 2, 'ITA-SVN': 2, 'AUT-CHE': 2, 'AUT-SVK': 3,
  'HRV-HUN': 2, 'HRV-SRB': 2, 'BIH-HRV': 2, 'BIH-SRB': 2, 'HUN-SRB': 2, 'HUN-ROU': 2, 'ROU-SRB': 2, 'BGR-ROU': 1,
  'BGR-GRC': 2, 'ALB-GRC': 2, 'ALB-MNE': 3, 'BGR-SRB': 3, 'BGR-MKD': 3, 'GRC-MKD': 3, 'ALB-MKD': 3, 'MNE-SRB': 3,
  'BIH-MNE': 3, 'MDA-ROU': 2, 'ROU-UKR': 2, 'MDA-UKR': 3, 'HUN-UKR': 3, 'POL-UKR': 2, 'BLR-UKR': 2, 'RUS-UKR': 1,
  'BLR-POL': 2, 'BLR-RUS': 2, 'BLR-LTU': 3, 'LTU-POL': 3, 'LTU-LVA': 2, 'EST-LVA': 2, 'EST-RUS': 2, 'LVA-RUS': 3,
  'BLR-LVA': 3, 'FIN-RUS': 1, 'FIN-SWE': 1, 'FIN-NOR': 2, 'NOR-SWE': 1, 'NOR-RUS': 2, 'POL-RUS': 3, 'LTU-RUS': 3,
  'GBR-IRL': 1, 'BGR-TUR': 2, 'GRC-TUR': 1, 'SVK-UKR': 3,
  // Asia
  'CHN-RUS': 1, 'CHN-MNG': 1, 'MNG-RUS': 2, 'CHN-KAZ': 2, 'KAZ-RUS': 1, 'CHN-PRK': 2, 'KOR-PRK': 1,
  'CHN-VNM': 2, 'CHN-MMR': 2, 'CHN-NPL': 1, 'BTN-CHN': 2, 'IND-NPL': 2, 'BTN-IND': 3, 'BGD-IND': 1, 'IND-PAK': 1,
  'IND-MMR': 3, 'AFG-PAK': 1, 'IRN-PAK': 2, 'AFG-IRN': 2, 'IRN-IRQ': 1, 'IRN-TUR': 2, 'IRQ-SAU': 2, 'IRQ-SYR': 2,
  'IRQ-TUR': 2, 'SYR-TUR': 2, 'IRQ-JOR': 3, 'JOR-SAU': 2, 'JOR-SYR': 3, 'ISR-JOR': 2, 'ISR-LBN': 3, 'LBN-SYR': 2,
  'EGY-ISR': 2, 'OMN-SAU': 2, 'SAU-YEM': 2, 'OMN-YEM': 3, 'ARE-SAU': 2, 'ARE-OMN': 3, 'KWT-SAU': 3, 'IRQ-KWT': 3,
  'ARM-AZE': 2, 'ARM-GEO': 3, 'AZE-GEO': 3, 'GEO-RUS': 2, 'AZE-RUS': 3, 'ARM-TUR': 2, 'AZE-IRN': 2,
  'GEO-TUR': 3, 'KAZ-UZB': 2, 'KAZ-KGZ': 3, 'KAZ-TKM': 3, 'TKM-UZB': 2, 'TJK-UZB': 3, 'KGZ-UZB': 3, 'AFG-TJK': 2,
  'AFG-TKM': 3, 'AFG-UZB': 3, 'CHN-KGZ': 3, 'CHN-TJK': 3, 'KGZ-TJK': 3, 'IRN-TKM': 3, 'CHN-PAK': 2, 'AFG-CHN': 3,
  'CHN-LAO': 3, 'LAO-THA': 1, 'LAO-VNM': 2, 'KHM-THA': 2, 'KHM-VNM': 2, 'KHM-LAO': 3, 'MMR-THA': 1, 'LAO-MMR': 3,
  'MYS-THA': 2, 'IDN-MYS': 1, 'IDN-PNG': 2, 'IDN-TLS': 2, 'BGD-MMR': 3,
  // Africa
  'DZA-MAR': 1, 'DZA-TUN': 1, 'DZA-LBY': 2, 'EGY-LBY': 1, 'EGY-SDN': 1, 'LBY-TUN': 2, 'DZA-MLI': 2, 'DZA-NER': 2,
  'DZA-MRT': 2, 'MLI-MRT': 2, 'MLI-NER': 2, 'LBY-NER': 3, 'LBY-TCD': 2, 'NER-TCD': 3, 'NER-NGA': 1, 'BEN-NGA': 2,
  'CMR-NGA': 1, 'CMR-TCD': 3, 'SDN-TCD': 2, 'CAF-TCD': 3, 'CAF-SDN': 3, 'SDN-SDS': 2, 'ETH-SDN': 2, 'ERI-ETH': 2,
  'ETH-SOM': 1, 'ETH-KEN': 2, 'ETH-SDS': 3, 'KEN-SOM': 2, 'KEN-TZA': 1, 'KEN-UGA': 2, 'SDS-UGA': 3, 'COD-UGA': 2,
  'RWA-UGA': 3, 'BDI-TZA': 3, 'MOZ-TZA': 2, 'MWI-TZA': 3, 'MOZ-ZMB': 2, 'MOZ-ZWE': 2, 'ZAF-ZWE': 2, 'BWA-ZAF': 1,
  'NAM-ZAF': 1, 'AGO-NAM': 1, 'BWA-NAM': 2, 'BWA-ZWE': 2, 'ZMB-ZWE': 1, 'AGO-ZMB': 2, 'COD-ZMB': 1, 'AGO-COD': 2,
  'AGO-COG': 3, 'COD-COG': 1, 'CAF-COD': 2, 'COD-SDS': 3, 'COD-RWA': 3, 'BDI-COD': 3, 'COD-TZA': 2, 'CMR-COG': 3,
  'CMR-GAB': 3, 'COG-GAB': 2, 'CAF-CMR': 3, 'CMR-GNQ': 3, 'GAB-GNQ': 3, 'LSO-ZAF': 1, 'SWZ-ZAF': 2, 'MOZ-ZAF': 2,
  'MOZ-SWZ': 3, 'MOZ-MWI': 2, 'MWI-ZMB': 3, 'TZA-ZMB': 3, 'CIV-GHA': 2, 'BFA-GHA': 2, 'GHA-TGO': 2, 'BEN-TGO': 3,
  'BFA-MLI': 2, 'BFA-NER': 3, 'BFA-CIV': 3, 'BEN-BFA': 3, 'GIN-MLI': 3, 'CIV-LBR': 3, 'GIN-SLE': 3, 'GIN-LBR': 3,
  'CIV-GIN': 3, 'GIN-SEN': 3, 'MRT-SEN': 2, 'GMB-SEN': 1, 'GNB-SEN': 3, 'GIN-GNB': 3, 'DJI-ETH': 3, 'ERI-SDN': 3,
  'NGA-TCD': 3, 'CIV-MLI': 3, 'LBR-SLE': 3, 'RWA-TZA': 3, 'TZA-UGA': 3, 'NAM-ZMB': 3, 'DJI-ERI': 3, 'LBY-SDN': 3,
  'ETH-SDS': 3, 'KEN-SDS': 3, 'MLI-SEN': 3, 'BEN-NER': 3, 'BFA-TGO': 3, 'CAF-COG': 3, 'CAF-SDS': 3,
  // Americas
  'CAN-USA': 1, 'MEX-USA': 1, 'GTM-MEX': 1, 'BLZ-MEX': 3, 'BLZ-GTM': 3, 'GTM-HND': 2, 'HND-NIC': 2, 'CRI-NIC': 2,
  'CRI-PAN': 2, 'COL-PAN': 1, 'HND-SLV': 3, 'GTM-SLV': 3, 'DOM-HTI': 1, 'COL-VEN': 1, 'COL-ECU': 2, 'COL-PER': 2,
  'BRA-COL': 2, 'BRA-VEN': 2, 'GUY-VEN': 2, 'BRA-GUY': 3, 'GUY-SUR': 3, 'BRA-SUR': 3, 'BRA-FRA': 2, 'FRA-SUR': 3,
  'ECU-PER': 1, 'BRA-PER': 2, 'BOL-PER': 1, 'BOL-BRA': 1, 'BOL-CHL': 2, 'ARG-CHL': 1, 'ARG-BOL': 2, 'BOL-PRY': 2,
  'ARG-PRY': 2, 'BRA-PRY': 2, 'ARG-BRA': 2, 'ARG-URY': 1, 'BRA-URY': 2, 'CHL-PER': 2,
};

// ── Small geometry helpers ────────────────────────────────────────────────────
const key   = p => p[0] + ',' + p[1];       // vertex → map key (exact coordinates)
const EMPTY = new Set();

function haversineKm(a, b) {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]), dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function lineLengthKm(line) { let s = 0; for (let i = 1; i < line.length; i++) s += haversineKm(line[i - 1], line[i]); return s; }

// Planar ring area in km² (good enough for "is this island tiny?")
function ringAreaKm2(ring) {
  let a = 0, latSum = 0;
  for (let i = 0; i < ring.length - 1; i++) { a += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]) / 2; latSum += ring[i][1]; }
  const midLat = latSum / Math.max(1, ring.length - 1);
  return Math.abs(a) * 111.32 * 110.57 * Math.cos(midLat * Math.PI / 180);
}
function bboxOf(rings) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings) for (const [x, y] of r) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
  return b;
}
const diagOf = b => Math.hypot(b[2] - b[0], b[3] - b[1]);
const round  = (p, d) => [+p[0].toFixed(d), +p[1].toFixed(d)];
function padBox(b, share) {
  const w = (b[2] - b[0]) * share, h = (b[3] - b[1]) * share;
  return [b[0] - w, Math.max(-90, b[1] - h), b[2] + w, Math.min(90, b[3] + h)];
}

// Douglas–Peucker: keeps the shape within `tol` degrees of the original, first + last point always kept.
function simplify(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, idx = -1;
    const [ax, ay] = pts[s], [bx, by] = pts[e];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else { const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)); d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); }
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Sutherland–Hodgman: clip a closed ring to a rectangle. Returns a closed ring or null.
// New vertices sit EXACTLY on the rectangle edges, so "is this a cut edge?" is a plain equality test.
function clipRing(ring, [x0, y0, x1, y1]) {
  const sides = [
    [p => p[0] >= x0, (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])]],
    [p => p[0] <= x1, (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])]],
    [p => p[1] >= y0, (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0]],
    [p => p[1] <= y1, (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1]],
  ];
  let out = ring.slice(0, -1);
  for (const [inside, intersect] of sides) {
    const input = out; out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i - 1 + input.length) % input.length];
      if (inside(cur)) { if (!inside(prev)) out.push(intersect(prev, cur)); out.push(cur); }
      else if (inside(prev)) out.push(intersect(prev, cur));
    }
    if (out.length < 3) return null;
  }
  out.push(out[0]);
  return out;
}
// Both points on the same rectangle side → the segment is a cut, not a real coastline.
function isCutEdge(p, q, [x0, y0, x1, y1]) {
  return (p[0] === x0 && q[0] === x0) || (p[0] === x1 && q[0] === x1) || (p[1] === y0 && q[1] === y0) || (p[1] === y1 && q[1] === y1);
}

// ── 1. Load and filter countries ──────────────────────────────────────────────
async function loadCountries() {
  const fc = await geo.loadNaturalEarth('ne_50m_admin_0_countries');
  const byId = {};
  const excluded = {};           // id → rings of features we skipped (needed for bridging across micro-states)
  for (const f of fc.features) {
    const p = f.properties;
    const id = MERGE_INTO[p.ADM0_A3] || p.ADM0_A3;
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const rings = [];
    for (const poly of polys) poly.forEach((ring, i) => rings.push({ coords: ring, hole: i > 0, area: ringAreaKm2(ring), part: p.ADM0_A3 }));
    const area = rings.filter(r => !r.hole).reduce((s, r) => s + r.area, 0);
    const skip = EXCLUDE_IDS.includes(id) || EXCLUDE_TYPES.includes(p.TYPE) || (area < MIN_AREA_KM2 && !MERGE_INTO[p.ADM0_A3]);
    if (skip) { excluded[p.ADM0_A3] = rings; continue; }
    // Make (or reuse) the entry for this id. A de-facto territory (Northern Cyprus)
    // and its parent (Cyprus) can arrive in either order in the GeoJSON, so we always
    // merge into whatever is already there instead of overwriting it.
    const entry = byId[id] || (byId[id] = { id, rings: [], area: 0 });
    entry.rings.push(...rings);
    entry.area += area;
    // Name / ISO code / the feature used for the region lookup come from the PARENT
    // feature only — never from the merged-in territory.
    if (!MERGE_INTO[p.ADM0_A3]) {
      entry.name    = NAME_OVERRIDE[id] || p.NAME_EN || p.NAME;
      entry.iso2    = p.ISO_A2_EH;
      entry.feature = f;
    }
  }
  // Safety net: a merged territory whose parent never showed up would have no name.
  for (const c of Object.values(byId)) if (!c.feature) throw new Error(`merged territory without parent: ${c.id}`);
  return { countries: Object.values(byId), excluded };
}

// ── 2. Vertex indexes ─────────────────────────────────────────────────────────
// vertex key → Set of country ids that use it. Neighbours share exact vertices.
function buildVertexIndex(countries) {
  const index = new Map();
  for (const c of countries) for (const r of c.rings) for (const p of r.coords) {
    const k = key(p);
    let s = index.get(k); if (!s) index.set(k, s = new Set());
    s.add(c.id);
  }
  return index;
}
// vertex key → Set of ids of EXCLUDED features (micro-states) touching it
function buildExcludedIndex(excluded) {
  const index = new Map();
  for (const [id, rings] of Object.entries(excluded)) for (const r of rings) for (const p of r.coords) {
    const k = key(p);
    let s = index.get(k); if (!s) index.set(k, s = new Set());
    s.add(id);
  }
  return index;
}
// Vertices used by more than one ring of the SAME country (Somalia/Somaliland seam) — never stroked.
function internalVertexKeys(country) {
  const seen = new Map(), internal = new Set();
  country.rings.forEach((r, ri) => { for (const p of r.coords) { const k = key(p); const prev = seen.get(k); if (prev !== undefined && prev !== ri) internal.add(k); else seen.set(k, ri); } });
  return internal;
}

// ── 3. Shared runs ────────────────────────────────────────────────────────────
// The runs of consecutive vertices of country A that are shared with country B.
// Each ring is rotated so it starts at a NON-shared vertex (a run must not be
// split at the ring's arbitrary start point). Returns [{ pts, closed }].
function sharedRuns(A, bId, index) {
  const runs = [];
  for (const ring of A.rings) {
    const verts = ring.coords.slice(0, -1);           // drop the closing duplicate
    const n = verts.length;
    const shared = verts.map(p => index.get(key(p)).has(bId));
    if (!shared.some(Boolean)) continue;
    const start = shared.indexOf(false);
    if (start < 0) { runs.push({ pts: [...verts, verts[0]], closed: true }); continue; }   // enclave: the whole ring is the border
    const rot = i => verts[(start + i) % n];
    let i = 0;
    while (i < n) {
      if (!shared[(start + i) % n]) { i++; continue; }
      let j = i;
      while (j + 1 < n && shared[(start + j + 1) % n]) j++;
      if (j > i) { const pts = []; for (let k = i; k <= j; k++) pts.push(rot(k)); runs.push({ pts, closed: false }); }
      i = j + 1;
    }
  }
  return mergeTouching(runs);
}

// Runs that end where another starts (e.g. split across two polygon parts) are joined.
// Runs whose ends are both on the same excluded micro-state (Andorra) are bridged with
// a straight segment when the gap is short.
function mergeTouching(runs, exIndex) {
  const endsOnSameMicro = (p, q) => {
    const a = exIndex && exIndex.get(key(p)), b = exIndex && exIndex.get(key(q));
    return !!(a && b && [...a].some(id => b.has(id)) && haversineKm(p, q) <= BRIDGE_KM);
  };
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < runs.length; i++) {
      if (runs[i].closed) continue;
      for (let j = 0; j < runs.length; j++) {
        if (i === j || runs[j].closed) continue;
        const a = runs[i].pts, b = runs[j].pts;
        const aS = a[0], aE = a[a.length - 1], bS = b[0], bE = b[b.length - 1];
        let joined = null, bridged = false;
        if (key(aE) === key(bS))      joined = a.concat(b.slice(1));
        else if (key(aE) === key(bE)) joined = a.concat(b.slice(0, -1).reverse());
        else if (key(aS) === key(bS)) joined = b.slice(1).reverse().concat(a);
        else if (key(aS) === key(bE)) joined = b.concat(a.slice(1));
        else if (endsOnSameMicro(aE, bS)) { joined = a.concat(b); bridged = true; }
        else if (endsOnSameMicro(aE, bE)) { joined = a.concat(b.slice().reverse()); bridged = true; }
        else if (endsOnSameMicro(aS, bS)) { joined = b.slice().reverse().concat(a); bridged = true; }
        else if (endsOnSameMicro(aS, bE)) { joined = b.concat(a); bridged = true; }
        if (joined) { runs[i] = { pts: joined, closed: false, bridged: bridged || runs[i].bridged || runs[j].bridged }; runs.splice(j, 1); merged = true; break outer; }
      }
    }
  }
  return runs;
}

// ── 4. Pick the rings to draw for one pair ────────────────────────────────────
// Rings touching the border are mandatory. Other rings (islands, far-away
// exclaves — think Russia's mainland for Kaliningrad–Poland) are only kept
// if they are big and do not blow up the bounding box.
function chooseRings(country, otherId, index) {
  const outer = country.rings.filter(r => !r.hole);
  const touching = outer.filter(r => r.coords.some(p => index.get(key(p)).has(otherId)));
  const chosen = touching.length ? touching.slice() : [outer.reduce((a, b) => b.area > a.area ? b : a)];
  const baseDiag = diagOf(bboxOf(chosen.map(r => r.coords)));
  const biggest  = Math.max(...chosen.map(r => r.area));
  for (const r of outer.filter(r => !chosen.includes(r)).sort((a, b) => b.area - a.area)) {
    if (r.area < TINY_RING_SHARE * biggest) continue;
    const newDiag = diagOf(bboxOf([...chosen, r].map(x => x.coords)));
    if (newDiag > baseDiag * MAX_BBOX_GROWTH && baseDiag > 0) continue;
    chosen.push(r);
  }
  return { rings: chosen.map(r => r.coords), touching: touching.map(r => r.coords) };
}

// ── 5. Canonical piecewise simplification ─────────────────────────────────────
// Each ring is cut into pieces where the vertex class changes:
//   'shared'   — on the border with the other country (hidden or known run)
//   'internal' — seam between two rings of the same country (never drawn)
//   'outer'    — coastline / border with a third country (drawn as the outline)
// Non-shared pieces are simplified on their own. Shared pieces are simplified
// ONCE (on country A) and the kept vertices are reused for country B, so both
// outlines meet exactly along the border — no slivers when the client fills
// both with the same colour.
function splitRing(ring, classify) {
  const verts = ring.slice(0, -1);
  const cls = verts.map(classify);
  let start = cls.indexOf('outer'); if (start < 0) start = cls.indexOf('internal'); if (start < 0) start = 0;
  const rot = verts.slice(start).concat(verts.slice(0, start));
  const rotCls = cls.slice(start).concat(cls.slice(0, start));
  rot.push(rot[0]); rotCls.push(rotCls[0]);      // close it again
  const edgeClass = i => (rotCls[i] === 'shared' && rotCls[i + 1] === 'shared') ? 'shared'
                       : (rotCls[i] === 'internal' && rotCls[i + 1] === 'internal') ? 'internal' : 'outer';
  const pieces = [];
  let i = 0;
  while (i < rot.length - 1) {
    const c = edgeClass(i);
    let j = i + 1;
    while (j + 1 < rot.length && edgeClass(j) === c) j++;
    pieces.push({ cls: c, pts: rot.slice(i, j + 1) });
    i = j;
  }
  return pieces;
}

function simplifyRings(rings, classify, tol, keptKeys, record, clipBox) {
  const outRings = [], outline = [], blob = [];
  for (const ring of rings) {
    const pieces = splitRing(ring, classify);
    const simp = [];       // the true country ring (border included) — reveal only
    const blobRing = [];   // the same ring with every shared piece flattened to a chord
    const outerPieces = [];
    for (const piece of pieces) {
      let pts;
      if (piece.cls === 'shared') {
        if (record) { pts = simplify(piece.pts, tol); pts.forEach(p => keptKeys.add(key(p))); }
        else pts = piece.pts.filter((p, i) => i === 0 || i === piece.pts.length - 1 || keptKeys.has(key(p)));
      } else pts = simplify(piece.pts, tol);
      if (piece.cls === 'outer') outerPieces.push(pts);
      simp.push(...(simp.length ? pts.slice(1) : pts));   // first point == last of previous piece
      // For the blob we keep only the coastline; every piece that runs along the
      // hidden border (or an internal seam) becomes a straight chord between its
      // two ends. A ∪ B is unchanged by that swap — the sliver between chord and
      // border always belongs to one of the two countries — so filling all blob
      // rings in ONE colour still draws the exact silhouette of the two countries,
      // while the shape of the border itself is nowhere in the data.
      const bpts = piece.cls === 'outer' ? pts : [pts[0], pts[pts.length - 1]];
      blobRing.push(...(blobRing.length ? bpts.slice(1) : bpts));
    }
    if (simp.length < 4) continue;
    outRings.push(simp);
    if (blobRing.length >= 4) blob.push(blobRing);
    // Outline polylines = outer pieces, split wherever a segment is a clip cut.
    for (const pts of outerPieces) {
      let cur = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        if (clipBox && isCutEdge(pts[i - 1], pts[i], clipBox)) { if (cur.length > 1) outline.push(cur); cur = [pts[i]]; }
        else cur.push(pts[i]);
      }
      if (cur.length > 1) outline.push(cur);
    }
  }
  return { rings: outRings, outline, blob };
}

// ── 6. Build one pair ─────────────────────────────────────────────────────────
function buildPair(A, B, index, exIndex, internalA, internalB) {
  const runs = mergeTouching(sharedRuns(A, B.id, index), exIndex);
  if (!runs.length) return { skip: 'no runs' };
  runs.forEach(r => { r.km = lineLengthKm(r.pts); });
  runs.sort((a, b) => b.km - a.km);
  const hidden = runs[0], total = runs.reduce((s, r) => s + r.km, 0);
  if (hidden.km < MIN_BORDER_KM) return { skip: `border only ${hidden.km.toFixed(0)} km` };
  if (hidden.km < MIN_SHARE * total) return { skip: `longest run is only ${(100 * hidden.km / total).toFixed(0)} % of ${total.toFixed(0)} km shared` };

  const chosenA = chooseRings(A, B.id, index), chosenB = chooseRings(B, A.id, index);
  let ringsA = chosenA.rings, ringsB = chosenB.rings;

  // Clip a giant neighbour to a window around the smaller country + the border.
  const dA = diagOf(bboxOf(chosenA.touching)), dB = diagOf(bboxOf(chosenB.touching));
  const smallRings = dA <= dB ? ringsA : ringsB;
  const focus = padBox(bboxOf([...smallRings, hidden.pts]), CLIP_PAD);
  let clipBox = null;
  if (Math.max(dA, dB) > CLIP_RATIO * diagOf(focus)) {
    clipBox = focus;
    const clip = rings => rings.map(r => clipRing(r, clipBox)).filter(Boolean).filter(r => ringAreaKm2(r) > 500);
    if (dA > dB) ringsA = clip(ringsA); else ringsB = clip(ringsB);
    if (!ringsA.length || !ringsB.length) return { skip: 'nothing left after clipping' };
  }

  const bbox = bboxOf([...ringsA, ...ringsB]);
  const diag = diagOf(bbox);
  const classA = p => (index.get(key(p)) || EMPTY).has(B.id) ? 'shared' : internalA.has(key(p)) ? 'internal' : 'outer';
  const classB = p => (index.get(key(p)) || EMPTY).has(A.id) ? 'shared' : internalB.has(key(p)) ? 'internal' : 'outer';

  let tol = SHAPE_TOL * diag, sa, sb, pts;
  for (let iter = 0; iter < 12; iter++) {
    const kept = new Set();
    sa = simplifyRings(ringsA, classA, tol, kept, true, clipBox);
    sb = simplifyRings(ringsB, classB, tol, kept, false, clipBox);
    pts = [...sa.rings, ...sb.rings].reduce((s, r) => s + r.length, 0);
    if (pts <= MAX_SHAPE_PTS) break;
    tol *= 1.3;
  }

  // "Known" runs (drawn solid by the client) reuse the vertices kept in the shapes,
  // so they sit exactly on the outline. Runs outside the clip window are dropped.
  const shapeKeys = new Set(); for (const r of [...sa.rings, ...sb.rings]) for (const p of r) shapeKeys.add(key(p));
  const inBox = p => !clipBox || (p[0] >= clipBox[0] && p[0] <= clipBox[2] && p[1] >= clipBox[1] && p[1] <= clipBox[3]);
  const knownLines = runs.slice(1)
    .map(r => r.pts.filter((p, i) => (i === 0 || i === r.pts.length - 1 || shapeKeys.has(key(p))) && inBox(p)).map(p => round(p, 3)))
    .filter(l => l.length >= 2);

  const border = simplify(hidden.pts, BORDER_TOL * diag).map(p => round(p, 4));
  const midLng = border[Math.floor(border.length / 2)][0];
  const id = `${A.id}-${B.id}`;
  const region = REGION_OVERRIDE[id] || geo.regionForCountry(A.feature, midLng) || geo.regionForCountry(B.feature, midLng) || null;

  return {
    pair: {
      id,
      a: { iso3: A.id, iso2: A.iso2, name: A.name },
      b: { iso3: B.id, iso2: B.iso2, name: B.name },
      region,
      bbox: bbox.map(v => +v.toFixed(3)),
      clipped: !!clipBox,
      shapes: { a: sa.rings.map(r => r.map(p => round(p, 3))), b: sb.rings.map(r => r.map(p => round(p, 3))) },
      // blob = what the PLAYER is shown (border flattened to chords), shapes = reveal only
      blob: [...sa.blob, ...sb.blob].map(r => r.map(p => round(p, 3))),
      outline: [...sa.outline, ...sb.outline].map(l => l.map(p => round(p, 3))),
      known: knownLines,
      border,
      endpoints: [border[0], border[border.length - 1]],
      closed: !!hidden.closed,
      bridged: !!hidden.bridged,
      lengthKm: Math.round(hidden.km),
      knownKm: Math.round(total - hidden.km),
    },
    stats: { pts, borderPts: border.length, tol },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const { countries, excluded } = await loadCountries();
  const byId = Object.fromEntries(countries.map(c => [c.id, c]));
  const index = buildVertexIndex(countries);
  const exIndex = buildExcludedIndex(excluded);
  const internal = Object.fromEntries(countries.map(c => [c.id, internalVertexKeys(c)]));

  // Which countries touch which? (any shared vertex)
  const neighbours = new Map();
  for (const s of index.values()) if (s.size > 1) {
    const ids = [...s].sort();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = `${ids[i]}-${ids[j]}`;
      if (!neighbours.has(k)) neighbours.set(k, [ids[i], ids[j]]);
    }
  }

  const data = {};
  const skipped = [];
  let totalPts = 0;
  for (const [id, [aId, bId]] of [...neighbours.entries()].sort()) {
    const res = buildPair(byId[aId], byId[bId], index, exIndex, internal[aId], internal[bId]);
    if (res.skip) { skipped.push(`${id}: ${res.skip}`); continue; }
    data[id] = res.pair;
    totalPts += res.stats.pts;
  }

  fs.mkdirSync(path.dirname(OUT_DATA), { recursive: true });
  fs.writeFileSync(OUT_DATA, JSON.stringify(data));
  const bytes = fs.statSync(OUT_DATA).size;

  // ── Questions ──────────────────────────────────────────────────────────────
  const withThe = c => (THE.has(c.iso3) ? 'the ' : '') + c.name;
  const questions = [];
  const missing = [];
  for (const [id, difficulty] of Object.entries(CURATED)) {
    const p = data[id];
    if (!p) { missing.push(id); continue; }
    const q = { type: 'trace', category: 'borders', question: `Draw the border between ${withThe(p.a)} and ${withThe(p.b)}`, pairId: id, difficulty };
    if (p.region) q.region = p.region;
    questions.push(q);
  }
  fs.mkdirSync(path.dirname(OUT_QS), { recursive: true });
  fs.writeFileSync(OUT_QS, JSON.stringify(questions, null, 2) + '\n');

  // ── Report ─────────────────────────────────────────────────────────────────
  const regions = {};
  for (const p of Object.values(data)) regions[p.region || 'none'] = (regions[p.region || 'none'] || 0) + 1;
  const clipped = Object.values(data).filter(p => p.clipped).length, bridged = Object.values(data).filter(p => p.bridged).map(p => p.id);
  console.log(`✓ ${Object.keys(data).length} pairs → ${path.relative(ROOT, OUT_DATA)} (${(bytes / 1e6).toFixed(2)} MB, ${totalPts} shape points, ${clipped} clipped, ${skipped.length} pairs skipped)`);
  console.log(`  regions: ${Object.entries(regions).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`  bridged across a micro-state: ${bridged.join(', ') || 'none'}`);
  console.log(`✓ ${questions.length} questions → ${path.relative(ROOT, OUT_QS)}`);
  if (missing.length) console.log(`⚠ curated pairs not in data (typo or skipped): ${missing.join(', ')}`);
  if (VERBOSE) {
    console.log('\nSkipped pairs:'); skipped.forEach(s => console.log('  ' + s));
    console.log('\nPairs in data (id: border km, shape points, region):');
    for (const p of Object.values(data)) console.log(`  ${p.id}: ${p.lengthKm} km, ${p.shapes.a.concat(p.shapes.b).reduce((s, r) => s + r.length, 0)} pts, ${p.region}${p.closed ? ' (enclave loop)' : ''}${p.clipped ? ' (clipped)' : ''}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
