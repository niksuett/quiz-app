// ─────────────────────────────────────────────────────────────────────────────
// public/games/trace.js — browser module for the "trace" game type.
//
// Two categories share this one mechanic: draw a single freehand line on a blank
// ink-on-parchment map.
//
//   borders 🖊️  Two neighbouring countries are drawn as ONE fused blob (the
//               border between them is simply missing) and the player draws
//               where they think it runs. Two gold marks show where it starts
//               and ends.
//   rivers  🌊  A coastline map with a "mouth" and a "source" marker; the player
//               traces the river's course between them.
//
// Everything is drawn as an SVG (crisp lines, no redraw loop, easy animation).
// The map is a plain equirectangular box built from payload.bbox with
// util.project / util.unproject, so screen pixels ⇄ lng/lat is a one-liner.
//
// Contract: docs/ARCHITECTURE.md §5 · payload/answer/result/reveal shapes:
// docs/games/trace.md and games/trace.js (the server module).
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG  = window.QuizGames;
  const esc = s => QG.util.escapeHtml(String(s == null ? '' : s));
  const NS  = 'http://www.w3.org/2000/svg';

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const r1    = n => Math.round(n * 10) / 10;
  const fmtKm = km => `${Math.round(km).toLocaleString('en-US')} km`;
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function snd(api, name) { const s = api && api.sound; if (s && typeof s[name] === 'function') s[name](); }

  // The player's last submitted line, remembered so result() can draw
  // "your line vs the truth" — the server's result payload only carries the truth.
  let lastSubmittedLine = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. SVG plumbing
  // ═══════════════════════════════════════════════════════════════════════════

  // Create an SVG element with attributes, optionally appending it to a parent.
  function svgEl(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // A "frame" turns [lng, lat] into a position inside a fixed viewBox and back.
  // The viewBox is always 1000 units wide; its height follows the bbox's shape so
  // the country is never squashed. A small padding keeps the geometry off the edge.
  function makeFrame(bbox, width) {
    const W = width || 1000;
    const b = (Array.isArray(bbox) && bbox.length === 4) ? bbox : [-180, -90, 180, 90];
    const midLat  = (b[1] + b[3]) / 2;
    const cos     = Math.max(0.05, Math.cos(midLat * Math.PI / 180));   // lng shrinks towards the poles
    const lngSpan = Math.max(1e-9, (b[2] - b[0]) * cos);
    const latSpan = Math.max(1e-9, b[3] - b[1]);
    const pad = Math.round(W * 0.035);
    const iw  = W - 2 * pad;
    // Keep the picture between "very wide" and "quite tall" so it fits a phone
    // and a TV alike; util.project letterboxes whatever is left over.
    const ih  = clamp(Math.round(iw * latSpan / lngSpan), Math.round(iw * 0.42), Math.round(iw * 1.25));
    return {
      W, H: ih + 2 * pad, pad, bbox: b,
      to(p)   { const q = QG.util.project(p[0], p[1], b, iw, ih);          return [q[0] + pad, q[1] + pad]; },
      from(xy) { return QG.util.unproject(xy[0] - pad, xy[1] - pad, b, iw, ih); },
    };
  }

  // Closed rings (land) → one path string. fill-rule="evenodd" makes holes work.
  function ringsPath(rings, f) {
    let d = '';
    for (const ring of rings || []) {
      if (!ring || ring.length < 3) continue;
      d += 'M' + ring.map(p => { const q = f.to(p); return `${r1(q[0])} ${r1(q[1])}`; }).join('L') + 'Z';
    }
    return d;
  }
  // An open polyline (coast, border, a drawn line) → one path string.
  function linePath(line, f) {
    if (!line || !line.length) return '';
    return 'M' + line.map(p => { const q = f.to(p); return `${r1(q[0])} ${r1(q[1])}`; }).join('L');
  }
  // Same, for points that are already in viewBox units (the live drawing).
  function rawPath(pts) {
    if (!pts || !pts.length) return '';
    return 'M' + pts.map(p => `${r1(p[0])} ${r1(p[1])}`).join('L');
  }

  // ── Keeping strokes and markers the same size on a phone and on a TV ────────
  // Everything inside the SVG is drawn in viewBox units, so it would shrink on a
  // small screen. We measure how many viewBox units fit in one screen pixel (`u`)
  // and re-apply it to:
  //   • every element with data-sw="3"   → stroke-width of 3 screen pixels
  //   • every <g data-ux data-uy>        → a marker group placed at that point and
  //                                        scaled so its contents are screen pixels
  function makeScaler(svg, f) {
    const state = { u: 1 };
    function apply() {
      const rect = svg.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const s = Math.min(rect.width / f.W, rect.height / f.H);   // preserveAspectRatio "meet"
        state.u = s > 0 ? 1 / s : 1;
      }
      const u = state.u;
      svg.querySelectorAll('[data-sw]').forEach(el => el.setAttribute('stroke-width', (parseFloat(el.dataset.sw) * u).toFixed(2)));
      svg.querySelectorAll('g[data-ux]').forEach(g => g.setAttribute('transform', `translate(${g.dataset.ux} ${g.dataset.uy}) scale(${u.toFixed(3)})`));
    }
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(apply); ro.observe(svg); }
    const onOrient = () => setTimeout(apply, 200);
    window.addEventListener('orientationchange', onOrient);
    apply();
    return {
      get u() { return state.u; },
      apply,
      destroy() { if (ro) ro.disconnect(); window.removeEventListener('orientationchange', onOrient); },
    };
  }

  // A marker group: its children are drawn in screen pixels around (0,0).
  function markerGroup(parent, xy, cls) {
    const g = svgEl('g', { class: cls }, parent);
    g.dataset.ux = r1(xy[0]); g.dataset.uy = r1(xy[1]);
    g.setAttribute('transform', `translate(${r1(xy[0])} ${r1(xy[1])})`);
    return g;
  }

  // Wipe a path in from its start ("drawing itself"). Skipped for reduced motion.
  function drawIn(path, ms, delay, timers) {
    if (reducedMotion()) return;
    let len = 0;
    try { len = path.getTotalLength(); } catch (e) { /* not rendered yet */ }
    if (!len) return;
    path.style.strokeDasharray  = String(len);
    path.style.strokeDashoffset = String(len);
    const start = QG.util.nextFrame(() => {
      path.style.transition = `stroke-dashoffset ${ms}ms linear ${delay}ms`;
      path.style.strokeDashoffset = '0';
    });
    timers.push(start);
    timers.push(setTimeout(() => { path.style.strokeDasharray = 'none'; path.style.transition = ''; }, delay + ms + 80));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Scenery — the parts of the map that are the same in every view
  // ═══════════════════════════════════════════════════════════════════════════

  // Sea background + the land shapes for the QUESTION view.
  // For borders the two countries MUST be one single colour: two tints would give
  // away exactly where the hidden border runs.
  function drawQuestionScene(svg, payload, f) {
    svgEl('rect', { x: 0, y: 0, width: f.W, height: f.H, class: 'trace-sea' }, svg);

    if (payload.mode === 'river') {
      svgEl('path', { d: ringsPath(payload.context, f), 'fill-rule': 'evenodd', class: 'trace-land' }, svg);
      drawMouth(svg, f.to(payload.mouth), f, 'Mouth');
      drawSource(svg, f.to(payload.source), f, 'Source');
      return;
    }

    // borders: one fused blob, then only the OUTER edges are stroked
    svgEl('path', { d: ringsPath(payload.blob, f), 'fill-rule': 'evenodd', class: 'trace-land' }, svg);
    for (const seg of payload.outline || []) {
      const el = svgEl('path', { d: linePath(seg, f), class: 'trace-coast' }, svg);
      el.dataset.sw = 1.4;
    }
    for (const seg of payload.known || []) {          // parts of the border we give away
      const el = svgEl('path', { d: linePath(seg, f), class: 'trace-known' }, svg);
      el.dataset.sw = 2.4;
    }
    const eps = payload.endpoints || [];
    const single = payload.closed || (eps.length === 2 && eps[0] && eps[1] && eps[0][0] === eps[1][0] && eps[0][1] === eps[1][1]);
    eps.slice(0, single ? 1 : 2).forEach((p, i) => {
      if (p) drawEndpoint(svg, f.to(p), f, single ? 'start & finish' : (i === 0 ? 'start' : 'end'));
    });
  }

  // Put a marker's caption where it will not be cut off by the edge of the map.
  // The stylesheet centres these labels, so a marker sitting near the left or
  // right border pushed half its caption outside the SVG ("START" showed as
  // "TART" on a 375 px phone). Near an edge we anchor the text inwards instead,
  // and a caption that would sit above the top edge is moved below the marker.
  //   g  — the marker group (its inner units are screen pixels)
  //   xy — the marker position in viewBox units
  //   f  — the frame (for W / H)
  //   dy — the preferred vertical offset in screen pixels (negative = above)
  function drawMarkerLabel(g, xy, f, dy, text) {
    if (!text) return;
    const edge = 0.14;                                   // treat the outer 14 % as "near the edge"
    const attrs = { y: dy, class: 'trace-mk-label' };
    if (xy[0] < f.W * edge)            { attrs['text-anchor'] = 'start'; attrs.x = 10; }
    else if (xy[0] > f.W * (1 - edge)) { attrs['text-anchor'] = 'end';   attrs.x = -10; }
    if (dy < 0 && xy[1] < f.H * 0.12) attrs.y = -dy + 6;  // no room above → drop it below
    svgEl('text', attrs, g).textContent = text;
  }

  // Gold "the hidden border starts here" mark, with a slow ripple.
  function drawEndpoint(svg, xy, f, label) {
    const g = markerGroup(svg, xy, 'trace-ep');
    if (!reducedMotion()) {
      const ripple = svgEl('circle', { r: 7, class: 'trace-ep-ripple' }, g);
      svgEl('animate', { attributeName: 'r', values: '7;20;20', dur: '2.4s', repeatCount: 'indefinite' }, ripple);
      svgEl('animate', { attributeName: 'opacity', values: '.75;0;0', dur: '2.4s', repeatCount: 'indefinite' }, ripple);
    }
    svgEl('circle', { r: 7, class: 'trace-ep-dot' }, g);
    drawMarkerLabel(g, xy, f, -13, label);
  }

  // River mouth: a filled droplet. Source: an open ring. Different SHAPES, not
  // only different colours, so they are told apart at a glance.
  function drawMouth(svg, xy, f, label) {
    const g = markerGroup(svg, xy, 'trace-mk trace-mouth');
    svgEl('path', { d: 'M0 -13 C 7 -4, 10 1, 10 4 A 10 10 0 1 1 -10 4 C -10 1, -7 -4, 0 -13 Z', class: 'trace-mouth-drop' }, g);
    drawMarkerLabel(g, xy, f, 30, label);
  }
  function drawSource(svg, xy, f, label) {
    const g = markerGroup(svg, xy, 'trace-mk trace-source');
    // No data-sw here: this circle sits inside a group that is already scaled to
    // screen pixels, so its stroke width comes straight from the stylesheet.
    svgEl('circle', { r: 9, class: 'trace-source-ring' }, g);
    svgEl('circle', { r: 2.5, class: 'trace-source-dot' }, g);
    drawMarkerLabel(g, xy, f, -16, label);
  }

  // Centroid of the biggest ring of a shape — used to place a country name.
  function shapeCentroid(rings) {
    let best = null, bestArea = -1;
    for (const ring of rings || []) {
      if (!ring || ring.length < 3) continue;
      let a = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a = Math.abs(a) / 2;
      if (a > bestArea) { bestArea = a; best = ring; }
    }
    if (!best) return null;
    let cx = 0, cy = 0, a2 = 0;
    for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
      const cross = best[j][0] * best[i][1] - best[i][0] * best[j][1];
      a2 += cross; cx += (best[j][0] + best[i][0]) * cross; cy += (best[j][1] + best[i][1]) * cross;
    }
    if (Math.abs(a2) < 1e-12) {                                  // degenerate → plain average
      const m = best.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
      return [m[0] / best.length, m[1] / best.length];
    }
    return [cx / (3 * a2), cy / (3 * a2)];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. mount() — the drawing surface
  // ═══════════════════════════════════════════════════════════════════════════
  function mount(container, payload, api) {
    container.innerHTML = '';
    lastSubmittedLine = null;

    const isRiver = payload.mode === 'river';
    const passive = api.role === 'host';          // TV host: watches, never draws
    const f = makeFrame(payload.bbox);

    // ── Chrome around the map ────────────────────────────────────────────────
    const wrap = document.createElement('div');
    wrap.className = 'trace-wrap' + (api.tvMode ? ' is-tv' : '') + (isRiver ? ' is-river' : ' is-border');
    const names = payload.names || {};
    const head = isRiver
      ? `<span class="trace-chip">🌊 ${esc(payload.name || 'the river')}</span>
         <span class="trace-len">about ${esc(fmtKm(payload.lengthKm || 0))} to trace</span>`
      : `<span class="trace-chip">${esc(names.a || '?')}</span>
         <span class="trace-fuse" aria-hidden="true">✚</span>
         <span class="trace-chip">${esc(names.b || '?')}</span>
         <span class="trace-len">missing border ≈ ${esc(fmtKm(payload.lengthKm || 0))}</span>`;

    wrap.innerHTML = `
      <div class="trace-head">${head}</div>
      <p class="trace-hint"></p>
      <div class="trace-stage"><svg class="trace-svg" viewBox="0 0 ${f.W} ${f.H}" preserveAspectRatio="xMidYMid meet" role="img"></svg></div>
      ${passive ? '' : `
      <div class="trace-bar">
        <span class="trace-meas" aria-live="polite"></span>
        <span class="trace-actions">
          <button type="button" class="btn btn-ghost trace-clear" disabled>Clear</button>
          <button type="button" class="btn btn-red trace-lock" disabled>Lock in</button>
        </span>
      </div>`}`;
    container.appendChild(wrap);

    const svg     = wrap.querySelector('.trace-svg');
    const hintEl  = wrap.querySelector('.trace-hint');
    const measEl  = wrap.querySelector('.trace-meas');
    const clearBtn = wrap.querySelector('.trace-clear');
    const lockBtn  = wrap.querySelector('.trace-lock');

    svg.setAttribute('aria-label', isRiver
      ? `Blank map — trace ${payload.name || 'the river'} from its mouth to its source`
      : `Blank map — draw the missing border between ${names.a || ''} and ${names.b || ''}`);

    drawQuestionScene(svg, payload, f);

    // The player's own stroke lives on top of the scenery.
    const inkPath = svgEl('path', { class: 'trace-ink', fill: 'none' }, svg);
    inkPath.dataset.sw = 4;
    const scaler = makeScaler(svg, f);

    // ── Hints ────────────────────────────────────────────────────────────────
    const HINTS = {
      idle:  isRiver ? 'Drag from the mouth 💧 to the source ○ in one stroke'
                     : 'Drag one stroke between the two gold marks',
      drawn: 'Drawing again replaces your line',
      lock:  'Locked in — waiting for the others',
      host:  'Players are drawing…',
    };
    function setHint(key) { hintEl.textContent = HINTS[key] || ''; }
    setHint(passive ? 'host' : (api.locked ? 'lock' : 'idle'));

    // ── Drawing (pointer events: mouse, pen and finger all in one) ────────────
    let pts = [];               // viewBox-unit points of the current stroke
    let drawing = false;
    let minStep = 4;            // viewBox units between two recorded points
    let destroyed = false;

    // Screen coordinates → viewBox coordinates, whatever the SVG is scaled to.
    function toUser(e) {
      const m = svg.getScreenCTM();
      if (!m) return null;
      const inv = m.inverse();
      if (window.DOMPointReadOnly) { const p = new DOMPointReadOnly(e.clientX, e.clientY).matrixTransform(inv); return [p.x, p.y]; }
      const sp = svg.createSVGPoint(); sp.x = e.clientX; sp.y = e.clientY;
      const p = sp.matrixTransform(inv);
      return [p.x, p.y];
    }

    function repaint() { inkPath.setAttribute('d', rawPath(pts)); }

    // Length of the current stroke on the ground, so the player can compare it
    // with the "missing border ≈ 511 km" hint.
    function measure() {
      if (pts.length < 2) return 0;
      let km = 0;
      let prev = f.from(pts[0]);
      for (let i = 1; i < pts.length; i++) {
        const cur = f.from(pts[i]);
        km += QG.util.haversineKm(prev[1], prev[0], cur[1], cur[0]);
        prev = cur;
      }
      return km;
    }
    function refreshBar() {
      if (!measEl) return;
      measEl.textContent = pts.length >= 2 ? `your line: ${fmtKm(measure())}` : '';
      if (clearBtn) clearBtn.disabled = pts.length === 0;
      if (lockBtn)  lockBtn.disabled  = pts.length < 2;
    }

    function onDown(e) {
      if (api.locked || passive || destroyed) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      // How many viewBox units are ~3 screen pixels right now?
      minStep = Math.max(1, 3 * scaler.u);
      drawing = true;
      const p = toUser(e);
      if (!p) return;
      pts = [p];                                   // a new stroke replaces the old one
      wrap.classList.add('is-drawing');
      repaint();
    }
    function onMove(e) {
      if (!drawing) return;
      e.preventDefault();
      const p = toUser(e);
      if (!p) return;
      const last = pts[pts.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < minStep) return;
      pts.push(p);
      repaint();
    }
    function onUp(e) {
      if (!drawing) return;
      drawing = false;
      wrap.classList.remove('is-drawing');
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (pts.length >= 2) { snd(api, 'click'); setHint('drawn'); }
      else { pts = []; repaint(); }
      refreshBar();
    }

    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);

    // ── Freeze / unfreeze ────────────────────────────────────────────────────
    function freeze(label) {
      wrap.classList.add('is-locked');
      if (clearBtn) clearBtn.disabled = true;
      if (lockBtn) { lockBtn.disabled = true; lockBtn.textContent = label || 'Locked in ✓'; }
      setHint('lock');
    }
    function unfreeze() {
      wrap.classList.remove('is-locked');
      if (lockBtn) { lockBtn.textContent = 'Lock in'; }
      setHint(pts.length >= 2 ? 'drawn' : 'idle');
      refreshBar();
    }
    if (api.locked && !passive) freeze();
    if (!passive && typeof api.onUnlock === 'function') api.onUnlock(unfreeze);

    if (clearBtn) clearBtn.addEventListener('click', () => {
      if (api.locked) return;
      pts = []; repaint(); refreshBar(); setHint('idle'); snd(api, 'click');
    });

    // ── Lock in: simplify the stroke, turn it back into lng/lat, submit ──────
    if (lockBtn) lockBtn.addEventListener('click', () => {
      if (api.locked || pts.length < 2) return;
      // Douglas-Peucker with a growing tolerance until we are safely under the
      // server's 600-point limit (it rejects anything longer).
      let simple = pts, tol = Math.max(0.8, scaler.u * 0.8);
      for (let i = 0; i < 10 && simple.length > 300; i++) { simple = QG.util.simplify(pts, tol); tol *= 1.8; }
      if (simple.length > 400) simple = QG.util.resample(simple, 400);
      const line = simple.map(p => { const g = f.from(p); return [+g[0].toFixed(4), +g[1].toFixed(4)]; });
      if (line.length < 2) return;
      lastSubmittedLine = line;
      snd(api, 'lock');
      freeze('Locked in ✓');
      api.submit({ line });
    });

    // Nudge the player when the clock runs out and they have drawn but not locked.
    if (!passive && typeof api.onTick === 'function') {
      api.onTick(sec => {
        if (api.locked || !lockBtn) return;
        wrap.classList.toggle('is-urgent', sec <= 5 && pts.length >= 2);
      });
    }

    refreshBar();

    return {
      destroy() {
        destroyed = true;
        svg.removeEventListener('pointerdown', onDown);
        svg.removeEventListener('pointermove', onMove);
        svg.removeEventListener('pointerup', onUp);
        svg.removeEventListener('pointercancel', onUp);
        scaler.destroy();
        wrap.remove();
      },
      // The core hands us the server's answer-result. Live this changes nothing
      // (the stroke is already on screen). After a RECONNECT — the player
      // reloaded the page mid-question — the map is redrawn empty, so we put
      // the line they locked in back on it from the server's copy. Without this
      // the frozen screen is a blank map under a "Locked in" banner.
      onResult(data) {
        if (!data || !Array.isArray(data.line) || data.line.length < 2) return;
        lastSubmittedLine = data.line;                 // also feeds the result-screen mini map
        if (pts.length >= 2) return;                   // we still have the live stroke
        pts = data.line.map(g => f.to(g));             // lng/lat back to viewBox units
        repaint();
        refreshBar();
        if (!passive) freeze('Locked in ✓');
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. result() — the player's own screen: how did I do?
  // ═══════════════════════════════════════════════════════════════════════════
  // The question map covers both whole countries; for the little result picture
  // we zoom right in on the two lines so the difference between them is visible.
  function tightBox(lines, fallback) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity, n = 0;
    for (const line of lines) for (const p of line || []) {
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      n++;
      if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0];
      if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1];
    }
    if (n < 2) return fallback;
    const px = Math.max((c - a) * 0.14, 0.05), py = Math.max((d - b) * 0.14, 0.05);
    return [a - px, b - py, c + px, d + py];
  }

  // A small static SVG (no resize logic — it is dropped in as an HTML string):
  // the true line in gold, the player's line in light lapis.
  function miniSvg(truth, mine, bbox) {
    const f = makeFrame(tightBox([truth, mine], bbox), 320);
    const parts = [`<svg class="trace-mini" viewBox="0 0 ${f.W} ${f.H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`];
    parts.push(`<rect x="0" y="0" width="${f.W}" height="${f.H}" class="trace-mini-bg"/>`);
    if (truth && truth.length > 1) parts.push(`<path d="${linePath(truth, f)}" class="trace-mini-truth" fill="none"/>`);
    if (mine && mine.length > 1)   parts.push(`<path d="${linePath(mine, f)}" class="trace-mini-mine" fill="none"/>`);
    parts.push('</svg>');
    return parts.join('');
  }

  function result(data) {
    const score = Number(data.score) || 0;
    // The middle icon is the one that says which game this was, so it follows
    // the category: a pen for a border, a wave for a river. (Before this it was
    // always the pen, which looked wrong on a River Run result screen.)
    const midIcon = data.mode === 'river' ? '🌊' : '🖊️';
    const tier =
      score >= 75 ? { icon: '🏅', iconColor: 'var(--correct)' } :
      score >= 55 ? { icon: midIcon, iconColor: 'var(--gold)' } :
      score >= 35 ? { icon: '🥾', iconColor: 'var(--gold-muted)' } :
                    { icon: '🧭', iconColor: 'var(--wrong)' };
    const errKm = Number(data.errKm);
    return {
      icon: tier.icon,
      iconColor: tier.iconColor,
      heading: data.rating || 'Line drawn',
      subtitle: Number.isFinite(errKm) ? `${fmtKm(errKm)} average error` : '',
      html: `
        <div class="trace-res">
          ${miniSvg(data.truth, lastSubmittedLine, data.bbox)}
          <div class="trace-res-keys">
            <span class="trace-key is-truth">the real ${data.mode === 'river' ? 'river' : 'border'}</span>
            <span class="trace-key is-mine">your line</span>
          </div>
        </div>`,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. reveal() — the shared big-screen moment on the leaderboard
  // ═══════════════════════════════════════════════════════════════════════════
  function reveal(container, rv, ctx) {
    const isRiver = rv.mode === 'river';
    const me      = (ctx && ctx.myNickname) || null;
    const players = (ctx && ctx.players) || [];
    const lines   = (rv.lines || []).filter(l => l && l.line && l.line.length > 1);

    // Same colour as the player's leaderboard avatar when the core offers it.
    const colorOf = nick => {
      if (typeof QG.util.colorForName === 'function') return QG.util.colorForName(nick);
      let i = players.findIndex(p => p.nickname === nick);
      if (i < 0) i = lines.findIndex(l => l.nickname === nick);
      return QG.util.colorFor(Math.max(0, i));
    };

    const f = makeFrame(rv.bbox);
    const wrap = document.createElement('div');
    wrap.className = 'trace-reveal';
    wrap.innerHTML = `
      <div class="trace-rv-title">${isRiver ? `The course of ${esc(rv.name || 'the river')}` : `The real ${esc((rv.names || {}).a || '')} – ${esc((rv.names || {}).b || '')} border`}</div>
      <div class="trace-stage"><svg class="trace-svg trace-rv-svg" viewBox="0 0 ${f.W} ${f.H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="The correct line and everyone's attempt"></svg></div>
      <div class="trace-rv-legend"></div>`;
    container.appendChild(wrap);

    const svg    = wrap.querySelector('.trace-rv-svg');
    const legend = wrap.querySelector('.trace-rv-legend');
    const timers = [];

    // ── Scenery ──────────────────────────────────────────────────────────────
    svgEl('rect', { x: 0, y: 0, width: f.W, height: f.H, class: 'trace-sea' }, svg);
    if (isRiver) {
      svgEl('path', { d: ringsPath(rv.context, f), 'fill-rule': 'evenodd', class: 'trace-land' }, svg);
    } else {
      // Now the two countries may finally be told apart — two soft parchment tints.
      const shapes = rv.shapes || {};
      svgEl('path', { d: ringsPath(shapes.a, f), 'fill-rule': 'evenodd', class: 'trace-shape-a' }, svg);
      svgEl('path', { d: ringsPath(shapes.b, f), 'fill-rule': 'evenodd', class: 'trace-shape-b' }, svg);
      for (const seg of rv.outline || []) svgEl('path', { d: linePath(seg, f), class: 'trace-coast' }, svg).dataset.sw = 1.4;
      for (const seg of rv.known || [])   svgEl('path', { d: linePath(seg, f), class: 'trace-known' }, svg).dataset.sw = 2.4;
    }

    // Players' lines are drawn first so the gold truth always stays on top.
    const inkLayer = svgEl('g', { class: 'trace-rv-lines' }, svg);
    const topLayer = svgEl('g', { class: 'trace-rv-top' }, svg);

    // Truth
    const truthPath = svgEl('path', { d: linePath(rv.truth, f), class: 'trace-truth', fill: 'none' }, topLayer);
    truthPath.dataset.sw = 4.5;

    if (isRiver) {
      if (rv.mouth)  drawMouth(topLayer, f.to(rv.mouth), f, 'Mouth');
      if (rv.source) drawSource(topLayer, f.to(rv.source), f, 'Source');
    } else {
      // Country names near the middle of each country.
      const shapes = rv.shapes || {}, names = rv.names || {};
      [['a', names.a], ['b', names.b]].forEach(([key, name]) => {
        if (!name) return;
        const c = shapeCentroid(shapes[key]);
        if (!c) return;
        const g = markerGroup(topLayer, f.to(c), 'trace-rv-name');
        svgEl('text', { class: 'trace-country-label' }, g).textContent = name;
      });
    }

    const scaler = makeScaler(svg, f);

    // ── Animation: truth first, then the players worst → best (finish on the winner)
    const step = reducedMotion() ? 0 : 320;
    drawIn(truthPath, reducedMotion() ? 0 : 700, 150, timers);

    const order = lines.slice().reverse();            // rv.lines is sorted best first
    order.forEach((entry, i) => {
      const delay = 900 + i * step;
      timers.push(setTimeout(() => {
        const color = colorOf(entry.nickname);
        const isMe  = entry.nickname === me;
        const p = svgEl('path', {
          d: linePath(entry.line, f), fill: 'none', stroke: color,
          class: 'trace-rv-line' + (isMe ? ' is-me' : ''),
        }, inkLayer);
        p.dataset.sw = isMe ? 4 : 2.8;
        // A small initialled badge halfway along the line — readable with 8+
        // players (the ends all bunch up on the markers), full names in the legend.
        const mid = entry.line[Math.floor(entry.line.length / 2)];
        const g = markerGroup(inkLayer, f.to(mid), 'trace-rv-badge' + (isMe ? ' is-me' : ''));
        svgEl('circle', { r: 9, fill: color, class: 'trace-rv-badge-dot' }, g);   // stroke width from CSS (already in screen px)
        svgEl('text', { y: 3.5, class: 'trace-rv-badge-txt' }, g).textContent = QG.util.playerInitial(entry.nickname);
        scaler.apply();
        drawIn(p, reducedMotion() ? 0 : 420, 0, timers);
      }, delay));
    });

    // ── Legend: best first ───────────────────────────────────────────────────
    if (!lines.length) {
      legend.innerHTML = '<span class="trace-rv-nobody">Nobody drew a line this round.</span>';
    } else {
      lines.forEach((entry, i) => {
        const chip = document.createElement('span');
        chip.className = 'trace-rv-chip' + (entry.nickname === me ? ' is-me' : '');
        chip.style.animationDelay = `${600 + i * 110}ms`;
        const err = Number.isFinite(+entry.errKm) ? `${fmtKm(entry.errKm)} off` : '';
        chip.innerHTML = `<i style="background:${colorOf(entry.nickname)}"></i>${esc(entry.nickname)}
                          <b>${Math.round(entry.score || 0)}</b><small>${esc(err)}</small>`;
        legend.appendChild(chip);
      });
    }

    return {
      destroy() {
        timers.forEach(t => { if (typeof t === 'function') t(); else clearTimeout(t); });
        scaler.destroy();
        wrap.remove();
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Register
  // ═══════════════════════════════════════════════════════════════════════════
  QG.register({
    type: 'trace',
    mount,
    result,
    reveal,
    // Leaderboard row, e.g. "Score 74 · 18 km off"
    metric(detail) {
      if (!detail) return '';
      const err = Number(detail.errKm);
      const hasScore = Number.isFinite(+detail.score);
      if (!Number.isFinite(err)) return hasScore ? `Score ${Math.round(detail.score)}` : '';
      const off = `${fmtKm(err)} off`;
      return hasScore ? `Score ${Math.round(detail.score)} · ${off}` : off;
    },
  });
})();
