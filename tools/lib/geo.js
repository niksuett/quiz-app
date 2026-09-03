// ─────────────────────────────────────────────────────────────────────────────
// tools/lib/geo.js — geometry helpers for the data build scripts (Node only).
//
//  • loadNaturalEarth(name)  downloads a Natural Earth GeoJSON into tools/raw/ (once) and parses it
//  • pointInPolygon / pointInFeature   ray casting for Polygon and MultiPolygon
//  • continentOf(lng, lat)   → our region id ('europe', 'asia', …) or null
//  • countryOf(lng, lat)     → the Natural Earth feature containing the point (or nearest)
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const RAW_DIR = path.join(__dirname, '..', 'raw');
const NE_BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';

async function loadNaturalEarth(name) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const file = path.join(RAW_DIR, `${name}.geojson`);
  if (!fs.existsSync(file)) {
    process.stderr.write(`↓ downloading ${name}.geojson … `);
    const r = await fetch(NE_BASE + `${name}.geojson`);
    if (!r.ok) throw new Error(`download failed: ${r.status}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    process.stderr.write('done\n');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function pointInPolygon(x, y, polygon) {           // polygon = [outerRing, hole, hole…]
  if (!pointInRing(x, y, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) if (pointInRing(x, y, polygon[i])) return false;
  return true;
}
function pointInFeature(x, y, feature) {
  const g = feature.geometry;
  if (!g) return false;
  if (g.type === 'Polygon')      return pointInPolygon(x, y, g.coordinates);
  if (g.type === 'MultiPolygon') return g.coordinates.some(poly => pointInPolygon(x, y, poly));
  return false;
}

// Squared distance from a point to the nearest vertex of a feature (cheap "nearest country")
function nearestVertexDist2(x, y, feature) {
  let best = Infinity;
  const visit = ring => { for (const [px, py] of ring) { const d = (px - x) ** 2 + (py - y) ** 2; if (d < best) best = d; } };
  const g = feature.geometry;
  if (g.type === 'Polygon') g.coordinates.forEach(visit);
  else if (g.type === 'MultiPolygon') g.coordinates.forEach(poly => poly.forEach(visit));
  return best;
}

// Natural Earth CONTINENT → our region ids
const CONTINENT_MAP = {
  'Europe': 'europe', 'Asia': 'asia', 'Africa': 'africa',
  'North America': 'north-america', 'South America': 'south-america', 'Oceania': 'oceania',
};

let countriesCache = null;
async function countries() {
  if (!countriesCache) countriesCache = (await loadNaturalEarth('ne_50m_admin_0_countries')).features;
  return countriesCache;
}

async function countryOf(lng, lat, { nearest = true } = {}) {
  const feats = await countries();
  let hit = feats.find(f => pointInFeature(lng, lat, f));
  if (!hit && nearest) {
    let best = Infinity;
    for (const f of feats) { const d = nearestVertexDist2(lng, lat, f); if (d < best) { best = d; hit = f; } }
    if (best > 15 * 15) return null;   // more than ~15° from any land: give up
  }
  return hit || null;
}

function regionForCountry(feature, lng) {
  if (!feature) return null;
  const p = feature.properties;
  // Russia is tagged "Europe" by Natural Earth; treat Siberia as Asia
  if (p.ADM0_A3 === 'RUS') return lng > 60 ? 'asia' : 'europe';
  if (p.ADM0_A3 === 'TUR') return 'asia';
  return CONTINENT_MAP[p.CONTINENT] || null;
}

async function continentOf(lng, lat) {
  const f = await countryOf(lng, lat);
  return regionForCountry(f, lng);
}

// ISO alpha-2 (lowercase) → region, using Natural Earth's ISO_A2_EH field (ISO_A2 is -99 for France etc.)
async function regionForIso2(iso2) {
  const feats = await countries();
  const code = String(iso2 || '').toUpperCase();
  const f = feats.find(x => x.properties.ISO_A2_EH === code || x.properties.ISO_A2 === code || x.properties.WB_A2 === code);
  if (!f) return null;
  const c = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0][0][0];
  return regionForCountry(f, c ? c[0] : 0);
}

module.exports = { loadNaturalEarth, pointInPolygon, pointInFeature, countries, countryOf, continentOf, regionForCountry, regionForIso2, RAW_DIR, CONTINENT_MAP };
