// ─────────────────────────────────────────────────────────────────────────────
// tools/build-silhouettes.js — builds data/silhouettes.json for the "Size It Up" game.
//
//   node tools/build-silhouettes.js             # (re)build data/silhouettes.json
//   node tools/build-silhouettes.js --preview   # also write a contact sheet (HTML) to check shapes
//
// What it produces (committed to git):
//   data/silhouettes.json  { credit, icons: { key: { name, body, w, h, flip? } } }
//
// Where the data comes from:
//   The game-icons.net set (CC BY 3.0) served by the Iconify API. Every icon is a
//   512×512 SVG whose "body" (the inner markup, mostly one <path>) uses
//   fill="currentColor", so the client can colour it red or brown with plain CSS.
//   Bulk endpoint: https://api.iconify.design/game-icons.json?icons=a,b,c
//   Fetched bodies are cached in tools/raw/game-icons/<name>.json (gitignored), so
//   re-running the script never hits the network for icons it already has.
//
// The script is idempotent and FAILS LOUDLY when a curated icon name does not exist
// in the set, so a typo in ICONS below never silently drops a silhouette.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const CACHE_DIR = path.join(__dirname, 'raw', 'game-icons');
const OUT_FILE  = path.join(ROOT, 'data', 'silhouettes.json');
const API       = 'https://api.iconify.design/game-icons.json?icons=';
const CREDIT    = 'Silhouettes from game-icons.net (CC BY 3.0) — https://game-icons.net';

// ── 1. The curated table: our key → game-icons name ──────────────────────────
// Keys are what content/sizeup.json refers to ("icon": "whale"). Keep keys stable:
// renaming one breaks every question that uses it.
//   name  – the icon name inside the game-icons set
//   flip  – mirror horizontally on the client (optional; purely cosmetic)
// Names were verified against the API on 2026-09-04. The set has no giraffe, hippo,
// rhino, crocodile, horse, shark, Eiffel Tower or Statue of Liberty — questions that
// need those simply cannot be asked (yet).
const ICONS = {
  // People & everyday references
  person:        { name: 'person' },
  coin:          { name: 'crown-coin' },
  smartphone:    { name: 'smartphone' },
  'soccer-ball': { name: 'soccer-ball' },
  'tennis-ball': { name: 'tennis-ball' },
  'tennis-racket': { name: 'tennis-racket' },
  'bowling-pin': { name: 'bowling-pin' },
  guitar:        { name: 'guitar' },
  violin:        { name: 'violin' },
  piano:         { name: 'grand-piano' },
  pencil:        { name: 'pencil' },
  skateboard:    { name: 'skateboard' },
  door:          { name: 'door' },
  bed:           { name: 'bed' },
  ladder:        { name: 'ladder' },
  // Animals
  cat:           { name: 'cat' },
  dog:           { name: 'sitting-dog' },
  mouse:         { name: 'mouse' },
  cow:           { name: 'cow' },
  pig:           { name: 'pig' },
  elephant:      { name: 'elephant' },
  camel:         { name: 'camel' },
  bison:         { name: 'bison' },
  lion:          { name: 'lion' },
  tiger:         { name: 'tiger' },
  'polar-bear':  { name: 'polar-bear' },
  gorilla:       { name: 'gorilla' },
  kangaroo:      { name: 'kangaroo' },
  capybara:      { name: 'capybara' },
  deer:          { name: 'deer' },
  whale:         { name: 'sperm-whale' },
  dolphin:       { name: 'dolphin' },
  'manta-ray':   { name: 'manta-ray' },
  'giant-squid': { name: 'giant-squid' },
  octopus:       { name: 'octopus' },
  'sea-turtle':  { name: 'sea-turtle' },
  tortoise:      { name: 'tortoise' },
  crab:          { name: 'crab' },
  frog:          { name: 'frog' },
  ostrich:       { name: 'ostrich' },
  penguin:       { name: 'penguin' },
  flamingo:      { name: 'flamingo' },
  swan:          { name: 'swan' },
  owl:           { name: 'owl' },
  hummingbird:   { name: 'hummingbird' },
  bee:           { name: 'bee' },
  ant:           { name: 'ant' },
  butterfly:     { name: 'butterfly' },
  dragonfly:     { name: 'dragonfly' },
  scorpion:      { name: 'scorpion' },
  snail:         { name: 'snail' },
  ladybug:       { name: 'ladybug' },
  // Prehistoric
  trex:          { name: 'dinosaur-rex' },
  velociraptor:  { name: 'velociraptor' },
  diplodocus:    { name: 'diplodocus' },
  pterodactyl:   { name: 'pterodactylus' },
  mammoth:       { name: 'mammoth' },
  trilobite:     { name: 'trilobite' },
  // Vehicles
  bicycle:       { name: 'dutch-bike' },
  car:           { name: 'city-car' },
  'f1-car':      { name: 'f1-car' },
  jeep:          { name: 'jeep' },
  bus:           { name: 'bus' },
  truck:         { name: 'truck' },
  'mine-truck':  { name: 'mine-truck' },
  tractor:       { name: 'farm-tractor' },
  bulldozer:     { name: 'bulldozer' },
  excavator:     { name: 'bucket-wheel-excavator' },
  locomotive:    { name: 'steam-locomotive' },
  tank:          { name: 'tank' },
  airliner:      { name: 'commercial-airplane' },
  'small-plane': { name: 'airplane' },
  biplane:       { name: 'biplane' },
  'jet-fighter': { name: 'jet-fighter' },
  'stealth-bomber': { name: 'stealth-bomber' },
  helicopter:    { name: 'helicopter' },
  zeppelin:      { name: 'zeppelin' },
  balloon:       { name: 'air-balloon' },
  rocket:        { name: 'rocket' },
  'space-shuttle': { name: 'space-shuttle' },
  capsule:       { name: 'apollo-capsule' },
  satellite:     { name: 'satellite' },
  'cargo-ship':  { name: 'cargo-ship' },
  steamer:       { name: 'paddle-steamer' },
  battleship:    { name: 'battleship' },
  cruiser:       { name: 'cruiser' },
  submarine:     { name: 'submarine' },
  sailboat:      { name: 'sailboat' },
  // Buildings & landmarks
  house:         { name: 'house' },
  'clock-tower': { name: 'clock-tower' },
  'pisa-tower':  { name: 'pisa-tower' },
  'tower-bridge': { name: 'tower-bridge' },
  pyramid:       { name: 'great-pyramid' },
  pyramids:      { name: 'egyptian-pyramids' },
  sphinx:        { name: 'egyptian-sphinx' },
  'greek-temple': { name: 'greek-temple' },
  'opera-house': { name: 'sydney-opera-house' },
  obelisk:       { name: 'obelisk' },
  church:        { name: 'church' },
  cathedral:     { name: 'saint-basil-cathedral' },
  'space-needle': { name: 'space-needle' },
  'radio-tower': { name: 'radio-tower' },
  'tv-tower':    { name: 'tv-tower' },
  lighthouse:    { name: 'lighthouse' },
  windmill:      { name: 'windmill' },
  'wind-turbine': { name: 'wind-turbine' },
  castle:        { name: 'castle' },
  statue:        { name: 'colombian-statue' },
  'suspension-bridge': { name: 'suspension-bridge' },
  // Plants
  oak:           { name: 'oak' },
  'pine-tree':   { name: 'pine-tree' },
  'palm-tree':   { name: 'palm-tree' },
  baobab:        { name: 'baobab' },
  cactus:        { name: 'cactus' },
  sunflower:     { name: 'sunflower' },
  mushroom:      { name: 'mushroom' },
  banana:        { name: 'banana' },
};

// ── 2. Fetch bodies (with an on-disk cache) ──────────────────────────────────
async function fetchIcons(names) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const result = {};
  const missing = [];
  for (const name of names) {
    const cached = path.join(CACHE_DIR, `${name}.json`);
    if (fs.existsSync(cached)) result[name] = JSON.parse(fs.readFileSync(cached, 'utf8'));
    else missing.push(name);
  }
  // The API accepts many icons per request; 50 at a time keeps URLs short.
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    process.stderr.write(`↓ fetching ${chunk.length} icons from iconify … `);
    const r = await fetch(API + chunk.join(','));
    if (!r.ok) throw new Error(`iconify request failed: ${r.status}`);
    const json = await r.json();
    process.stderr.write('done\n');
    if (json.not_found && json.not_found.length) {
      throw new Error(`These icon names do not exist in game-icons — fix ICONS in this script:\n  ${json.not_found.join(', ')}`);
    }
    for (const [name, icon] of Object.entries(json.icons || {})) {
      const entry = { body: icon.body, w: icon.width || json.width || 512, h: icon.height || json.height || 512 };
      fs.writeFileSync(path.join(CACHE_DIR, `${name}.json`), JSON.stringify(entry));
      result[name] = entry;
    }
  }
  return result;
}

// ── 3. Main ───────────────────────────────────────────────────────────────────
(async () => {
  const names = [...new Set(Object.values(ICONS).map(i => i.name))];
  const fetched = await fetchIcons(names);

  const icons = {};
  for (const [key, spec] of Object.entries(ICONS)) {
    const f = fetched[spec.name];
    if (!f) throw new Error(`Icon "${spec.name}" (key "${key}") was not returned by the API`);
    if (!f.body.includes('currentColor')) console.warn(`  ⚠ ${key}: body does not use currentColor — colouring may not work`);
    icons[key] = { name: spec.name, body: f.body, w: f.w, h: f.h };
    if (spec.flip) icons[key].flip = true;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const out = { credit: CREDIT, license: 'CC BY 3.0', source: 'https://game-icons.net via https://api.iconify.design', icons };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out) + '\n');
  const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);
  console.log(`✓ data/silhouettes.json — ${Object.keys(icons).length} silhouettes, ${kb} KB`);
  if (kb > 400) console.warn(`  ⚠ file is over 400 KB — drop some icons`);

  // Optional contact sheet so a human can eyeball every shape (written outside the repo).
  if (process.argv.includes('--preview')) {
    const dir  = process.env.PREVIEW_DIR || path.join(__dirname, 'raw');
    const file = path.join(dir, 'silhouettes-preview.html');
    const cells = Object.entries(icons).map(([key, ic]) =>
      `<figure><svg viewBox="0 0 ${ic.w} ${ic.h}" style="color:#7a4a1e;width:96px;height:96px;background:#f5ecd7">${ic.body}</svg><figcaption>${key}<br><small>${ic.name}</small></figcaption></figure>`).join('\n');
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>silhouettes</title><style>body{font:12px sans-serif;display:flex;flex-wrap:wrap;gap:6px}figure{margin:0;text-align:center;width:110px}</style>${cells}`);
    console.log(`✓ preview: ${file}`);
  }
})().catch(e => { console.error('✗', e.message); process.exit(1); });
