// ─────────────────────────────────────────────────────────────────────────────
// public/games/flag.js — client module for flag questions (type "flag").
//
// Shows a country flag (from flagcdn.com, built from the ISO code in
// payload.code) and four country-name buttons. Everything button-related comes
// from the shared toolkit that mc.js puts on QuizGames.util._mcKit, so the two
// modules behave exactly the same. If mc.js has not been loaded yet (the core
// loads modules in any order) we fetch it on demand and mount when it arrives.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG  = window.QuizGames;
  const esc = s => QG.util.escapeHtml(String(s == null ? '' : s));

  const flagUrl = (code, w) => `https://flagcdn.com/w${w || 320}/${String(code || '').toLowerCase()}.png`;

  // Resolve the shared MC kit, loading /games/mc.js if it is missing.
  let kitPromise = null;
  function getKit() {
    if (QG.util._mcKit) return Promise.resolve(QG.util._mcKit);
    if (!kitPromise) {
      kitPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/games/mc.js';
        s.onload  = () => QG.util._mcKit ? resolve(QG.util._mcKit) : reject(new Error('mc kit missing'));
        s.onerror = () => reject(new Error('could not load /games/mc.js'));
        document.head.appendChild(s);
      });
    }
    return kitPromise;
  }

  QG.register({
    type: 'flag',

    mount(container, payload, api) {
      container.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'flag-wrap' + (api.tvMode ? ' is-tv' : '');
      wrap.innerHTML = `
        <p class="flag-prompt">Which country does this flag belong to?</p>
        <div class="flag-frame"><img class="flag-img" alt="Flag" src="${flagUrl(payload.code)}"></div>
        <div class="flag-choices"></div>`;
      container.appendChild(wrap);

      let choice = null, destroyed = false, pendingResult = null;
      getKit().then(kit => {
        if (destroyed) return;
        choice = kit.buildChoice(wrap.querySelector('.flag-choices'), payload.answers || [], api);
        if (pendingResult) choice.onResult(pendingResult);
      }).catch(err => {
        wrap.querySelector('.flag-choices').innerHTML = `<p class="flag-error">${esc(err.message)}</p>`;
      });

      return {
        onResult(data) { if (choice) choice.onResult(data); else pendingResult = data; },
        destroy() { destroyed = true; if (choice) choice.destroy(); wrap.remove(); },
      };
    },

    result(data) {
      const kit = QG.util._mcKit;
      const base = kit ? kit.choiceResult(data)
                       : { icon: data.isCorrect ? '✓' : '✗', iconColor: data.isCorrect ? 'var(--correct)' : 'var(--wrong)',
                           heading: data.isCorrect ? 'Correct!' : 'Not this time', subtitle: `The answer was ${data.correctText}` };
      return base;
    },

    // Reveal: the flag once more, then the bar chart of who picked what.
    reveal(container, reveal, ctx) {
      const wrap = document.createElement('div');
      wrap.className = 'flag-reveal';
      wrap.innerHTML = `<div class="flag-frame flag-frame-sm"><img class="flag-img" alt="Flag" src="${flagUrl(reveal.code, 160)}"></div>`;
      container.appendChild(wrap);
      let bars = null;
      getKit().then(kit => { if (wrap.isConnected) bars = kit.renderBars(wrap, reveal, ctx); });
      return { destroy() { if (bars) bars.destroy(); wrap.remove(); } };
    },

    metric(detail) {
      const kit = QG.util._mcKit;
      if (kit) return kit.choiceMetric(detail);
      return detail ? (detail.isCorrect ? '✓ Correct' : `✗ ${detail.answerText || ''}`) : '';
    },
  });
})();
