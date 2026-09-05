// ─────────────────────────────────────────────────────────────────────────────
// games/mc.js — plain multiple choice (4 buttons, one correct).
// Categories: trivia (merged facts/science/sports/entertainment) and emoji riddles.
// ─────────────────────────────────────────────────────────────────────────────
const { validateMC, validateCommon, mcAnswers, evaluateMC, revealMC } = require('./_shared');

module.exports = {
  type: 'mc',
  categories: [
    { id: 'trivia', label: 'Trivia', emoji: '🧠', group: 'classic', order: 10,
      blurb: 'General knowledge, science, sport and culture.',
      howTo:  'Four options, one is right. Fastest correct answer scores most.' },
    { id: 'emoji',  label: 'Emoji Riddles', emoji: '🎬', group: 'classic', order: 40,
      blurb: 'Decode the emoji — a film, a place, a phrase.',
      howTo:  'Read the emoji clue and pick what it describes. Speed counts.' },
  ],
  timeLimit: 15,
  revealPause: 6,
  earlyPause: 3000,
  speedScored: true,
  usesRegion: false,

  validate(q) { return [...validateCommon(q), ...validateMC(q)]; },

  toRow(q) {
    const extra = { answers: q.answers };
    if (q.topic) extra.topic = q.topic;   // trivia keeps its old sub-topic (facts / science / …)
    return { correct: String(q.correct), extra };
  },
  fromRow(row, extra) {
    const out = { answers: extra.answers, correct: parseInt(row.correct, 10) };
    if (extra.topic) out.topic = extra.topic;
    return out;
  },

  // The four options are shuffled per game (seeded, see _shared.js mcOrder) so
  // the stored order never becomes a tell.
  payload(q, game) {
    return { question: q.question, answers: mcAnswers(q, game), imageUrl: q.imageUrl || null, topic: q.topic || null };
  },

  evaluate(q, answer, ctx)  { return evaluateMC(q, answer, ctx && ctx.game); },
  reveal(q, answers, game)  { return revealMC(q, answers, game); },
  correctText(q)      { return q.answers[q.correct]; },
  sampleAnswer()      { return { index: Math.floor(Math.random() * 4) }; },
};
