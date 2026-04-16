// ─────────────────────────────────────────────────────────────────────────────
// db.js — SQLite database setup and question row conversion helpers
//
// Opens (or creates) quiz.db in the project root.
// All questions live in a single `questions` table.
// Variable fields (answers, items, coordinates, etc.) are stored as a JSON
// blob in the `extra` column so the schema stays simple regardless of type.
// ─────────────────────────────────────────────────────────────────────────────

const path    = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'quiz.db');
const db      = new Database(DB_PATH);

// Enable WAL mode — faster writes, safe for concurrent reads
db.pragma('journal_mode = WAL');

// ── Create tables if they don't exist yet ─────────────────────────────────────
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
// Converts a database row back into the plain JS object shape that the rest of
// the app (server.js, scoring logic) already expects.
function rowToQuestion(row) {
  const extra = JSON.parse(row.extra);
  const type  = row.type;

  const q = {
    id:       row.id,
    category: row.category,
    type:     type === 'mc' ? undefined : type,  // MC questions have no `type` field in original JSON
    question: row.question,
  };

  // Remove undefined type so it matches the original JSON structure
  if (q.type === undefined) delete q.type;

  if (row.image_url) q.imageUrl = row.image_url;

  if (type === 'mc' || type === 'flag') {
    q.answers = extra.answers;
    q.correct = parseInt(row.correct, 10);
    if (type === 'flag') q.type = 'flag';

  } else if (type === 'slider' || type === 'timeline') {
    q.min     = extra.min;
    q.max     = extra.max;
    q.step    = extra.step;
    q.unit    = extra.unit;
    q.correct = parseFloat(row.correct);

  } else if (type === 'map') {
    q.correctLat   = extra.correctLat;
    q.correctLng   = extra.correctLng;
    q.locationName = extra.locationName;
    if (extra.toleranceKm) q.toleranceKm = extra.toleranceKm;
    // map questions have no `correct` scalar value

  } else if (type === 'sequence') {
    q.items = extra.items;
    // sequence questions have no `correct` scalar value
  }

  return q;
}

// ── questionToRow ─────────────────────────────────────────────────────────────
// Converts a plain JS question object into a row ready for INSERT.
function questionToRow(q) {
  const type = q.type || 'mc';
  let correct   = null;
  let extraObj  = {};

  if (type === 'mc' || type === 'flag') {
    extraObj = { answers: q.answers };
    correct  = String(q.correct);

  } else if (type === 'slider' || type === 'timeline') {
    extraObj = { min: q.min, max: q.max, step: q.step, unit: q.unit || '' };
    correct  = String(q.correct);

  } else if (type === 'map') {
    extraObj = { correctLat: q.correctLat, correctLng: q.correctLng, locationName: q.locationName || '' };
    if (q.toleranceKm) extraObj.toleranceKm = q.toleranceKm;
    correct  = null;

  } else if (type === 'sequence') {
    extraObj = { items: q.items };
    correct  = null;
  }

  return {
    category:  q.category,
    type,
    question:  q.question,
    correct,
    image_url: q.imageUrl || null,
    extra:     JSON.stringify(extraObj),
  };
}

// ── getQuestionById ───────────────────────────────────────────────────────────
// Fetches a single question by its numeric ID. Returns null if not found.
function getQuestionById(id) {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  return row ? rowToQuestion(row) : null;
}

module.exports = { db, rowToQuestion, questionToRow, getQuestionById };
