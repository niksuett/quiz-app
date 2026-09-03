// ─────────────────────────────────────────────────────────────────────────────
// tools/migrate-v2.js — one-off upgrade of quiz.db to the v2 layout.
//
//   node tools/migrate-v2.js
//
// 1. Merges facts / science / sports / entertainment into one "trivia" category
//    (the old category is kept as `topic` inside the extra blob, nothing is lost).
// 2. Tags every map question with a region (continent) from its coordinates and
//    every flag question from its country code — this powers the host's
//    "Geographic focus" filter.
// Safe to run more than once.
// ─────────────────────────────────────────────────────────────────────────────
const { db } = require('../db');
const geo    = require('./lib/geo');

(async () => {
  const rows = db.prepare('SELECT * FROM questions').all();
  const update = db.prepare('UPDATE questions SET category = @category, extra = @extra WHERE id = @id');
  let merged = 0, tagged = 0, untagged = [];

  const changes = [];
  for (const row of rows) {
    let extra = {};
    try { extra = JSON.parse(row.extra || '{}'); } catch (e) {}
    let category = row.category;
    let dirty = false;

    if (['facts', 'science', 'sports', 'entertainment'].includes(category)) {
      extra.topic = category;
      category = 'trivia';
      merged++; dirty = true;
    }

    if (row.type === 'map' && !extra.region && typeof extra.correctLat === 'number') {
      const region = await geo.continentOf(extra.correctLng, extra.correctLat);
      if (region) { extra.region = region; tagged++; dirty = true; }
      else untagged.push(`${row.id} ${row.question}`);
    }
    if (row.type === 'flag' && !extra.region) {
      const region = await geo.regionForIso2(row.question);
      if (region) { extra.region = region; tagged++; dirty = true; }
      else untagged.push(`${row.id} flag ${row.question}`);
    }

    if (dirty) changes.push({ id: row.id, category, extra: JSON.stringify(extra) });
  }

  db.transaction(list => { for (const c of list) update.run(c); })(changes);

  console.log(`✅ migrate-v2: merged ${merged} questions into "trivia", tagged ${tagged} with a region.`);
  if (untagged.length) { console.log(`   ${untagged.length} could not be tagged:`); untagged.forEach(u => console.log('     -', u)); }
  const counts = db.prepare('SELECT category, COUNT(*) n FROM questions GROUP BY category ORDER BY n DESC').all();
  console.log('   Categories now:', counts.map(c => `${c.category}=${c.n}`).join(', '));
})().catch(e => { console.error(e); process.exit(1); });
