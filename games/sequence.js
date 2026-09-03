// ─────────────────────────────────────────────────────────────────────────────
// games/sequence.js — drag four items into the correct order.
// Quality uses the number of correctly ordered PAIRS (Kendall tau), so a single
// adjacent swap still scores well, while a fully reversed list scores 0.
// ─────────────────────────────────────────────────────────────────────────────
const { validateCommon, shuffle } = require('./_shared');

function kendallCorrectPairs(playerOrder, correctOrder) {
  const pos = new Map(correctOrder.map((item, i) => [item, i]));
  let good = 0, total = 0;
  for (let i = 0; i < playerOrder.length; i++) {
    for (let j = i + 1; j < playerOrder.length; j++) {
      total++;
      if (pos.get(playerOrder[i]) < pos.get(playerOrder[j])) good++;
    }
  }
  return { good, total };
}

module.exports = {
  type: 'sequence',
  categories: [
    { id: 'sequence', label: 'Sequence', emoji: '🔢', group: 'classic', order: 80,
      blurb: 'Four things, one right order. Drag them into place.',
      howTo:  'Drag the items so the earliest / smallest / first is on top, then lock in.' },
  ],
  timeLimit: 30,
  revealPause: 8,
  earlyPause: 4000,
  speedScored: false,
  usesRegion: false,

  validate(q) {
    const errors = validateCommon(q);
    if (!Array.isArray(q.items) || q.items.length !== 4 || q.items.some(s => typeof s !== 'string' || !s.trim()))
      errors.push('"items" must be exactly 4 non-empty strings in the correct order');
    else if (new Set(q.items).size !== 4) errors.push('"items" must be distinct');
    return errors;
  },

  toRow(q)            { return { correct: null, extra: { items: q.items } }; },
  fromRow(row, extra) { return { items: extra.items }; },

  // Items are shuffled so the correct order is never the displayed order.
  payload(q) {
    let items = shuffle(q.items);
    if (items.every((it, i) => it === q.items[i])) items = [items[1], items[0], items[3], items[2]];
    return { question: q.question, items, imageUrl: q.imageUrl || null };
  },

  evaluate(q, answer) {
    const order = answer && Array.isArray(answer.order) ? answer.order : null;
    if (!order || order.length !== q.items.length || new Set(order).size !== q.items.length || order.some(it => !q.items.includes(it))) return null;
    const correctCount = order.filter((it, i) => it === q.items[i]).length;
    const { good, total } = kendallCorrectPairs(order, q.items);
    const quality = good / total;
    return {
      quality,
      detail: { playerOrder: order, correctCount, pairsCorrect: good, pairsTotal: total },
      result: { correctCount, totalItems: q.items.length, correctOrder: q.items, playerOrder: order, pairsCorrect: good, pairsTotal: total },
    };
  },

  reveal(q, answers) {
    return {
      correctOrder: q.items,
      playerAnswers: answers.map(a => ({ nickname: a.nickname, playerOrder: a.detail.playerOrder, correctCount: a.detail.correctCount })),
    };
  },

  correctText(q) { return q.items.map((it, i) => `${i + 1}. ${it}`).join(' → '); },
  sampleAnswer(p) { return { order: shuffle(p.items) }; },
};
