// ─────────────────────────────────────────────────────────────────────────────
// public/games/sizeup.js — client module for "Size It Up" (type "sizeup").
//
// Two silhouettes stand on a common baseline: a BROWN reference of known size
// (a person, a bus…) on the left and a RED target on the right. The player drags
// a logarithmic slider (or pinches / scrolls on the picture) until the red shape
// LOOKS the right size next to the brown one, then locks in.
//
// The trick that makes it fun: both shapes share one "pixels per metre" scale
// that is recomputed from the LARGER of the two, so the reference visibly
// shrinks as the player makes the target bigger.
//
// What this file contains
//   1. Small helpers (formatting, sound, motion)
//   2. SVG figure helpers — turn an icon body into a <g> and measure its ink box
//   3. createScene()  — the shared drawing used by mount(), result() and reveal()
//   4. mount()        — the answering UI (slider + pinch + lock in)
//   5. result()       — the per-player result screen
//   6. reveal()       — the shared leaderboard moment
//   7. metric()       — the one-liner on the leaderboard row
//
// Payload / answer / result / reveal shapes: see docs/games/sizeup.md and the
// server module games/sizeup.js.
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
  // the slider, the result screen and the leaderboard banner always agree.
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
  const DIM_ADJ  = { height: 'tall', length: 'long' };

  // Colour for a player: the same colour their avatar has on the leaderboard.
  function playerColor(nickname, fallbackIndex) {
    if (typeof QG.util.colorForName === 'function') return QG.util.colorForName(nickname);
    return QG.util.colorFor(fallbackIndex || 0);
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
  function parseInto(node, body) {
    try {
      const doc  = new DOMParser().parseFromString(`<svg xmlns="${NS}">${body || ''}</svg>`, 'image/svg+xml');
      const root = doc.documentElement;
      if (root && !root.getElementsByTagName('parsererror').length && root.nodeName !== 'parsererror') {
        Array.from(root.childNodes).forEach(n => node.appendChild(document.importNode(n, true)));
        return;
      }
    } catch (e) { /* fall through to the simple path */ }
    try { node.innerHTML = body || ''; } catch (e) { /* give up: empty figure */ }
  }

  // Build one silhouette group inside `svg`. Returns a small record we can
  // measure and transform later.
  function addFigure(svg, icon, className) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', className);
    const inner = document.createElementNS(NS, 'g');
    parseInto(inner, icon && icon.body);
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

  // The transform that puts a figure on the baseline:
  //   move to (x, baselineY) → scale → mirror if icon.flip → centre the ink box
  //   horizontally and put its bottom edge on 0.
  function figureTransform(bb, x, baseY, s, flip) {
    const cx = bb.x + bb.width / 2, bottom = bb.y + bb.height;
    return `translate(${x.toFixed(2)}, ${baseY.toFixed(2)}) scale(${s.toFixed(5)})` +
           (flip ? ' scale(-1, 1)' : '') +
           ` translate(${(-cx).toFixed(2)}, ${(-bottom).toFixed(2)})`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. createScene() — the two-silhouette drawing
  //
  // Used three times: the answering screen, the reveal, and (as a tiny variant)
  // the result screen. `reference` / `target` are the payload objects
  // { name, dim, sizeM?, icon }.
  //
  // Returns { el, layout(), setTarget(m), destroy() }.
  // ═══════════════════════════════════════════════════════════════════════════
  const MIN_PX = 6;           // never draw a silhouette smaller than this
  const FILL_H = 0.80;        // the taller figure fills this share of the stage
  const FILL_W = 0.94;        // both figures together fill this share of the width

  function createScene(reference, target, opts) {
    opts = opts || {};
    let targetM = opts.targetSizeM > 0 ? opts.targetSizeM : (target.sizeM || reference.sizeM);

    const el = document.createElement('div');
    el.className = 'su-stage' + (opts.stageClass ? ' ' + opts.stageClass : '');
    el.innerHTML = `
      <svg class="su-svg" aria-hidden="true"></svg>
      <div class="su-caps">
        <div class="su-cap su-cap-ref"><span class="su-cap-name"></span><span class="su-cap-size"></span></div>
        <div class="su-cap su-cap-tgt"><span class="su-cap-name"></span><span class="su-cap-size"></span></div>
      </div>`;

    const svg    = el.querySelector('.su-svg');
    const capRef = el.querySelector('.su-cap-ref');
    const capTgt = el.querySelector('.su-cap-tgt');

    // Baseline + a soft shadow under each figure (drawn before the figures so
    // the silhouettes sit on top of them).
    const ground = document.createElementNS(NS, 'line');
    ground.setAttribute('class', 'su-ground');
    svg.appendChild(ground);
    const shadowRef = document.createElementNS(NS, 'ellipse'); shadowRef.setAttribute('class', 'su-shadow'); svg.appendChild(shadowRef);
    const shadowTgt = document.createElementNS(NS, 'ellipse'); shadowTgt.setAttribute('class', 'su-shadow'); svg.appendChild(shadowTgt);

    const figRef = addFigure(svg, reference.icon, 'su-fig su-fig-ref');
    const figTgt = addFigure(svg, target.icon,    'su-fig su-fig-tgt');

    // ── Layout: one shared pixels-per-metre for both figures ────────────────
    function layout() {
      const rect = svg.getBoundingClientRect();
      const W = Math.round(rect.width), H = Math.round(rect.height);
      if (!W || !H) return;                       // not laid out yet
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

      const pad   = Math.max(6, W * 0.02);
      const gap   = Math.max(12, W * 0.05);
      const baseY = H - 3;
      const availH = (H - 6) * FILL_H;
      const availW = (W - pad * 2 - gap) * FILL_W;

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

      // Fit: the taller one must fit the height, both together the width.
      const ppmH = availH / Math.max(1e-9, Math.max(...items.map(i => i.sizeM * i.ah)));
      const ppmW = availW / Math.max(1e-9, items.reduce((s, i) => s + i.sizeM * i.aw, 0));
      const ppm  = Math.max(1e-9, Math.min(ppmH, ppmW));

      // Pixel size of each figure (with a floor so a tiny reference stays visible).
      items.forEach(it => {
        let extPx = it.sizeM * ppm;
        it.tiny = extPx < MIN_PX;
        if (it.tiny) extPx = MIN_PX;
        const extUnits = it.dim === 'length' ? it.bb.width : it.bb.height;
        it.s = extPx / (extUnits || 1);
        it.w = it.bb.width  * it.s;
        it.h = it.bb.height * it.s;
      });

      // Centre the pair horizontally: reference left, target right.
      const totalW = items[0].w + items[1].w + gap;
      const x0 = Math.max(pad + items[0].w / 2, (W - totalW) / 2 + items[0].w / 2);
      const x1 = Math.min(W - pad - items[1].w / 2, x0 + items[0].w / 2 + gap + items[1].w / 2);

      items[0].fig.g.setAttribute('transform', figureTransform(items[0].bb, x0, baseY, items[0].s, items[0].flip));
      items[1].fig.g.setAttribute('transform', figureTransform(items[1].bb, x1, baseY, items[1].s, items[1].flip));

      ground.setAttribute('x1', pad * 0.5); ground.setAttribute('x2', W - pad * 0.5);
      ground.setAttribute('y1', baseY);     ground.setAttribute('y2', baseY);
      [[shadowRef, items[0], x0], [shadowTgt, items[1], x1]].forEach(([sh, it, x]) => {
        sh.setAttribute('cx', x); sh.setAttribute('cy', baseY);
        sh.setAttribute('rx', Math.max(6, it.w * 0.42)); sh.setAttribute('ry', Math.max(2, Math.min(6, it.h * 0.05)));
      });

      // Captions sit under the figure they belong to.
      capRef.style.left = `${(x0 / W) * 100}%`;
      capTgt.style.left = `${(x1 / W) * 100}%`;
      capRef.classList.toggle('is-tiny', !!items[0].tiny);
      capTgt.classList.toggle('is-tiny', !!items[1].tiny);
      capRef.querySelector('.su-cap-name').textContent = reference.name || '';
      capTgt.querySelector('.su-cap-name').textContent = target.name || '';
      capRef.querySelector('.su-cap-size').textContent = fmtSize(reference.sizeM) + (items[0].tiny ? ' · not to scale' : '');
      capTgt.querySelector('.su-cap-size').textContent = opts.showTargetSize ? fmtSize(targetM) : '';
    }

    // Re-layout whenever the container changes size (rotation, TV vs phone).
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(() => layout()); ro.observe(el); }
    const onOrient = () => setTimeout(layout, 200);
    window.addEventListener('orientationchange', onOrient);

    return {
      el, layout,
      figTarget: figTgt,
      setTarget(m) { targetM = m > 0 ? m : targetM; layout(); },
      destroy() {
        if (ro) ro.disconnect();
        window.removeEventListener('orientationchange', onOrient);
        el.remove();
      },
    };
  }

  // Build a stand-alone mini silhouette (used by the result screen and the
  // reveal row). `ppm` is pixels per metre, shared by every figure in a group so
  // they are all drawn to the same scale. Returns an <svg> element.
  function miniFigure(icon, dim, sizeM, boxH, ppm, color) {
    const bb  = BBOX.get(icon && icon.key) || { x: 0, y: 0, width: (icon && icon.w) || 512, height: (icon && icon.h) || 512 };
    const ext = dim === 'length' ? bb.width : bb.height;
    const extPx = Math.max(MIN_PX, sizeM * ppm);
    const s  = extPx / (ext || 1);
    const w  = Math.max(MIN_PX, bb.width * s);
    const h  = Math.max(MIN_PX, bb.height * s);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'su-mini');
    svg.setAttribute('viewBox', `0 0 ${w.toFixed(2)} ${boxH.toFixed(2)}`);
    svg.setAttribute('width', w.toFixed(2));
    svg.setAttribute('height', boxH.toFixed(2));
    if (color) svg.style.color = color;
    const g = document.createElementNS(NS, 'g');
    parseInto(g, icon && icon.body);
    g.setAttribute('transform', figureTransform(bb, w / 2, boxH, s, !!(icon && icon.flip)));
    svg.appendChild(g);
    svg._suSize = { w, h };
    return svg;
  }

  // Shared pixels-per-metre for a list of { dim, sizeM } drawn inside boxH×maxW.
  function fitPpm(icon, list, boxH, maxW) {
    const bb  = BBOX.get(icon && icon.key) || { x: 0, y: 0, width: (icon && icon.w) || 512, height: (icon && icon.h) || 512 };
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
      const minM = range.min > 0 ? range.min : 0.1;
      const maxM = range.max > minM ? range.max : minM * 10;

      // Logarithmic slider: the position t ∈ [0,1] maps to a size by
      // sizeM = exp(ln min + t · (ln max − ln min)). Doubling always feels like
      // the same distance on the track.
      const lnMin = Math.log(minM), lnSpan = Math.log(maxM) - lnMin;
      const toSize = t => Math.exp(lnMin + clamp(t, 0, 1) * lnSpan);
      const toT    = m => clamp((Math.log(m) - lnMin) / lnSpan, 0, 1);

      // Start at a RANDOM position (never the middle) so it hints at nothing.
      let t = passive ? 0.5 : 0.15 + Math.random() * 0.70;
      let sizeM = toSize(t);

      const wrap = document.createElement('div');
      wrap.className = 'su-wrap' + (api.tvMode ? ' is-tv' : '') + (passive ? ' is-passive' : '');
      wrap.innerHTML = `
        <p class="su-hint">Reference: <b>${esc(reference.name)}</b>, ${esc(fmtSize(reference.sizeM))} ${esc(DIM_ADJ[reference.dim] || 'long')}</p>
        <div class="su-stage-slot"></div>
        ${payload.credit ? `<p class="su-credit">${esc(payload.credit)}</p>` : ''}
        <div class="su-controls">
          ${passive ? `<p class="su-host-hint">Players are sizing it up…</p>` : `
          <div class="su-track">
            <div class="su-bubble"><span class="su-bubble-val"></span></div>
            <div class="su-refmark" hidden><i></i><span>${esc(reference.name)}</span></div>
            <input class="su-range" type="range" min="0" max="1000" step="1" value="${Math.round(t * 1000)}"
                   aria-label="Size of the ${esc(target.name)}">
          </div>
          <div class="su-bounds"><span>${esc(fmtSize(minM))}</span><span>${esc(fmtSize(maxM))}</span></div>
          <button type="button" class="btn btn-primary su-lock">Lock in</button>`}
        </div>`;
      container.appendChild(wrap);

      // The drawing itself
      const scene = createScene(reference, target, { targetSizeM: sizeM, showTargetSize: false });
      wrap.querySelector('.su-stage-slot').appendChild(scene.el);

      const rangeEl  = wrap.querySelector('.su-range');
      const bubble   = wrap.querySelector('.su-bubble');
      const bubbleV  = wrap.querySelector('.su-bubble-val');
      const refMark  = wrap.querySelector('.su-refmark');
      const lockBtn  = wrap.querySelector('.su-lock');
      let destroyed = false, rafCancel = null, breathRaf = null;

      // Move the value bubble with the thumb (the small pixel correction keeps
      // it centred over a 30 px thumb at both ends of the track).
      function paint() {
        if (!bubble) return;
        const pct = t * 100;
        bubble.style.left = `calc(${pct}% + ${(0.5 - t) * 30}px)`;
        bubbleV.textContent = fmtSize(sizeM);
        if (rangeEl) rangeEl.style.setProperty('--su-pct', `${pct}%`);
      }

      // Set a new size from anywhere (slider, wheel, pinch).
      function setT(nextT, silent) {
        t = clamp(nextT, 0, 1);
        sizeM = toSize(t);
        if (rangeEl) rangeEl.value = String(Math.round(t * 1000));
        scene.setTarget(sizeM);
        paint();
        if (!silent) { /* no sound on every pixel — only on 'change' */ }
      }

      // The reference size is public, so we may mark it on the track: it gives
      // the player an anchor without giving anything away.
      if (refMark && reference.sizeM > 0 && reference.sizeM >= minM && reference.sizeM <= maxM) {
        const rt = toT(reference.sizeM);
        refMark.hidden = false;
        refMark.style.left = `calc(${rt * 100}% + ${(0.5 - rt) * 30}px)`;
      }

      // ── Slider ────────────────────────────────────────────────────────────
      if (rangeEl) {
        rangeEl.addEventListener('input', () => { if (api.locked) return; setT(+rangeEl.value / 1000); });
        rangeEl.addEventListener('change', () => { if (!api.locked) snd(api, 'click'); });
      }

      // ── Mouse wheel / trackpad on the picture ─────────────────────────────
      function onWheel(e) {
        if (api.locked || passive) return;
        e.preventDefault();
        setT(t - e.deltaY * 0.0009);
      }
      scene.el.addEventListener('wheel', onWheel, { passive: false });

      // ── Two-finger pinch on the picture ───────────────────────────────────
      // A pinch that spreads the fingers by a factor f multiplies the guessed
      // size by f — which on a log slider is a constant shift of ln(f)/lnSpan.
      const pointers = new Map();
      let pinchDist = 0;
      const dist = () => {
        const [a, b] = Array.from(pointers.values());
        return Math.hypot(a.x - b.x, a.y - b.y);
      };
      function onDown(e) {
        if (api.locked || passive) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) { pinchDist = dist(); scene.el.classList.add('is-pinching'); }
        if (scene.el.setPointerCapture) { try { scene.el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      }
      function onMove(e) {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size !== 2 || api.locked) return;
        e.preventDefault();
        const d = dist();
        if (pinchDist > 4 && d > 4) { setT(t + Math.log(d / pinchDist) / lnSpan); pinchDist = d; }
      }
      function onUp(e) {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        if (pointers.size < 2) { pinchDist = 0; scene.el.classList.remove('is-pinching'); }
      }
      if (!passive) {
        scene.el.addEventListener('pointerdown', onDown);
        scene.el.addEventListener('pointermove', onMove, { passive: false });
        scene.el.addEventListener('pointerup', onUp);
        scene.el.addEventListener('pointercancel', onUp);
      }

      // ── Freeze / unfreeze ─────────────────────────────────────────────────
      function freeze(label) {
        wrap.classList.add('is-locked');
        if (rangeEl) rangeEl.disabled = true;
        if (lockBtn) { lockBtn.disabled = true; lockBtn.textContent = label || 'Locked in ✓'; }
      }
      function unfreeze() {
        wrap.classList.remove('is-locked');
        if (rangeEl) rangeEl.disabled = false;
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
          if (data && data.yourSizeM > 0) { setT(toT(data.yourSizeM), true); }
          freeze('Locked in ✓');
        },
        destroy() {
          destroyed = true;
          if (rafCancel) rafCancel();
          if (breathRaf) cancelAnimationFrame(breathRaf);
          scene.el.removeEventListener('wheel', onWheel);
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

      // The true scene: same drawing, target at its real size, both labelled.
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
