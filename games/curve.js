// ─────────────────────────────────────────────────────────────────────────────
// games/curve.js — "Draw the Curve": the start of a real chart is shown, the
// player draws how the line continues, the reveal overlays the truth.
//
// A question carries its own time series ([[year, value], …]) so the game
// never needs the network at play time. The first `knownFraction` of the
// x-range is revealed in the payload; everything after it is the secret.
//
// Scoring: for every hidden year we measure how far the drawn value is from the
// truth, as a share of the axis height. The mean of those errors (mae) becomes
// the quality: mae ≤ 1.5 % of the axis = perfect, 30 % of the axis or worse = 0.
// ─────────────────────────────────────────────────────────────────────────────
const { validateCommon, clamp } = require('./_shared');

const MIN_POINTS   = 5;
const MAX_POINTS   = 60;
const HEADROOM     = 0.10;   // the truth must stay ≥ 10 % of the axis away from the top (and the bottom, unless yMin is 0)
const PERFECT_MAE  = 0.015;  // mean error ≤ 1.5 % of the axis counts as a perfect drawing
const ZERO_MAE     = 0.30;   // mean error of 30 % of the axis (or worse) scores 0

// ── Helpers ───────────────────────────────────────────────────────────────────
const isNum = v => typeof v === 'number' && Number.isFinite(v);

// Split the series into the revealed part and the hidden part.
// The known part = every point whose x ≤ xMin + knownFraction × (xMax − xMin), but at least 2 points
// (so the player always sees a direction) and never the whole series.
function splitSeries(q) {
  const s = q.series;
  const xMin = s[0][0], xMax = s[s.length - 1][0];
  const cut  = xMin + (q.knownFraction ?? 0.25) * (xMax - xMin);
  let n = s.filter(p => p[0] <= cut).length;
  n = Math.max(2, Math.min(n, s.length - 1));
  return { known: s.slice(0, n), hidden: s.slice(n), xMin, xMax };
}

function maeToQuality(mae) {
  if (mae <= PERFECT_MAE) return 1;
  return clamp(1 - mae / ZERO_MAE, 0, 1);
}

// Format a value the way the client should: fixed decimals + unit ("8.0 bn", "42 %", "$1,234")
function fmt(v, q) {
  const d = q.decimals ?? 2;
  const s = Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (!q.unit) return s;
  if (q.unit === '$') return '$' + s;
  return `${s} ${q.unit}`;
}

module.exports = {
  type: 'curve',
  categories: [
    { id: 'curves', label: 'Draw the Curve', emoji: '📈', group: 'draw', order: 30,
      blurb: 'You know how it started. Draw how it went on.',
      howTo:  'The start of the chart is given — draw the rest of the line with your finger, then lock in.' },
  ],
  timeLimit: 40,
  revealPause: 12,
  earlyPause: 5000,
  speedScored: false,
  usesRegion: false,

  // ── Validation (import.js / admin) ─────────────────────────────────────────
  validate(q) {
    const errors = validateCommon(q);
    const s = q.series;
    if (!Array.isArray(s) || s.length < MIN_POINTS || s.length > MAX_POINTS) {
      errors.push(`"series" must be an array of ${MIN_POINTS}–${MAX_POINTS} [x, y] points`);
      return errors;
    }
    for (let i = 0; i < s.length; i++) {
      const p = s[i];
      if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || !isNum(p[1])) { errors.push(`series[${i}] must be [integer x, number y]`); return errors; }
      if (i > 0 && p[0] <= s[i - 1][0]) errors.push(`series x values must be strictly increasing (at index ${i})`);
    }
    if (!isNum(q.yMin) || !isNum(q.yMax) || q.yMin >= q.yMax) { errors.push('"yMin" must be a number less than "yMax"'); return errors; }
    const range = q.yMax - q.yMin;
    const ys = s.map(p => p[1]);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    if (q.yMax - hi < HEADROOM * range) errors.push(`the highest value (${hi}) needs ≥ 10 % headroom below yMax (${q.yMax})`);
    if (q.yMin === 0 ? lo < 0 : lo - q.yMin < HEADROOM * range) errors.push(`the lowest value (${lo}) needs ≥ 10 % headroom above yMin (${q.yMin}) — or use yMin: 0`);
    if (q.knownFraction !== undefined && (!isNum(q.knownFraction) || q.knownFraction < 0.1 || q.knownFraction > 0.5)) errors.push('"knownFraction" must be between 0.1 and 0.5');
    if (q.decimals !== undefined && (!Number.isInteger(q.decimals) || q.decimals < 0 || q.decimals > 4)) errors.push('"decimals" must be an integer 0–4');
    for (const k of ['xLabel', 'yLabel', 'unit', 'source']) if (q[k] !== undefined && typeof q[k] !== 'string') errors.push(`"${k}" must be a string`);
    return errors;
  },

  // ── DB serialisation ───────────────────────────────────────────────────────
  toRow(q) {
    return {
      correct: String(q.series[q.series.length - 1][1]),   // last value — handy when browsing the DB
      extra: {
        series: q.series, xLabel: q.xLabel || 'Year', yLabel: q.yLabel || '', unit: q.unit || '',
        yMin: q.yMin, yMax: q.yMax, knownFraction: q.knownFraction ?? 0.25, decimals: q.decimals ?? 2, source: q.source || '',
      },
    };
  },
  fromRow(row, extra) {
    return {
      series: extra.series, xLabel: extra.xLabel || 'Year', yLabel: extra.yLabel || '', unit: extra.unit || '',
      yMin: extra.yMin, yMax: extra.yMax, knownFraction: extra.knownFraction ?? 0.25, decimals: extra.decimals ?? 2, source: extra.source || '',
    };
  },

  // ── What every client receives when the question starts ────────────────────
  // Only the known points carry values; the hidden years are listed as bare x's.
  payload(q) {
    const { known, xMin, xMax } = splitSeries(q);
    return {
      question: q.question,
      xs: q.series.map(p => p[0]),
      known,
      xMin, xMax, yMin: q.yMin, yMax: q.yMax,
      xLabel: q.xLabel || 'Year', yLabel: q.yLabel || '', unit: q.unit || '', decimals: q.decimals ?? 2,
    };
  },

  // ── Judge one answer: { ys: [number|null, …] } — one entry per hidden x ────
  evaluate(q, answer) {
    if (!answer || typeof answer !== 'object' || !Array.isArray(answer.ys)) return null;
    const { hidden } = splitSeries(q);
    if (answer.ys.length !== hidden.length) return null;
    const range = q.yMax - q.yMin;
    const ys = [];
    let sum = 0, drawn = 0;
    for (let i = 0; i < hidden.length; i++) {
      const raw = answer.ys[i];
      if (raw === null || raw === undefined || !isNum(Number(raw))) { ys.push(null); sum += 1; continue; }   // a gap counts as a full miss
      const y = clamp(Number(raw), q.yMin, q.yMax);
      ys.push(Math.round(y * 1000) / 1000);
      sum += Math.abs(y - hidden[i][1]) / range;
      drawn++;
    }
    if (drawn === 0) return null;                       // nothing drawn at all → rejected, the client should not submit this
    const mae     = Math.round(sum / hidden.length * 10000) / 10000;
    const quality = maeToQuality(mae);
    return {
      quality,
      detail: { ys, mae },
      result: {
        truth: q.series, ys, mae, score: Math.round(quality * 100),
        unit: q.unit || '', decimals: q.decimals ?? 2,
        lastTruth: q.series[q.series.length - 1], lastYours: ys[ys.length - 1],
      },
    };
  },

  // ── Leaderboard reveal (everyone) ──────────────────────────────────────────
  reveal(q, answers) {
    const { known, xMin, xMax } = splitSeries(q);
    return {
      xs: q.series.map(p => p[0]),
      truth: q.series,
      known,
      xMin, xMax, yMin: q.yMin, yMax: q.yMax,
      xLabel: q.xLabel || 'Year', yLabel: q.yLabel || '', unit: q.unit || '', decimals: q.decimals ?? 2, source: q.source || '',
      lines: answers.map(a => ({ nickname: a.nickname, ys: a.detail.ys, mae: a.detail.mae, score: Math.round(a.quality * 100) })),
    };
  },

  correctText(q) {
    const last = q.series[q.series.length - 1];
    return `Ended at ${fmt(last[1], q)} in ${last[0]}`;
  },

  // A noisy line drifting away from the last known value (used by test/simulate.js)
  sampleAnswer(p) {
    const hiddenCount = p.xs.length - p.known.length;
    const range = p.yMax - p.yMin;
    let y = p.known[p.known.length - 1][1];
    const drift = (Math.random() - 0.5) * range * 0.06;
    const ys = [];
    for (let i = 0; i < hiddenCount; i++) {
      y = clamp(y + drift + (Math.random() - 0.5) * range * 0.04, p.yMin, p.yMax);
      ys.push(Math.round(y * 1000) / 1000);
    }
    return { ys };
  },

  // exported for tests / tools
  _splitSeries: splitSeries,
  _maeToQuality: maeToQuality,
  _fmt: fmt,
};
