// ─────────────────────────────────────────────────────────────────────────────
// tools/build-rivers.js — builds the data + questions for "River Run"
// (game type "trace", category "rivers").
//
//   node tools/build-rivers.js            # writes data/rivers.json + content/rivers.json
//   node tools/build-rivers.js --verbose  # also prints every river that was skipped and why
//
// The game: a blank ink-on-parchment map shows the surrounding countries plus two
// markers — the river's MOUTH and its SOURCE. The player draws the river's course
// between them; the closer the drawn line follows the real river, the more points.
//
// Where the data comes from
//   tools/raw/ne_10m_rivers_lake_centerlines.geojson   (Natural Earth 1:10m)
//   tools/raw/ne_50m_rivers_lake_centerlines.geojson   (fallback for missing names)
//   tools/raw/ne_50m_admin_0_countries.geojson         (land shapes drawn behind the river)
// All three are downloaded once into tools/raw/ by tools/lib/geo.js (gitignored).
//
// The hard part: in Natural Earth a river is NOT one line. It is many LineString /
// MultiLineString features that share a name and meet end-to-end (plus separate
// "Lake Centerline" pieces where the river runs through a lake or reservoir). This
// script stitches those pieces back into one continuous path (see chainLines).
//
// Output (committed to git)
//   data/rivers.json     { "nile": { id, name, region, path, bbox, lengthKm, mouth, source, context } }
//   content/rivers.json  one question per river, ready for `node import.js content/rivers.json`
//
// The script is idempotent: it rewrites both files from scratch every run.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const geo  = require('./lib/geo');

const ROOT     = path.join(__dirname, '..');
const OUT_DATA = path.join(ROOT, 'data', 'rivers.json');
const OUT_QS   = path.join(ROOT, 'content', 'rivers.json');
const VERBOSE  = process.argv.includes('--verbose');

// ── Config ────────────────────────────────────────────────────────────────────
const JOIN_TOL_DEG   = 0.02;   // two line ends this close (in degrees) are treated as the same point
const MAX_PATH_PTS   = 400;    // the answer key: simplified to at most this many points
const BBOX_PAD       = 0.12;   // the map window is the river's bbox grown by 12 % on each side
const MAX_CTX_PTS    = 1500;   // total points of the surrounding land shapes
const CTX_TOL_START  = 0.004;  // land simplification tolerance, as a share of the window diagonal
const MIN_LENGTH_KM  = 250;    // a chained river shorter than this is almost certainly broken data

// ─────────────────────────────────────────────────────────────────────────────
// The curated river list. Only rivers people have actually heard of.
//   id         key in data/rivers.json and in the question JSON (riverId)
//   name       display name, used in the prompt and in correctText()
//   ne         the Natural Earth name(s) to collect the line pieces from
//   region     continent tag for the host's "Geographic focus" filter
//   difficulty 1 = most people know it, 2 = solid trivia, 3 = expert
//   where      optional country hint appended to the prompt for the less obvious ones
//   mouth      optional override: 'first' | 'last' (index into the chained path) or [lng,lat].
//              Only needed when the automatic "which end is nearest the sea" test is wrong.
// ─────────────────────────────────────────────────────────────────────────────
const RIVERS = [
  // ── Europe ────────────────────────────────────────────────────────────────
  { id: 'danube',   name: 'the Danube',        ne: ['Danube'],        region: 'europe', difficulty: 1 },
  { id: 'rhine',    name: 'the Rhine',         ne: ['Rhein', 'Rhine'], region: 'europe', difficulty: 1 },
  { id: 'seine',    name: 'the Seine',         ne: ['Seine'],         region: 'europe', difficulty: 1 },
  { id: 'loire',    name: 'the Loire',         ne: ['Loire'],         region: 'europe', difficulty: 2 },
  { id: 'rhone',    name: 'the Rhône',         ne: ['Rhône', 'Rhone'], region: 'europe', difficulty: 2 },
  { id: 'thames',   name: 'the Thames',        ne: ['Thames'],        region: 'europe', difficulty: 1 },
  { id: 'elbe',     name: 'the Elbe',          ne: ['Elbe'],          region: 'europe', difficulty: 2 },
  { id: 'oder',     name: 'the Oder',          ne: ['Oder'],          region: 'europe', difficulty: 2, where: 'the Germany–Poland border river' },
  { id: 'vistula',  name: 'the Vistula',       ne: ['Vistula'],       region: 'europe', difficulty: 2, where: 'Poland' },
  { id: 'po',       name: 'the Po',            ne: ['Po'],            region: 'europe', difficulty: 2, where: 'northern Italy' },
  { id: 'tiber',    name: 'the Tiber',         ne: ['Tiber'],         region: 'europe', difficulty: 3, where: 'Italy' },
  { id: 'ebro',     name: 'the Ebro',          ne: ['Ebro'],          region: 'europe', difficulty: 2, where: 'Spain' },
  { id: 'tagus',    name: 'the Tagus',         ne: ['Tagus', 'Tajo', 'Tejo'], region: 'europe', difficulty: 2, where: 'Spain and Portugal' },
  { id: 'douro',    name: 'the Douro',         ne: ['Duero', 'Douro'], region: 'europe', difficulty: 3, where: 'Spain and Portugal' },
  { id: 'guadalquivir', name: 'the Guadalquivir', ne: ['Guadalquivir'], region: 'europe', difficulty: 3, where: 'southern Spain' },
  { id: 'volga',    name: 'the Volga',         ne: ['Volga'],         region: 'europe', difficulty: 1 },
  { id: 'don',      name: 'the Don',           ne: ['Don'],           region: 'europe', difficulty: 3, where: 'Russia' },
  { id: 'dnieper',  name: 'the Dnieper',       ne: ['Dnieper'],       region: 'europe', difficulty: 2, where: 'Ukraine' },
  { id: 'sava',     name: 'the Sava',          ne: ['Sava'],          region: 'europe', difficulty: 3, where: 'the Balkans' },
  { id: 'dniester', name: 'the Dniester',      ne: ['Dniester'],      region: 'europe', difficulty: 3, where: 'Moldova and Ukraine' },
  { id: 'ural',     name: 'the Ural',          ne: ['Ural'],          region: 'europe', difficulty: 3, where: 'Russia and Kazakhstan' },
  { id: 'northern-dvina', name: 'the Northern Dvina', ne: ['Severnaya Dvina'], region: 'europe', difficulty: 3, where: 'northern Russia' },

  // ── Asia ──────────────────────────────────────────────────────────────────
  { id: 'yangtze',  name: 'the Yangtze',       ne: ['Yangtze'],       region: 'asia', difficulty: 1 },
  { id: 'huanghe',  name: 'the Yellow River',  ne: ['Huang'],         region: 'asia', difficulty: 1, where: 'China' },
  { id: 'mekong',   name: 'the Mekong',        ne: ['Mekong'],        region: 'asia', difficulty: 1 },
  { id: 'ganges',   name: 'the Ganges',        ne: ['Ganges'],        region: 'asia', difficulty: 1 },
  { id: 'indus',    name: 'the Indus',         ne: ['Indus'],         region: 'asia', difficulty: 1 },
  { id: 'brahmaputra', name: 'the Brahmaputra', ne: ['Brahmaputra'],  region: 'asia', difficulty: 2 },
  { id: 'tigris',   name: 'the Tigris',        ne: ['Tigris'],        region: 'asia', difficulty: 2, where: 'Iraq' },
  { id: 'euphrates', name: 'the Euphrates',    ne: ['Euphrates'],     region: 'asia', difficulty: 2 },
  { id: 'jordan',   name: 'the Jordan',        ne: ['Jordan'],        region: 'asia', difficulty: 2 },
  { id: 'ob',       name: 'the Ob',            ne: ['Ob'],            region: 'asia', difficulty: 2, where: 'Siberia' },
  { id: 'irtysh',   name: 'the Irtysh',        ne: ['Irtysh'],        region: 'asia', difficulty: 3 },
  { id: 'yenisey',  name: 'the Yenisey',       ne: ['Yenisey'],       region: 'asia', difficulty: 2, where: 'Siberia' },
  { id: 'lena',     name: 'the Lena',          ne: ['Lena'],          region: 'asia', difficulty: 2, where: 'Siberia' },
  { id: 'amur',     name: 'the Amur',          ne: ['Amur'],          region: 'asia', difficulty: 2, where: 'the Russia–China border river' },
  { id: 'kolyma',   name: 'the Kolyma',        ne: ['Kolyma'],        region: 'asia', difficulty: 3, where: 'far-eastern Siberia' },
  { id: 'amudarya', name: 'the Amu Darya',     ne: ['Amu  Darya', 'Amu Darya'], region: 'asia', difficulty: 3, where: 'Central Asia' },
  { id: 'syrdarya', name: 'the Syr Darya',     ne: ['Syr  Darya', 'Syr Darya'], region: 'asia', difficulty: 3, where: 'Central Asia' },
  { id: 'irrawaddy', name: 'the Irrawaddy',    ne: ['Irrawaddy'],     region: 'asia', difficulty: 3, where: 'Myanmar' },
  { id: 'salween',  name: 'the Salween',       ne: ['Salween'],       region: 'asia', difficulty: 3 },
  { id: 'chaophraya', name: 'the Chao Phraya', ne: ['Chao Phraya'],   region: 'asia', difficulty: 3, where: 'Thailand' },
  { id: 'narmada',  name: 'the Narmada',       ne: ['Narmada'],       region: 'asia', difficulty: 3, where: 'India' },

  // ── Africa ────────────────────────────────────────────────────────────────
  { id: 'nile',     name: 'the Nile',          ne: ['Nile'],          region: 'africa', difficulty: 1 },
  { id: 'bluenile', name: 'the Blue Nile',     ne: ['Blue Nile'],     region: 'africa', difficulty: 3 },
  { id: 'whitenile', name: 'the White Nile',   ne: ['White Nile'],    region: 'africa', difficulty: 3 },
  { id: 'congo',    name: 'the Congo',         ne: ['Congo'],         region: 'africa', difficulty: 1 },
  { id: 'niger',    name: 'the Niger',         ne: ['Niger'],         region: 'africa', difficulty: 2 },
  { id: 'zambezi',  name: 'the Zambezi',       ne: ['Zambezi'],       region: 'africa', difficulty: 2 },
  { id: 'limpopo',  name: 'the Limpopo',       ne: ['Limpopo'],       region: 'africa', difficulty: 3 },
  { id: 'orange',   name: 'the Orange River',  ne: ['Orange'],        region: 'africa', difficulty: 3, where: 'southern Africa' },
  // (The Okavango is deliberately absent: Natural Earth only carries its lowest
  //  380 km, which would make the drawn "river" unrecognisable.)
  { id: 'chari',    name: 'the Chari',         ne: ['Chari'],         region: 'africa', difficulty: 3, where: 'Chad' },
  { id: 'gambia',   name: 'the Gambia River',  ne: ['Gambia'],        region: 'africa', difficulty: 3 },
  { id: 'volta',    name: 'the Volta',         ne: ['Volta'],         region: 'africa', difficulty: 3, where: 'Ghana' },

  // ── North America ─────────────────────────────────────────────────────────
  { id: 'mississippi', name: 'the Mississippi', ne: ['Mississippi'],  region: 'north-america', difficulty: 1 },
  { id: 'missouri', name: 'the Missouri',      ne: ['Missouri'],      region: 'north-america', difficulty: 2 },
  { id: 'ohio',     name: 'the Ohio',          ne: ['Ohio'],          region: 'north-america', difficulty: 3 },
  { id: 'riogrande', name: 'the Rio Grande',   ne: ['Rio Grande'],    region: 'north-america', difficulty: 2, where: 'the USA–Mexico border river' },
  { id: 'colorado', name: 'the Colorado',      ne: ['Colorado'],      region: 'north-america', difficulty: 2, where: 'the river of the Grand Canyon' },
  { id: 'columbia', name: 'the Columbia',      ne: ['Columbia'],      region: 'north-america', difficulty: 3 },
  { id: 'yukon',    name: 'the Yukon',         ne: ['Yukon'],         region: 'north-america', difficulty: 2 },
  { id: 'mackenzie', name: 'the Mackenzie',    ne: ['Mackenzie'],     region: 'north-america', difficulty: 3, where: 'Canada' },
  { id: 'fraser',   name: 'the Fraser',        ne: ['Fraser'],        region: 'north-america', difficulty: 3, where: 'British Columbia' },
  { id: 'arkansas', name: 'the Arkansas River', ne: ['Arkansas'],     region: 'north-america', difficulty: 3 },
  { id: 'nelson',   name: 'the Nelson',        ne: ['Nelson'],        region: 'north-america', difficulty: 3, where: 'Canada' },
  { id: 'usumacinta', name: 'the Usumacinta',  ne: ['Usumacinta'],    region: 'north-america', difficulty: 3, where: 'Guatemala and Mexico' },

  // ── South America ─────────────────────────────────────────────────────────
  { id: 'amazon',   name: 'the Amazon',        ne: ['Amazonas'],      region: 'south-america', difficulty: 1 },
  { id: 'parana',   name: 'the Paraná',        ne: ['Paraná'],        region: 'south-america', difficulty: 2 },
  { id: 'orinoco',  name: 'the Orinoco',       ne: ['Orinoco'],       region: 'south-america', difficulty: 2, where: 'Venezuela' },
  { id: 'saofrancisco', name: 'the São Francisco', ne: ['São  Francisco', 'São Francisco'], region: 'south-america', difficulty: 3, where: 'Brazil' },
  { id: 'magdalena', name: 'the Magdalena',    ne: ['Magdalena'],     region: 'south-america', difficulty: 3, where: 'Colombia' },
  { id: 'uruguay',  name: 'the Uruguay River', ne: ['Uruguay'],       region: 'south-america', difficulty: 3 },
  { id: 'madeira',  name: 'the Madeira',       ne: ['Madeira'],       region: 'south-america', difficulty: 3, where: 'the biggest Amazon tributary' },
  { id: 'tocantins', name: 'the Tocantins',    ne: ['Tocantins'],     region: 'south-america', difficulty: 3, where: 'Brazil' },
  { id: 'xingu',    name: 'the Xingu',         ne: ['Xingu'],         region: 'south-america', difficulty: 3, where: 'Brazil' },
  { id: 'essequibo', name: 'the Essequibo',    ne: ['Essequibo'],     region: 'south-america', difficulty: 3, where: 'Guyana' },

  // ── Oceania ───────────────────────────────────────────────────────────────
  { id: 'murray',   name: 'the Murray',        ne: ['Murray'],        region: 'oceania', difficulty: 2, where: 'Australia' },
  { id: 'darling',  name: 'the Darling',       ne: ['Darling'],       region: 'oceania', difficulty: 3, where: 'Australia' },
  { id: 'sepik',    name: 'the Sepik',         ne: ['Sepik'],         region: 'oceania', difficulty: 3, where: 'Papua New Guinea' },
  { id: 'waikato',  name: 'the Waikato',       ne: ['Waikato'],       region: 'oceania', difficulty: 3, where: 'New Zealand' },
];

// ── Mouth override table ──────────────────────────────────────────────────────
// Approximate [lng, lat] of where each river ends. The automatic test ("which end
// of the chain is nearest a coastline?") gets a surprising number of rivers
// backwards — the source of the Niger is only 250 km from the Atlantic, the Tigris
// and the Sava end at a confluence far inland, the Amu Darya ends in the dried-up
// Aral Sea. So we simply state the mouth for every river and pick the chain end
// closest to it. These are only used to decide the DIRECTION; the drawn markers
// are always the real endpoints of the chained path.
const MOUTHS = {
  danube: [29.7, 45.2],       rhine: [4.1, 51.95],        seine: [0.2, 49.45],      loire: [-2.2, 47.28],
  rhone: [4.85, 43.35],       thames: [0.7, 51.5],        elbe: [8.85, 53.9],       oder: [14.55, 53.9],
  vistula: [18.95, 54.35],    po: [12.5, 44.95],          tiber: [12.23, 41.74],    ebro: [0.87, 40.72],
  tagus: [-9.2, 38.7],        douro: [-8.67, 41.14],      guadalquivir: [-6.35, 36.8],
  volga: [48.6, 45.8],        don: [39.3, 47.1],          dnieper: [32.3, 46.5],    sava: [20.45, 44.82],
  dniester: [30.4, 46.1],     ural: [51.85, 47.0],        'northern-dvina': [40.5, 64.6],

  yangtze: [121.8, 31.5],     huanghe: [119.1, 37.8],     mekong: [106.6, 9.6],     ganges: [90.5, 22.2],
  indus: [67.4, 24.0],        brahmaputra: [89.8, 23.8],  tigris: [47.4, 30.9],     euphrates: [47.4, 31.0],
  jordan: [35.55, 31.5],      ob: [69.0, 66.8],           irtysh: [68.9, 61.1],     yenisey: [82.5, 71.8],
  lena: [126.7, 72.4],        amur: [140.7, 53.0],        kolyma: [161.3, 69.5],    amudarya: [59.0, 44.4],
  syrdarya: [61.9, 46.1],     irrawaddy: [95.2, 15.9],    salween: [97.6, 16.5],    chaophraya: [100.6, 13.5],
  narmada: [72.6, 21.6],

  nile: [31.1, 31.5],         bluenile: [32.53, 15.62],   whitenile: [32.53, 15.62], congo: [12.4, -6.05],
  niger: [6.4, 4.4],          zambezi: [36.3, -18.9],     limpopo: [33.6, -25.2],   orange: [16.45, -28.6],
  okavango: [22.9, -19.5],    chari: [14.9, 12.9],        gambia: [-16.5, 13.5],    volta: [0.65, 5.78],

  mississippi: [-89.25, 29.15], missouri: [-90.12, 38.81], ohio: [-89.13, 37.0],    riogrande: [-97.15, 25.95],
  colorado: [-114.7, 31.8],   columbia: [-124.05, 46.25], yukon: [-164.5, 62.6],    mackenzie: [-134.5, 69.3],
  fraser: [-123.1, 49.1],     arkansas: [-91.2, 33.95],   nelson: [-92.9, 57.0],    usumacinta: [-92.6, 18.6],

  amazon: [-50.0, -0.5],      parana: [-58.4, -34.0],     orinoco: [-61.0, 8.9],    saofrancisco: [-36.4, -10.5],
  magdalena: [-74.85, 11.1],  uruguay: [-58.4, -34.0],    madeira: [-58.8, -3.35],  tocantins: [-49.4, -2.0],
  xingu: [-52.0, -1.9],       essequibo: [-58.5, 6.8],

  murray: [139.35, -35.55],   darling: [141.9, -34.1],    sepik: [144.5, -3.85],    waikato: [174.72, -37.47],
};
// If the chosen end is further than this from the declared mouth the chain is badly
// truncated (Natural Earth is missing the lower course) → drop the river.
const MOUTH_MAX_DEG = 8;

// ── Small geometry helpers ────────────────────────────────────────────────────
const round = (p, d) => [+p[0].toFixed(d), +p[1].toFixed(d)];

function haversineKm(a, b) {
  const R = 6371, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]), dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function lineKm(line) { let s = 0; for (let i = 1; i < line.length; i++) s += haversineKm(line[i - 1], line[i]); return s; }
function dist2(a, b)  { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2; }

// Douglas–Peucker: throw away points that are within `tol` of the straight line
// between the points we keep. Works in degrees, which is fine at this scale.
function simplify(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, bestD = tol;
    const [x1, y1] = pts[i], [x2, y2] = pts[j];
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
    for (let k = i + 1; k < j; k++) {
      const [x, y] = pts[k];
      let t = len2 ? ((x - x1) * dx + (y - y1) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      if (d > bestD) { bestD = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
function padBbox([x0, y0, x1, y1], share) {
  const px = Math.max((x1 - x0) * share, 0.4), py = Math.max((y1 - y0) * share, 0.4);
  return [Math.max(-180, x0 - px), Math.max(-90, y0 - py), Math.min(180, x1 + px), Math.min(90, y1 + py)];
}
const bboxOverlap = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);

// ── 1. Collect the raw line pieces of one river ───────────────────────────────
// A Natural Earth river is spread over several features, and each feature can be a
// MultiLineString. We flatten everything whose name matches into a plain list of
// polylines. "Lake Centerline" pieces are kept on purpose: they are the bits that
// run through lakes and reservoirs and they are what keeps a river connected.
function collectLines(featureCollection, names) {
  const wanted = new Set(names.map(n => n.toLowerCase()));
  const out = [];
  for (const f of featureCollection.features) {
    const p = f.properties || {};
    const candidates = [p.name_en, p.name, p.name_alt].filter(Boolean).map(s => String(s).toLowerCase());
    if (!candidates.some(c => wanted.has(c))) continue;
    const g = f.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const l of lines) if (l.length >= 2) out.push(l.map(p2 => [p2[0], p2[1]]));
  }
  return out;
}

// ── 2. Stitch the pieces into one continuous river ────────────────────────────
// Greedy chaining: start from one piece, then repeatedly glue on the unused piece
// whose end is closest to one of our two open ends (within JOIN_TOL_DEG), flipping
// it if necessary. At a fork the nearest piece wins. Because a bad starting piece
// can produce a short chain, we try EVERY piece as the seed and keep the longest
// result — cheap, since a river here has at most a few dozen pieces.
function chainLines(lines) {
  const tol2 = JOIN_TOL_DEG * JOIN_TOL_DEG;
  let best = null, bestKm = 0;

  for (let seed = 0; seed < lines.length; seed++) {
    const used = new Set([seed]);
    let chain = lines[seed].slice();

    for (;;) {
      const head = chain[0], tail = chain[chain.length - 1];
      let pick = null, pickD = tol2;
      for (let i = 0; i < lines.length; i++) {
        if (used.has(i)) continue;
        const l = lines[i], a = l[0], b = l[l.length - 1];
        // four ways to attach: to our head or tail, using the piece forwards or backwards
        const opts = [
          { d: dist2(tail, a), at: 'tail', flip: false },
          { d: dist2(tail, b), at: 'tail', flip: true },
          { d: dist2(head, b), at: 'head', flip: false },
          { d: dist2(head, a), at: 'head', flip: true },
        ];
        for (const o of opts) if (o.d < pickD) { pickD = o.d; pick = { i, ...o }; }
      }
      if (!pick) break;
      used.add(pick.i);
      const piece = pick.flip ? lines[pick.i].slice().reverse() : lines[pick.i];
      // drop the duplicated joint point
      if (pick.at === 'tail') chain = chain.concat(piece.slice(1));
      else                    chain = piece.slice(0, -1).concat(chain);
    }

    const km = lineKm(chain);
    if (km > bestKm) { bestKm = km; best = chain; }
  }
  return { path: best || [], lengthKm: bestKm };
}

// ── 3. Which end is the mouth? ────────────────────────────────────────────────
// The mouth is the end that reaches the sea, so it is the end that sits closest to
// a coastline vertex of the countries dataset. Country outlines follow the coast
// (and the shores of the Caspian and the Aral Sea), so this also works for rivers
// that end in an inland sea. Coast vertices are bucketed into 1° cells so the
// lookup only ever scans a handful of them.
function buildCoastIndex(countryFeatures) {
  const cells = new Map();
  const add = ring => { for (const p of ring) {
    const k = `${Math.floor(p[0])},${Math.floor(p[1])}`;
    let arr = cells.get(k); if (!arr) cells.set(k, arr = []);
    arr.push(p);
  } };
  for (const f of countryFeatures) {
    const g = f.geometry; if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polys) add(poly[0]);     // outer ring only = the coast / land outline
  }
  return cells;
}
function distToCoastDeg(cells, pt) {
  const cx = Math.floor(pt[0]), cy = Math.floor(pt[1]);
  for (let r = 1; r <= 12; r++) {
    let best = Infinity;
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r && r > 1) continue;   // only the new ring of cells
      const arr = cells.get(`${cx + dx},${cy + dy}`); if (!arr) continue;
      for (const p of arr) { const d = dist2(p, pt); if (d < best) best = d; }
    }
    if (best < Infinity) return Math.sqrt(best);
  }
  return Infinity;
}

// ── 4. The land shapes drawn behind the river ─────────────────────────────────
// Every country outline that pokes into the map window, simplified hard. The
// player only needs enough coastline to recognise where they are.
function buildContext(countryFeatures, window) {
  const rings = [];
  for (const f of countryFeatures) {
    const g = f.geometry; if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    for (const poly of polys) {
      const ring = poly[0];
      if (!bboxOverlap(bboxOf(ring), window)) continue;   // far-away island: skip entirely
      rings.push(ring);
    }
  }
  const diag = Math.hypot(window[2] - window[0], window[3] - window[1]);
  let tol = CTX_TOL_START * diag, out = [];
  for (let attempt = 0; attempt < 25; attempt++) {
    out = rings.map(r => simplify(r, tol)).filter(r => r.length >= 4);
    if (out.reduce((s, r) => s + r.length, 0) <= MAX_CTX_PTS) break;
    tol *= 1.35;
  }
  return out.map(r => r.map(p => round(p, 2)));
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const rivers10 = await geo.loadNaturalEarth('ne_10m_rivers_lake_centerlines');
  const rivers50 = await geo.loadNaturalEarth('ne_50m_rivers_lake_centerlines');
  const countries = (await geo.loadNaturalEarth('ne_50m_admin_0_countries')).features
    .filter(f => f.properties.ADM0_A3 !== 'ATA');            // Antarctica is never useful context
  const coast = buildCoastIndex(countries);

  const data = {}, questions = [], skipped = [];

  for (const r of RIVERS) {
    // Prefer the detailed 1:10m set; fall back to 1:50m if the name is missing there.
    let lines = collectLines(rivers10, r.ne);
    let source = '10m';
    if (!lines.length) { lines = collectLines(rivers50, r.ne); source = '50m'; }
    if (!lines.length) { skipped.push(`${r.id}: no Natural Earth feature named ${r.ne.join(' / ')}`); continue; }

    const { path: raw, lengthKm } = chainLines(lines);
    if (lengthKm < MIN_LENGTH_KM) { skipped.push(`${r.id}: longest chain only ${Math.round(lengthKm)} km`); continue; }

    // Simplify the answer key. Start gently and only coarsen if it is still too long.
    const diag0 = Math.hypot(...bboxOf(raw).map((v, i) => i < 2 ? -v : v).slice(0, 2)) || 1;
    const rawBbox = bboxOf(raw);
    const diag = Math.hypot(rawBbox[2] - rawBbox[0], rawBbox[3] - rawBbox[1]) || 1;
    let simplified = raw, tol = 0.0006 * diag;
    while (simplified.length > MAX_PATH_PTS && tol < diag) { simplified = simplify(raw, tol); tol *= 1.4; }
    let pathPts = simplified.map(p => round(p, 3));

    // Orient the path mouth → source: the end nearest the declared mouth wins.
    // Without a declared mouth we fall back to "which end is nearest the coast".
    const first = pathPts[0], last = pathPts[pathPts.length - 1];
    const hint = MOUTHS[r.id];
    let mouthIsFirst, mouthOffDeg = null;
    if (hint) {
      const dFirst = Math.sqrt(dist2(first, hint)), dLast = Math.sqrt(dist2(last, hint));
      mouthIsFirst = dFirst <= dLast;
      mouthOffDeg  = Math.min(dFirst, dLast);
      if (mouthOffDeg > MOUTH_MAX_DEG) {
        skipped.push(`${r.id}: chain ends ${mouthOffDeg.toFixed(1)}° from the real mouth — lower course missing`);
        continue;
      }
    } else {
      mouthIsFirst = distToCoastDeg(coast, first) <= distToCoastDeg(coast, last);
    }
    if (!mouthIsFirst) pathPts = pathPts.slice().reverse();

    const window = padBbox(bboxOf(pathPts), BBOX_PAD);
    const context = buildContext(countries, window);

    data[r.id] = {
      id: r.id,
      name: r.name,
      region: r.region,
      path: pathPts,
      bbox: window.map(v => +v.toFixed(3)),
      lengthKm: Math.round(lengthKm),
      mouth: pathPts[0],
      source: pathPts[pathPts.length - 1],
      context,
    };

    questions.push({
      type: 'trace',
      category: 'rivers',
      question: r.where ? `Trace the course of ${r.name} (${r.where})` : `Trace the course of ${r.name}`,
      riverId: r.id,
      difficulty: r.difficulty,
      region: r.region,
    });

    if (VERBOSE) console.log(`  ${r.id.padEnd(14)} ${String(Math.round(lengthKm)).padStart(5)} km  ${String(pathPts.length).padStart(3)} pts  ` +
      `${String(context.reduce((s, c) => s + c.length, 0)).padStart(4)} ctx pts  [${source}]  ` +
      `mouth ${pathPts[0]} → source ${pathPts[pathPts.length - 1]}` +
      (mouthOffDeg === null ? '  (auto)' : `  (${mouthOffDeg.toFixed(1)}° off)`));
  }

  fs.mkdirSync(path.dirname(OUT_DATA), { recursive: true });
  fs.writeFileSync(OUT_DATA, JSON.stringify(data));
  fs.mkdirSync(path.dirname(OUT_QS), { recursive: true });
  fs.writeFileSync(OUT_QS, JSON.stringify(questions, null, 2) + '\n');

  const bytes = fs.statSync(OUT_DATA).size;
  console.log(`✓ ${Object.keys(data).length} rivers → ${path.relative(ROOT, OUT_DATA)} (${(bytes / 1e6).toFixed(2)} MB)`);
  const byRegion = {};
  for (const v of Object.values(data)) byRegion[v.region] = (byRegion[v.region] || 0) + 1;
  console.log('  regions: ' + Object.entries(byRegion).map(([k, n]) => `${k}=${n}`).join(', '));
  console.log(`✓ ${questions.length} questions → ${path.relative(ROOT, OUT_QS)}`);
  if (skipped.length) { console.log(`\n${skipped.length} river(s) skipped:`); skipped.forEach(s => console.log('  ·', s)); }
})();
