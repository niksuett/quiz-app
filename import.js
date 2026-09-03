// ─────────────────────────────────────────────────────────────────────────────
// import.js — append new questions from a JSON file into quiz.db
//
// Usage:  node import.js path/to/new-questions.json [--dry-run]
//
// Validates every question with its game module first. If anything is invalid
// nothing is written. Existing rows are never touched (append-only).
// ─────────────────────────────────────────────────────────────────────────────

const fs       = require('fs');
const path     = require('path');
const registry = require('./games');
const { db, questionToRow } = require('./db');

const args     = process.argv.slice(2);
const dryRun   = args.includes('--dry-run');
const filePath = args.find(a => !a.startsWith('--'));

if (!filePath) { console.error('Usage: node import.js path/to/questions.json [--dry-run]'); process.exit(1); }
const fullPath = path.resolve(filePath);
if (!fs.existsSync(fullPath)) { console.error(`File not found: ${fullPath}`); process.exit(1); }

let questions;
try { questions = JSON.parse(fs.readFileSync(fullPath, 'utf8')); }
catch (err) { console.error(`Could not parse JSON: ${err.message}`); process.exit(1); }
if (!Array.isArray(questions)) { console.error('JSON file must contain an array of questions.'); process.exit(1); }

// ── Validate ──────────────────────────────────────────────────────────────────
const errors = validateQuestions(questions);
if (errors.length) {
  console.error(`\nFound ${errors.length} validation error(s) — nothing was imported:\n`);
  errors.slice(0, 60).forEach(e => console.error('  ✗', e));
  if (errors.length > 60) console.error(`  … and ${errors.length - 60} more`);
  process.exit(1);
}

if (dryRun) { console.log(`✓ ${questions.length} question(s) valid (dry run — nothing written).`); process.exit(0); }

// ── Insert in one transaction ─────────────────────────────────────────────────
const before = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
const insert = db.prepare(`INSERT INTO questions (category, type, question, correct, image_url, extra)
                           VALUES (@category, @type, @question, @correct, @image_url, @extra)`);
db.transaction(qs => { for (const q of qs) insert.run(questionToRow(q)); })(questions);
const after = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;

console.log(`\n✅ Imported ${after - before} question(s). Database now contains ${after} total.\n`);
const byCategory = {};
for (const q of questions) byCategory[q.category] = (byCategory[q.category] || 0) + 1;
console.log('Breakdown of imported questions:');
for (const [cat, n] of Object.entries(byCategory)) console.log(`  ${cat}: ${n}`);
console.log('');

// Shared with the admin API and tools.
function validateQuestions(list) {
  const errs = [];
  list.forEach((q, i) => {
    const label = `Question ${i + 1}${q && q.question ? ` ("${String(q.question).slice(0, 40)}")` : ''}`;
    if (!q || typeof q !== 'object') { errs.push(`${label}: not an object`); return; }
    if (!q.question || typeof q.question !== 'string') errs.push(`${label}: missing "question"`);
    const cat = registry.categoryById[q.category];
    if (!cat) { errs.push(`${label}: unknown category "${q.category}"`); return; }
    const type = q.type || 'mc';
    if (type !== cat.type) errs.push(`${label}: category "${q.category}" expects type "${cat.type}" but got "${type}"`);
    const mod = registry.get(type);
    if (!mod) { errs.push(`${label}: unknown type "${type}"`); return; }
    for (const e of mod.validate({ ...q, type })) errs.push(`${label}: ${e}`);
  });
  return errs;
}
