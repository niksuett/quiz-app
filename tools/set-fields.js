// ─────────────────────────────────────────────────────────────────────────────
// tools/set-fields.js — merge extra fields (difficulty, region, …) into rows.
//
//   node tools/set-fields.js content/difficulty-tags.json
//   QUIZ_DB=path/to/other.db node tools/set-fields.js content/difficulty-tags.json
//
// The JSON file maps question ids to the fields that should be set:
//
//   { "12": { "difficulty": 2 }, "345": { "difficulty": 3, "region": "africa" } }
//
// Fields are merged into the row's `extra` JSON blob (that is where region and
// difficulty live — see docs/ARCHITECTURE.md §3). Existing fields with other
// names are left untouched. Everything runs in one transaction, so either every
// change is applied or none is. Ids that do not exist are reported and skipped.
// Safe to run more than once (re-running with the same file changes nothing).
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const { db } = require('../db');   // honours QUIZ_DB just like the server does

// ── 1. Read the input file ────────────────────────────────────────────────────
const filePath = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!filePath) { console.error('Usage: node tools/set-fields.js content/difficulty-tags.json'); process.exit(1); }
const fullPath = path.resolve(filePath);
if (!fs.existsSync(fullPath)) { console.error(`File not found: ${fullPath}`); process.exit(1); }

let updates;
try { updates = JSON.parse(fs.readFileSync(fullPath, 'utf8')); }
catch (err) { console.error(`Could not parse JSON: ${err.message}`); process.exit(1); }
if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
  console.error('JSON must be an object of the form { "<id>": { difficulty, region, ... } }');
  process.exit(1);
}

// ── 2. Validate the values we understand ─────────────────────────────────────
const REGIONS = ['europe', 'asia', 'africa', 'north-america', 'south-america', 'oceania'];
const problems = [];
for (const [id, fields] of Object.entries(updates)) {
  if (!/^\d+$/.test(id)) problems.push(`"${id}" is not a numeric id`);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) { problems.push(`id ${id}: value must be an object`); continue; }
  if (fields.difficulty !== undefined && ![1, 2, 3].includes(fields.difficulty)) problems.push(`id ${id}: difficulty must be 1, 2 or 3`);
  if (fields.region !== undefined && !REGIONS.includes(fields.region)) problems.push(`id ${id}: invalid region "${fields.region}"`);
}
if (problems.length) {
  console.error(`\nFound ${problems.length} problem(s) — nothing was written:`);
  problems.slice(0, 40).forEach(p => console.error('  ✗', p));
  process.exit(1);
}

// ── 3. Apply in one transaction ───────────────────────────────────────────────
const getRow = db.prepare('SELECT id, extra FROM questions WHERE id = ?');
const setRow = db.prepare('UPDATE questions SET extra = ? WHERE id = ?');

let changed = 0, unchanged = 0;
const missing = [];

db.transaction(() => {
  for (const [id, fields] of Object.entries(updates)) {
    const row = getRow.get(Number(id));
    if (!row) { missing.push(id); continue; }

    let extra = {};
    try { extra = JSON.parse(row.extra || '{}'); } catch (e) { extra = {}; }

    const before = JSON.stringify(extra);
    Object.assign(extra, fields);           // merge — new fields win, others stay
    const after = JSON.stringify(extra);

    if (before === after) { unchanged++; continue; }
    setRow.run(after, row.id);
    changed++;
  }
})();

// ── 4. Report ─────────────────────────────────────────────────────────────────
console.log(`✅ set-fields: ${changed} row(s) changed, ${unchanged} already up to date.`);
if (missing.length) {
  console.warn(`⚠️  ${missing.length} id(s) do not exist and were skipped: ${missing.slice(0, 30).join(', ')}${missing.length > 30 ? ', …' : ''}`);
}
