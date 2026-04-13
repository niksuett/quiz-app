// ─────────────────────────────────────────────────────────────────────────────
// migrate.js — one-time script to load questions.json into the SQLite database
//
// Run once with:  node migrate.js
//
// The script is safe to keep around — it exits early if the database already
// contains questions, so running it a second time does nothing.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const { db, questionToRow } = require('./db');

// Safety check — don't duplicate data if already migrated
const existing = db.prepare('SELECT COUNT(*) AS n FROM questions').get();
if (existing.n > 0) {
  console.log(`Database already contains ${existing.n} questions. Nothing to do.`);
  process.exit(0);
}

const jsonPath  = path.join(__dirname, 'questions.json');
const questions = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const insert = db.prepare(`
  INSERT INTO questions (category, type, question, correct, image_url, extra)
  VALUES (@category, @type, @question, @correct, @image_url, @extra)
`);

// Wrap all inserts in a transaction — either all 233 go in, or none do
const insertAll = db.transaction(qs => {
  for (const q of qs) {
    insert.run(questionToRow(q));
  }
});

insertAll(questions);

const count = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
console.log(`✅ Migrated ${count} questions into quiz.db`);
