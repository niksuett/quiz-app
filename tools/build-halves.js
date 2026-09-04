// ─────────────────────────────────────────────────────────────────────────────
// tools/build-halves.js — builds the data for the "Population Split" game.
//
//   node tools/build-halves.js            build every country (downloads are cached)
//   node tools/build-halves.js DEU JPN    build only these ISO3 codes
//   node tools/build-halves.js --check    after building: print how a line through
//                                         each capital splits the population
//
// What it produces (committed to git):
//   data/halves/<ISO3>.json   one file per country:
//       { id, name, region, bbox, cols, rows, pop:[…], total, outline:[…], capital }
//       • pop is a coarse population grid (≤ 160 × 160 cells, row-major, starting at
//         the north-west corner). Each number = people living in that cell.
//       • bbox = [minLng, minLat, maxLng, maxLat] of the grid.
//       • outline = the country's coastline / border as a list of rings, simplified
//         to ≤ 500 points in total, so the client can draw the shape.
//   data/halves/index.json    [{ id, name, total, region }, …] for every country built
//
// Where the data comes from:
//   • WorldPop "Aggregated" 2020, 1 km resolution: one GeoTIFF per country where every
//     pixel holds the estimated number of people living in that ~1 km square.
//     https://data.worldpop.org/GIS/Population/Global_2000_2020_1km/2020/<ISO3>/
//     Downloads are cached in tools/raw/worldpop/ (gitignored; 30 KB … 195 MB each).
//   • Natural Earth 1:50m country polygons (tools/raw/ne_50m_admin_0_countries.geojson)
//     for the outline.
//
// How the grid is made: the raster is read in horizontal strips (so even Russia's
// 43 000 × 4 900 pixel file fits in memory), every block of f × f pixels is summed
// into one cell (f chosen so the longer side is ≤ 160 cells), empty rows/columns at
// the edges are trimmed, and values are rounded to whole people.
//
// Some countries are CLIPPED to their main territory (see CLIP below) because the
// raster would otherwise be dominated by empty ocean: the contiguous USA without
// Alaska/Hawaii, Spain without the Canaries, New Zealand without the Chathams, …
// The outline is clipped to the same box so shape and grid always match.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const { fromFile } = require('geotiff');
const geo  = require('./lib/geo');

const ROOT     = path.join(__dirname, '..');
const RAW_DIR  = path.join(geo.RAW_DIR, 'worldpop');
const OUT_DIR  = path.join(ROOT, 'data', 'halves');
const WP_BASE  = 'https://data.worldpop.org/GIS/Population/Global_2000_2020_1km/2020/';

const MAX_SIDE      = 160;   // grid cells on the longer side
const MAX_OUTLINE   = 500;   // total outline points per country
const STRIP_ROWS    = 1024;  // raster rows read per chunk

// ── 1. The countries ──────────────────────────────────────────────────────────
// [ISO3, display name, capital name, capital lat, capital lng]
const COUNTRIES = [
  ['USA', 'United States',  'Washington, D.C.', 38.9072,  -77.0369],
  ['CAN', 'Canada',         'Ottawa',           45.4215,  -75.6972],
  ['MEX', 'Mexico',         'Mexico City',      19.4326,  -99.1332],
  ['BRA', 'Brazil',         'Brasília',        -15.7939,  -47.8828],
  ['ARG', 'Argentina',      'Buenos Aires',    -34.6037,  -58.3816],
  ['CHL', 'Chile',          'Santiago',        -33.4489,  -70.6693],
  ['PER', 'Peru',           'Lima',            -12.0464,  -77.0428],
  ['COL', 'Colombia',       'Bogotá',            4.7110,  -74.0721],
  ['GBR', 'United Kingdom', 'London',           51.5074,   -0.1278],
  ['IRL', 'Ireland',        'Dublin',           53.3498,   -6.2603],
  ['FRA', 'France',         'Paris',            48.8566,    2.3522],
  ['DEU', 'Germany',        'Berlin',           52.5200,   13.4050],
  ['ESP', 'Spain',          'Madrid',           40.4168,   -3.7038],
  ['PRT', 'Portugal',       'Lisbon',           38.7223,   -9.1393],
  ['ITA', 'Italy',          'Rome',             41.9028,   12.4964],
  ['POL', 'Poland',         'Warsaw',           52.2297,   21.0122],
  ['NLD', 'Netherlands',    'Amsterdam',        52.3676,    4.9041],
  ['SWE', 'Sweden',         'Stockholm',        59.3293,   18.0686],
  ['NOR', 'Norway',         'Oslo',             59.9139,   10.7522],
  ['FIN', 'Finland',        'Helsinki',         60.1699,   24.9384],
  ['GRC', 'Greece',         'Athens',           37.9838,   23.7275],
  ['TUR', 'Turkey',         'Ankara',           39.9334,   32.8597],
  ['UKR', 'Ukraine',        'Kyiv',             50.4501,   30.5234],
  ['RUS', 'Russia',         'Moscow',           55.7558,   37.6173],
  ['EGY', 'Egypt',          'Cairo',            30.0444,   31.2357],
  ['MAR', 'Morocco',        'Rabat',            34.0209,   -6.8416],
  ['DZA', 'Algeria',        'Algiers',          36.7538,    3.0588],
  ['NGA', 'Nigeria',        'Abuja',             9.0765,    7.3986],
  ['ZAF', 'South Africa',   'Pretoria',        -25.7479,   28.2293],
  ['KEN', 'Kenya',          'Nairobi',          -1.2921,   36.8219],
  ['ETH', 'Ethiopia',       'Addis Ababa',       8.9806,   38.7578],
  ['COD', 'DR Congo',       'Kinshasa',         -4.4419,   15.2663],
  ['SAU', 'Saudi Arabia',   'Riyadh',           24.7136,   46.6753],
  ['IRN', 'Iran',           'Tehran',           35.6892,   51.3890],
  ['IRQ', 'Iraq',           'Baghdad',          33.3152,   44.3661],
  ['PAK', 'Pakistan',       'Islamabad',        33.6844,   73.0479],
  ['IND', 'India',          'New Delhi',        28.6139,   77.2090],
  ['CHN', 'China',          'Beijing',          39.9042,  116.4074],
  ['JPN', 'Japan',          'Tokyo',            35.6762,  139.6503],
  ['KOR', 'South Korea',    'Seoul',            37.5665,  126.9780],
  ['VNM', 'Vietnam',        'Hanoi',            21.0278,  105.8342],
  ['THA', 'Thailand',       'Bangkok',          13.7563,  100.5018],
  ['IDN', 'Indonesia',      'Jakarta',          -6.2088,  106.8456],
  ['PHL', 'Philippines',    'Manila',           14.5995,  120.9842],
  ['AUS', 'Australia',      'Canberra',        -35.2809,  149.1300],
  ['NZL', 'New Zealand',    'Wellington',      -41.2865,  174.7762],
];

// Clip boxes [minLng, minLat, maxLng, maxLat] for countries whose raster is
// dominated by far-away islands / territories. Everything outside the box is
// ignored (raster AND outline). Countries not listed use their raster's bbox.
const CLIP = {
  USA: [-125.0,  24.3,  -66.5,  49.6],   // contiguous 48 states (Alaska, Hawaii excluded)
  CAN: [-141.5,  41.5,  -52.0,  76.0],   // drops the far-north islands (a few hundred people)
  RUS: [  19.0,  41.0,  180.0,  82.0],   // the sliver of Chukotka west of the antimeridian is dropped
  NZL: [ 165.5, -47.8,  179.5, -34.0],   // North + South Island (no Chatham Islands)
  CHL: [ -76.5, -56.2,  -66.0, -17.3],   // no Easter Island / Juan Fernández
  ESP: [  -9.6,  35.7,    4.5,  44.0],   // mainland + Balearics (no Canaries)
  PRT: [  -9.8,  36.8,   -6.0,  42.3],   // mainland (no Azores / Madeira)
  JPN: [ 126.0,  24.0,  146.5,  46.0],   // main islands + Okinawa (no Ogasawara)
  AUS: [ 112.5, -44.5,  154.5,  -9.5],   // mainland + Tasmania (no Lord Howe / Norfolk)
  ZAF: [  16.0, -35.5,   33.5, -22.0],   // no Prince Edward Islands
  COL: [ -79.5,  -4.5,  -66.5,  13.0],   // no San Andrés
  BRA: [ -74.5, -34.0,  -34.5,   5.5],   // no Fernando de Noronha / Trindade
  CHN: [  73.0,  18.0,  135.5,  54.0],   // no South China Sea islets
  MAR: [ -13.5,  27.6,   -0.9,  36.0],   // matches the WorldPop raster (Western Sahara excluded)
};

// ── 2. Download (cached) ──────────────────────────────────────────────────────
async function ensureRaster(iso3) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const name = `${iso3.toLowerCase()}_ppp_2020_1km_Aggregated.tif`;
  const file = path.join(RAW_DIR, name);
  const url  = `${WP_BASE}${iso3}/${name}`;

  // Is the cached file complete? Compare with the server's content-length when we can.
  if (fs.existsSync(file)) {
    let expected = null;
    try { const h = await fetch(url, { method: 'HEAD' }); if (h.ok) expected = parseInt(h.headers.get('content-length'), 10) || null; } catch (e) { /* offline: trust the file */ }
    const size = fs.statSync(file).size;
    if (!expected || expected === size) return file;
    process.stderr.write(`  cached ${name} is ${size} bytes, server says ${expected} — re-downloading\n`);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      process.stderr.write(`  ↓ ${name} … `);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const total = parseInt(r.headers.get('content-length'), 10) || 0;
      const tmp = file + '.part';
      const out = fs.createWriteStream(tmp);
      let got = 0, lastPct = -1;
      for await (const chunk of r.body) {
        out.write(chunk); got += chunk.length;
        if (total) { const pct = Math.floor(got / total * 10) * 10; if (pct !== lastPct) { process.stderr.write(`${pct}% `); lastPct = pct; } }
      }
      await new Promise((res, rej) => out.end(err => err ? rej(err) : res()));
      if (total && got !== total) throw new Error(`incomplete (${got}/${total} bytes)`);
      fs.renameSync(tmp, file);
      process.stderr.write('done\n');
      return file;
    } catch (e) {
      process.stderr.write(`failed: ${e.message}\n`);
      if (attempt === 2) throw e;
    }
  }
}

// ── 3. Raster → coarse grid ───────────────────────────────────────────────────
async function buildGrid(file, clip) {
  const tiff = await fromFile(file);
  const img  = await tiff.getImage();
  const W = img.getWidth(), H = img.getHeight();
  const [minLng, minLat, maxLng, maxLat] = img.getBoundingBox();
  const resX = (maxLng - minLng) / W, resY = (maxLat - minLat) / H;   // degrees per pixel
  const nodata = img.getGDALNoData();

  // Pixel window covered by the clip box (whole image when no clip)
  const box = clip || [minLng, minLat, maxLng, maxLat];
  const px0 = Math.max(0, Math.floor((box[0] - minLng) / resX));
  const px1 = Math.min(W, Math.ceil((box[2] - minLng) / resX));
  const py0 = Math.max(0, Math.floor((maxLat - box[3]) / resY));
  const py1 = Math.min(H, Math.ceil((maxLat - box[1]) / resY));
  const w = px1 - px0, h = py1 - py0;
  if (w <= 0 || h <= 0) throw new Error('clip box does not overlap the raster');

  const f    = Math.ceil(Math.max(w, h) / MAX_SIDE);       // pixels per cell side
  const cols = Math.ceil(w / f), rows = Math.ceil(h / f);
  const grid = new Float64Array(cols * rows);

  // Read the window in strips so huge rasters never sit in memory at once.
  for (let y = py0; y < py1; y += STRIP_ROWS) {
    const yEnd = Math.min(py1, y + STRIP_ROWS);
    const [data] = await img.readRasters({ window: [px0, y, px1, yEnd], samples: [0] });
    const stripH = yEnd - y;
    for (let sy = 0; sy < stripH; sy++) {
      const r = Math.floor((y + sy - py0) / f);
      const rowBase = sy * w;
      for (let sx = 0; sx < w; sx++) {
        const v = data[rowBase + sx];
        if (v > 0 && v !== nodata) grid[r * cols + Math.floor(sx / f)] += v;
      }
    }
  }

  // Round to whole people, then trim empty margins
  const ints = Array.from(grid, v => Math.round(v));
  let r0 = 0, r1 = rows - 1, c0 = 0, c1 = cols - 1;
  const rowEmpty = r => { for (let c = 0; c < cols; c++) if (ints[r * cols + c]) return false; return true; };
  const colEmpty = c => { for (let r = 0; r < rows; r++) if (ints[r * cols + c]) return false; return true; };
  while (r0 < r1 && rowEmpty(r0)) r0++;
  while (r1 > r0 && rowEmpty(r1)) r1--;
  while (c0 < c1 && colEmpty(c0)) c0++;
  while (c1 > c0 && colEmpty(c1)) c1--;
  const tCols = c1 - c0 + 1, tRows = r1 - r0 + 1;
  const pop = new Array(tCols * tRows);
  let total = 0;
  for (let r = 0; r < tRows; r++) for (let c = 0; c < tCols; c++) { const v = ints[(r + r0) * cols + (c + c0)]; pop[r * tCols + c] = v; total += v; }

  const cellW = f * resX, cellH = f * resY;
  const gridMinLng = minLng + (px0 + c0 * f) * resX;
  const gridMaxLat = maxLat - (py0 + r0 * f) * resY;
  const bbox = [gridMinLng, gridMaxLat - tRows * cellH, gridMinLng + tCols * cellW, gridMaxLat].map(v => +v.toFixed(4));
  return { bbox, cols: tCols, rows: tRows, pop, total, cellKm: Math.round(f * resY * 111) };
}

// ── 4. Outline: clip → drop specks → simplify to ≤ 500 points ────────────────
// Sutherland–Hodgman: clip one ring against an axis-aligned rectangle.
function clipRing(ring, [x0, y0, x1, y1]) {
  const edges = [
    [p => p[0] >= x0, (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])]],
    [p => p[0] <= x1, (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])]],
    [p => p[1] >= y0, (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0]],
    [p => p[1] <= y1, (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1]],
  ];
  let out = ring;
  for (const [inside, intersect] of edges) {
    const input = out; out = [];
    if (!input.length) break;
    let prev = input[input.length - 1];
    for (const cur of input) {
      if (inside(cur)) { if (!inside(prev)) out.push(intersect(prev, cur)); out.push(cur); }
      else if (inside(prev)) out.push(intersect(prev, cur));
      prev = cur;
    }
  }
  return out;
}

// Signed area in "square degrees" corrected for latitude (good enough for ranking rings).
function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]);
  const midLat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  return Math.abs(a / 2) * Math.cos(midLat * Math.PI / 180);
}

// Douglas–Peucker on an open polyline
function simplifyLine(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = pts[s], [bx, by] = pts[e];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let best = -1, bestD = tol;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else { const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)); d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)); }
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([s, best], [best, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function simplifyRing(ring, tol) {
  // Split the closed ring in two halves so DP has proper endpoints, then rejoin.
  const mid = Math.floor(ring.length / 2);
  const a = simplifyLine(ring.slice(0, mid + 1), tol), b = simplifyLine(ring.slice(mid), tol);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

function buildOutline(feature, clip) {
  const g = feature.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  // Outer rings only (holes are irrelevant at this scale), clipped, dropping tiny specks
  let rings = polys.map(p => clipRing(p[0], clip)).filter(r => r.length >= 4);
  rings = rings.map(r => ({ r, area: ringArea(r) })).sort((a, b) => b.area - a.area);
  const totalArea = rings.reduce((s, x) => s + x.area, 0);
  rings = rings.filter((x, i) => i === 0 || (x.area >= totalArea * 0.003 && i < 30)).map(x => x.r);

  // Binary-search the simplification tolerance until we fit the point budget
  let lo = 0, hi = 3, out = rings;
  const count = rs => rs.reduce((s, r) => s + r.length, 0);
  if (count(rings) > MAX_OUTLINE) {
    for (let it = 0; it < 30; it++) {
      const tol = (lo + hi) / 2;
      const s = rings.map(r => simplifyRing(r, tol)).filter(r => r.length >= 4);
      if (count(s) > MAX_OUTLINE) lo = tol; else { hi = tol; out = s; }
    }
  }
  return out.map(r => r.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]));
}

// ── 5. Main ───────────────────────────────────────────────────────────────────
(async () => {
  const args   = process.argv.slice(2);
  const check  = args.includes('--check');
  const wanted = args.filter(a => /^[A-Z]{3}$/.test(a));
  const list   = wanted.length ? COUNTRIES.filter(c => wanted.includes(c[0])) : COUNTRIES;

  if (check) return runCheck(list);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const features = (await geo.loadNaturalEarth('ne_50m_admin_0_countries')).features;
  const index = fs.existsSync(path.join(OUT_DIR, 'index.json')) && wanted.length
    ? JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8')) : [];
  const failed = [];
  let bytes = 0;

  for (const [id, name, capName, capLat, capLng] of list) {
    process.stderr.write(`${id} ${name}\n`);
    try {
      const feature = features.find(f => f.properties.ADM0_A3 === id);
      if (!feature) throw new Error('not found in Natural Earth');
      const file = await ensureRaster(id);
      const clipBox = CLIP[id] || null;
      const grid = await buildGrid(file, clipBox);
      // Outline clip = explicit clip, else the raster's own extent (plus a hair so borders survive)
      const outlineClip = clipBox || (() => {
        const b = grid.bbox; return [b[0] - 0.05, b[1] - 0.05, b[2] + 0.05, b[3] + 0.05];
      })();
      const outline = buildOutline(feature, outlineClip);
      const region  = geo.regionForCountry(feature, capLng);
      if (!region) throw new Error('no region');

      const country = {
        id, name, region, bbox: grid.bbox, cols: grid.cols, rows: grid.rows,
        pop: grid.pop, total: grid.total, outline,
        capital: { name: capName, lat: capLat, lng: capLng },
      };
      const outFile = path.join(OUT_DIR, `${id}.json`);
      // Compact but readable: one key per line, the big arrays on a single line each
      const json = '{\n' + Object.entries(country).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n') + '\n}\n';
      fs.writeFileSync(outFile, json);
      bytes += json.length;
      const idx = { id, name, total: grid.total, region };
      const at = index.findIndex(x => x.id === id);
      if (at >= 0) index[at] = idx; else index.push(idx);
      console.log(`  ✓ ${grid.cols}×${grid.rows} cells (~${grid.cellKm} km), ${grid.total.toLocaleString('en-US')} people, outline ${outline.reduce((s, r) => s + r.length, 0)} pts in ${outline.length} rings, ${(json.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      failed.push(`${id}: ${e.message}`);
      console.log(`  ✗ skipped — ${e.message}`);
    }
  }

  index.sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  console.log(`\n✓ data/halves/index.json — ${index.length} countries, ${(bytes / 1024 / 1024).toFixed(2)} MB written this run`);
  if (failed.length) console.log(`✗ ${failed.length} failed:\n  ${failed.join('\n  ')}`);
  writeQuestions(index);
})().catch(e => { console.error('✗', e.message); process.exit(1); });

// ── 7. Questions: one per country → content/halves.json ───────────────────────
// Difficulty: 1 = one obvious megacity dominates (Cairo, Buenos Aires, Tokyo …),
// 2 = a clear centre of gravity but not obvious, 3 = people are spread evenly.
const DIFFICULTY = {
  1: ['EGY', 'ARG', 'CHL', 'AUS', 'JPN', 'KOR', 'PER', 'THA'],
  3: ['DEU', 'POL', 'IND', 'NGA', 'NLD'],
};
// The name players see in the prompt when only part of a country is on the board.
const PROMPT_NAME = {
  USA: 'the contiguous USA', FRA: 'mainland France', ESP: 'mainland Spain', PRT: 'mainland Portugal',
  CHL: 'mainland Chile', GBR: 'the United Kingdom', NLD: 'the Netherlands', PHL: 'the Philippines',
};
// Several phrasings so the prompt does not read identically every round.
const TEMPLATES = [
  n => `Draw a line that splits ${n}'s population in half`,
  n => `Slice ${n} so that half of its people are on each side of the line`,
  n => `Where does the line run that divides ${n}'s population 50/50?`,
  n => `Split ${n} into two halves — by people, not by land`,
];
const possessive = n => n.endsWith('s') ? `${n}'` : `${n}'s`;

function writeQuestions(index) {
  const outFile = path.join(ROOT, 'content', 'halves.json');
  const questions = index.map((c, i) => {
    const name = PROMPT_NAME[c.id] || c.name;
    const difficulty = DIFFICULTY[1].includes(c.id) ? 1 : DIFFICULTY[3].includes(c.id) ? 3 : 2;
    const tpl = TEMPLATES[i % TEMPLATES.length];
    // Template 0 and 2 use a possessive; keep "the contiguous USA's" readable
    const question = (tpl === TEMPLATES[0] || tpl === TEMPLATES[2]) ? tpl(name).replace(`${name}'s`, possessive(name)) : tpl(name);
    return { type: 'halves', category: 'halves', question, regionId: c.id, region: c.region, difficulty };
  });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(questions, null, 2) + '\n');
  const byDiff = [1, 2, 3].map(d => `${d}: ${questions.filter(q => q.difficulty === d).length}`).join(', ');
  console.log(`✓ content/halves.json — ${questions.length} questions, difficulty ${byDiff}`);
}

// ── 6. --check: sanity-check the split maths through the capital ──────────────
// A north–south and an east–west line through each capital, plus where the
// "ideal" line of the same direction actually lies. Uses games/halves.js so the
// numbers are exactly what the game will compute.
function runCheck(list) {
  const halves = require('../games/halves');
  for (const [id, name] of list) {
    const c = halves._country(id);
    if (!c) { console.log(`${id} — no data`); continue; }
    const { lat, lng } = c.capital;
    for (const [label, a, b] of [['N–S', [lng, lat - 1], [lng, lat + 1]], ['E–W', [lng - 1, lat], [lng + 1, lat]]]) {
      const s = halves._split(c, a, b);
      const q = halves._quality(s.imbalance);
      console.log(`${id.padEnd(4)} ${name.padEnd(15)} ${label} through ${c.capital.name.padEnd(17)} → ${s.pctA.toFixed(1).padStart(5)}% / ${s.pctB.toFixed(1).padStart(5)}%  score ${String(Math.round(q * 100)).padStart(3)}   ideal line is ${Math.round(s.shiftKm)} km away`);
    }
  }
}
