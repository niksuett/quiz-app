// ─────────────────────────────────────────────────────────────────────────────
// import.js — append new questions from a JSON file into quiz.db
//
// Usage:  node import.js path/to/new-questions.json
//
// Unlike migrate.js, this script does NOT wipe existing data — it only adds
// the new questions from the file you provide.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const { db, questionToRow } = require('./db');

// ── Validate input ────────────────────────────────────────────────────────────

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: node import.js path/to/questions.json');
  process.exit(1);
}

const fullPath = path.resolve(filePath);

if (!fs.existsSync(fullPath)) {
  console.error(`File not found: ${fullPath}`);
  process.exit(1);
}

let questions;
try {
  questions = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
} catch (err) {
  console.error(`Could not parse JSON: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(questions)) {
  console.error('JSON file must contain an array of questions at the top level.');
  process.exit(1);
}

// ── Validate each question before touching the DB ─────────────────────────────

const VALID_CATEGORIES = [
  'facts', 'science', 'sports', 'entertainment',
  'flags', 'estimation', 'timeline',
  'geo-natural', 'geo-built', 'geo-cities', 'geo-history',
  'sequence',
];

const VALID_TYPES = ['mc', 'flag', 'slider', 'timeline', 'map', 'sequence'];

const errors = [];

questions.forEach((q, i) => {
  const label = `Question ${i + 1}`;

  if (!q.question || typeof q.question !== 'string') {
    errors.push(`${label}: missing or invalid "question" field`);
  }
  if (!q.category || !VALID_CATEGORIES.includes(q.category)) {
    errors.push(`${label}: invalid category "${q.category}" — must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }

  const type = q.type || 'mc';
  if (!VALID_TYPES.includes(type)) {
    errors.push(`${label}: invalid type "${type}"`);
  }

  if (type === 'mc' || type === 'flag') {
    if (!Array.isArray(q.answers) || q.answers.length !== 4) {
      errors.push(`${label}: "answers" must be an array of exactly 4 strings`);
    }
    if (typeof q.correct !== 'number' || q.correct < 0 || q.correct > 3) {
      errors.push(`${label}: "correct" must be a number 0–3`);
    }
  }

  if (type === 'slider' || type === 'timeline') {
    if (typeof q.min !== 'number') errors.push(`${label}: missing "min"`);
    if (typeof q.max !== 'number') errors.push(`${label}: missing "max"`);
    if (typeof q.correct !== 'number') errors.push(`${label}: "correct" must be a number`);
    if (q.min >= q.max) errors.push(`${label}: "min" must be less than "max"`);
    if (q.correct < q.min || q.correct > q.max) {
      errors.push(`${label}: "correct" (${q.correct}) is outside the range ${q.min}–${q.max}`);
    }
  }

  if (type === 'map') {
    if (typeof q.correctLat !== 'number' || q.correctLat < -90  || q.correctLat > 90) {
      errors.push(`${label}: "correctLat" must be a number between -90 and 90`);
    }
    if (typeof q.correctLng !== 'number' || q.correctLng < -180 || q.correctLng > 180) {
      errors.push(`${label}: "correctLng" must be a number between -180 and 180`);
    }
  }

  if (type === 'sequence') {
    if (!Array.isArray(q.items) || q.items.length !== 4) {
      errors.push(`${label}: "items" must be an array of exactly 4 strings (in correct order)`);
    }
  }
});

if (errors.length > 0) {
  console.error(`\nFound ${errors.length} validation error(s) — nothing was imported:\n`);
  errors.forEach(e => console.error('  ✗', e));
  console.error('\nFix the errors above and try again.');
  process.exit(1);
}

// ── Insert all questions in a single transaction ──────────────────────────────

const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;

const insert = db.prepare(`
  INSERT INTO questions (category, type, question, correct, image_url, extra)
  VALUES (@category, @type, @question, @correct, @image_url, @extra)
`);

const insertAll = db.transaction(qs => {
  for (const q of qs) {
    insert.run(questionToRow(q));
  }
});

insertAll(questions);

const afterCount = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
const added = afterCount - beforeCount;

console.log(`\n✅ Imported ${added} question(s). Database now contains ${afterCount} total.\n`);

// ── Show a breakdown by category ──────────────────────────────────────────────

const byCategory = {};
for (const q of questions) {
  const cat = q.category;
  byCategory[cat] = (byCategory[cat] || 0) + 1;
}

console.log('Breakdown of imported questions:');
for (const [cat, count] of Object.entries(byCategory)) {
  console.log(`  ${cat}: ${count}`);
}
console.log('');
