// ─────────────────────────────────────────────────────────────────────────────
// public/games/timeline.js — client module for "in which year…?" (type "timeline").
//
// The same slider as estimation, but the box is a text field that understands
// years like "44 BCE", "-44", "100 CE" or "1969". Negative numbers mean BCE.
// The slider UI, result compare and axis reveal come from the toolkit that
// slider.js publishes on QuizGames.util._scaleKit (loaded on demand if needed).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG = window.QuizGames;
  const formatYear = y => QG.util.formatYear(y);

  // "323 BCE" → -323, "100 CE" → 100, "-44" → -44, "1969" → 1969, junk → null
  function parseYear(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    let m = s.match(/^(-?\d+)\s*(bce?|bc)\.?$/i);
    if (m) return -Math.abs(parseInt(m[1], 10));
    m = s.match(/^(\d+)\s*(ce|ad)\.?$/i);
    if (m) return parseInt(m[1], 10);
    const n = parseInt(s.replace(/,/g, ''), 10);
    return Number.isNaN(n) ? null : n;
  }

  // Resolve the shared kit, loading /games/slider.js when it is not there yet.
  let kitPromise = null;
  function getKit() {
    if (QG.util._scaleKit) return Promise.resolve(QG.util._scaleKit);
    if (!kitPromise) {
      kitPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/games/slider.js';
        s.onload  = () => QG.util._scaleKit ? resolve(QG.util._scaleKit) : reject(new Error('scale kit missing'));
        s.onerror = () => reject(new Error('could not load /games/slider.js'));
        document.head.appendChild(s);
      });
    }
    return kitPromise;
  }

  QG.register({
    type: 'timeline',

    mount(container, payload, api) {
      container.innerHTML = '';
      const holder = document.createElement('div');
      holder.className = 'tl-holder';
      container.appendChild(holder);

      const min = Math.round(payload.min), max = Math.round(payload.max);
      const ticks = Array.from({ length: 5 }, (_, i) => formatYear(Math.round(min + (i / 4) * (max - min))));
      const hint  = min < 1 ? 'Type a year, e.g. <strong>44 BCE</strong> or <strong>1969</strong>' : null;

      let ui = null, destroyed = false;
      getKit().then(kit => {
        if (destroyed) return;
        ui = kit.buildRangeUI(holder, {
          min, max, step: 1, unit: '',
          inputType: 'text',
          format: formatYear,
          parse:  parseYear,
          tickLabels: ticks, hint,
          hostHint: 'Players are pinning the year…',
        }, api);
        holder.classList.add('tl-ready');
      }).catch(err => { holder.textContent = err.message; });

      return { destroy() { destroyed = true; if (ui) ui.destroy(); holder.remove(); } };
    },

    result(data) {
      const kit = QG.util._scaleKit;
      const diffText = data.diff === 0 ? 'Exact year!' : `Off by ${Math.round(data.diff).toLocaleString('en-US')} year${Math.round(data.diff) === 1 ? '' : 's'}`;
      if (!kit) return { icon: '📅', iconColor: 'var(--gold)', heading: diffText, subtitle: `Correct: ${formatYear(data.correctValue)}` };
      return { ...kit.tier(data.accuracyPct, '📅'), html: kit.compareHtml(formatYear(data.yourAnswer), formatYear(data.correctValue), diffText) };
    },

    reveal(container, reveal, ctx) {
      const holder = document.createElement('div');
      holder.className = 'tl-holder';
      container.appendChild(holder);
      let axis = null;
      getKit().then(kit => {
        if (!holder.isConnected) return;
        axis = kit.renderAxis(holder, {
          correctValue: reveal.correctValue, min: reveal.min, max: reveal.max, guesses: reveal.guesses,
          fmt: formatYear,
          fmtDiff: d => d === 0 ? 'exact' : `off by ${Math.round(d)} yr${Math.round(d) === 1 ? '' : 's'}`,
        }, ctx);
      });
      return { destroy() { if (axis) axis.destroy(); holder.remove(); } };
    },

    metric(detail) {
      if (!detail || !Number.isFinite(detail.diff)) return '';
      const d = Math.round(detail.diff);
      return d === 0 ? 'Exact!' : `Off by ${d.toLocaleString('en-US')} year${d === 1 ? '' : 's'}`;
    },
  });
})();
