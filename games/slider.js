// ─────────────────────────────────────────────────────────────────────────────
// games/slider.js — estimation: drag a slider (or type a number) to guess a value.
// Quality falls linearly with the distance from the correct value, measured as a
// share of half the slider range (so the range chosen by the author defines
// what counts as "close").
// ─────────────────────────────────────────────────────────────────────────────
const { validateCommon, clamp } = require('./_shared');

function validateRange(q) {
  const errors = [];
  for (const k of ['min', 'max', 'correct']) if (typeof q[k] !== 'number' || Number.isNaN(q[k])) errors.push(`"${k}" must be a number`);
  if (errors.length) return errors;
  if (q.min >= q.max) errors.push('"min" must be less than "max"');
  if (q.correct < q.min || q.correct > q.max) errors.push(`"correct" (${q.correct}) is outside ${q.min}–${q.max}`);
  if (q.step !== undefined && (typeof q.step !== 'number' || q.step <= 0)) errors.push('"step" must be a positive number');
  return errors;
}

function proximityQuality(value, correct, min, max) {
  const halfRange = (max - min) / 2;
  const error     = Math.abs(value - correct);
  return clamp(1 - error / halfRange, 0, 1);
}

module.exports = {
  type: 'slider',
  categories: [
    { id: 'estimation', label: 'Estimation', emoji: '📏', group: 'classic', order: 60,
      blurb: 'How tall, how many, how far? Slide to your best guess.',
      howTo:  'Drag the slider or type a number. Closest guess wins the round.' },
  ],
  timeLimit: 20,
  revealPause: 8,
  earlyPause: 4000,
  speedScored: false,
  usesRegion: false,

  validate(q) { return [...validateCommon(q), ...validateRange(q)]; },

  toRow(q)            { return { correct: String(q.correct), extra: { min: q.min, max: q.max, step: q.step || 1, unit: q.unit || '' } }; },
  fromRow(row, extra) { return { min: extra.min, max: extra.max, step: extra.step || 1, unit: extra.unit || '', correct: parseFloat(row.correct) }; },

  payload(q) { return { question: q.question, min: q.min, max: q.max, step: q.step || 1, unit: q.unit || '', imageUrl: q.imageUrl || null }; },

  evaluate(q, answer) {
    const raw = answer && typeof answer.value === 'number' ? answer.value : NaN;
    if (Number.isNaN(raw)) return null;
    const value   = clamp(raw, q.min, q.max);
    const diff    = Math.abs(value - q.correct);
    const quality = proximityQuality(value, q.correct, q.min, q.max);
    return {
      quality,
      detail: { value, diff, unit: q.unit || '' },
      result: { yourAnswer: value, correctValue: q.correct, diff, unit: q.unit || '', accuracyPct: Math.round(quality * 100) },
    };
  },

  reveal(q, answers) {
    return {
      correctValue: q.correct, unit: q.unit || '', min: q.min, max: q.max,
      guesses: answers.map(a => ({ nickname: a.nickname, value: a.detail.value, diff: a.detail.diff })),
    };
  },

  correctText(q) { return q.unit ? `${q.correct.toLocaleString('en-US')} ${q.unit}` : q.correct.toLocaleString('en-US'); },

  sampleAnswer(p) { return { value: p.min + Math.random() * (p.max - p.min) }; },

  // exported for timeline.js
  _validateRange: validateRange,
  _proximityQuality: proximityQuality,
};
