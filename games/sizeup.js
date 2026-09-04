// ─────────────────────────────────────────────────────────────────────────────
// games/sizeup.js — "Size It Up" 📐
//
// Two silhouettes stand side by side: a BROWN reference of known size (a person,
// a bus, a house…) and a RED target whose size is the secret. Players drag a
// slider until the red shape looks the right size next to the brown one, then
// lock in.
//
// Why this is fun: everybody has an intuition for "how big is a blue whale next
// to a bus?" and almost everybody is wrong. Scoring is on the RATIO, not the
// absolute difference, so guessing 3 m for a 1.5 m animal is exactly as bad as
// guessing 15 m for a 30 m one.
//
// Data: the silhouettes live in data/silhouettes.json, built by
// tools/build-silhouettes.js from the game-icons.net set (CC BY 3.0).
// A question only stores icon KEYS ("whale", "bus"); the SVG bodies are looked
// up here and shipped in the payload.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const { validateCommon, clamp } = require('./_shared');

// ── 1. Load the silhouette library once, at require time ─────────────────────
// Shape: { credit, license, source, icons: { key: { name, body, w, h, flip? } } }
const DATA_FILE = path.join(__dirname, '..', 'data', 'silhouettes.json');
let LIB = { icons: {} };
try {
  LIB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  console.warn(`games/sizeup.js: could not read ${DATA_FILE} — run "node tools/build-silhouettes.js" (${e.message})`);
}
const ICONS = LIB.icons || {};

// ── 2. Scoring constants ─────────────────────────────────────────────────────
// A guess within 6 % of the truth is a perfect 1.0; being 2.5× too big or too
// small scores 0. In between, quality falls linearly in LOG space (so "twice as
// big" and "half as big" are punished identically).
const PERFECT_LN = Math.log(1.06);   // ≈ 0.0583
const ZERO_LN    = Math.log(2.5);    // ≈ 0.9163

// ── 3. Small helpers ─────────────────────────────────────────────────────────

// Round to 2 significant digits, e.g. 3.71 → 3.7, 137 → 140, 0.0123 → 0.012.
// Used for the slider range so the endpoints look "human" and never hint at the
// exact answer.
function round2sig(n) {
  if (!(n > 0)) return n;
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}

// The icon record sent to the client (no internal name needed, but harmless).
function iconPayload(key) {
  const ic = ICONS[key];
  if (!ic) throw new Error(`sizeup: unknown silhouette key "${key}" — add it to tools/build-silhouettes.js`);
  return { key, body: ic.body, w: ic.w, h: ic.h, flip: !!ic.flip };
}

// Human-friendly size string: metres, or centimetres below 1 m.
function fmtSize(m) {
  if (!(m > 0)) return '?';
  if (m < 0.01) return `${(m * 1000).toFixed(m * 1000 < 10 ? 1 : 0)} mm`;
  if (m < 1)    return `${(m * 100).toFixed(m * 100 < 10 ? 1 : 0)} cm`;
  if (m < 10)   return `${m.toFixed(m < 3 ? 2 : 1)} m`;
  return `${Math.round(m).toLocaleString('en-US')} m`;
}

// "tall" / "long" from the dim field — used in the reveal banner text.
const DIM_WORD = { height: 'tall', length: 'long' };

// Validate one side of a question ({ name, icon, sizeM, dim }).
function validateSide(side, label, errors, needSize) {
  if (!side || typeof side !== 'object') { errors.push(`"${label}" must be an object`); return; }
  if (typeof side.name !== 'string' || !side.name.trim()) errors.push(`"${label}.name" must be a non-empty string`);
  if (typeof side.icon !== 'string' || !ICONS[side.icon])  errors.push(`"${label}.icon" ("${side.icon}") is not a key in data/silhouettes.json`);
  if (needSize && (typeof side.sizeM !== 'number' || !(side.sizeM > 0) || !Number.isFinite(side.sizeM)))
    errors.push(`"${label}.sizeM" must be a positive number (metres)`);
  if (!['height', 'length'].includes(side.dim))
    errors.push(`"${label}.dim" must be "height" or "length"`);
}

module.exports = {
  type: 'sizeup',
  categories: [
    { id: 'sizeup', label: 'Size It Up', emoji: '📐', group: 'draw', order: 40,
      blurb: 'How big is a blue whale next to a bus? Resize it.',
      howTo:  'Drag the slider (or pinch) until the red silhouette looks the right size next to the brown reference, then lock in.' },
  ],
  timeLimit: 30,
  revealPause: 10,
  earlyPause: 4000,
  speedScored: false,   // ranked by accuracy; speed only breaks ties (core does that)
  usesRegion: false,

  // ── Validation (import.js / admin) ─────────────────────────────────────────
  validate(q) {
    const errors = [...validateCommon(q)];
    validateSide(q.target,    'target',    errors, true);
    validateSide(q.reference, 'reference', errors, true);
    if (!errors.length) {
      if (q.target.icon === q.reference.icon) errors.push('target and reference must use different silhouettes');
      const ratio = q.target.sizeM / q.reference.sizeM;
      if (ratio > 60 || ratio < 1 / 40)
        errors.push(`target/reference size ratio ${ratio.toFixed(2)} is too extreme — pick a closer reference`);
    }
    return errors;
  },

  // ── DB (de)serialisation ───────────────────────────────────────────────────
  // `correct` holds the true target size in metres so it is greppable in the DB;
  // everything else lives in the extra JSON blob.
  toRow(q) {
    return {
      correct: String(q.target.sizeM),
      extra: {
        target:    { name: q.target.name,    icon: q.target.icon,    dim: q.target.dim },
        reference: { name: q.reference.name, icon: q.reference.icon, dim: q.reference.dim, sizeM: q.reference.sizeM },
      },
    };
  },
  fromRow(row, extra) {
    return {
      target:    { ...extra.target, sizeM: parseFloat(row.correct) },
      reference: { ...extra.reference },
    };
  },

  // ── Payload: what every client gets when the question starts ───────────────
  // The truth is NEVER sent. The slider range is randomised around the truth so
  // that the midpoint of the slider carries no information: min = truth / r1 and
  // max = truth × r2 with r1, r2 drawn independently from [4, 14].
  payload(q) {
    const truth = q.target.sizeM;
    const r1 = 4 + Math.random() * 10;
    const r2 = 4 + Math.random() * 10;
    let min = round2sig(truth / r1);
    let max = round2sig(truth * r2);
    if (!(min > 0)) min = truth / 20;          // paranoia for very tiny targets
    if (max <= min * 2) max = round2sig(min * 8);
    return {
      question: q.question,
      target:    { name: q.target.name, dim: q.target.dim, icon: iconPayload(q.target.icon) },
      reference: { name: q.reference.name, dim: q.reference.dim, sizeM: q.reference.sizeM, icon: iconPayload(q.reference.icon) },
      range: { min, max },
      credit: LIB.credit || '',
    };
  },

  // ── Evaluate one answer: { sizeM: number } ─────────────────────────────────
  // Defensive: anything that is not a finite positive number is rejected (null).
  evaluate(q, answer) {
    const raw = answer && typeof answer.sizeM === 'number' ? answer.sizeM : NaN;
    if (!Number.isFinite(raw) || raw <= 0) return null;

    const truth = q.target.sizeM;
    // Clamp to a sane band so a hostile client cannot send 1e300.
    const sizeM = clamp(raw, truth / 1e4, truth * 1e4);
    const ratio = sizeM / truth;
    const err   = Math.abs(Math.log(ratio));
    const quality = err <= PERFECT_LN ? 1 : clamp(1 - (err - PERFECT_LN) / (ZERO_LN - PERFECT_LN), 0, 1);

    return {
      quality,
      detail: { sizeM, ratio },
      result: {
        trueSizeM: truth,
        yourSizeM: sizeM,
        ratio,
        dim: q.target.dim,
        targetName: q.target.name,
        referenceName: q.reference.name,
        score: Math.round(quality * 100),
      },
    };
  },

  // ── Leaderboard reveal (everyone sees this) ────────────────────────────────
  reveal(q, answers) {
    return {
      target:    { name: q.target.name,    dim: q.target.dim,    sizeM: q.target.sizeM,    icon: iconPayload(q.target.icon) },
      reference: { name: q.reference.name, dim: q.reference.dim, sizeM: q.reference.sizeM, icon: iconPayload(q.reference.icon) },
      guesses: answers.map(a => ({
        nickname: a.nickname,
        sizeM: a.detail && a.detail.sizeM,
        ratio: a.detail && a.detail.ratio,
      })),
    };
  },

  // ── One-line banner under the leaderboard ──────────────────────────────────
  correctText(q) {
    return `${q.target.name}: ${fmtSize(q.target.sizeM)} ${DIM_WORD[q.target.dim] || ''}`.trim();
  },

  // ── Headless test bot: a log-uniform random pick inside the slider range ───
  sampleAnswer(p) {
    const { min, max } = p.range;
    const t = Math.random();
    return { sizeM: Math.exp(Math.log(min) + t * (Math.log(max) - Math.log(min))) };
  },

  // Exposed for tools/tests (not part of the contract).
  _icons: ICONS,
  _fmtSize: fmtSize,
};
