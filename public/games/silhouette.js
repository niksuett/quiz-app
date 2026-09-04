// ─────────────────────────────────────────────────────────────────────────────
// public/games/silhouette.js — client module for country-outline questions
// (type "silhouette", category "Shape of Nations").
//
// A country's outline is drawn as a filled ink shape on parchment (no map, no
// labels, north up) and four country-name buttons are shown underneath —
// mechanically identical to flag.js, just with an SVG shape instead of a flag
// image. We reuse the shared MC button/bar-chart toolkit that mc.js publishes
// on QuizGames.util._mcKit (see flag.js for the same pattern), and load
// /games/mc.js on demand if it has not landed yet.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG  = window.QuizGames;
  const esc = s => QG.util.escapeHtml(String(s == null ? '' : s));

  // ── Resolve the shared MC kit, loading /games/mc.js if it is missing ───────
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

  // ── Shape → SVG markup ──────────────────────────────────────────────────────
  // North-up Mercator projection (per docs/games/silhouette.md §9): longitude is
  // linear, latitude goes through the Mercator log/tan formula so high-latitude
  // countries (Canada, Russia, Greenland) look the way people expect from web
  // maps instead of squashed flat. Longitudes are used exactly as given — some
  // antimeridian-crossing countries (Russia, Fiji) go past 180°, never wrap them.
  // NOTE (deviation from docs/games/silhouette.md §9): the doc's merc() returns
  // a plain radian-scale ln(tan(...)) value, which is ~57x smaller than the
  // longitude span it gets paired with (lng stays in degrees) — every shape
  // collapsed to a flat horizontal line when tested. The 180/PI factor below
  // converts to "degree-equivalent" Mercator units so 1° of longitude and 1°
  // of latitude project to the same on-screen scale near the equator, which is
  // the whole point of using Mercator here.
  function merc(lat) {
    const clamped = Math.max(-85, Math.min(85, lat));
    return (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360));
  }

  // Builds the <svg> markup for a shape. `strokeAnim` adds the short "draw-on"
  // flourish (stroke-dasharray) used on the question screen only.
  function shapeSvg(rings, bbox, opts) {
    opts = opts || {};
    const [x0, y0, x1, y1] = bbox;
    const my0 = merc(y0), my1 = merc(y1);
    const W = Math.max(1e-6, x1 - x0);
    const H = Math.max(1e-6, my1 - my0);
    const pad = 0.06 * Math.max(W, H);
    const vbX = x0 - pad, vbY = -my1 - pad, vbW = W + 2 * pad, vbH = H + 2 * pad;
    // Stroke width scales with the viewBox so it stays visible on tiny islands
    // but doesn't overwhelm small countries — ~0.9% of the longer side.
    const strokeW = 0.009 * Math.max(vbW, vbH);

    const paths = (rings || []).map(ring => {
      if (!ring || !ring.length) return '';
      let d = '';
      ring.forEach(([lng, lat], i) => { d += `${i ? 'L' : 'M'}${(lng).toFixed(3)} ${(-merc(lat)).toFixed(3)}`; });
      d += 'Z';
      return `<path class="silh-ring" d="${d}"/>`;
    }).join('');

    return `<svg class="silh-svg${opts.anim ? ' silh-anim' : ''}" viewBox="${vbX} ${vbY} ${vbW} ${vbH}"
                 preserveAspectRatio="xMidYMid meet" style="--silh-stroke:${strokeW}">
      ${paths}
    </svg>`;
  }

  QG.register({
    type: 'silhouette',

    // ── Question screen ───────────────────────────────────────────────────────
    mount(container, payload, api) {
      container.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'silh-wrap' + (api.tvMode ? ' is-tv' : '');
      wrap.innerHTML = `
        <p class="silh-prompt">${esc(payload.prompt || 'Which country is this?')}</p>
        <div class="silh-frame">${shapeSvg(payload.rings, payload.bbox, { anim: true })}</div>
        <div class="silh-choices"></div>`;
      container.appendChild(wrap);

      let choice = null, destroyed = false, pendingResult = null;
      getKit().then(kit => {
        if (destroyed) return;
        choice = kit.buildChoice(wrap.querySelector('.silh-choices'), payload.answers || [], api);
        if (pendingResult) choice.onResult(pendingResult);
      }).catch(err => {
        wrap.querySelector('.silh-choices').innerHTML = `<p class="silh-error">${esc(err.message)}</p>`;
      });

      return {
        onResult(data) { if (choice) choice.onResult(data); else pendingResult = data; },
        destroy() { destroyed = true; if (choice) choice.destroy(); wrap.remove(); },
      };
    },

    // ── Result screen (player only) ─────────────────────────────────────────
    result(data) {
      const kit = QG.util._mcKit;
      const base = kit ? kit.choiceResult(data)
                       : { icon: data.isCorrect ? '✓' : '✗', iconColor: data.isCorrect ? 'var(--correct)' : 'var(--wrong)',
                           heading: data.isCorrect ? 'Correct!' : 'Not this time', subtitle: `The answer was ${data.correctText}` };
      base.heading = data.name || base.heading;
      // Extra shape + flag row, shown above the mc "your pick vs correct" cells.
      const flagImg = data.iso2 ? `<img class="silh-res-flag" alt="" src="https://flagcdn.com/w80/${String(data.iso2).toLowerCase()}.png">` : '';
      const shapeHtml = data.rings ? `
        <div class="silh-res-row">
          <div class="silh-res-shape">${shapeSvg(data.rings, data.bbox)}</div>
          ${flagImg}
        </div>` : '';
      base.html = shapeHtml + (base.html || '');
      return base;
    },

    // ── Leaderboard reveal (everyone) ───────────────────────────────────────
    reveal(container, reveal, ctx) {
      const wrap = document.createElement('div');
      wrap.className = 'silh-reveal';
      const flagImg = reveal.iso2 ? `<img class="silh-rv-flag" alt="" src="https://flagcdn.com/w80/${String(reveal.iso2).toLowerCase()}.png">` : '';
      wrap.innerHTML = `
        <div class="silh-rv-shape-row">
          <div class="silh-rv-shape">${shapeSvg(reveal.rings, reveal.bbox)}</div>
          <div class="silh-rv-caption">${flagImg}<span class="silh-rv-name">${esc(reveal.name || '')}</span></div>
        </div>`;
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
