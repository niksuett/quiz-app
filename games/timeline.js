// ─────────────────────────────────────────────────────────────────────────────
// games/timeline.js — "in which year…?" A year slider with BCE support
// (negative years). Scoring works like the estimation slider.
// ─────────────────────────────────────────────────────────────────────────────
const { validateCommon, clamp, formatYear } = require('./_shared');
const slider = require('./slider');

module.exports = {
  type: 'timeline',
  categories: [
    { id: 'timeline', label: 'Timeline', emoji: '📅', group: 'classic', order: 70,
      blurb: 'When did it happen? Pin the year.',
      howTo:  'Slide along the years or type one (e.g. 44 BCE). Closest year wins.' },
  ],
  timeLimit: 20,
  revealPause: 8,
  earlyPause: 4000,
  speedScored: false,
  usesRegion: false,

  validate(q) { return [...validateCommon(q), ...slider._validateRange(q)]; },

  toRow(q)            { return { correct: String(q.correct), extra: { min: q.min, max: q.max, step: 1, unit: '' } }; },
  fromRow(row, extra) { return { min: extra.min, max: extra.max, step: 1, unit: '', correct: parseInt(row.correct, 10) }; },

  payload(q, game) {
    // Same seeded window slide as slider (see games/slider.js shownRange): the
    // authored year ranges sat almost dead-centre on the answer, so "drag to the
    // middle" was worth 80/100 without knowing anything.
    const { min, max } = slider._shownRange(q, game);
    return { question: q.question, min, max, imageUrl: q.imageUrl || null };
  },

  evaluate(q, answer, ctx) {
    const raw = answer && typeof answer.value === 'number' ? Math.round(answer.value) : NaN;
    if (Number.isNaN(raw)) return null;
    // Score against the range the player was shown, not the authored one.
    const { min, max } = slider._shownRange(q, ctx && ctx.game);
    const value   = clamp(raw, min, max);
    const diff    = Math.abs(value - q.correct);
    const quality = slider._proximityQuality(value, q.correct, min, max);
    return {
      quality,
      detail: { value, diff },
      result: { yourAnswer: value, correctValue: q.correct, diff, accuracyPct: Math.round(quality * 100) },
    };
  },

  reveal(q, answers, game) {
    const { min, max } = slider._shownRange(q, game);
    return {
      correctValue: q.correct, min, max,
      guesses: answers.map(a => ({ nickname: a.nickname, value: a.detail.value, diff: a.detail.diff })),
    };
  },

  correctText(q) { return formatYear(q.correct); },
  sampleAnswer(p) { return { value: Math.round(p.min + Math.random() * (p.max - p.min)) }; },
};
