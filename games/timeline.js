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

  payload(q) { return { question: q.question, min: q.min, max: q.max, imageUrl: q.imageUrl || null }; },

  evaluate(q, answer) {
    const raw = answer && typeof answer.value === 'number' ? Math.round(answer.value) : NaN;
    if (Number.isNaN(raw)) return null;
    const value   = clamp(raw, q.min, q.max);
    const diff    = Math.abs(value - q.correct);
    const quality = slider._proximityQuality(value, q.correct, q.min, q.max);
    return {
      quality,
      detail: { value, diff },
      result: { yourAnswer: value, correctValue: q.correct, diff, accuracyPct: Math.round(quality * 100) },
    };
  },

  reveal(q, answers) {
    return {
      correctValue: q.correct, min: q.min, max: q.max,
      guesses: answers.map(a => ({ nickname: a.nickname, value: a.detail.value, diff: a.detail.diff })),
    };
  },

  correctText(q) { return formatYear(q.correct); },
  sampleAnswer(p) { return { value: Math.round(p.min + Math.random() * (p.max - p.min)) }; },
};
