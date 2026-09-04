// ─────────────────────────────────────────────────────────────────────────────
// tools/delete-ids.js — delete a list of question ids from quiz.db.
//
//   node tools/delete-ids.js content/delete-ids.json
//   QUIZ_DB=path/to/other.db node tools/delete-ids.js content/delete-ids.json
//
// The JSON file looks like:
//
//   { "ids": [2, 10, 57], "reasons": { "2": "too trivial", "10": "too trivial" } }
//
// Every id is deleted in one transaction (all or nothing). Ids that do not
// exist are reported and skipped, so re-running the file is harmless.
// The reasons are optional and are only printed so the log is readable.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const { db } = require('../db');   // honours QUIZ_DB just like the server does

// ── 1. Read the input file ────────────────────────────────────────────────────
const filePath = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!filePath) { console.error('Usage: node tools/delete-ids.js content/delete-ids.json'); process.exit(1); }
const fullPath = path.resolve(filePath);
if (!fs.existsSync(fullPath)) { console.error(`File not found: ${fullPath}`); process.exit(1); }

let input;
try { input = JSON.parse(fs.readFileSync(fullPath, 'utf8')); }
catch (err) { console.error(`Could not parse JSON: ${err.message}`); process.exit(1); }
if (!input || !Array.isArray(input.ids)) { console.error('JSON must look like { "ids": [..], "reasons": { "<id>": "why" } }'); process.exit(1); }

const reasons = input.reasons && typeof input.reasons === 'object' ? input.reasons : {};
const ids = [...new Set(input.ids.map(Number))];          // de-duplicate
if (ids.some(id => !Number.isInteger(id) || id <= 0)) { console.error('Every id must be a positive integer.'); process.exit(1); }

// ── 2. Delete in one transaction ─────────────────────────────────────────────
const getRow = db.prepare('SELECT id, category, question FROM questions WHERE id = ?');
const delRow = db.prepare('DELETE FROM questions WHERE id = ?');

const removed = [], missing = [];
db.transaction(() => {
  for (const id of ids) {
    const row = getRow.get(id);
    if (!row) { missing.push(id); continue; }
    delRow.run(id);
    removed.push(row);
  }
})();

// ── 3. Report ─────────────────────────────────────────────────────────────────
for (const r of removed) {
  const why = reasons[r.id] ? `  — ${reasons[r.id]}` : '';
  console.log(`  🗑  #${r.id} [${r.category}] ${r.question.slice(0, 70)}${why}`);
}
console.log(`\n✅ delete-ids: removed ${removed.length} question(s).`);
if (missing.length) console.warn(`⚠️  ${missing.length} id(s) do not exist and were skipped: ${missing.join(', ')}`);
const total = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
console.log(`   Database now contains ${total} question(s).`);
