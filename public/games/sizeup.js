// ─────────────────────────────────────────────────────────────────────────────
// public/games/sizeup.js — client module for "Size It Up" (type "sizeup").
//
// Two silhouettes stand on a common ground line: a BROWN reference of known size
// (a person, a bus…) on the left and a RED target on the right. The player
// grabs the red shape (or its corner handle) and drags it bigger or smaller
// until it LOOKS the right size next to the brown one, then locks in. The
// canvas can be zoomed in and out (buttons, pinch, mouse wheel) so a tiny
// target can be worked on comfortably and a huge one still fits.
//
// Two ways the canvas can be scaled:
//   • FIT (default) — one shared "pixels per metre" is recomputed from the
//     LARGER of the two figures every frame, so both always fill the stage and
//     the reference visibly shrinks as the player pulls the target bigger.
//   • MANUAL — the player zoomed with the buttons / pinch / wheel; the scale
//     stays where they put it until they press "Fit".
//
// What this file contains
//   1. Small helpers (formatting, sound, motion)
//   2. SVG figure helpers — turn an icon body into a <g> and measure its ink box
//   3. createScene()  — the canvas: figures, ground, ruler, dimension brackets,
//                       resize handle, zoom; used by mount(), reveal() and result()
//   4. mount()        — the answering UI (canvas + readout + zoom + lock in)
//   5. result()       — the per-player result screen
//   6. reveal()       — the shared leaderboard moment
//   7. metric()       — the one-liner on the leaderboard row
//
// Payload / answer / result / reveal shapes: see docs/games/sizeup.md and the
// server module games/sizeup.js. payload.tier ('casual' | 'mixed' | 'expert')
// decides how much help the canvas gives: casual = ruler + live size readout,
// mixed = readout only, expert = no numbers for the guess at all.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG = window.QuizGames;
  const NS = 'http://www.w3.org/2000/svg';

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Small helpers
  // ═══════════════════════════════════════════════════════════════════════════
  const esc   = s => QG.util.escapeHtml(String(s == null ? '' : s));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function snd(api, name) { const s = api && api.sound; if (s && typeof s[name] === 'function') s[name](); }
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Same size wording as the server (games/sizeup.js fmtSize) so the numbers on
  // the canvas, the result screen and the leaderboard banner always agree.
  function fmtSize(m) {
    if (!(m > 0)) return '?';
    if (m < 0.01) return `${(m * 1000).toFixed(m * 1000 < 10 ? 1 : 0)} mm`;
    if (m < 1)    return `${(m * 100).toFixed(m * 100 < 10 ? 1 : 0)} cm`;
    if (m < 10)   return `${m.toFixed(m < 3 ? 2 : 1)} m`;
    return `${Math.round(m).toLocaleString('en-US')} m`;
  }
  // 0.667 → "0.67×", 2.5 → "2.5×", 12.3 → "12×"  (two significant digits, no padding)
  const fmtRatio = r => `${+Number(r).toPrecision(2)}×`;

  // "tall" / "long" — which axis of the object the size refers to.
  const DIM_ADJ = { height: 'tall', length: 'long' };

  // Colour for a player: the same colour their avatar has on the leaderboard.
  function playerColor(nickname, fallbackIndex) {
    if (typeof QG.util.colorForName === 'function') return QG.util.colorForName(nickname);
    return QG.util.colorFor(fallbackIndex || 0);
  }

  // A "nice" tick step (1, 2 or 5 × 10^k metres) that is at least minM apart.
  function niceStep(minM) {
    if (!(minM > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(minM)));
    for (const f of [1, 2, 5, 10]) if (f * mag >= minM) return f * mag;
    return 10 * mag;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. SVG figure helpers
  //
  // payload.target.icon = { key, body, w, h, flip } where `body` is the inner
  // markup of a 512×512 SVG using fill="currentColor". The drawing rarely fills
  // the whole 512×512 box, so we measure the real "ink" box once per icon with
  // getBBox() and cache it — every later scale/position calculation uses it.
  // ═══════════════════════════════════════════════════════════════════════════
  const BBOX = new Map();     // icon key → { x, y, width, height } in 512-space

  // Parse the icon body (an XML fragment) into `node`. DOMParser keeps us in the
  // SVG namespace, which plain innerHTML does not guarantee in every browser.
  // `inherit` = drop the icon's own fill="currentColor" so the shapes take the
  // fill of the group we put them in (the gradient in the scene). The mini
  // figures keep currentColor and are coloured through CSS `color` instead.
  function parseInto(node, body, inherit) {
    try {
      const doc  = new DOMParser().parseFromString(`<svg xmlns="${NS}">${body || ''}</svg>`, 'image/svg+xml');
      const root = doc.documentElement;
      if (root && !root.getElementsByTagName('parsererror').length && root.nodeName !== 'parsererror') {
        Array.from(root.childNodes).forEach(n => node.appendChild(document.importNode(n, true)));
        if (inherit) node.querySelectorAll('[fill="currentColor"]').forEach(n => n.removeAttribute('fill'));
        return;
      }
    } catch (e) { /* fall through to the simple path */ }
    try { node.innerHTML = body || ''; if (inherit) node.querySelectorAll('[fill="currentColor"]').forEach(n => n.removeAttribute('fill')); }
    catch (e) { /* give up: empty figure */ }
  }

  function el(tag, cls, attrs) {
    const n = document.createElementNS(NS, tag);
    if (cls) n.setAttribute('class', cls);
    if (attrs) Object.keys(attrs).forEach(k => n.setAttribute(k, attrs[k]));
    return n;
  }

  // Build one silhouette group inside `svg`. Returns a small record we can
  // measure and transform later.
  function addFigure(svg, icon, className) {
    const g = el('g', className);
    const inner = el('g');
    parseInto(inner, icon && icon.body, true);
    g.appendChild(inner);
    svg.appendChild(g);
    return { g, inner, icon: icon || {}, bb: null };
  }

  // The ink box of a figure, cached per icon key. Falls back to the full 512×512
  // box when getBBox() is unavailable (e.g. the element is not rendered yet).
  function measure(fig) {
    if (fig.bb) return fig.bb;
    const key = fig.icon.key;
    if (key && BBOX.has(key)) { fig.bb = BBOX.get(key); return fig.bb; }
    let bb = null;
    try { const b = fig.inner.getBBox(); if (b && b.width > 0 && b.height > 0) bb = { x: b.x, y: b.y, width: b.width, height: b.height }; }
    catch (e) { /* not rendered */ }
    if (!bb) bb = { x: 0, y: 0, width: fig.icon.w || 512, height: fig.icon.h || 512 };
    if (key) BBOX.set(key, bb);
    fig.bb = bb;
    return bb;
  }
  const bboxOf = icon => BBOX.get(icon && icon.key) || { x: 0, y: 0, width: (icon && icon.w) || 512, height: (icon && icon.h) || 512 };

  // The transform that puts a figure on the ground line:
  //   move to (x, baseY) → scale → mirror if icon.flip → centre the ink box
  //   horizontally and put its bottom edge on 0.
  function figureTransform(bb, x, baseY, s, flip) {
    const cx = bb.x + bb.width / 2, bottom = bb.y + bb.height;
    return `translate(${x.toFixed(2)}, ${baseY.toFixed(2)}) scale(${s.toFixed(5)})` +
           (flip ? ' scale(-1, 1)' : '') +
           ` translate(${(-cx).toFixed(2)}, ${(-bottom).toFixed(2)})`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. createScene() — the canvas
  //
  // opts = {
  //   targetSizeM,      starting size of the target (metres)
  //   showTargetSize,   print the target's size in its caption / bracket
  //   interactive,      drag-to-resize + zoom (answering screen only)
  //   ruler,            draw the metre ruler (casual tier)
  //   minM, maxM,       resize limits (from payload.range)
  //   stageClass,       extra class on the root element
  //   onResize(sizeM),  called on every size change the PLAYER makes
  //   sound(name),      play a UI sound
  // }
  // Returns { el, layout(), setTarget(m), zoom(factor), fit(), setInteractive(b), destroy() }.
  // ═══════════════════════════════════════════════════════════════════════════
  const MIN_PX   = 6;       // never draw a silhouette smaller than this
  const FILL_H   = 0.78;    // in fit mode the taller figure fills this share of the free height
  const FILL_W   = 0.92;    // …and both together this share of the free width
  const GROUND_H = 16;      // ground strip at the bottom of the SVG (the figures stand on its top edge)
  const TOP_PAD  = 30;      // room above the tallest figure for the handle and the bracket label
  const ZOOM_STEP = 1.35;   // one press of + or −
  let sceneSeq = 0;

  function createScene(reference, target, opts) {
    opts = opts || {};
    const uid   = `su${++sceneSeq}`;
    const minM  = opts.minM > 0 ? opts.minM : 1e-6;
    const maxM  = opts.maxM > minM ? opts.maxM : 1e9;
    let targetM = opts.targetSizeM > 0 ? opts.targetSizeM : (target.sizeM || reference.sizeM || 1);
    let interactive = !!opts.interactive;
    let autoFit = true, manualPpm = 0, ppm = 0;
    let dragging = false;
    const geo = { W: 0, H: 0, baseY: 0, left: 0, x0: 0, x1: 0, w1: 0, h1: 0, w0: 0, h0: 0 };

    const root = document.createElement('div');
    root.className = 'su-stage' + (opts.stageClass ? ' ' + opts.stageClass : '') + (interactive ? ' is-interactive' : '') + (opts.ruler ? ' has-ruler' : '');
    root.innerHTML = `
      <svg class="su-svg" aria-hidden="true">
        <defs>
          <linearGradient id="${uid}-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#fbf5e8"/><stop offset="1" stop-color="#ead9bd"/>
          </linearGradient>
          <linearGradient id="${uid}-ground" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#b89868"/><stop offset="1" stop-color="#8d6f45"/>
          </linearGradient>
          <linearGradient id="${uid}-ref" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#a07d3c"/><stop offset="1" stop-color="#6e4f1f"/>
          </linearGradient>
          <linearGradient id="${uid}-tgt" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#c8493a"/><stop offset="1" stop-color="#8c2a22"/>
          </linearGradient>
        </defs>
      </svg>
      <div class="su-caps">
        <div class="su-cap su-cap-ref"><span class="su-cap-name"></span><span class="su-cap-size"></span></div>
        <div class="su-cap su-cap-tgt"><span class="su-cap-name"></span><span class="su-cap-size"></span></div>
      </div>
      ${interactive ? `
      <div class="su-zoom" role="group" aria-label="Zoom">
        <button type="button" class="su-zbtn su-zout" aria-label="Zoom out">−</button>
        <button type="button" class="su-zbtn su-zin" aria-label="Zoom in">+</button>
        <button type="button" class="su-zbtn su-zfit is-active" aria-label="Fit both to the canvas">Fit</button>
      </div>
      <div class="su-nudge" role="group" aria-label="Fine-tune size">
        <button type="button" class="su-nbtn su-nsmaller" aria-label="A little smaller">−</button>
        <span class="su-nlabel">size</span>
        <button type="button" class="su-nbtn su-nbigger" aria-label="A little bigger">+</button>
      </div>` : ''}`;

    const svg    = root.querySelector('.su-svg');
    const capRef = root.querySelector('.su-cap-ref');
    const capTgt = root.querySelector('.su-cap-tgt');

    // Draw order matters in SVG: sky, ruler, ground, shadows, figures, brackets, handle.
    const sky     = el('rect', 'su-sky', { fill: `url(#${uid}-sky)` });          svg.appendChild(sky);
    const rulerG  = el('g', 'su-ruler');                                          svg.appendChild(rulerG);
    const ground  = el('rect', 'su-groundfill', { fill: `url(#${uid}-ground)` }); svg.appendChild(ground);
    const groundL = el('line', 'su-ground');                                      svg.appendChild(groundL);
    const shadowRef = el('ellipse', 'su-shadow');                                 svg.appendChild(shadowRef);
    const shadowTgt = el('ellipse', 'su-shadow');                                 svg.appendChild(shadowTgt);
    const figRef = addFigure(svg, reference.icon, 'su-fig su-fig-ref');
    const figTgt = addFigure(svg, target.icon,    'su-fig su-fig-tgt');
    figRef.g.setAttribute('fill', `url(#${uid}-ref)`);
    figTgt.g.setAttribute('fill', `url(#${uid}-tgt)`);
    const brRef  = el('g', 'su-bracket su-bracket-ref');                          svg.appendChild(brRef);
    const brTgt  = el('g', 'su-bracket su-bracket-tgt');                          svg.appendChild(brTgt);
    const boxTgt = el('rect', 'su-tgtbox');                                       svg.appendChild(boxTgt);
    let handle = null;
    if (interactive) {
      handle = el('g', 'su-handle');
      handle.appendChild(el('circle', 'su-handle-ring', { r: 15 }));
      handle.appendChild(el('path', 'su-handle-glyph', { d: 'M-6 6 L6 -6 M6 -6 H1.5 M6 -6 V-1.5 M-6 6 H-1.5 M-6 6 V1.5' }));
      svg.appendChild(handle);
    }

    // ── A dimension bracket: the classic "|←——→|" line with a label ──────────
    // Vertical (dim = height) brackets stand to the LEFT of a figure with the
    // label above the top tick; horizontal ones (dim = length) run along the
    // ground under the figure and have no label (the caption shows it).
    function drawBracket(g, dim, x, baseY, w, h, label, side) {
      g.innerHTML = '';
      if (!(w > 0) || !(h > 0)) return;
      if (dim === 'height') {
        const bx = side === 'right' ? x + w / 2 + 12 : x - w / 2 - 12;
        const top = baseY - h;
        g.appendChild(el('line', 'su-br-line', { x1: bx, y1: top, x2: bx, y2: baseY }));
        g.appendChild(el('line', 'su-br-tick', { x1: bx - 5, y1: top, x2: bx + 5, y2: top }));
        g.appendChild(el('line', 'su-br-tick', { x1: bx - 5, y1: baseY, x2: bx + 5, y2: baseY }));
        if (label) {
          const t = el('text', 'su-br-label', { x: bx, y: Math.max(11, top - 7), 'text-anchor': 'middle' });
          t.textContent = label;
          g.appendChild(t);
        }
      } else {
        const by = baseY + 9, x1 = x - w / 2, x2 = x + w / 2;
        g.appendChild(el('line', 'su-br-line', { x1, y1: by, x2, y2: by }));
        g.appendChild(el('line', 'su-br-tick', { x1, y1: by - 4, x2: x1, y2: by + 4 }));
        g.appendChild(el('line', 'su-br-tick', { x1: x2, y1: by - 4, x2, y2: by + 4 }));
      }
    }

    // ── The metre ruler along the left edge (casual tier) ────────────────────
    function drawRuler(W, baseY) {
      rulerG.innerHTML = '';
      if (!opts.ruler || !(ppm > 0)) return;
      const rx = 30;
      const stepM = niceStep(34 / ppm);                 // ticks at least 34 px apart
      const minor = stepM / (stepM / Math.pow(10, Math.floor(Math.log10(stepM))) === 2 ? 2 : 5);
      rulerG.appendChild(el('line', 'su-rl-axis', { x1: rx, y1: 4, x2: rx, y2: baseY }));
      const maxM = (baseY - 4) / ppm;
      for (let m = minor, i = 1; m <= maxM; m += minor, i++) {
        const y = baseY - m * ppm;
        const major = Math.abs(m / stepM - Math.round(m / stepM)) < 1e-6;
        rulerG.appendChild(el('line', major ? 'su-rl-major' : 'su-rl-minor', { x1: rx - (major ? 7 : 4), y1: y, x2: rx, y2: y }));
        if (major && y > 14) {
          const t = el('text', 'su-rl-label', { x: rx - 10, y: y + 3.5, 'text-anchor': 'end' });
          t.textContent = fmtSize(m);
          rulerG.appendChild(t);
        }
      }
      // faint guide lines across the stage at every major tick
      for (let m = stepM; m <= maxM; m += stepM) {
        const y = baseY - m * ppm;
        rulerG.appendChild(el('line', 'su-rl-guide', { x1: rx, y1: y, x2: W, y2: y }));
      }
    }

    // ── Layout: one shared pixels-per-metre for both figures ────────────────
    function layout() {
      const rect = svg.getBoundingClientRect();
      const W = Math.round(rect.width), H = Math.round(rect.height);
      if (!W || !H) return;                        // not laid out yet
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      geo.W = W; geo.H = H;

      const pad    = Math.max(8, W * 0.02);
      const gap    = Math.max(14, W * 0.05);
      const rulerW = opts.ruler ? (W > 560 ? 62 : 50) : 0;
      const baseY  = H - GROUND_H;
      const left   = rulerW + pad;
      const usable = W - left - pad;

      // For each figure: how many pixels wide/tall it is per metre of its
      // measured dimension (aw / ah come from the icon's ink box aspect ratio).
      const items = [
        { fig: figRef, dim: reference.dim, sizeM: reference.sizeM, flip: !!(reference.icon && reference.icon.flip) },
        { fig: figTgt, dim: target.dim,    sizeM: targetM,          flip: !!(target.icon && target.icon.flip) },
      ];
      items.forEach(it => {
        const bb  = measure(it.fig);
        const ext = it.dim === 'length' ? bb.width : bb.height;   // the axis sizeM refers to
        it.bb = bb;
        it.aw = bb.width  / (ext || 1);
        it.ah = bb.height / (ext || 1);
        it.sizeM = it.sizeM > 0 ? it.sizeM : 1;
      });

      // FIT: the taller one must fit the height, both together the width.
      const availH = (baseY - TOP_PAD) * FILL_H;
      const availW = (usable - gap) * FILL_W;
      const ppmH = availH / Math.max(1e-9, Math.max(...items.map(i => i.sizeM * i.ah)));
      const ppmW = availW / Math.max(1e-9, items.reduce((s, i) => s + i.sizeM * i.aw, 0));
      const fitPpm = Math.max(1e-9, Math.min(ppmH, ppmW));
      if (autoFit || !(manualPpm > 0)) { ppm = fitPpm; manualPpm = fitPpm; } else { ppm = manualPpm; }

      // Pixel size of each figure (with a floor so a tiny figure stays visible).
      items.forEach(it => {
        let extPx = it.sizeM * ppm;
        it.tiny = extPx < MIN_PX;
        if (it.tiny) extPx = MIN_PX;
        const extUnits = it.dim === 'length' ? it.bb.width : it.bb.height;
        it.s = extPx / (extUnits || 1);
        it.w = it.bb.width  * it.s;
        it.h = it.bb.height * it.s;
      });

      // Centre the pair; when zoomed in so far that it no longer fits, keep the
      // TARGET on screen (it is what the player is working on) and let the
      // reference run off the left edge.
      const totalW = items[0].w + gap + items[1].w;
      let x0 = left + (usable - totalW) / 2 + items[0].w / 2;
      let x1 = x0 + items[0].w / 2 + gap + items[1].w / 2;
      let shift = 0;
      if (x1 + items[1].w / 2 > W - pad) shift = (W - pad) - (x1 + items[1].w / 2);
      if (x1 + shift - items[1].w / 2 < left) shift = left - (x1 - items[1].w / 2);
      x0 += shift; x1 += shift;
      Object.assign(geo, { baseY, left, x0, x1, w0: items[0].w, h0: items[0].h, w1: items[1].w, h1: items[1].h });

      items[0].fig.g.setAttribute('transform', figureTransform(items[0].bb, x0, baseY, items[0].s, items[0].flip));
      items[1].fig.g.setAttribute('transform', figureTransform(items[1].bb, x1, baseY, items[1].s, items[1].flip));

      // Backdrop, ground, shadows
      sky.setAttribute('x', 0); sky.setAttribute('y', 0); sky.setAttribute('width', W); sky.setAttribute('height', baseY);
      ground.setAttribute('x', 0); ground.setAttribute('y', baseY); ground.setAttribute('width', W); ground.setAttribute('height', GROUND_H);
      groundL.setAttribute('x1', 0); groundL.setAttribute('x2', W); groundL.setAttribute('y1', baseY); groundL.setAttribute('y2', baseY);
      [[shadowRef, items[0], x0], [shadowTgt, items[1], x1]].forEach(([sh, it, x]) => {
        sh.setAttribute('cx', x); sh.setAttribute('cy', baseY + 1);
        sh.setAttribute('rx', Math.max(6, it.w * 0.46)); sh.setAttribute('ry', Math.max(2, Math.min(7, it.h * 0.05)));
      });

      // Dimension brackets. The target's label shows the guess only when allowed.
      const tgtLabel = opts.showTargetSize ? fmtSize(targetM) : (interactive ? '?' : '');
      drawBracket(brRef, reference.dim, x0, baseY, items[0].w, items[0].h, fmtSize(reference.sizeM), 'left');
      drawBracket(brTgt, target.dim,    x1, baseY, items[1].w, items[1].h, tgtLabel, 'right');
      brRef.classList.toggle('is-hidden', items[0].tiny);
      brTgt.classList.toggle('is-hidden', items[1].tiny);

      // Ruler (casual)
      drawRuler(W, baseY);

      // Dashed box + corner handle around the target (answering screen only)
      if (interactive) {
        const bx = x1 - items[1].w / 2, by = baseY - items[1].h;
        boxTgt.setAttribute('x', bx - 4); boxTgt.setAttribute('y', by - 4);
        boxTgt.setAttribute('width', items[1].w + 8); boxTgt.setAttribute('height', items[1].h + 8);
        // The handle sits on the top-right corner but never leaves the stage,
        // so a target that is zoomed past the edge can still be grabbed.
        const hx = clamp(x1 + items[1].w / 2 + 2, left + 16, W - 16);
        const hy = clamp(by - 2, 16, baseY - 16);
        handle.setAttribute('transform', `translate(${hx.toFixed(1)}, ${hy.toFixed(1)})`);
        root.classList.toggle('is-clipped', by < 0 || x1 + items[1].w / 2 > W || x1 - items[1].w / 2 < left);
      }

      // Captions sit under the figure they belong to.
      capRef.style.left = `${clamp(x0 / W, 0.1, 0.9) * 100}%`;
      capTgt.style.left = `${clamp(x1 / W, 0.1, 0.9) * 100}%`;
      capRef.classList.toggle('is-tiny', !!items[0].tiny);
      capTgt.classList.toggle('is-tiny', !!items[1].tiny);
      capRef.querySelector('.su-cap-name').textContent = reference.name || '';
      capTgt.querySelector('.su-cap-name').textContent = target.name || '';
      capRef.querySelector('.su-cap-size').textContent = fmtSize(reference.sizeM) + (items[0].tiny ? ' · not to scale' : '');
      capTgt.querySelector('.su-cap-size').textContent = opts.showTargetSize ? fmtSize(targetM) : '';

      // Manual zoom that ran out of room during a drag: fall back to fit so the
      // player never loses sight of what they are resizing.
      if (interactive && dragging && !autoFit && (items[1].h > baseY - TOP_PAD || items[1].w > usable)) {
        autoFit = true; syncZoomButtons(); layout();
      }
    }

    // ── Size / zoom API ───────────────────────────────────────────────────────
    function setTarget(m, fromPlayer) {
      const next = clamp(m, minM, maxM);
      if (!(next > 0)) return;
      targetM = next;
      layout();
      if (fromPlayer && typeof opts.onResize === 'function') opts.onResize(targetM);
    }
    function zoomBy(f) {
      if (!(ppm > 0)) layout();
      autoFit = false;
      // Limits: never so far out that the target is a speck, never so far in that
      // it is 40 stages wide.
      const tgtExt = Math.max(1e-9, targetM);
      const lo = 3 / tgtExt, hi = Math.max(lo * 2, (geo.W || 400) * 40 / tgtExt);
      manualPpm = clamp((manualPpm || ppm) * f, lo, hi);
      syncZoomButtons();
      layout();
    }
    function fit() { autoFit = true; syncZoomButtons(); layout(); }
    function syncZoomButtons() {
      const b = root.querySelector('.su-zfit');
      if (b) b.classList.toggle('is-active', autoFit);
    }

    // ── Pointer interaction: drag to resize, pinch / wheel to zoom ───────────
    const pointers = new Map();
    let mode = null;            // 'resize' | 'pinch' | null
    let pinchDist = 0, lastPt = null;
    const anchor = () => { const r = svg.getBoundingClientRect(); return { x: r.left + geo.x1, y: r.top + geo.baseY }; };
    const distTo = (p, a) => Math.max(18, Math.hypot(p.x - a.x, p.y - a.y));
    const pinch  = () => { const [a, b] = Array.from(pointers.values()); return Math.hypot(a.x - b.x, a.y - b.y); };

    // Everything on the stage that is not the reference figure or a button
    // starts a resize — the whole canvas is the control.
    function onDown(e) {
      if (!interactive) return;
      if (e.target.closest && e.target.closest('button')) return;
      if (e.target.closest && e.target.closest('.su-fig-ref')) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (pointers.size === 1) {
        mode = 'resize'; dragging = true; lastPt = { x: e.clientX, y: e.clientY };
        root.classList.add('is-dragging');
      } else if (pointers.size === 2) {
        mode = 'pinch'; dragging = false; pinchDist = pinch();
        root.classList.remove('is-dragging'); root.classList.add('is-pinching');
      }
      e.preventDefault();
    }
    function onMove(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      e.preventDefault();
      if (mode === 'resize' && pointers.size === 1) {
        // Incremental: the size grows by the ratio of the pointer's distance
        // from the target's foot now vs. one move ago. Because both distances
        // are measured in the SAME frame, a zoom change between moves does not
        // make the size jump.
        const a = anchor(), now = { x: e.clientX, y: e.clientY };
        const ratio = distTo(now, a) / distTo(lastPt, a);
        lastPt = now;
        if (Number.isFinite(ratio) && ratio > 0) setTarget(targetM * ratio, true);
      } else if (mode === 'pinch' && pointers.size === 2) {
        const d = pinch();
        if (pinchDist > 4 && d > 4) { zoomBy(d / pinchDist); pinchDist = d; }
      }
    }
    function onUp(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        if (mode === 'resize' && typeof opts.sound === 'function') opts.sound('click');
        mode = null; dragging = false;
        root.classList.remove('is-dragging', 'is-pinching');
      } else if (pointers.size === 1) {
        // one finger lifted from a pinch: the remaining finger continues as a resize
        mode = 'resize'; dragging = true; lastPt = Array.from(pointers.values())[0];
        root.classList.remove('is-pinching'); root.classList.add('is-dragging');
      }
    }
    function onWheel(e) {
      if (!interactive) return;
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * 0.0012));
    }
    function onKey(e) {
      if (!interactive) return;
      const k = e.key;
      if (k === 'ArrowUp' || k === 'ArrowRight' || k === '+' || k === '=') { setTarget(targetM * 1.03, true); e.preventDefault(); }
      else if (k === 'ArrowDown' || k === 'ArrowLeft' || k === '-') { setTarget(targetM / 1.03, true); e.preventDefault(); }
    }
    if (interactive) {
      root.tabIndex = 0;
      svg.addEventListener('pointerdown', onDown);
      svg.addEventListener('pointermove', onMove, { passive: false });
      svg.addEventListener('pointerup', onUp);
      svg.addEventListener('pointercancel', onUp);
      root.addEventListener('wheel', onWheel, { passive: false });
      root.addEventListener('keydown', onKey);
      root.querySelector('.su-zout').addEventListener('click', () => { zoomBy(1 / ZOOM_STEP); if (opts.sound) opts.sound('click'); });
      root.querySelector('.su-zin').addEventListener('click',  () => { zoomBy(ZOOM_STEP);     if (opts.sound) opts.sound('click'); });
      root.querySelector('.su-zfit').addEventListener('click', () => { fit();                 if (opts.sound) opts.sound('click'); });
      root.querySelector('.su-nsmaller').addEventListener('click', () => { setTarget(targetM / 1.06, true); if (opts.sound) opts.sound('click'); });
      root.querySelector('.su-nbigger').addEventListener('click',  () => { setTarget(targetM * 1.06, true); if (opts.sound) opts.sound('click'); });
    }

    // Re-layout whenever the container changes size (rotation, TV vs phone).
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(() => layout()); ro.observe(root); }
    const onOrient = () => setTimeout(layout, 200);
    window.addEventListener('orientationchange', onOrient);

    return {
      el: root, layout, fit,
      zoom: zoomBy,
      setTarget(m) { setTarget(m, false); },
      get targetM() { return targetM; },
      setInteractive(b) {
        interactive = !!b;
        root.classList.toggle('is-interactive', interactive);
        root.classList.remove('is-dragging', 'is-pinching');
        pointers.clear(); mode = null; dragging = false;
        layout();
      },
      destroy() {
        if (ro) ro.disconnect();
        window.removeEventListener('orientationchange', onOrient);
        root.remove();
      },
    };
  }

  // Build a stand-alone mini silhouette (used by the result screen and the
  // reveal row). `ppm` is pixels per metre, shared by every figure in a group so
  // they are all drawn to the same scale. Returns an <svg> element.
  function miniFigure(icon, dim, sizeM, boxH, ppm, color) {
    const bb  = bboxOf(icon);
    const ext = dim === 'length' ? bb.width : bb.height;
    const extPx = Math.max(MIN_PX, sizeM * ppm);
    const s  = extPx / (ext || 1);
    const w  = Math.max(MIN_PX, bb.width * s);
    const h  = Math.max(MIN_PX, bb.height * s);
    const svg = el('svg', 'su-mini', { viewBox: `0 0 ${w.toFixed(2)} ${boxH.toFixed(2)}`, width: w.toFixed(2), height: boxH.toFixed(2) });
    if (color) svg.style.color = color;
    const g = el('g');
    parseInto(g, icon && icon.body);
    g.setAttribute('transform', figureTransform(bb, w / 2, boxH, s, !!(icon && icon.flip)));
    svg.appendChild(g);
    svg._suSize = { w, h };
    return svg;
  }

  // Shared pixels-per-metre for a list of { dim, sizeM } drawn inside boxH×maxW.
  function fitPpm(icon, list, boxH, maxW) {
    const bb = bboxOf(icon);
    let biggestH = 1e-9, biggestW = 1e-9;
    list.forEach(it => {
      const ext = it.dim === 'length' ? bb.width : bb.height;
      biggestH = Math.max(biggestH, it.sizeM * (bb.height / (ext || 1)));
      biggestW = Math.max(biggestW, it.sizeM * (bb.width  / (ext || 1)));
    });
    return Math.max(1e-9, Math.min(boxH * 0.94 / biggestH, maxW / biggestW));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE
  // ═══════════════════════════════════════════════════════════════════════════
  // The result screen needs the icon again but the server's result object only
  // carries numbers, so we remember the payload of the question we mounted.
  let LAST_PAYLOAD = null;

  QG.register({
    type: 'sizeup',

    // ── 4. mount() — the answering UI ────────────────────────────────────────
    mount(container, payload, api) {
      container.innerHTML = '';
      LAST_PAYLOAD = payload;

      const passive   = api.role === 'host';           // TV host: watches, cannot answer
      const reference = payload.reference || {};
      const target    = payload.target || {};
      const range     = payload.range || {};
      const tier      = payload.tier === 'casual' || payload.tier === 'expert' ? payload.tier : 'mixed';
      const showNums  = tier !== 'expert';
      const minM = range.min > 0 ? range.min : 0.1;
      const maxM = range.max > minM ? range.max : minM * 10;

      // Start at a RANDOM size (never the middle of the range) so it hints at
      // nothing. Log-uniform: doubling is the same step everywhere.
      const lnMin = Math.log(minM), lnSpan = Math.log(maxM) - lnMin;
      const toSize = t => Math.exp(lnMin + clamp(t, 0, 1) * lnSpan);
      let sizeM = toSize(passive ? 0.5 : 0.15 + Math.random() * 0.70);

      const TIER_HINT = {
        casual: 'Casual: a metre ruler and your size readout help you out.',
        mixed:  'Drag the red shape to resize it. Pinch or use − / + to zoom.',
        expert: 'Expert: no numbers — judge the size by eye against the reference.',
      };

      const wrap = document.createElement('div');
      wrap.className = 'su-wrap' + (api.tvMode ? ' is-tv' : '') + (passive ? ' is-passive' : '') + ` tier-${tier}`;
      wrap.innerHTML = `
        <p class="su-hint">Reference: <b>${esc(reference.name)}</b>, ${esc(fmtSize(reference.sizeM))} ${esc(DIM_ADJ[reference.dim] || 'long')}
          ${passive ? '' : `<span class="su-tierhint">${esc(TIER_HINT[tier])}</span>`}</p>
        <div class="su-stage-slot"></div>
        ${payload.credit ? `<p class="su-credit">${esc(payload.credit)}</p>` : ''}
        <div class="su-controls">
          ${passive ? `<p class="su-host-hint">Players are sizing it up…</p>` : `
          <div class="su-readout${showNums ? '' : ' is-hidden-nums'}">
            <span class="su-ro-name">${esc(target.name)}</span>
            <span class="su-ro-val">${showNums ? esc(fmtSize(sizeM)) : '?'}</span>
            <span class="su-ro-rel"></span>
          </div>
          <button type="button" class="btn btn-primary su-lock">Lock in</button>`}
        </div>`;
      container.appendChild(wrap);

      const roVal = wrap.querySelector('.su-ro-val');
      const roRel = wrap.querySelector('.su-ro-rel');
      const lockBtn = wrap.querySelector('.su-lock');
      let destroyed = false, rafCancel = null, breathRaf = null;

      // Readout under the canvas: the size and how it compares to the reference.
      function paint() {
        if (!roVal) return;
        if (showNums) {
          roVal.textContent = fmtSize(sizeM);
          const r = sizeM / (reference.sizeM || 1);
          const adj = DIM_ADJ[target.dim] || 'long';
          roRel.textContent = r >= 1 ? `${fmtRatio(r)} as ${adj} as the ${reference.name}` : `${fmtRatio(1 / r)} smaller than the ${reference.name}`;
        } else {
          roVal.textContent = '?';
          roRel.textContent = 'Judge it by eye';
        }
      }

      // The canvas itself
      const scene = createScene(reference, target, {
        targetSizeM: sizeM,
        showTargetSize: false,
        interactive: !passive && !api.locked,
        ruler: tier === 'casual' && !passive,
        minM, maxM,
        sound: name => snd(api, name),
        onResize(m) { if (api.locked) return; sizeM = m; paint(); },
      });
      wrap.querySelector('.su-stage-slot').appendChild(scene.el);

      // ── Freeze / unfreeze ─────────────────────────────────────────────────
      function freeze(label) {
        wrap.classList.add('is-locked');
        scene.setInteractive(false);
        if (lockBtn) { lockBtn.disabled = true; lockBtn.textContent = label || 'Locked in ✓'; }
      }
      function unfreeze() {
        wrap.classList.remove('is-locked');
        scene.setInteractive(true);
        if (lockBtn) { lockBtn.disabled = false; lockBtn.textContent = 'Lock in'; }
      }
      if (api.locked) freeze();
      if (!passive && typeof api.onUnlock === 'function') api.onUnlock(unfreeze);

      if (lockBtn) lockBtn.addEventListener('click', () => {
        if (api.locked) return;
        freeze('Locked in ✓');
        api.submit({ sizeM: +sizeM.toFixed(4) });      // the core plays the lock sound
      });

      // ── First layout (the SVG must be on screen before we can measure it) ──
      rafCancel = QG.util.nextFrame(() => {
        if (destroyed) return;
        scene.layout();
        paint();

        // TV host: nothing to control, so the target slowly "breathes" between
        // sizes. It looks alive on the big screen and reveals nothing.
        if (passive && !reducedMotion()) {
          const t0 = performance.now();
          let last = 0;
          const loop = now => {
            if (destroyed) return;
            if (now - last > 45) {                       // ~22 fps is plenty
              last = now;
              const phase = ((now - t0) / 9000) % 1;     // one slow 9 s cycle
              scene.setTarget(toSize(0.5 + 0.3 * Math.sin(phase * 2 * Math.PI)));
            }
            breathRaf = requestAnimationFrame(loop);
          };
          breathRaf = requestAnimationFrame(loop);
        }
      });

      return {
        // Called when our answer comes back (also after a reconnect): show the
        // size we actually locked in and keep the UI frozen.
        onResult(data) {
          if (data && data.yourSizeM > 0) { sizeM = data.yourSizeM; scene.setTarget(sizeM); paint(); }
          freeze('Locked in ✓');
        },
        destroy() {
          destroyed = true;
          if (rafCancel) rafCancel();
          if (breathRaf) cancelAnimationFrame(breathRaf);
          scene.destroy();
          wrap.remove();
        },
      };
    },

    // ── 5. result() — the player's own result screen ─────────────────────────
    result(data) {
      const score = Number.isFinite(data.score) ? data.score : 0;
      const ratio = Number.isFinite(data.ratio) ? data.ratio : 1;

      // Headline tier from the score the server computed.
      let t;
      if (score >= 95)      t = { icon: '🎯', iconColor: 'var(--correct)',    heading: 'Spot on!' };
      else if (score >= 70) t = { icon: '📐', iconColor: 'var(--correct)',    heading: 'Very close!' };
      else if (score >= 40) t = { icon: '📐', iconColor: 'var(--gold)',       heading: 'In the ballpark' };
      else if (score >= 15) t = { icon: '📐', iconColor: 'var(--gold-muted)', heading: 'Not quite…' };
      else                  t = { icon: '✗',  iconColor: 'var(--wrong)',      heading: 'Way off!' };

      const near = Math.abs(Math.log(ratio)) <= Math.log(1.06);
      const subtitle = `You said ${fmtSize(data.yourSizeM)} — it is ${fmtSize(data.trueSizeM)} (${fmtRatio(ratio)})`;
      const verdict  = near ? 'Spot on — within a whisker.'
                     : ratio > 1 ? `You guessed it ${fmtRatio(ratio)} too big.`
                                 : `You guessed it ${fmtRatio(1 / ratio)} too small.`;

      // Mini comparison drawn to scale: your guess next to the truth. It reuses
      // the icon of the question we just answered (remembered in mount()).
      const icon = LAST_PAYLOAD && LAST_PAYLOAD.target && LAST_PAYLOAD.target.icon;
      const dim  = data.dim || (LAST_PAYLOAD && LAST_PAYLOAD.target && LAST_PAYLOAD.target.dim) || 'height';
      let html = '';
      if (icon && data.trueSizeM > 0 && data.yourSizeM > 0) {
        const boxH = 92;
        const ppm  = fitPpm(icon, [{ dim, sizeM: data.trueSizeM }, { dim, sizeM: data.yourSizeM }], boxH, 132);
        const mkCell = (sizeM, label, cls, color) => {
          const svg = miniFigure(icon, dim, sizeM, boxH, ppm, color);
          return `<div class="su-rcell ${cls}">
                    <div class="su-rfig">${svg.outerHTML}</div>
                    <span class="su-rlabel">${esc(label)}</span>
                    <span class="su-rsize">${esc(fmtSize(sizeM))}</span>
                  </div>`;
        };
        html = `<div class="su-rcmp">
                  ${mkCell(data.yourSizeM, 'You said', 'is-guess', '#c46a55')}
                  ${mkCell(data.trueSizeM, 'It was', 'is-truth', 'var(--gold-bright)')}
                </div>
                <div class="su-rdiff">${esc(verdict)}</div>`;
      } else {
        html = `<div class="su-rdiff">${esc(verdict)}</div>`;
      }
      return { ...t, subtitle, html };
    },

    // ── 6. reveal() — the shared big-screen moment ───────────────────────────
    reveal(container, reveal, ctx) {
      const me        = (ctx && ctx.myNickname) || null;
      const players   = (ctx && ctx.players) || [];
      const reference = reveal.reference || {};
      const target    = reveal.target || {};
      const guesses   = (reveal.guesses || []).filter(g => Number.isFinite(g.sizeM) && g.sizeM > 0);
      const colorIdx  = nick => { const i = players.findIndex(p => p.nickname === nick); return i >= 0 ? i : guesses.findIndex(g => g.nickname === nick); };

      const wrap = document.createElement('div');
      wrap.className = 'su-reveal';
      wrap.innerHTML = `
        <div class="su-rv-title">The real thing</div>
        <div class="su-rv-scene"></div>
        <p class="su-rv-punch"></p>
        <div class="su-rv-title su-rv-title2">Where everyone landed</div>
        <div class="su-rv-row"></div>`;
      container.appendChild(wrap);

      // The true scene: same canvas, target at its real size, both labelled.
      const scene = createScene(reference, target, { targetSizeM: target.sizeM, showTargetSize: true, stageClass: 'is-reveal' });
      wrap.querySelector('.su-rv-scene').appendChild(scene.el);

      // Punchline: "A blue whale is 2.5× as long as a city bus."
      const adj = DIM_ADJ[target.dim] || 'long';
      if (target.sizeM > 0 && reference.sizeM > 0) {
        const r = target.sizeM / reference.sizeM;
        const punch = r >= 1
          ? `<b>${esc(target.name)}</b> is ${esc(fmtRatio(r))} as ${esc(adj)} as a <b>${esc(reference.name)}</b>.`
          : `<b>${esc(reference.name)}</b> is ${esc(fmtRatio(1 / r))} as ${esc(DIM_ADJ[reference.dim] || 'long')} as a <b>${esc(target.name)}</b>.`;
        wrap.querySelector('.su-rv-punch').innerHTML = punch;
      }

      const row = wrap.querySelector('.su-rv-row');
      const cancel = QG.util.nextFrame(() => {
        scene.layout();                       // this also fills the icon bbox cache

        if (!guesses.length) {
          row.innerHTML = '<span class="su-rv-nobody">Nobody answered this one.</span>';
          return;
        }

        // Everything in the row shares one scale, including the gold truth chip.
        const boxH = 78;
        const all  = guesses.map(g => ({ dim: target.dim, sizeM: g.sizeM })).concat([{ dim: target.dim, sizeM: target.sizeM }]);
        const ppm  = fitPpm(target.icon, all, boxH, 110);

        // Worst guess first so the winner lands last — but the row itself is
        // ordered by size, which is what makes the comparison readable.
        const errOf = g => Math.abs(Math.log(g.sizeM / (target.sizeM || g.sizeM)));
        const byErr = guesses.slice().sort((a, b) => errOf(b) - errOf(a));
        const step  = reducedMotion() ? 0 : 340;

        const items = guesses.map(g => ({ ...g, truth: false }))
          .concat([{ nickname: null, sizeM: target.sizeM, truth: true }])
          .sort((a, b) => a.sizeM - b.sizeM);

        items.forEach(it => {
          const color = it.truth ? 'var(--gold-bright)' : playerColor(it.nickname, colorIdx(it.nickname));
          const cell  = document.createElement('div');
          cell.className = 'su-rv-item' + (it.truth ? ' is-truth' : '') + (it.nickname === me ? ' is-me' : '');
          const delay = it.truth ? 120 : 260 + byErr.findIndex(g => g === it || g.nickname === it.nickname) * step;
          cell.style.animationDelay = `${delay}ms`;
          const fig = document.createElement('div');
          fig.className = 'su-rv-fig';
          fig.style.height = `${boxH}px`;
          fig.appendChild(miniFigure(target.icon, target.dim, it.sizeM, boxH, ppm, color));
          cell.appendChild(fig);
          cell.insertAdjacentHTML('beforeend',
            `<span class="su-rv-name">${it.truth ? '★ Truth' : esc(it.nickname)}</span>
             <span class="su-rv-size">${esc(fmtSize(it.sizeM))}</span>`);
          row.appendChild(cell);
        });
      });

      return {
        destroy() {
          if (cancel) cancel();
          scene.destroy();
          wrap.remove();
        },
      };
    },

    // ── 7. metric() — the little line on the leaderboard row ─────────────────
    metric(detail) {
      if (!detail || !Number.isFinite(detail.sizeM)) return '';
      const ratio = Number.isFinite(detail.ratio) ? detail.ratio : null;
      if (ratio === null) return fmtSize(detail.sizeM);
      return `${fmtRatio(ratio)} (${fmtSize(detail.sizeM)})`;
    },
  });
})();
