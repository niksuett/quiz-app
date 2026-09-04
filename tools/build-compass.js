// ─────────────────────────────────────────────────────────────────────────────
// tools/build-compass.js — builds the data + questions for the "Compass" game.
//
//   node tools/build-compass.js
//
// What it produces (both committed to git):
//   data/cities.json      ~150 famous world cities: { id: { name, country, lat, lng, pop, region } }
//   content/compass.json  the question list for import.js ("From Paris, which direction is Cairo?")
//
// Where the data comes from:
//   tools/raw/cities15000.txt — GeoNames "cities15000" dump (every place with 15 000+
//   inhabitants). It is tab-separated; we only need name, country, lat/lng, population.
//   If only the .zip is present the script unzips it with the "unzip" command (Git Bash has it).
//
// The script is idempotent: run it as often as you like, it always rewrites the two
// output files from scratch. It FAILS LOUDLY if a curated city cannot be found in
// GeoNames, so a typo in the list below never silently produces a wrong coordinate.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const geo  = require('./lib/geo');

const ROOT     = path.join(__dirname, '..');
const RAW_DIR  = geo.RAW_DIR;
const RAW_TXT  = path.join(RAW_DIR, 'cities15000.txt');
const RAW_ZIP  = path.join(RAW_DIR, 'cities15000.zip');
const OUT_DATA = path.join(ROOT, 'data', 'cities.json');
const OUT_QS   = path.join(ROOT, 'content', 'compass.json');

// Bearings become meaningless near the antipode (every direction is "the shortest"),
// so pairs further apart than this are skipped.
const MAX_DISTANCE_KM = 18500;

// ── 1. The curated city list ──────────────────────────────────────────────────
// [id, display name, ISO-3166 alpha-2 country, optional GeoNames name to match]
// The 4th entry is only needed when the display name differs from what GeoNames
// calls the place (e.g. we say "Mexico City", GeoNames also says "Mexico City" — fine;
// but we say "Kyiv" while an older dump might say "Kiev").
const CITIES = [
  // Europe
  ['london', 'London', 'GB'], ['paris', 'Paris', 'FR'], ['berlin', 'Berlin', 'DE'], ['madrid', 'Madrid', 'ES'],
  ['rome', 'Rome', 'IT'], ['lisbon', 'Lisbon', 'PT'], ['amsterdam', 'Amsterdam', 'NL'], ['brussels', 'Brussels', 'BE'],
  ['vienna', 'Vienna', 'AT'], ['zurich', 'Zurich', 'CH'], ['geneva', 'Geneva', 'CH'], ['prague', 'Prague', 'CZ'],
  ['warsaw', 'Warsaw', 'PL'], ['budapest', 'Budapest', 'HU'], ['athens', 'Athens', 'GR'], ['istanbul', 'Istanbul', 'TR'],
  ['moscow', 'Moscow', 'RU'], ['saint-petersburg', 'Saint Petersburg', 'RU'], ['kyiv', 'Kyiv', 'UA'],
  ['stockholm', 'Stockholm', 'SE'], ['oslo', 'Oslo', 'NO'], ['copenhagen', 'Copenhagen', 'DK'], ['helsinki', 'Helsinki', 'FI'],
  ['reykjavik', 'Reykjavik', 'IS'], ['dublin', 'Dublin', 'IE'], ['edinburgh', 'Edinburgh', 'GB'], ['manchester', 'Manchester', 'GB'],
  ['barcelona', 'Barcelona', 'ES'], ['milan', 'Milan', 'IT'], ['naples', 'Naples', 'IT'], ['venice', 'Venice', 'IT'],
  ['munich', 'Munich', 'DE'], ['hamburg', 'Hamburg', 'DE'], ['frankfurt', 'Frankfurt', 'DE', 'Frankfurt am Main'],
  ['marseille', 'Marseille', 'FR'], ['bucharest', 'Bucharest', 'RO'], ['sofia', 'Sofia', 'BG'], ['belgrade', 'Belgrade', 'RS'],
  ['zagreb', 'Zagreb', 'HR'], ['krakow', 'Krakow', 'PL'], ['porto', 'Porto', 'PT'], ['seville', 'Seville', 'ES'],
  ['tallinn', 'Tallinn', 'EE'], ['riga', 'Riga', 'LV'], ['vilnius', 'Vilnius', 'LT'], ['minsk', 'Minsk', 'BY'],
  // Asia
  ['tokyo', 'Tokyo', 'JP'], ['osaka', 'Osaka', 'JP'], ['seoul', 'Seoul', 'KR'], ['beijing', 'Beijing', 'CN'],
  ['shanghai', 'Shanghai', 'CN'], ['hong-kong', 'Hong Kong', 'HK'], ['taipei', 'Taipei', 'TW'], ['manila', 'Manila', 'PH'],
  ['bangkok', 'Bangkok', 'TH'], ['singapore', 'Singapore', 'SG'], ['kuala-lumpur', 'Kuala Lumpur', 'MY'], ['jakarta', 'Jakarta', 'ID'],
  ['hanoi', 'Hanoi', 'VN'], ['ho-chi-minh-city', 'Ho Chi Minh City', 'VN'], ['delhi', 'Delhi', 'IN'], ['mumbai', 'Mumbai', 'IN'],
  ['bengaluru', 'Bengaluru', 'IN'], ['kolkata', 'Kolkata', 'IN'], ['chennai', 'Chennai', 'IN'], ['karachi', 'Karachi', 'PK'],
  ['lahore', 'Lahore', 'PK'], ['dhaka', 'Dhaka', 'BD'], ['kathmandu', 'Kathmandu', 'NP'], ['colombo', 'Colombo', 'LK'],
  ['tehran', 'Tehran', 'IR'], ['baghdad', 'Baghdad', 'IQ'], ['riyadh', 'Riyadh', 'SA'], ['jeddah', 'Jeddah', 'SA'],
  ['dubai', 'Dubai', 'AE'], ['abu-dhabi', 'Abu Dhabi', 'AE'], ['doha', 'Doha', 'QA'], ['muscat', 'Muscat', 'OM'],
  ['tel-aviv', 'Tel Aviv', 'IL'], ['jerusalem', 'Jerusalem', 'IL'], ['beirut', 'Beirut', 'LB'], ['amman', 'Amman', 'JO'],
  ['tashkent', 'Tashkent', 'UZ'], ['almaty', 'Almaty', 'KZ'], ['ulaanbaatar', 'Ulaanbaatar', 'MN'], ['kabul', 'Kabul', 'AF'],
  ['vladivostok', 'Vladivostok', 'RU'], ['novosibirsk', 'Novosibirsk', 'RU'], ['tbilisi', 'Tbilisi', 'GE'], ['baku', 'Baku', 'AZ'],
  // Africa
  ['cairo', 'Cairo', 'EG'], ['alexandria', 'Alexandria', 'EG'], ['casablanca', 'Casablanca', 'MA'], ['marrakesh', 'Marrakesh', 'MA'],
  ['algiers', 'Algiers', 'DZ'], ['tunis', 'Tunis', 'TN'], ['tripoli', 'Tripoli', 'LY'], ['khartoum', 'Khartoum', 'SD'],
  ['addis-ababa', 'Addis Ababa', 'ET'], ['nairobi', 'Nairobi', 'KE'], ['mombasa', 'Mombasa', 'KE'], ['kampala', 'Kampala', 'UG'],
  ['dar-es-salaam', 'Dar es Salaam', 'TZ'], ['kinshasa', 'Kinshasa', 'CD'], ['lagos', 'Lagos', 'NG'], ['abuja', 'Abuja', 'NG'],
  ['accra', 'Accra', 'GH'], ['dakar', 'Dakar', 'SN'], ['luanda', 'Luanda', 'AO'], ['lusaka', 'Lusaka', 'ZM'],
  ['harare', 'Harare', 'ZW'], ['johannesburg', 'Johannesburg', 'ZA'], ['cape-town', 'Cape Town', 'ZA'], ['durban', 'Durban', 'ZA'],
  ['antananarivo', 'Antananarivo', 'MG'], ['windhoek', 'Windhoek', 'NA'],
  // North America
  ['new-york', 'New York', 'US', 'New York City'], ['los-angeles', 'Los Angeles', 'US'], ['chicago', 'Chicago', 'US'],
  ['houston', 'Houston', 'US'], ['miami', 'Miami', 'US'], ['washington', 'Washington, D.C.', 'US', 'Washington'],
  ['boston', 'Boston', 'US'], ['san-francisco', 'San Francisco', 'US'], ['seattle', 'Seattle', 'US'], ['denver', 'Denver', 'US'],
  ['las-vegas', 'Las Vegas', 'US'], ['new-orleans', 'New Orleans', 'US'], ['atlanta', 'Atlanta', 'US'], ['dallas', 'Dallas', 'US'],
  ['anchorage', 'Anchorage', 'US'], ['honolulu', 'Honolulu', 'US'],
  ['toronto', 'Toronto', 'CA'], ['vancouver', 'Vancouver', 'CA'], ['montreal', 'Montreal', 'CA', 'Montréal'], ['calgary', 'Calgary', 'CA'],
  ['mexico-city', 'Mexico City', 'MX'], ['guadalajara', 'Guadalajara', 'MX'], ['cancun', 'Cancún', 'MX', 'Cancún'],
  ['havana', 'Havana', 'CU'], ['panama-city', 'Panama City', 'PA', 'Panamá'], ['san-jose-cr', 'San José', 'CR', 'San José'],
  ['guatemala-city', 'Guatemala City', 'GT'], ['kingston', 'Kingston', 'JM'], ['santo-domingo', 'Santo Domingo', 'DO'],
  // South America
  ['sao-paulo', 'São Paulo', 'BR', 'São Paulo'], ['rio-de-janeiro', 'Rio de Janeiro', 'BR'], ['brasilia', 'Brasília', 'BR', 'Brasília'],
  ['salvador', 'Salvador', 'BR'], ['manaus', 'Manaus', 'BR'], ['buenos-aires', 'Buenos Aires', 'AR'], ['santiago', 'Santiago', 'CL'],
  ['lima', 'Lima', 'PE'], ['bogota', 'Bogotá', 'CO', 'Bogotá'], ['caracas', 'Caracas', 'VE'], ['quito', 'Quito', 'EC'],
  ['la-paz', 'La Paz', 'BO'], ['montevideo', 'Montevideo', 'UY'], ['asuncion', 'Asunción', 'PY', 'Asunción'],
  // Oceania
  ['sydney', 'Sydney', 'AU'], ['melbourne', 'Melbourne', 'AU'], ['brisbane', 'Brisbane', 'AU'], ['perth', 'Perth', 'AU'],
  ['adelaide', 'Adelaide', 'AU'], ['darwin', 'Darwin', 'AU'], ['auckland', 'Auckland', 'NZ'], ['wellington', 'Wellington', 'NZ'],
  ['port-moresby', 'Port Moresby', 'PG'], ['suva', 'Suva', 'FJ'],
];

// A few cities where GeoNames' country polygon lookup gives a debatable region.
const REGION_OVERRIDES = { istanbul: 'europe', honolulu: 'oceania' };

// ── 2. The curated question pairs ─────────────────────────────────────────────
// [fromId, toId, difficulty]. The bearing is computed, never typed by hand.
//   difficulty 1 = most people can point roughly the right way
//   difficulty 2 = solid trivia — the great circle bends noticeably
//   difficulty 3 = expert — the answer surprises almost everyone
const PAIRS = [
  // (a) Same continent — Europe
  ['paris', 'berlin', 1], ['london', 'rome', 1], ['madrid', 'lisbon', 1], ['berlin', 'moscow', 1],
  ['rome', 'athens', 1], ['amsterdam', 'vienna', 1], ['stockholm', 'madrid', 2], ['dublin', 'istanbul', 2],
  ['lisbon', 'warsaw', 2], ['oslo', 'rome', 2], ['vienna', 'london', 2], ['athens', 'paris', 2],
  ['barcelona', 'amsterdam', 2],
  ['copenhagen', 'istanbul', 2], ['istanbul', 'london', 2], ['reykjavik', 'moscow', 2], ['zurich', 'stockholm', 2],
  
  // (a) Same continent — Asia
  ['tokyo', 'beijing', 1], ['delhi', 'mumbai', 1], ['bangkok', 'singapore', 1], ['seoul', 'tokyo', 1],
  ['beijing', 'shanghai', 1], ['hong-kong', 'tokyo', 2], ['dubai', 'delhi', 2], ['singapore', 'hong-kong', 2],
  ['tehran', 'beijing', 2], ['riyadh', 'tokyo', 3],
  ['delhi', 'beijing', 2], ['tokyo', 'singapore', 2], ['istanbul', 'tokyo', 3], ['seoul', 'dubai', 3],
  
  // (a) Same continent — Africa
  ['cairo', 'cape-town', 1], ['nairobi', 'cairo', 1], ['lagos', 'nairobi', 2], ['johannesburg', 'lagos', 2],
  ['casablanca', 'cairo', 2], ['addis-ababa', 'dakar', 2],
  // (a) Same continent — North America
  ['new-york', 'los-angeles', 1], ['chicago', 'miami', 1], ['toronto', 'mexico-city', 1], ['san-francisco', 'new-york', 1],
  ['vancouver', 'mexico-city', 2], ['seattle', 'miami', 2], ['havana', 'toronto', 2], ['los-angeles', 'chicago', 2],
  ['anchorage', 'new-york', 3],
  // (a) Same continent — South America
  ['buenos-aires', 'rio-de-janeiro', 1], ['lima', 'bogota', 1], ['santiago', 'buenos-aires', 1], ['sao-paulo', 'lima', 2],
  ['caracas', 'buenos-aires', 2],
  // (a) Same continent — Oceania
  ['sydney', 'perth', 1], ['auckland', 'sydney', 1], ['melbourne', 'brisbane', 1],
  // (b) Intercontinental — the great circle bends: these are the "really?!" ones
  ['london', 'new-york', 1], ['paris', 'cairo', 1],
  ['london', 'tokyo', 2], ['new-york', 'madrid', 2], ['singapore', 'london', 2], ['cape-town', 'rio-de-janeiro', 2],
  ['johannesburg', 'sydney', 2], ['dubai', 'sydney', 2], ['rio-de-janeiro', 'lisbon', 2], ['cairo', 'mumbai', 2],
  ['miami', 'lagos', 2], ['vancouver', 'london', 2], ['auckland', 'los-angeles', 2], ['mumbai', 'london', 2],
  ['nairobi', 'sydney', 2], ['rome', 'buenos-aires', 2], ['honolulu', 'tokyo', 2],
  ['madrid', 'mexico-city', 2], ['buenos-aires', 'cape-town', 2],
  ['sao-paulo', 'nairobi', 2],
  ['los-angeles', 'tokyo', 3], ['buenos-aires', 'sydney', 3], ['moscow', 'los-angeles', 3], ['delhi', 'new-york', 3],
  ['london', 'sydney', 3], ['tokyo', 'san-francisco', 3], ['sydney', 'santiago', 3], ['seoul', 'paris', 3],
  ['toronto', 'beijing', 3], ['mexico-city', 'tokyo', 3], ['reykjavik', 'tokyo', 3], ['beijing', 'new-york', 3],
  
  ['hong-kong', 'san-francisco', 3], ['new-york', 'tokyo', 3],
];

// ── 3. Geometry helpers (same formulas as games/_shared.js) ───────────────────
const toRad = d => d * Math.PI / 180;
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function bearingDeg(lat1, lng1, lat2, lng2) {
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compassName = b => COMPASS16[Math.round(((b % 360) + 360) % 360 / 22.5) % 16];

// ── 4. Load GeoNames ──────────────────────────────────────────────────────────
function ensureRawText() {
  if (fs.existsSync(RAW_TXT)) return;
  if (!fs.existsSync(RAW_ZIP)) {
    throw new Error(`Missing ${RAW_ZIP}. Download https://download.geonames.org/export/dump/cities15000.zip into tools/raw/ first.`);
  }
  process.stderr.write('unzipping cities15000.zip … ');
  execSync(`unzip -p "${RAW_ZIP}" cities15000.txt > "${RAW_TXT}"`, { shell: process.platform === 'win32' ? 'bash' : undefined });
  process.stderr.write('done\n');
}

// Returns an index: "COUNTRY|lowercased name" → [candidate rows]. Every row is
// indexed under its main name, its ASCII name and every alternate name, so we
// can look up "Kyiv", "Kiev" or "Київ" and land on the same city.
function loadGeoNames() {
  ensureRawText();
  const index = new Map();
  const add = (key, row) => { const k = key.toLowerCase(); if (!index.has(k)) index.set(k, []); index.get(k).push(row); };
  for (const line of fs.readFileSync(RAW_TXT, 'utf8').split('\n')) {
    if (!line) continue;
    const c = line.split('\t');
    // Columns: 0 id, 1 name, 2 asciiname, 3 alternatenames, 4 lat, 5 lng, 6 fclass, 7 fcode, 8 country, …, 14 population
    if (c[6] !== 'P') continue;                     // P = populated place
    const row = { name: c[1], ascii: c[2], lat: parseFloat(c[4]), lng: parseFloat(c[5]), country: c[8], pop: parseInt(c[14], 10) || 0, fcode: c[7] };
    add(`${row.country}|${row.name}`, row);
    add(`${row.country}|${row.ascii}`, row);
    for (const alt of c[3].split(',')) if (alt) add(`${row.country}|${alt}`, row);
  }
  return index;
}

function findCity(index, [id, name, country, match]) {
  const keys = [match, name].filter(Boolean).map(n => `${country}|${n}`.toLowerCase());
  let rows = [];
  for (const k of keys) if (index.has(k)) { rows = index.get(k); break; }
  if (!rows.length) throw new Error(`City "${name}" (${country}) not found in GeoNames — check the spelling in CITIES or add a 4th "match" entry.`);
  // Several rows can share a name (e.g. suburbs called "Paris"); the real one is the most populous.
  // Capitals (PPLC) and big cities (PPLA) win over sections of a city (PPLX) with the same name.
  const rank = r => (r.fcode === 'PPLX' ? -1 : 0) * 1e9 + r.pop;
  return rows.slice().sort((a, b) => rank(b) - rank(a))[0];
}

// ── 5. Main ───────────────────────────────────────────────────────────────────
(async () => {
  const index  = loadGeoNames();
  const cities = {};
  const seen   = new Set();
  for (const entry of CITIES) {
    const [id, name, country] = entry;
    if (seen.has(id)) throw new Error(`Duplicate city id "${id}"`);
    seen.add(id);
    const row = findCity(index, entry);
    if (row.pop < 15000) throw new Error(`"${name}" matched a tiny place (pop ${row.pop}) — probably the wrong one`);
    // Region: which continent polygon contains the city (falls back to the country's continent)
    let region = REGION_OVERRIDES[id];
    if (!region) {
      const feature = await geo.countryOf(row.lng, row.lat);
      region = geo.regionForCountry(feature, row.lng) || await geo.regionForIso2(country);
    }
    if (!region) throw new Error(`No region for ${name} (${country})`);
    cities[id] = { name, country, lat: +row.lat.toFixed(4), lng: +row.lng.toFixed(4), pop: row.pop, region };
  }
  fs.mkdirSync(path.dirname(OUT_DATA), { recursive: true });
  fs.writeFileSync(OUT_DATA, JSON.stringify(cities, null, 1) + '\n');
  console.log(`✓ data/cities.json — ${Object.keys(cities).length} cities`);

  // Questions
  const questions = [];
  const pairSeen  = new Set();
  let skipped = 0;
  for (const [fromId, toId, difficulty] of PAIRS) {
    const from = cities[fromId], to = cities[toId];
    if (!from) throw new Error(`Pair uses unknown city "${fromId}"`);
    if (!to)   throw new Error(`Pair uses unknown city "${toId}"`);
    if (fromId === toId) throw new Error(`Pair ${fromId}→${toId} points at itself`);
    const key = `${fromId}>${toId}`;
    if (pairSeen.has(key)) throw new Error(`Duplicate pair ${key}`);
    pairSeen.add(key);
    const distanceKm = haversineKm(from.lat, from.lng, to.lat, to.lng);
    if (distanceKm > MAX_DISTANCE_KM) { console.warn(`  skipped ${key}: ${Math.round(distanceKm)} km is near-antipodal`); skipped++; continue; }
    if (![1, 2, 3].includes(difficulty)) throw new Error(`Pair ${key} has difficulty ${difficulty}`);
    questions.push({
      type: 'compass', category: 'compass',
      question: `From ${from.name}, which direction is ${to.name}?`,
      from: { id: fromId, name: from.name, lat: from.lat, lng: from.lng },
      to:   { id: toId,   name: to.name,   lat: to.lat,   lng: to.lng },
      region: from.region,
      difficulty,
    });
  }
  fs.mkdirSync(path.dirname(OUT_QS), { recursive: true });
  fs.writeFileSync(OUT_QS, JSON.stringify(questions, null, 2) + '\n');
  const byDiff = [1, 2, 3].map(d => `${d}: ${questions.filter(q => q.difficulty === d).length}`).join(', ');
  console.log(`✓ content/compass.json — ${questions.length} questions (${skipped} skipped), difficulty ${byDiff}`);

  // Handy preview so the author can sanity-check the surprising ones
  if (process.argv.includes('--preview')) {
    for (const q of questions) {
      const b = bearingDeg(q.from.lat, q.from.lng, q.to.lat, q.to.lng);
      console.log(`  ${q.from.name.padEnd(16)} → ${q.to.name.padEnd(16)} ${String(Math.round(b)).padStart(3)}° ${compassName(b).padEnd(3)} ${Math.round(haversineKm(q.from.lat, q.from.lng, q.to.lat, q.to.lng))} km  d${q.difficulty} ${q.region}`);
    }
  }
})().catch(e => { console.error('✗', e.message); process.exit(1); });
