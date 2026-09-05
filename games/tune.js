// ─────────────────────────────────────────────────────────────────────────────
// games/tune.js — "Name That Tune": a chiptune melody plays, players pick the title.
//
// There are no audio files anywhere in this game. A question stores the melody
// as a plain list of notes — [midiNoteNumber, lengthInBeats] — plus a tempo and
// a waveform name. The browser turns that list into sound with the Web Audio
// API (a single oscillator playing one note after another), so the game works
// offline, loads instantly and sounds identical on every device.
//
// MIDI note numbers: 60 = middle C (C4), 62 = D4, 64 = E4 … every step of 1 is
// one semitone. We use 0 to mean "a rest" (silence for that many beats).
// Beats are fractions of a quarter note: 1 = quarter, 0.5 = eighth, 2 = half.
//
// Mechanically this is an ordinary multiple-choice question, so almost all of
// the work is done by the shared MC helpers in games/_shared.js. Only the audio
// data is special: it travels in the payload (which is safe — the melody is the
// question, not the answer) and again in the reveal, so the leaderboard can
// replay the tune with the title shown.
// ─────────────────────────────────────────────────────────────────────────────
const { validateMC, validateCommon, mcAnswers, evaluateMC, revealMC } = require('./_shared');

// ── Limits (also documented in docs/games/tune.md) ────────────────────────────
const MIN_NOTES = 8, MAX_NOTES = 40;      // long enough to recognise, short enough to fit the timer
const MIN_MIDI  = 36, MAX_MIDI  = 96;     // C2 … C7 — anything outside is inaudible or shrill
const MIN_BPM   = 50, MAX_BPM   = 220;
const WAVES     = ['square', 'triangle', 'sawtooth', 'sine'];
const DEFAULT_WAVE = 'square';            // classic 8-bit lead sound

const PROMPT = 'Name that tune';

// Validate the note list. Returns an array of human-readable problems ([] = fine).
function validateNotes(notes) {
  const errors = [];
  if (!Array.isArray(notes)) return ['"notes" must be an array of [midi, beats] pairs'];
  if (notes.length < MIN_NOTES || notes.length > MAX_NOTES)
    errors.push(`"notes" must contain ${MIN_NOTES}–${MAX_NOTES} notes (got ${notes.length})`);
  notes.forEach((n, i) => {
    if (!Array.isArray(n) || n.length !== 2) { errors.push(`note ${i + 1} must be a [midi, beats] pair`); return; }
    const [midi, beats] = n;
    if (!Number.isInteger(midi) || (midi !== 0 && (midi < MIN_MIDI || midi > MAX_MIDI)))
      errors.push(`note ${i + 1}: midi must be 0 (rest) or an integer ${MIN_MIDI}–${MAX_MIDI} (got ${midi})`);
    if (typeof beats !== 'number' || !(beats > 0) || beats > 16)
      errors.push(`note ${i + 1}: beats must be a number greater than 0 (got ${beats})`);
  });
  return errors;
}

// Total playing time of a melody in seconds — handy for the docs/tools and for
// warning an author that a tune would run past the 25 s question timer.
function durationSec(notes, bpm) {
  const beats = notes.reduce((sum, n) => sum + (Array.isArray(n) ? n[1] : 0), 0);
  return beats * 60 / bpm;
}

module.exports = {
  type: 'tune',
  categories: [
    { id: 'tunes', label: 'Name That Tune', emoji: '🎵', group: 'classic', order: 35,
      blurb: 'A chiptune melody plays. Which piece is it?',
      howTo:  'Listen (tap replay if you like) and pick the title. Fastest correct answer scores most.' },
  ],
  timeLimit: 25,
  revealPause: 8,
  earlyPause: 3500,
  speedScored: true,   // correct answers score more the faster they come in
  usesRegion: false,   // music is not tagged by continent

  // ── Validation (import.js / admin) ─────────────────────────────────────────
  validate(q) {
    const errors = [...validateCommon(q), ...validateMC(q), ...validateNotes(q.notes)];
    if (typeof q.bpm !== 'number' || !Number.isFinite(q.bpm) || q.bpm < MIN_BPM || q.bpm > MAX_BPM)
      errors.push(`"bpm" must be a number ${MIN_BPM}–${MAX_BPM} (got ${q.bpm})`);
    if (q.wave !== undefined && !WAVES.includes(q.wave))
      errors.push(`"wave" must be one of ${WAVES.join(', ')}`);
    return errors;
  },

  // ── DB (de)serialisation of the type-specific fields ───────────────────────
  // The common fields (category, question, region, difficulty…) are handled by db.js.
  toRow(q) {
    return {
      correct: String(q.correct),
      extra: { answers: q.answers, notes: q.notes, bpm: q.bpm, wave: q.wave || DEFAULT_WAVE },
    };
  },
  fromRow(row, extra) {
    return {
      answers: extra.answers || [],
      notes:   extra.notes   || [],
      bpm:     extra.bpm     || 120,
      wave:    extra.wave    || DEFAULT_WAVE,
      correct: parseInt(row.correct, 10),
    };
  },

  // ── What every client gets when the question starts ────────────────────────
  // The melody plus the four titles. The correct index is NOT included — the
  // title of the played piece is simply one of the four options, as in any
  // multiple-choice question.
  payload(q, game) {
    return {
      prompt: PROMPT,
      notes:  q.notes,
      bpm:    q.bpm,
      wave:   q.wave || DEFAULT_WAVE,
      answers: mcAnswers(q, game),   // options shuffled per game (seeded, see _shared.js)
    };
  },

  // ── One player's answer: { index: 0–3 } ────────────────────────────────────
  // evaluateMC is already defensive: anything that is not an integer 0–3
  // (undefined, a string, null, an object…) makes it return null = rejected.
  evaluate(q, answer, ctx) {
    return evaluateMC(q, answer, ctx && ctx.game);
  },

  // ── Leaderboard reveal (everyone) ──────────────────────────────────────────
  // The melody rides along so the reveal can replay it now that the title is known.
  reveal(q, answers, game) {
    return {
      ...revealMC(q, answers, game),
      notes: q.notes,
      bpm:   q.bpm,
      wave:  q.wave || DEFAULT_WAVE,
    };
  },

  correctText(q) { return q.answers[q.correct]; },

  // Used by test/simulate.js so bots can play this type headlessly.
  sampleAnswer() { return { index: Math.floor(Math.random() * 4) }; },

  // Exposed for tools and tests (not part of the module contract).
  _durationSec: durationSec,
  _limits: { MIN_NOTES, MAX_NOTES, MIN_MIDI, MAX_MIDI, MIN_BPM, MAX_BPM, WAVES },
};
