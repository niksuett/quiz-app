// ─────────────────────────────────────────────────────────────────────────────
// games/flag.js — flag image + 4 country names. `question` holds the ISO 3166-1
// alpha-2 code (lowercase); the client builds the image URL from it.
// ─────────────────────────────────────────────────────────────────────────────
const { validateMC, validateCommon, mcAnswers, evaluateMC, revealMC } = require('./_shared');

module.exports = {
  type: 'flag',
  categories: [
    { id: 'flags', label: 'Flags', emoji: '🏳️', group: 'classic', order: 20,
      blurb: 'Which country flies this flag?',
      howTo:  'Look at the flag, tap the country. Fastest correct answer scores most.' },
  ],
  timeLimit: 15,
  revealPause: 6,
  earlyPause: 3000,
  speedScored: true,
  usesRegion: true,

  validate(q) {
    const errors = [...validateCommon(q), ...validateMC(q)];
    if (!/^[a-z]{2}$/.test(q.question || '')) errors.push('"question" must be a lowercase 2-letter ISO country code (e.g. "fr")');
    return errors;
  },

  toRow(q)            { return { correct: String(q.correct), extra: { answers: q.answers } }; },
  fromRow(row, extra) { return { answers: extra.answers, correct: parseInt(row.correct, 10) }; },

  payload(q, game) { return { code: q.question, answers: mcAnswers(q, game) }; },   // options shuffled per game

  evaluate(q, answer, ctx) { return evaluateMC(q, answer, ctx && ctx.game); },
  reveal(q, answers, game) { return { ...revealMC(q, answers, game), code: q.question }; },
  correctText(q)      { return q.answers[q.correct]; },
  sampleAnswer()      { return { index: Math.floor(Math.random() * 4) }; },
};
