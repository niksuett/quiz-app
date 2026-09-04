// ─────────────────────────────────────────────────────────────────────────────
// public/games/curve.js — client module for "Draw the Curve" (type "curve").
//
// The chart shows the START of a real time series (e.g. world population
// 1960–1976). The player drags left → right across the empty part of the chart
// and the module samples a value for every hidden year under the finger.
// "Lock in" is only enabled once every hidden year has a value.
//
// What this file contains, top to bottom:
//   1. small helpers (formatting, "nice" tick steps, SVG element creation)
//   2. makeChart()  — the shared chart builder: axes, gridlines, ticks, labels.
//                     Used by the question screen, the result screen and the reveal.
//   3. mount()      — the drawing UI (players) / passive chart (TV host)
//   4. result()     — truth (gold) vs your line (blue) + "avg. off by …"
//   5. reveal()     — the big shared screen: truth in gold, every player's line
//                     drawn on one after another, legend sorted by score
//   6. metric()     — the one-liner on the leaderboard row ("Score 61")
//
// Server contract: games/curve.js  ·  docs/games/curve.md  ·  ARCHITECTURE.md §5
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG  = window.QuizGames;
  const esc = s => QG.util.escapeHtml(String(s == null ? '' : s));
  function snd(api, name) { const s = api && api.sound; if (s && typeof s[name] === 'function') s[name](); }

  const clamp  = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const round3 = n => Math.round(n * 1000) / 1000;
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // The scoring curve from games/curve.js, mirrored here so the leaderboard row
  // can show a score from the stored detail (which only carries `mae`).
  const PERFECT_MAE = 0.015, ZERO_MAE = 0.30;
  const maeToQuality = mae => (mae <= PERFECT_MAE ? 1 : clamp(1 - mae / ZERO_MAE, 0, 1));

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  // Full-precision value with its unit — "8.14 bn", "42.0 %", "$1,234.00".
  // Matches fmt() in games/curve.js: "$" is prefixed, everything else suffixed.
  function fmtVal(v, unit, decimals) {
    const d = Number.isFinite(decimals) ? decimals : 2;
    const s = Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    if (!unit) return s;
    if (unit === '$') return '$' + s;
    return s + ' ' + unit;
  }

  // Shorter version for axis ticks: trailing zeros dropped so "2.00 bn" → "2 bn".
  function fmtTick(v, unit, decimals) {
    const s = Number(v).toLocaleString('en-US', { maximumFractionDigits: Math.min(4, (decimals ?? 2) + 1) });
    if (!unit) return s;
    if (unit === '$') return '$' + s;
    return s + ' ' + unit;
  }

  // Round a rough spacing up to a friendly 1 / 2 / 2.5 / 5 / 10 × 10ⁿ step.
  function niceStep(rough) {
    if (!(rough > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(rough)));
    const m = rough / p;
    const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
    return n * p;
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(name, attrs) {
    const n = document.createElementNS(SVGNS, name);
    if (attrs) for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  }
  // Build an SVG path string "M x y L x y L …" from [[px, py], …]
  function pathD(pts) {
    if (!pts.length) return '';
    return pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. makeChart — axes, gridlines, ticks. Returns the <svg> plus the scale
  //    functions and an empty <g> ("plot") that callers draw their lines into.
  //    cfg = { w, h, xMin, xMax, yMin, yMax, unit, decimals, xLabel, yLabel, compact }
  // ═══════════════════════════════════════════════════════════════════════════
  function makeChart(cfg) {
    const w = cfg.w, h = cfg.h;
    const compact = !!cfg.compact;                    // the small chart on the result panel
    const fs      = compact ? 9 : 11;                 // tick font size
    const yTickN  = compact ? 3 : 5;

    // ── y ticks first: their widest label decides the left margin ────────────
    const yStep = niceStep((cfg.yMax - cfg.yMin) / yTickN);
    const yTicks = [];
    for (let v = Math.ceil(cfg.yMin / yStep - 1e-9) * yStep; v <= cfg.yMax + 1e-9; v += yStep) {
      yTicks.push({ v: +v.toFixed(6), label: fmtTick(+v.toFixed(6), cfg.unit, cfg.decimals) });
    }
    const widest = yTicks.reduce((m, t) => Math.max(m, t.label.length), 1);
    const ml = clamp(Math.round(widest * fs * 0.58) + 10, 30, Math.round(w * 0.34));
    const mr = compact ? 8 : 12;
    const mt = compact ? 8 : 14;
    const mb = (compact ? 20 : 26) + (cfg.xLabel ? (compact ? 11 : 15) : 0);

    const iw = Math.max(20, w - ml - mr);             // inner plot width
    const ih = Math.max(20, h - mt - mb);             // inner plot height
    const xOf = x => ml + ((x - cfg.xMin) / Math.max(1e-9, cfg.xMax - cfg.xMin)) * iw;
    const yOf = v => mt + ((cfg.yMax - v) / Math.max(1e-9, cfg.yMax - cfg.yMin)) * ih;
    const valueAt = py => clamp(cfg.yMax - ((py - mt) / ih) * (cfg.yMax - cfg.yMin), cfg.yMin, cfg.yMax);

    // ── x ticks: whole years on a friendly step ──────────────────────────────
    const xStep = Math.max(1, Math.round(niceStep((cfg.xMax - cfg.xMin) / 4)));
    const xTicks = [];
    for (let x = Math.ceil(cfg.xMin / xStep) * xStep; x <= cfg.xMax + 1e-9; x += xStep) xTicks.push(x);
    if (!xTicks.length) xTicks.push(cfg.xMin, cfg.xMax);

    const svg = svgEl('svg', {
      class: 'curve-svg' + (compact ? ' is-compact' : ''),
      width: w, height: h, viewBox: `0 0 ${w} ${h}`,
      role: 'img', 'aria-label': cfg.ariaLabel || 'Line chart',
    });

    const grid = svgEl('g', { class: 'curve-grid' });
    yTicks.forEach(t => {
      grid.appendChild(svgEl('line', { x1: ml, x2: ml + iw, y1: yOf(t.v).toFixed(1), y2: yOf(t.v).toFixed(1) }));
    });
    xTicks.forEach(x => {
      const px = xOf(x).toFixed(1);
      grid.appendChild(svgEl('line', { class: 'curve-grid-v', x1: px, x2: px, y1: mt, y2: mt + ih }));
    });
    svg.appendChild(grid);

    // Axis lines (left + bottom)
    const axes = svgEl('g', { class: 'curve-axes' });
    axes.appendChild(svgEl('line', { x1: ml, x2: ml, y1: mt, y2: mt + ih }));
    axes.appendChild(svgEl('line', { x1: ml, x2: ml + iw, y1: mt + ih, y2: mt + ih }));
    svg.appendChild(axes);

    // Tick labels
    const labels = svgEl('g', { class: 'curve-ticklabels', 'font-size': fs });
    yTicks.forEach(t => {
      const el = svgEl('text', { x: ml - 6, y: yOf(t.v) + fs * 0.35, 'text-anchor': 'end' });
      el.textContent = t.label;
      labels.appendChild(el);
    });
    xTicks.forEach(x => {
      const el = svgEl('text', { x: xOf(x), y: mt + ih + fs + 6, 'text-anchor': 'middle' });
      el.textContent = String(x);
      labels.appendChild(el);
    });
    if (cfg.xLabel) {
      const el = svgEl('text', { class: 'curve-axis-title', x: ml + iw / 2, y: h - 2, 'text-anchor': 'middle', 'font-size': fs });
      el.textContent = cfg.xLabel;
      labels.appendChild(el);
    }
    svg.appendChild(labels);

    // Everything the callers draw goes in here, on top of the grid.
    const plot = svgEl('g', { class: 'curve-plot' });
    svg.appendChild(plot);

    return { svg, plot, xOf, yOf, valueAt, ml, mr, mt, mb, iw, ih, w, h };
  }

  // Shade the part of the chart the player has to fill in, so the split between
  // "given" and "your job" is obvious at a glance.
  function addHiddenBand(chart, xFrom) {
    const x = chart.xOf(xFrom);
    const band = svgEl('rect', { class: 'curve-band', x: x, y: chart.mt, width: Math.max(0, chart.ml + chart.iw - x), height: chart.ih });
    chart.plot.appendChild(band);
    chart.plot.appendChild(svgEl('line', { class: 'curve-split', x1: x, x2: x, y1: chart.mt, y2: chart.mt + chart.ih }));
    return band;
  }

  // The solid ink line of the real, already-revealed data.
  function addKnownLine(chart, known) {
    const pts = known.map(p => [chart.xOf(p[0]), chart.yOf(p[1])]);
    chart.plot.appendChild(svgEl('path', { class: 'curve-known', d: pathD(pts) }));
    const last = pts[pts.length - 1];
    if (last) chart.plot.appendChild(svgEl('circle', { class: 'curve-known-dot', cx: last[0], cy: last[1], r: 4.5 }));
    return pts;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Remember the last payload we mounted: the result screen needs yMin/yMax
  // (which the server's `result` object does not repeat) to draw the same axes.
  // ═══════════════════════════════════════════════════════════════════════════
  let lastPayload = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. MODULE
  // ═══════════════════════════════════════════════════════════════════════════
  QG.register({
    type: 'curve',

    // ── Question screen ──────────────────────────────────────────────────────
    mount(container, payload, api) {
      container.innerHTML = '';
      lastPayload = payload;

      const passive   = api.role === 'host';                 // TV host: watch only
      const xs        = Array.isArray(payload.xs) ? payload.xs : [];
      const known     = Array.isArray(payload.known) ? payload.known : [];
      const hiddenXs  = xs.slice(known.length);
      const yMin      = payload.yMin, yMax = payload.yMax;
      const unit      = payload.unit || '';
      const decimals  = payload.decimals ?? 2;
      const lastKnown = known[known.length - 1] || [payload.xMin, (yMin + yMax) / 2];

      // The answer we are building: one value per hidden year, null = not drawn yet.
      const ys = new Array(hiddenXs.length).fill(null);
      let drawnCount = 0;
      let truthShown = null;                                  // set by onResult()
      // Our own copy of "the UI is frozen". api.locked only flips inside
      // api.submit(), i.e. *after* we freeze, so we cannot read it in freeze().
      let frozen = !!api.locked;

      const wrap = document.createElement('div');
      wrap.className = 'curve-wrap' + (api.tvMode ? ' is-tv' : '') + (passive ? ' is-passive' : '');
      wrap.innerHTML = `
        <div class="curve-head">
          <span class="curve-ylabel">${esc(payload.yLabel || '')}</span>
          <span class="curve-readout" aria-live="off"></span>
        </div>
        <div class="curve-chart"></div>
        <p class="curve-hint"></p>
        ${passive ? '' : `<div class="curve-actions">
          <button type="button" class="btn curve-clear btn-ghost">Start over</button>
          <button type="button" class="btn btn-red curve-lock" disabled>Lock in</button>
        </div>`}`;
      container.appendChild(wrap);

      const chartHost = wrap.querySelector('.curve-chart');
      const readout   = wrap.querySelector('.curve-readout');
      const hintEl    = wrap.querySelector('.curve-hint');
      const lockBtn   = wrap.querySelector('.curve-lock');
      const clearBtn  = wrap.querySelector('.curve-clear');

      let chart = null, drawPath = null, penDot = null, truthPath = null;
      let lastW = 0, ro = null, raf = null, destroyed = false;

      // ── Hint line under the chart ─────────────────────────────────────────
      function setHint() {
        if (passive)             { hintEl.textContent = 'Players are drawing…'; return; }
        if (frozen || api.locked) { hintEl.textContent = 'Locked in — waiting for the others'; return; }
        if (!drawnCount)      { hintEl.textContent = 'Drag right from the dot to draw how it continued'; return; }
        if (drawnCount < ys.length) { hintEl.textContent = 'Keep going — draw to the right edge'; return; }
        hintEl.textContent = 'Line complete — lock it in';
      }

      function refreshButtons() {
        if (!lockBtn) return;
        lockBtn.disabled = frozen || api.locked || drawnCount < ys.length;
        if (clearBtn) clearBtn.disabled = frozen || api.locked || !drawnCount;
      }

      // ── (Re)build the SVG at the current container width ──────────────────
      function render() {
        const w = Math.max(240, Math.round(chartHost.clientWidth || 320));
        const h = clamp(Math.round(w * 0.55), 240, api.tvMode ? 560 : 460);
        lastW = w;
        chartHost.innerHTML = '';
        chart = makeChart({
          w, h, xMin: payload.xMin, xMax: payload.xMax, yMin, yMax,
          unit, decimals, xLabel: payload.xLabel || '', ariaLabel: payload.question || 'Chart',
        });
        addHiddenBand(chart, lastKnown[0]);
        addKnownLine(chart, known);

        // The player's line + the dot that follows the finger.
        drawPath = svgEl('path', { class: 'curve-you' });
        chart.plot.appendChild(drawPath);
        penDot = svgEl('circle', { class: 'curve-pen', r: 5, cx: chart.xOf(lastKnown[0]), cy: chart.yOf(lastKnown[1]) });
        chart.plot.appendChild(penDot);
        if (truthShown) addTruth();

        chartHost.appendChild(chart.svg);
        redrawLine();
      }

      // Redraw the player's polyline from the `ys` array.
      function redrawLine() {
        if (!chart || !drawPath) return;
        const pts = [[chart.xOf(lastKnown[0]), chart.yOf(lastKnown[1])]];
        for (let i = 0; i < ys.length; i++) {
          if (ys[i] === null) break;
          pts.push([chart.xOf(hiddenXs[i]), chart.yOf(ys[i])]);
        }
        drawPath.setAttribute('d', pts.length > 1 ? pathD(pts) : '');
        const tip = pts[pts.length - 1];
        penDot.setAttribute('cx', tip[0]); penDot.setAttribute('cy', tip[1]);
        penDot.classList.toggle('is-drawing', pts.length > 1);
      }

      // The gold truth line, added once the server tells us the answer.
      function addTruth() {
        if (!chart || !truthShown) return;
        // Only the hidden part: the known prefix is already the ink line.
        const pts = truthShown.slice(Math.max(0, known.length - 1)).map(p => [chart.xOf(p[0]), chart.yOf(p[1])]);
        truthPath = svgEl('path', { class: 'curve-truth', d: pathD(pts) });
        chart.plot.appendChild(truthPath);
      }

      // ── Drawing ────────────────────────────────────────────────────────────
      // Pointer x → the nearest hidden year; pointer y → its value. Everything
      // the finger skipped is filled in by interpolation, so there are never
      // holes behind the pen (a hole would score as a full miss, see curve.md).
      let drawing = false, strokeMax = -1;

      function indexAt(px) {
        if (!hiddenXs.length) return -1;
        // Nothing to do over the known part of the chart (a 12 px grace zone
        // around the split keeps starting right at the dot easy on a phone).
        if (px < chart.xOf(lastKnown[0]) - 12) return -1;
        let best = 0, bestD = Infinity;
        for (let i = 0; i < hiddenXs.length; i++) {
          const d = Math.abs(chart.xOf(hiddenXs[i]) - px);
          if (d < bestD) { bestD = d; best = i; }
        }
        return best;
      }

      function paintTo(i, value) {
        // Anchor = the last value we already have to the left of i.
        let a = -1, aY = lastKnown[1];
        for (let k = i - 1; k >= 0; k--) if (ys[k] !== null) { a = k; aY = ys[k]; break; }
        for (let k = a + 1; k <= i; k++) {
          const t = (k - a) / (i - a);
          ys[k] = round3(clamp(aY + (value - aY) * t, yMin, yMax));
        }
        drawnCount = ys.reduce((n, v) => n + (v === null ? 0 : 1), 0);
      }

      function pointerPos(e) {
        const r = chart.svg.getBoundingClientRect();
        return {
          x: (e.clientX - r.left) * (chart.w / Math.max(1, r.width)),
          y: (e.clientY - r.top)  * (chart.h / Math.max(1, r.height)),
        };
      }

      function onDown(e) {
        if (frozen || api.locked || !chart) return;
        const p = pointerPos(e);
        const i = indexAt(p.x);
        if (i < 0) return;
        drawing = true; strokeMax = i - 1;                 // a new stroke may start anywhere
        try { chart.svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        e.preventDefault();
        onMove(e);
      }

      function onMove(e) {
        if (!drawing || frozen || api.locked || !chart) return;
        const p = pointerPos(e);
        const i = indexAt(p.x);
        if (i < 0 || i <= strokeMax) {                     // backwards motion within a stroke: ignored
          if (i >= 0) showReadout(i, chart.valueAt(p.y));
          return;
        }
        const v = chart.valueAt(p.y);
        strokeMax = i;
        paintTo(i, v);
        redrawLine();
        showReadout(i, ys[i]);
        refreshButtons();
        setHint();
        e.preventDefault();
      }

      function onUp(e) {
        if (!drawing) return;
        drawing = false;
        try { chart.svg.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (drawnCount === ys.length) snd(api, 'click');
      }

      function showReadout(i, v) {
        readout.textContent = `${hiddenXs[i]} · ${fmtVal(v, unit, decimals)}`;
        readout.classList.add('is-on');
      }

      // ── Freeze / unfreeze ─────────────────────────────────────────────────
      function freeze(label) {
        frozen = true;
        drawing = false;
        wrap.classList.add('is-locked');
        if (lockBtn)  { lockBtn.disabled = true; lockBtn.textContent = label || 'Locked in ✓'; }
        if (clearBtn) clearBtn.disabled = true;
        setHint();
      }
      // The server can reject an answer (see client.js onUnlock) — let the
      // player edit their line and lock in again.
      function unfreeze() {
        frozen = false;
        wrap.classList.remove('is-locked');
        if (lockBtn) lockBtn.textContent = 'Lock in';
        refreshButtons();
        setHint();
      }

      if (lockBtn) lockBtn.addEventListener('click', () => {
        if (frozen || api.locked || drawnCount < ys.length) return;
        snd(api, 'lock');
        freeze('Locked in ✓');
        api.submit({ ys: ys.slice() });
      });
      if (clearBtn) clearBtn.addEventListener('click', () => {
        if (frozen || api.locked) return;
        ys.fill(null); drawnCount = 0; strokeMax = -1;
        readout.textContent = ''; readout.classList.remove('is-on');
        snd(api, 'click');
        redrawLine(); refreshButtons(); setHint();
      });

      if (!passive) {
        chartHost.addEventListener('pointerdown', onDown);
        chartHost.addEventListener('pointermove', onMove);
        chartHost.addEventListener('pointerup', onUp);
        chartHost.addEventListener('pointercancel', onUp);
        if (typeof api.onUnlock === 'function') api.onUnlock(unfreeze);
      }

      // Build on the next frame so the container already has its real width.
      raf = QG.util.nextFrame(() => {
        if (destroyed) return;
        render();
        setHint();
        refreshButtons();
        if (api.locked) freeze();
        if (window.ResizeObserver) {
          ro = new ResizeObserver(() => {
            const w = Math.round(chartHost.clientWidth || 0);
            if (w && Math.abs(w - lastW) > 8) render();
          });
          ro.observe(chartHost);
        }
      });

      return {
        // The server answered us while we are still on the question screen —
        // flash the truth in gold over our own line before the result screen.
        onResult(data) {
          if (!data || !Array.isArray(data.truth)) return;
          truthShown = data.truth;
          // Reconnect case: we never drew, but the server knows what we sent.
          if (!drawnCount && Array.isArray(data.ys)) {
            for (let i = 0; i < ys.length && i < data.ys.length; i++) ys[i] = data.ys[i];
            drawnCount = ys.reduce((n, v) => n + (v === null ? 0 : 1), 0);
          }
          if (chart) { addTruth(); redrawLine(); }
          freeze();
        },
        destroy() {
          destroyed = true;
          if (raf) raf();
          if (ro) ro.disconnect();
          wrap.remove();
        },
      };
    },

    // ── Result screen (dark ink panel, this player only) ─────────────────────
    result(data) {
      const truth    = Array.isArray(data.truth) ? data.truth : [];
      const ys       = Array.isArray(data.ys) ? data.ys : [];
      const unit     = data.unit || '';
      const decimals = data.decimals ?? 2;
      const score    = Number.isFinite(data.score) ? data.score : Math.round((data.quality || 0) * 100);

      // The axis range is not repeated in `result` — reuse the payload we
      // mounted, and fall back to a padded range around the data if we must.
      const p = lastPayload;
      const sameQuestion = p && Array.isArray(p.xs) && truth.length === p.xs.length;
      let yMin, yMax;
      if (sameQuestion) { yMin = p.yMin; yMax = p.yMax; }
      else {
        const vals = truth.map(t => t[1]).concat(ys.filter(v => Number.isFinite(v)));
        const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.15 || 1;
        yMin = lo - pad; yMax = hi + pad;
      }

      // Tier — how good the drawn shape was.
      let t;
      if (score >= 90)      t = { icon: '🎯', iconColor: 'var(--correct)',    heading: 'Nailed the curve!' };
      else if (score >= 70) t = { icon: '📈', iconColor: 'var(--correct)',    heading: 'Very close!' };
      else if (score >= 45) t = { icon: '📈', iconColor: 'var(--gold)',       heading: 'Right shape' };
      else if (score >= 18) t = { icon: '📉', iconColor: 'var(--gold-muted)', heading: 'Not quite…' };
      else                  t = { icon: '✗',  iconColor: 'var(--wrong)',      heading: 'Way off!' };

      let html = '';
      if (truth.length) {
        const chart = makeChart({
          w: 300, h: 150, compact: true,
          xMin: truth[0][0], xMax: truth[truth.length - 1][0], yMin, yMax,
          unit, decimals, xLabel: '', ariaLabel: 'Your line against the real one',
        });
        const knownCount = Math.max(1, truth.length - ys.length);
        addKnownLine(chart, truth.slice(0, knownCount));
        chart.plot.appendChild(svgEl('path', { class: 'curve-truth', d: pathD(truth.slice(knownCount - 1).map(q => [chart.xOf(q[0]), chart.yOf(q[1])])) }));
        const mine = [[chart.xOf(truth[knownCount - 1][0]), chart.yOf(truth[knownCount - 1][1])]];
        ys.forEach((v, i) => { if (Number.isFinite(v)) mine.push([chart.xOf(truth[knownCount + i][0]), chart.yOf(v)]); });
        if (mine.length > 1) chart.plot.appendChild(svgEl('path', { class: 'curve-you', d: pathD(mine) }));

        const box = document.createElement('div');
        box.className = 'curve-cmp';
        box.appendChild(chart.svg);
        html += box.outerHTML;
        html += `<div class="curve-key">
                   <span class="curve-key-item is-truth">The real line</span>
                   <span class="curve-key-item is-you">Your line</span>
                 </div>`;
      }

      // "avg. off by X" — mae is a share of the axis height, so scale it back.
      const avgOff = Number.isFinite(data.mae) ? data.mae * (yMax - yMin) : null;
      const lastTruth = Array.isArray(data.lastTruth) ? data.lastTruth : null;
      html += `<div class="compare-grid">
                 <div class="compare-cell">
                   <span class="compare-label">Your ending</span>
                   <span class="compare-value">${Number.isFinite(data.lastYours) ? esc(fmtVal(data.lastYours, unit, decimals)) : '—'}</span>
                 </div>
                 <div class="compare-cell compare-correct">
                   <span class="compare-label">It ended at</span>
                   <span class="compare-value">${lastTruth ? esc(fmtVal(lastTruth[1], unit, decimals)) : '—'}</span>
                 </div>
               </div>
               <div class="compare-diff">${avgOff === null ? '' : `avg. off by ${esc(fmtVal(avgOff, unit, decimals))}`}</div>`;

      return { ...t, subtitle: 'Rank points — see leaderboard', html };
    },

    // ── Leaderboard reveal (the shared big-screen moment) ────────────────────
    reveal(container, reveal, ctx) {
      const me       = ctx && ctx.myNickname;
      const players  = (ctx && ctx.players) || [];
      const lines    = (reveal.lines || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0));
      const unit     = reveal.unit || '';
      const decimals = reveal.decimals ?? 2;
      const truth    = reveal.truth || [];
      const known    = reveal.known || [];
      const hiddenXs = (reveal.xs || []).slice(known.length);
      const lastKnown = known[known.length - 1] || truth[0] || [reveal.xMin, reveal.yMin];
      const colorOf  = nick => (typeof QG.util.colorForName === 'function'
        ? QG.util.colorForName(nick)
        : QG.util.colorFor(Math.max(0, players.findIndex(p => p.nickname === nick))));

      const wrap = document.createElement('div');
      wrap.className = 'curve-reveal';
      wrap.innerHTML = `
        <div class="curve-rv-title">How the line really went</div>
        <div class="curve-rv-chart"></div>
        <div class="curve-rv-legend"></div>
        ${reveal.source ? `<p class="curve-rv-source">Source: ${esc(reveal.source)}</p>` : ''}`;
      container.appendChild(wrap);

      const chartHost = wrap.querySelector('.curve-rv-chart');
      const legend    = wrap.querySelector('.curve-rv-legend');
      const still     = reducedMotion();
      // Only the FIRST render plays the draw-on animation. A later re-render
      // (window resize, phone rotation) paints the finished lines straight away
      // instead of replaying the whole reveal.
      let animated = false;
      let chart = null, ro = null, raf = null, lastW = 0;
      const timers = [];

      // One player's continuation: starts where the known part ends.
      function lineFor(l) {
        const pts = [[chart.xOf(lastKnown[0]), chart.yOf(lastKnown[1])]];
        (l.ys || []).forEach((v, i) => { if (Number.isFinite(v) && i < hiddenXs.length) pts.push([chart.xOf(hiddenXs[i]), chart.yOf(v)]); });
        return pts;
      }

      function render() {
        const w = Math.max(240, Math.round(chartHost.clientWidth || 320));
        const h = clamp(Math.round(w * 0.55), 240, 460);
        lastW = w;
        chartHost.innerHTML = '';
        chart = makeChart({
          w, h, xMin: reveal.xMin, xMax: reveal.xMax, yMin: reveal.yMin, yMax: reveal.yMax,
          unit, decimals, xLabel: reveal.xLabel || '', ariaLabel: 'Everyone’s lines against the real one',
        });
        addHiddenBand(chart, lastKnown[0]);
        addKnownLine(chart, known);
        const anim = !still && !animated;                // animate the first paint only

        // Players first (underneath), truth last so gold sits on top.
        lines.forEach((l, i) => {
          const pts = lineFor(l);
          if (pts.length < 2) return;
          const p = svgEl('path', { class: 'curve-rv-line' + (l.nickname === me ? ' is-me' : ''), d: pathD(pts), pathLength: 1, stroke: colorOf(l.nickname) });
          if (anim) { p.style.strokeDashoffset = '1'; p.style.transitionDelay = (500 + i * 340) + 'ms'; }
          chart.plot.appendChild(p);
          if (anim) timers.push(setTimeout(() => { p.style.strokeDashoffset = '0'; }, 30));
        });

        // The truth only covers the hidden part — the known prefix stays the
        // ink line everyone already saw, so the "given vs guessed" split stays clear.
        const truthTail = truth.slice(Math.max(0, known.length - 1));
        const tp = svgEl('path', { class: 'curve-rv-truth', d: pathD(truthTail.map(q => [chart.xOf(q[0]), chart.yOf(q[1])])), pathLength: 1 });
        if (anim) { tp.style.strokeDashoffset = '1'; tp.style.transitionDelay = '120ms'; }
        chart.plot.appendChild(tp);
        if (anim) timers.push(setTimeout(() => { tp.style.strokeDashoffset = '0'; }, 30));

        // Gold star on the real end point.
        const end = truth[truth.length - 1];
        if (end) {
          const star = svgEl('text', { class: 'curve-rv-star', x: chart.xOf(end[0]), y: chart.yOf(end[1]) + 5, 'text-anchor': 'middle' });
          star.textContent = '★';
          if (anim) star.style.animationDelay = '900ms'; else star.style.animation = 'none';
          chart.plot.appendChild(star);
        }
        chartHost.appendChild(chart.svg);
        animated = true;
      }

      // Legend: best score first, matching the rank points awarded.
      legend.innerHTML = lines.length
        ? `<span class="curve-rv-chip is-truth" style="animation-delay:200ms"><i></i>Real line <b>${esc(truth.length ? fmtVal(truth[truth.length - 1][1], unit, decimals) : '')}</b></span>` +
          lines.map((l, i) => `<span class="curve-rv-chip${l.nickname === me ? ' is-me' : ''}" style="animation-delay:${500 + i * 340}ms">
              <i style="background:${colorOf(l.nickname)}"></i>${esc(l.nickname)} <b>${Number.isFinite(l.score) ? l.score : 0}</b></span>`).join('')
        : '<span class="curve-rv-nobody">Nobody drew a line this round.</span>';

      raf = QG.util.nextFrame(() => {
        render();
        if (window.ResizeObserver) {
          ro = new ResizeObserver(() => {
            const w = Math.round(chartHost.clientWidth || 0);
            if (w && Math.abs(w - lastW) > 8) render();
          });
          ro.observe(chartHost);
        }
      });

      return {
        destroy() {
          if (raf) raf();
          if (ro) ro.disconnect();
          timers.forEach(clearTimeout);
          wrap.remove();
        },
      };
    },

    // ── Leaderboard row one-liner ───────────────────────────────────────────
    metric(detail) {
      if (!detail || !Number.isFinite(detail.mae)) return '';
      return 'Score ' + Math.round(maeToQuality(detail.mae) * 100);
    },
  });
})();
