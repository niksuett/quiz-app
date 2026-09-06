// ─────────────────────────────────────────────────────────────────────────────
// games/slider.js — estimation: drag a slider (or type a number) to guess a value.
// Quality falls linearly with the distance from the correct value, measured as a
// share of half the slider range (so the range chosen by the author defines
// what counts as "close").
// ─────────────────────────────────────────────────────────────────────────────
const { validateCommon, clamp, hashString, seededRandom } = require('./_shared');

// ── Where the answer sits inside the range ────────────────────────────────────
// The authored ranges put the answer close to the middle: measured across all
// 184 slider + timeline questions the answer's position averaged 0.49 with a
// standard deviation of only 0.12, and 39% of timeline answers were within 5% of
// dead centre. So "drag to the exact middle, every round" scored 80/100 with no
// knowledge at all — better than a player who actually knows roughly the answer
// but is off by a tenth of the range. (The client already starts the thumb at a
// random spot, which is why a genuinely lazy player scores ~56 rather than 80 —
// but that does nothing against someone who deliberately aims for the centre.)
//
// So slide the window per game so the answer lands somewhere else. The WIDTH is
// deliberately preserved: proximityQuality measures error against half the
// range, so the width IS the scoring tolerance and changing it would silently
// change how hard the question is.
//
// Seeded from game id + question id, exactly like the mc option shuffle, so
// payload(), evaluate() and reveal() all derive the identical range and a
// reconnecting player sees the same bounds. With no game (dev harness, import
// validation) the authored range is used unchanged.
function shownRange(q, game) {
  const width = q.max - q.min;
  if (!game || !game.id || !(width > 0)) return { min: q.min, max: q.max };

  const rnd = seededRandom(hashString(`range:${game.id}:${q.id !== undefined ? q.id : q.question}`));
  const target = 0.15 + rnd() * 0.70;          // where the answer should sit, 0..1

  // Round the new bound to something that reads like a deliberate choice rather
  // than a random offset ("150–700", not "162.4–712.4").
  const step = (typeof q.step === 'number' && q.step > 0) ? q.step : 1;
  const nice = Math.max(step, Math.pow(10, Math.floor(Math.log10(width)) - 1));
  const boundsFor = (p) => {
    const lo = Math.round((q.correct - p * width) / nice) * nice;
    return { min: lo, max: lo + width };
  };

  // Guardrails. A quantity authored as non-negative must stay non-negative
  // (timeline questions legitimately go negative — those are BCE years), and a
  // percentage must stay inside 0–100.
  const floor = q.unit === '%' ? 0 : (q.min >= 0 ? 0 : -Infinity);
  const ceil  = q.unit === '%' ? 100 : Infinity;

  // If sliding one way runs off an edge, try the mirror image before clamping —
  // clamping piles a lot of questions onto min = 0, which both looks careless
  // ("How many calories? 0 to 950") and re-introduces a predictable bound.
  let { min, max } = boundsFor(target);
  if (min < floor || max > ceil) ({ min, max } = boundsFor(1 - target));
  if (min < floor) { min = floor; max = min + width; }
  if (max > ceil)  { max = ceil;  min = max - width; }

  // If the guardrails fought each other, keep what the author wrote.
  if (min < floor || max > ceil || min > q.correct || max < q.correct) return { min: q.min, max: q.max };
  return { min, max };
}

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

  payload(q, game) {
    const { min, max } = shownRange(q, game);
    return { question: q.question, min, max, step: q.step || 1, unit: q.unit || '', imageUrl: q.imageUrl || null };
  },

  evaluate(q, answer, ctx) {
    const raw = answer && typeof answer.value === 'number' ? answer.value : NaN;
    if (Number.isNaN(raw)) return null;
    // Score against the range the player was actually shown, not the authored one.
    const { min, max } = shownRange(q, ctx && ctx.game);
    const value   = clamp(raw, min, max);
    const diff    = Math.abs(value - q.correct);
    const quality = proximityQuality(value, q.correct, min, max);
    return {
      quality,
      detail: { value, diff, unit: q.unit || '' },
      result: { yourAnswer: value, correctValue: q.correct, diff, unit: q.unit || '', accuracyPct: Math.round(quality * 100) },
    };
  },

  reveal(q, answers, game) {
    const { min, max } = shownRange(q, game);
    return {
      correctValue: q.correct, unit: q.unit || '', min, max,
      guesses: answers.map(a => ({ nickname: a.nickname, value: a.detail.value, diff: a.detail.diff })),
    };
  },

  correctText(q) { return q.unit ? `${q.correct.toLocaleString('en-US')} ${q.unit}` : q.correct.toLocaleString('en-US'); },

  sampleAnswer(p) { return { value: p.min + Math.random() * (p.max - p.min) }; },

  // exported for timeline.js
  _validateRange: validateRange,
  _proximityQuality: proximityQuality,
  _shownRange: shownRange,
};
