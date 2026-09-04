// ─────────────────────────────────────────────────────────────────────────────
// scoring.js — the single scoring system (see docs/ARCHITECTURE.md §7).
//
// Every answer gets a "quality" between 0 and 1 from its game module
// (1 = perfect, null = wrong / no answer). This file turns quality into points:
//
//   accuracy points  0–100 from quality (speed-scaled for MC-style questions)
//   rank bonus       +50 / +30 / +15 for the three best answers of the round
//   streak bonus     +20 once you have answered 3+ questions in a row well
//   final round ×2   optional host setting — doubles everything on the last question
// ─────────────────────────────────────────────────────────────────────────────

const RANK_BONUS  = [50, 30, 15];
const STREAK_MIN  = 3;   // streak length needed for the bonus
const STREAK_ACC  = 60;  // accuracy points needed to keep a streak alive
const STREAK_PTS  = 20;

function accuracyPoints(quality, elapsed, timeLimit, speedScored) {
  if (quality === null || quality === undefined) return 0;
  if (speedScored) {
    const speed = Math.max(0, 1 - (elapsed / timeLimit));
    return Math.round(100 * (0.5 + 0.5 * speed));
  }
  return Math.round(100 * Math.max(0, Math.min(1, quality)));
}

// Called once per question, after all answers are in. Mutates game.players.
function applyRoundScores(game, question, mod) {
  const multiplier = (game.options.finalDouble && game.currentIndex === game.questions.length - 1) ? 2 : 1;
  const timeLimit  = mod.timeLimit;

  // Ranked players = answered with a non-null quality, best first (speed breaks ties)
  const ranked = game.players
    .filter(p => p.answer && p.answer.quality !== null && p.answer.quality !== undefined)
    .sort((a, b) => (b.answer.quality - a.answer.quality) || (a.answer.elapsed - b.answer.elapsed));

  ranked.forEach((p, i) => {
    const prev = ranked[i - 1], next = ranked[i + 1];
    p.round.speedTiebreak      = !!next && next.answer.quality === p.answer.quality;
    p.round.speedTiebreakedOut = !!prev && prev.answer.quality === p.answer.quality;
  });

  for (const p of game.players) {
    const r = p.round;
    if (!p.answer || p.answer.quality === null || p.answer.quality === undefined) {
      // Wrong answer or no answer: 0 points, streak broken
      r.accuracyPts = 0; r.rankBonus = 0; r.streakBonus = 0; r.roundRank = null; r.roundPoints = 0;
      p.streak = 0;
      if (p.answer) { p.stats.answered++; }
      continue;
    }
    const rank = ranked.indexOf(p);
    r.accuracyPts = accuracyPoints(p.answer.quality, p.answer.elapsed, timeLimit, mod.speedScored);
    // A rank bonus is only earned by an answer that had some merit (accuracy > ~2 pts)
    r.rankBonus   = p.answer.quality > 0.02 ? (RANK_BONUS[rank] || 0) : 0;
    r.roundRank   = rank + 1;

    p.streak = r.accuracyPts >= STREAK_ACC ? p.streak + 1 : 0;
    r.streakBonus = p.streak >= STREAK_MIN ? STREAK_PTS : 0;

    r.roundPoints = (r.accuracyPts + r.rankBonus + r.streakBonus) * multiplier;
    p.score += r.roundPoints;

    // Stats for end-of-game awards
    const s = p.stats;
    s.answered++;
    s.sumAccuracy += r.accuracyPts;
    if (rank === 0) s.firsts++;
    if (r.roundPoints > s.bestRound) s.bestRound = r.roundPoints;
    if (p.answer.quality >= 0.999) s.perfects++;
    if (p.streak > s.longestStreak) s.longestStreak = p.streak;
    if (mod.speedScored) { s.speedN++; s.speedSumMs += p.answer.elapsed * 1000; }
    const bt = s.byType[mod.type] || (s.byType[mod.type] = { n: 0, sumAccuracy: 0 });
    bt.n++; bt.sumAccuracy += r.accuracyPts;
    if (p.answer.quality < s.worstQuality) { s.worstQuality = p.answer.quality; s.worstDetail = { type: mod.type, question: question.question }; }
  }
  return { multiplier };
}

function newStats() {
  return { answered: 0, firsts: 0, bestRound: 0, sumAccuracy: 0, perfects: 0, longestStreak: 0,
           speedN: 0, speedSumMs: 0, byType: {}, worstQuality: 2, worstDetail: null, midRank: null };
}

function newRound() {
  return { roundPoints: 0, roundRank: null, accuracyPts: 0, rankBonus: 0, streakBonus: 0, speedTiebreak: false, speedTiebreakedOut: false };
}

// ── End-of-game awards ────────────────────────────────────────────────────────
// Returns up to 5 awards. Each award goes to one player; the champion is implied by rank 1.
function computeAwards(game) {
  const players = game.players.filter(p => p.stats.answered > 0);
  const awards  = [];
  const taken   = new Set();
  const give = (emoji, title, p, detail) => {
    if (!p || taken.has(p.nickname) && awards.length >= 3) return;
    awards.push({ emoji, title, nickname: p.nickname, detail });
    taken.add(p.nickname);
  };
  const best = (arr, key) => arr.length ? arr.reduce((a, b) => key(b) > key(a) ? b : a) : null;

  // Sharpshooter: highest average accuracy (min 3 answers)
  const sharp = best(players.filter(p => p.stats.answered >= 3), p => p.stats.sumAccuracy / p.stats.answered);
  if (sharp) give('🎯', 'Sharpshooter', sharp, `${Math.round(sharp.stats.sumAccuracy / sharp.stats.answered)} avg accuracy`);

  // Speed Demon: fastest average on speed-scored questions (min 2)
  const fast = players.filter(p => p.stats.speedN >= 2).sort((a, b) => (a.stats.speedSumMs / a.stats.speedN) - (b.stats.speedSumMs / b.stats.speedN))[0];
  if (fast) give('⚡', 'Speed Demon', fast, `${(fast.stats.speedSumMs / fast.stats.speedN / 1000).toFixed(1)}s average`);

  // Hot Streak: longest streak (3+)
  const streak = best(players.filter(p => p.stats.longestStreak >= 3), p => p.stats.longestStreak);
  if (streak) give('🔥', 'Hot Streak', streak, `${streak.stats.longestStreak} in a row`);

  // Cartographer: best average on map-like types (min 2)
  const mapTypes = ['map', 'trace', 'halves', 'compass', 'silhouette'];
  const carto = best(players.map(p => {
    let n = 0, sum = 0;
    for (const t of mapTypes) { const b = p.stats.byType[t]; if (b) { n += b.n; sum += b.sumAccuracy; } }
    return { p, n, avg: n ? sum / n : -1 };
  }).filter(x => x.n >= 2 && x.avg >= 25), x => x.avg);
  if (carto) give('🧭', 'Master Cartographer', carto.p, `${Math.round(carto.avg)} avg accuracy on map rounds`);

  // Comeback Kid: biggest climb from the mid-game rank to the final rank
  const finalOrder = [...game.players].sort((a, b) => b.score - a.score);
  const climb = best(players.filter(p => p.stats.midRank !== null).map(p => ({ p, gain: p.stats.midRank - (finalOrder.indexOf(p) + 1) })).filter(x => x.gain >= 2), x => x.gain);
  if (climb) give('🎢', 'Comeback Kid', climb.p, `climbed ${climb.gain} places`);

  // Perfectionist: most perfect answers (2+)
  const perf = best(players.filter(p => p.stats.perfects >= 2), p => p.stats.perfects);
  if (perf) give('💎', 'Perfectionist', perf, `${perf.stats.perfects} perfect answers`);

  // Bold Explorer: the wildest single miss (only if it was really wild)
  const wild = players.filter(p => p.stats.worstQuality <= 0.05 && p.stats.worstDetail).sort((a, b) => a.stats.worstQuality - b.stats.worstQuality)[0];
  if (wild && awards.length < 5) give('🧨', 'Bold Explorer', wild, 'one truly adventurous answer');

  return awards.slice(0, 5);
}

module.exports = { applyRoundScores, computeAwards, newStats, newRound, RANK_BONUS, STREAK_MIN, STREAK_PTS };
