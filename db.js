// ─────────────────────────────────────────────────────────────────────────────
// db.js — SQLite database setup and question row conversion helpers
//
// Opens (or creates) quiz.db in the project root. All questions live in one
// `questions` table. Type-specific fields (answers, coordinates, items, …) are
// stored as a JSON blob in the `extra` column; each game module in games/
// knows how to pack and unpack its own fields (toRow / fromRow), so this file
// only deals with the columns every question shares.
// ─────────────────────────────────────────────────────────────────────────────

const path     = require('path');
const Database = require('better-sqlite3');
const registry = require('./games');

const DB_PATH = process.env.QUIZ_DB || path.join(__dirname, 'quiz.db');
const db      = new Database(DB_PATH);

// WAL mode — faster writes, safe for concurrent reads
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    category  TEXT    NOT NULL,
    type      TEXT    NOT NULL DEFAULT 'mc',
    question  TEXT    NOT NULL,
    correct   TEXT,
    image_url TEXT,
    extra     TEXT    NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_questions_category ON questions (category);
  CREATE INDEX IF NOT EXISTS idx_questions_type     ON questions (type);
`);

// ── rowToQuestion ─────────────────────────────────────────────────────────────
// Database row → plain question object (the shape game modules work with).
function rowToQuestion(row) {
  let extra = {};
  try { extra = JSON.parse(row.extra || '{}'); } catch (e) { extra = {}; }
  const type = row.type || 'mc';
  const q = { id: row.id, category: row.category, type, question: row.question };
  if (row.image_url)   q.imageUrl   = row.image_url;
  if (extra.region)     q.region     = extra.region;
  if (extra.difficulty) q.difficulty = extra.difficulty;

  const mod = registry.get(type);
  if (mod) {
    Object.assign(q, mod.fromRow(row, extra));
  } else {
    // Unknown type (module not installed) — keep the raw fields so nothing is lost
    Object.assign(q, extra);
    if (row.correct !== null) q.correct = row.correct;
  }
  return q;
}

// ── questionToRow ─────────────────────────────────────────────────────────────
// Plain question object → row ready for INSERT.
function questionToRow(q) {
  const type = q.type || 'mc';
  const mod  = registry.get(type);
  let correct = null, extra = {};
  if (mod) {
    ({ correct, extra } = mod.toRow(q));
  } else {
    const { id, category, question, imageUrl, region, difficulty, type: _t, ...rest } = q;
    extra = rest;
    correct = rest.correct !== undefined ? String(rest.correct) : null;
  }
  if (q.region)     extra.region     = q.region;
  if (q.difficulty) extra.difficulty = q.difficulty;
  return {
    category:  q.category,
    type,
    question:  q.question,
    correct:   correct === undefined ? null : correct,
    image_url: q.imageUrl || null,
    extra:     JSON.stringify(extra),
  };
}

function loadAllQuestions() {
  return db.prepare('SELECT * FROM questions ORDER BY id').all().map(rowToQuestion);
}

function getQuestionById(id) {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  return row ? rowToQuestion(row) : null;
}

function countsByCategory() {
  const out = {};
  for (const r of db.prepare('SELECT category, COUNT(*) AS n FROM questions GROUP BY category').all()) out[r.category] = r.n;
  return out;
}

module.exports = { db, rowToQuestion, questionToRow, loadAllQuestions, getQuestionById, countsByCategory };
