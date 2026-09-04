// ─────────────────────────────────────────────────────────────────────────────
// games/fakes.js — 🕵️ "Spot the Fakes"
//
// Six names are shown (IKEA products, Bond films, dinosaurs …). Some of them
// are invented. Every player taps the ones they think are fake and locks in.
//
// The question author marks each item with fake:true/false. Some sets twist
// the idea — "Pokémon or pharmaceutical? Tap the DRUGS" — so the module also
// supports an optional `fakeLabel` ("Drugs", "Pokémon", "Not on the board")
// that names what the flagged items are. The flag always means "tap this".
//
// Scoring: every item is a yes/no decision. c = number of correct decisions
// (0–6). quality = max(0, (c − 3) / 3): 6 right → 1, 5 → 0.67, 4 → 0.33,
// 3 or fewer → 0 (a coin flip gets ~3 right on average, so that is worth nothing).
//
// Shuffling: payload() shows the six items in a random order, and the client
// answers with indices into THAT order. Rather than remembering the order in
// server memory, both payload() and evaluate() rebuild it from the same seed
// (game id + question id). That keeps the module stateless — a player who
// rejoins mid-question gets the identical order again.
// ─────────────────────────────────────────────────────────────────────────────
const { validateCommon } = require('./_shared');

const ITEM_COUNT   = 6;
const MIN_FAKES    = 2;
const MAX_FAKES    = 4;
const DEFAULT_LABEL = 'Fakes';

// ── Seeded shuffle ────────────────────────────────────────────────────────────
// FNV-1a string hash → 32-bit seed, then mulberry32 for a tiny deterministic
// random generator. Same seed in → same order out, every time.
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seededOrder(n, seed) {
  let t = seed;
  const rnd = () => {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return order;
}

// The items in the order the players see them, for this game + question.
function displayedItems(q, game) {
  const seed  = hashString(`${game && game.id ? game.id : 'no-game'}:${q.id !== undefined ? q.id : q.question}`);
  const order = seededOrder(q.items.length, seed);
  return order.map(i => q.items[i]);
}

function labelOf(q)  { return (q.fakeLabel && String(q.fakeLabel).trim()) || DEFAULT_LABEL; }
function fakesOf(q)  { return q.items.filter(it => it.fake); }

module.exports = {
  type: 'fakes',
  categories: [
    { id: 'fakes', label: 'Spot the Fakes', emoji: '🕵️', group: 'classic', order: 90,
      blurb: 'Six names. Some are made up. Tap the fakes.',
      howTo:  'Tap every item you think is invented, then lock in. Real ones you tap count against you.' },
  ],
  timeLimit: 25,
  revealPause: 9,
  earlyPause: 4000,
  speedScored: false,
  usesRegion: false,

  // ── Validation (import.js / admin) ──────────────────────────────────────────
  validate(q) {
    const errors = validateCommon(q);
    if (!Array.isArray(q.items) || q.items.length !== ITEM_COUNT) {
      errors.push(`"items" must be an array of exactly ${ITEM_COUNT} objects { text, fake }`);
      return errors;
    }
    q.items.forEach((it, i) => {
      if (!it || typeof it !== 'object') { errors.push(`item ${i + 1}: not an object`); return; }
      if (typeof it.text !== 'string' || !it.text.trim()) errors.push(`item ${i + 1}: "text" must be a non-empty string`);
      if (typeof it.fake !== 'boolean') errors.push(`item ${i + 1}: "fake" must be true or false`);
    });
    const texts = q.items.map(it => String(it && it.text || '').trim().toLowerCase());
    if (new Set(texts).size !== ITEM_COUNT) errors.push('item texts must be distinct');
    const fakes = q.items.filter(it => it && it.fake === true).length;
    if (fakes < MIN_FAKES || fakes > MAX_FAKES) errors.push(`between ${MIN_FAKES} and ${MAX_FAKES} items must be fake (got ${fakes})`);
    if (q.fakeLabel !== undefined && (typeof q.fakeLabel !== 'string' || !q.fakeLabel.trim() || q.fakeLabel.length > 30))
      errors.push('"fakeLabel" must be a short non-empty string (max 30 chars)');
    return errors;
  },

  // ── DB (de)serialisation of the type-specific fields ────────────────────────
  toRow(q) {
    const extra = { items: q.items.map(it => ({ text: it.text.trim(), fake: !!it.fake })) };
    if (q.fakeLabel) extra.fakeLabel = q.fakeLabel.trim();
    return { correct: null, extra };
  },
  fromRow(row, extra) {
    const out = { items: Array.isArray(extra.items) ? extra.items : [] };
    if (extra.fakeLabel) out.fakeLabel = extra.fakeLabel;
    return out;
  },

  // ── What every client receives when the question starts ─────────────────────
  // Only the texts (shuffled) and how many to look for. Never the flags.
  payload(q, game) {
    return {
      question:  q.question,
      imageUrl:  q.imageUrl || null,
      items:     displayedItems(q, game).map(it => it.text),
      fakeCount: fakesOf(q).length,
      fakeLabel: labelOf(q),
    };
  },

  // ── Score one answer: { picks: [indices into payload.items] } ───────────────
  evaluate(q, answer, ctx) {
    if (!answer || !Array.isArray(answer.picks) || answer.picks.length > ITEM_COUNT) return null;
    const picks = new Set();
    for (const p of answer.picks) {
      if (!Number.isInteger(p) || p < 0 || p >= ITEM_COUNT) return null;   // garbage → reject
      picks.add(p);
    }
    const shown = displayedItems(q, ctx && ctx.game);
    let correct = 0;
    const items = shown.map((it, i) => {
      const picked = picks.has(i);
      if (picked === it.fake) correct++;          // tapped a fake, or left a real one alone
      return { text: it.text, fake: it.fake, picked };
    });
    const quality = Math.max(0, (correct - 3) / 3);
    return {
      quality,
      detail: { picks: [...picks].sort((a, b) => a - b), correct },
      result: {
        items, correct, total: ITEM_COUNT,
        score: quality, accuracyPct: Math.round(quality * 100),
        fakeLabel: labelOf(q),
        soundCorrect: correct >= 5,
      },
    };
  },

  // ── Reveal for everyone on the leaderboard ──────────────────────────────────
  // Items in the displayed order, each with who tapped it.
  reveal(q, answers, game) {
    const shown = displayedItems(q, game);
    const items = shown.map(it => ({ text: it.text, fake: it.fake, pickedBy: [] }));
    for (const a of answers) {
      const picks = a.detail && Array.isArray(a.detail.picks) ? a.detail.picks : [];
      for (const i of picks) if (Number.isInteger(i) && items[i]) items[i].pickedBy.push(a.nickname);
    }
    return {
      items,
      fakeCount: fakesOf(q).length,
      fakeLabel: labelOf(q),
      scores: answers.map(a => ({ nickname: a.nickname, correct: a.detail ? a.detail.correct : 0 })),
    };
  },

  correctText(q) { return `${labelOf(q)}: ${fakesOf(q).map(it => it.text).join(', ')}`; },

  // Plausible random answer for test/simulate.js: pick `fakeCount` distinct indices.
  sampleAnswer(p) {
    const n = p && Array.isArray(p.items) ? p.items.length : ITEM_COUNT;
    const k = p && Number.isInteger(p.fakeCount) ? p.fakeCount : 3;
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return { picks: idx.slice(0, k).sort((a, b) => a - b) };
  },

  // exported for tests
  _displayedItems: displayedItems,
};
