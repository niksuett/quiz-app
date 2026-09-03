// ─────────────────────────────────────────────────────────────────────────────
// games/index.js — the game-type registry.
//
// Every file in this folder (except index.js and files starting with "_") is a
// game-type module following docs/ARCHITECTURE.md. This file loads them all,
// checks they implement the contract, and builds the list of categories,
// groups, regions and presets that the config screen is generated from.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const REQUIRED = ['type', 'categories', 'timeLimit', 'validate', 'toRow', 'fromRow', 'payload', 'evaluate', 'reveal', 'correctText', 'sampleAnswer'];

const modules = {};
for (const file of fs.readdirSync(__dirname).sort()) {
  if (file === 'index.js' || file.startsWith('_') || !file.endsWith('.js')) continue;
  const mod = require(path.join(__dirname, file));
  if (!mod || !mod.type) continue;
  const missing = REQUIRED.filter(k => mod[k] === undefined);
  if (missing.length) throw new Error(`games/${file} is missing: ${missing.join(', ')}`);
  if (modules[mod.type]) throw new Error(`Duplicate game type "${mod.type}" in games/${file}`);
  // Defaults for optional fields
  mod.revealPause = mod.revealPause ?? 8;
  mod.earlyPause  = mod.earlyPause  ?? 4000;
  mod.speedScored = !!mod.speedScored;
  mod.usesRegion  = !!mod.usesRegion;
  modules[mod.type] = mod;
}

// ── Groups shown on the config screen (in this order) ─────────────────────────
const GROUPS = [
  { id: 'draw',    label: 'Draw & Build',  emoji: '🎨', blurb: 'Draw, drag, resize, split — the creative rounds.' },
  { id: 'map',     label: 'On the Map',    emoji: '🗺️', blurb: 'Drop a pin where it belongs.' },
  { id: 'classic', label: 'Classic Quiz',  emoji: '🧠', blurb: 'Buttons, sliders and drag-to-order.' },
];

const REGIONS = [
  { id: 'europe',        label: 'Europe',        emoji: '🏰' },
  { id: 'asia',          label: 'Asia',          emoji: '🏯' },
  { id: 'africa',        label: 'Africa',        emoji: '🦁' },
  { id: 'north-america', label: 'North America', emoji: '🗽' },
  { id: 'south-america', label: 'South America', emoji: '🌴' },
  { id: 'oceania',       label: 'Oceania',       emoji: '🐨' },
];

// ── Categories (flattened from modules, sorted by group then order) ───────────
const categories = [];
for (const mod of Object.values(modules)) {
  for (const cat of mod.categories) {
    if (categories.find(c => c.id === cat.id)) throw new Error(`Duplicate category "${cat.id}"`);
    categories.push({ ...cat, type: mod.type, order: cat.order ?? 50 });
  }
}
const groupIndex = Object.fromEntries(GROUPS.map((g, i) => [g.id, i]));
categories.sort((a, b) => (groupIndex[a.group] - groupIndex[b.group]) || (a.order - b.order) || a.label.localeCompare(b.label));

const categoryById = Object.fromEntries(categories.map(c => [c.id, c]));

// ── Presets: quick picks on the config screen ─────────────────────────────────
const only = ids => ids.filter(id => categoryById[id]);
const PRESETS = [
  { id: 'party',     label: 'Party Mix',        emoji: '🎉', blurb: 'Everything — the full variety show.',
    categories: categories.map(c => c.id) },
  { id: 'creative',  label: 'Creative Only',    emoji: '🎨', blurb: 'Only the drawing, dragging and guessing games.',
    categories: only([...categories.filter(c => c.group === 'draw').map(c => c.id), 'birdseye', 'silhouettes', 'tunes', 'fakes', 'emoji']) },
  { id: 'geography', label: 'Geography Night',  emoji: '🌍', blurb: 'Maps, borders, rivers, flags and shapes.',
    categories: only(['borders', 'rivers', 'halves', 'compass', ...categories.filter(c => c.group === 'map').map(c => c.id), 'flags', 'silhouettes']) },
  { id: 'classic',   label: 'Classic Quiz',     emoji: '🧠', blurb: 'Good old buttons and sliders.',
    categories: only(['trivia', 'flags', 'estimation', 'timeline', 'sequence', 'emoji']) },
];

function get(type) { return modules[type] || null; }
function all()     { return Object.values(modules); }
function typeForCategory(catId) { const c = categoryById[catId]; return c ? c.type : null; }

module.exports = { get, all, modules, categories, categoryById, typeForCategory, GROUPS, REGIONS, PRESETS };
