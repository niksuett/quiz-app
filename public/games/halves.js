// ─────────────────────────────────────────────────────────────────────────────
// public/games/halves.js — client module for "Population Split" (type "halves").
//
// The player sees a country on a map with a straight line lying across it. The
// line has two draggable handles: drag a handle to rotate/stretch the line, drag
// anywhere else on the map (in "Line" mode) to slide the whole line sideways.
// The goal is to cut the country so that HALF its PEOPLE end up on each side —
// which is nothing like cutting it in half by area (95 % of Egypt lives along
// the Nile). Nothing is computed in the browser: the population grid never
// leaves the server, so there is no live feedback while you drag.
//
// The answer is { a:[lng,lat], b:[lng,lat] } — the two handle positions, read by
// the server as an INFINITE line through those two points.
//
// Reveal: the population heat grid is finally shown as a translucent overlay on
// the map, then every player's line is drawn in their own colour one by one,
// and the "perfect" 50/50 line of the best player is drawn in gold.
//
// Sections in this file
//   1. Small helpers (formatting, sounds, compass names)
//   2. Line geometry (initial random line, screen-extension, signed distance)
//   3. Map building blocks shared by mount() and reveal()
//   4. mount()   — the answering UI
//   5. result()  — the personal result screen
//   6. reveal()  — the shared leaderboard moment
//   7. metric()  — the one-line leaderboard label, e.g. "52 / 48"
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG  = window.QuizGames;
  const esc = s => QG.util.escapeHtml(String(s == null ? '' : s));

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Small helpers
  // ═══════════════════════════════════════════════════════════════════════════

  // How far the terrain basemap is faded down on the reveal map (0 = invisible),
  // so the population colours are the thing you look at.
  const BASEMAP_FADE = 0.5;

  // Play a sound only if the core gave us one (the dev harness stubs them out).
  function snd(api, name) { const s = api && api.sound; if (s && typeof s[name] === 'function') s[name](); }
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 83784727 → "83.8 M" — short enough for a phone, still readable on a TV.
  function fmtPop(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(2).replace(/\.?0+$/, '') + ' bn';
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + ' M';
    if (v >= 1e3) return Math.round(v / 1e3) + ' k';
    return String(Math.round(v));
  }

  // Percentages that always add up to 100 (58.4 / 41.6 → "58" and "42").
  function roundPair(pctA) {
    const a = Math.round(Number(pctA) || 0);
    return [a, 100 - a];
  }

  // Compass direction of a vector given in "scaled" coordinates (x = east, y = north).
  const COMPASS = ['east', 'north-east', 'north', 'north-west', 'west', 'south-west', 'south', 'south-east'];
  function compassName(x, y) {
    const deg = Math.atan2(y, x) * 180 / Math.PI;
    return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  }
  const capitalise = s => s.charAt(0).toUpperCase() + s.slice(1);

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Line geometry
  //
  // Longitude degrees get shorter towards the poles, so before doing any angle
  // maths we multiply longitude by cos(middle latitude). That is exactly what
  // the server does in games/halves.js, so "left of the line" means the same
  // thing on both sides.
  // ═══════════════════════════════════════════════════════════════════════════

  function cosOf(bbox) {
    const midLat = ((bbox[1] + bbox[3]) / 2) * Math.PI / 180;
    return Math.max(0.05, Math.cos(midLat));
  }

  // Unit direction a→b and the unit normal pointing LEFT of it (= the server's side A).
  function frame(a, b, cos) {
    const dx = (b[0] - a[0]) * cos, dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-9)) return null;
    return { dx: dx / len, dy: dy / len, nx: -dy / len, ny: dx / len };
  }

  // Signed perpendicular distance (in km) from point p to the infinite line a→b.
  // Positive = p lies on side A (the left-hand side walking from a to b).
  function signedKm(p, a, b, cos) {
    const f = frame(a, b, cos);
    if (!f) return 0;
    const px = (p[0] - a[0]) * cos, py = p[1] - a[1];
    return (px * f.nx + py * f.ny) * 111.32;   // ~111.32 km per degree of latitude
  }

  // A random starting line: a random angle through a slightly off-centre point,
  // with both handles sitting on the edges of the (inset) bounding box. Random
  // so the puzzle is never pre-solved — the same trick slider/timeline use.
  function initialLine(bbox) {
    const [x0, y0, x1, y1] = bbox;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const cos = cosOf(bbox);
    const ang = Math.random() * Math.PI;                 // 0…180°, direction sign does not matter
    const dx = Math.cos(ang) / cos, dy = Math.sin(ang);  // back into lng/lat units
    const ox = cx + (Math.random() - 0.5) * 0.30 * (x1 - x0);
    const oy = cy + (Math.random() - 0.5) * 0.30 * (y1 - y0);
    const hw = (x1 - x0) / 2 * 0.92, hh = (y1 - y0) / 2 * 0.92;
    // How far can we walk from (ox,oy) along (dx,dy) before leaving the inset box?
    const tX = Math.abs(dx) > 1e-9 ? (hw - Math.abs(ox - cx)) / Math.abs(dx) : Infinity;
    const tY = Math.abs(dy) > 1e-9 ? (hh - Math.abs(oy - cy)) / Math.abs(dy) : Infinity;
    const t  = Math.max(1e-3, Math.min(tX, tY));
    return { a: [ox - dx * t, oy - dy * t], b: [ox + dx * t, oy + dy * t] };
  }

  // Stretch the segment a–b far past both ends so it reads as an infinite line.
  // Done in screen pixels, so it always covers the whole visible map.
  function extended(map, a, b) {
    const pa = map.latLngToLayerPoint([a[1], a[0]]);
    const pb = map.latLngToLayerPoint([b[1], b[0]]);
    let dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const size  = map.getSize();
    const reach = (size.x + size.y) * 2 + 600;
    return [
      map.layerPointToLatLng(L.point(pa.x - dx * reach, pa.y - dy * reach)),
      map.layerPointToLatLng(L.point(pb.x + dx * reach, pb.y + dy * reach)),
    ];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Map building blocks (used by both mount() and reveal())
  // ═══════════════════════════════════════════════════════════════════════════

  // Keep Leaflet's idea of its size in sync with the container (rotation, resize,
  // and the very first frames — our stylesheet may still have been loading when
  // the map was created, in which case the box was 0 px high and the initial
  // fitBounds landed on the whole world). `after` is called once Leaflet has
  // re-measured, so the caller can fit the country again.
  function watchSize(el, map, after) {
    const sync = () => { map.invalidateSize(); if (after) after(); };
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(sync); ro.observe(el); }
    const onOrient = () => setTimeout(sync, 200);
    window.addEventListener('orientationchange', onOrient);
    return () => { if (ro) ro.disconnect(); window.removeEventListener('orientationchange', onOrient); };
  }

  const bboxBounds = bbox => L.latLngBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]);

  // Draw the country outline. Each ring becomes its own polygon so island
  // countries (Indonesia, Japan…) are not mistaken for holes.
  function drawOutline(map, outline, opts) {
    const layers = [];
    for (const ring of outline || []) {
      if (!ring || ring.length < 3) continue;
      layers.push(L.polygon(ring.map(p => [p[1], p[0]]), Object.assign({
        color: '#c8922a', weight: 2, opacity: .95,
        fillColor: '#c8922a', fillOpacity: .10, interactive: false,
      }, opts || {})).addTo(map));
    }
    return layers;
  }

  // The capital city: a small lapis dot with its name — the landmark players
  // reason from ("a third of Argentina lives around Buenos Aires").
  function drawCapital(map, capital) {
    if (!capital || !Number.isFinite(capital.lat) || !Number.isFinite(capital.lng)) return null;
    const icon = L.divIcon({
      className: 'hv-icon-reset',
      html: `<div class="hv-capital"><i></i><b>${esc(capital.name || 'Capital')}</b></div>`,
      iconSize: [12, 12], iconAnchor: [6, 6],
    });
    return L.marker([capital.lat, capital.lng], { icon, interactive: false, keyboard: false, zIndexOffset: 400 }).addTo(map);
  }

  // Turn the revealed heat grid into a single small PNG (one image beats hundreds
  // of rectangles — the browser smooths it as it is scaled up over the map).
  //
  // The server already square-roots the counts, but a country like Egypt still
  // has one blinding cell (Cairo) and hundreds of faint ones, so we bend the
  // scale once more (^0.45) and give every populated cell a visible floor.
  // Empty land stays fully transparent.
  function heatImageUrl(heat) {
    const cols = heat.cols, rows = heat.rows;
    const canvas = document.createElement('canvas');
    canvas.width = cols; canvas.height = rows;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(cols, rows);
    // Colour ramp: sepia (a few people) → gold → orange → deep crimson (a city).
    // The dark low end is deliberate: pale gold would vanish into desert tiles.
    const STOPS = [[122, 74, 34], [200, 146, 42], [208, 100, 42], [150, 28, 28]];
    for (let i = 0; i < cols * rows; i++) {
      const t = Math.max(0, Math.min(1, (heat.values[i] || 0) / 255));
      const o = i * 4;
      if (t <= 0) { img.data[o + 3] = 0; continue; }
      const u   = Math.pow(t, 0.38);
      const seg = Math.min(STOPS.length - 2, Math.floor(u * (STOPS.length - 1)));
      const f   = u * (STOPS.length - 1) - seg;
      const c0 = STOPS[seg], c1 = STOPS[seg + 1];
      img.data[o]     = c0[0] + (c1[0] - c0[0]) * f;
      img.data[o + 1] = c0[1] + (c1[1] - c0[1]) * f;
      img.data[o + 2] = c0[2] + (c1[2] - c0[2]) * f;
      img.data[o + 3] = Math.round(255 * Math.min(1, 0.32 + 0.68 * u));
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. MODULE
  // ═══════════════════════════════════════════════════════════════════════════
  QG.register({
    type: 'halves',

    // ── The answering UI ─────────────────────────────────────────────────────
    mount(container, payload, api) {
      container.innerHTML = '';
      const passive = api.role === 'host';               // TV host: watch only, no controls
      const bbox = payload.bbox || [-10, -10, 10, 10];
      const cos  = cosOf(bbox);

      const wrap = document.createElement('div');
      wrap.className = 'hv-wrap' + (api.tvMode ? ' is-tv' : '') + (passive ? ' is-passive' : '');
      wrap.innerHTML = `
        <div class="hv-body">
          <p class="hv-hint"></p>
          <div class="hv-canvas" role="application" aria-label="${esc(payload.name || 'Country')} map"></div>
          ${passive ? '' : `
          <div class="hv-tools">
            <div class="hv-seg" role="group" aria-label="Drag mode">
              <button type="button" data-mode="line" class="active">✥ Line</button>
              <button type="button" data-mode="pan">✋ Pan</button>
            </div>
            <div class="hv-zoom">
              <button type="button" data-zoom="-1" aria-label="Zoom out">−</button>
              <button type="button" data-zoom="1" aria-label="Zoom in">+</button>
            </div>
          </div>
          <button type="button" class="btn btn-red hv-lock">${api.locked ? 'Locked in ✓' : 'Lock in'}</button>`}
        </div>`;
      container.appendChild(wrap);

      const canvas  = wrap.querySelector('.hv-canvas');
      const hintEl  = wrap.querySelector('.hv-hint');
      const lockBtn = wrap.querySelector('.hv-lock');
      const tools   = wrap.querySelector('.hv-tools');

      let map = null, unwatch = null, raf = null, destroyed = false;
      let handleA = null, handleB = null, line = null, halo = null, idealLine = null;
      let mode = 'line';                                  // 'line' = drag moves the line, 'pan' = drag moves the map
      let ends = initialLine(bbox);                       // { a:[lng,lat], b:[lng,lat] }
      let spinTimer = null;                               // TV host: slowly turning demo line
      let userMoved = false;                              // has the player panned/zoomed the map themselves?

      const fitCountry = () => { if (map) map.fitBounds(bboxBounds(bbox).pad(0.12)); };
      const takeOver   = () => { userMoved = true; };

      function hint(text) { if (hintEl) hintEl.textContent = text; }
      hint(passive ? 'Players are slicing the country…'
                   : api.locked ? 'Locked in — waiting for the others'
                                : 'Drag the two ends to aim the line · drag the map to slide it');

      // ── Draw / redraw the line (and its parchment halo underneath) ─────────
      function redraw() {
        if (!map || !line) return;
        const pts = extended(map, ends.a, ends.b);
        line.setLatLngs(pts);
        halo.setLatLngs(pts);
      }

      function moveHandles() {
        if (handleA) handleA.setLatLng([ends.a[1], ends.a[0]]);
        if (handleB) handleB.setLatLng([ends.b[1], ends.b[0]]);
      }

      // ── Build the map (next frame: Leaflet must measure a visible box) ─────
      raf = QG.util.nextFrame(() => {
        if (destroyed) return;
        map = L.map(canvas, {
          zoomControl: false, attributionControl: false,
          zoomSnap: 0.25, minZoom: 1, maxZoom: 12,
          dragging: false,                     // "Line" mode is the default → map dragging is off
          scrollWheelZoom: !passive, touchZoom: !passive, doubleClickZoom: false,
          boxZoom: false, keyboard: false, tap: false,
        });
        QG.util.tiles.streets().addTo(map);
        fitCountry();
        // Re-fit while the player has not taken control of the map yet.
        unwatch = watchSize(canvas, map, () => { if (!userMoved) fitCountry(); });

        drawOutline(map, payload.outline, { color: '#8c6b2e', weight: 2, fillColor: '#c8922a', fillOpacity: .12 });
        drawCapital(map, payload.capital);

        // The line: a wide pale halo so it stays visible over any terrain, plus
        // the line itself on top.
        halo = L.polyline([], { color: '#f5ede0', weight: 9, opacity: .55, interactive: false }).addTo(map);
        line = L.polyline([], { color: '#1e3a6e', weight: 4, opacity: .95, interactive: false, className: 'hv-line' }).addTo(map);

        if (!passive) {
          handleA = makeHandle('a');
          handleB = makeHandle('b');
        }
        redraw();
        map.on('move zoom resize', redraw);
        // Once the player pans or zooms themselves we stop re-fitting the country.
        map.on('dragstart', takeOver);
        canvas.addEventListener('wheel', takeOver, { passive: true });
        canvas.addEventListener('touchstart', onMultiTouch, { passive: true });

        if (passive && !reducedMotion()) startSpin();
        if (!passive && !api.locked) attachDrag();
        // Reconnecting after having already answered: come up frozen.
        if (!passive && api.locked) freeze();
      });

      // ── One draggable end handle ("a" or "b" of the line) ──────────────────
      function makeHandle(key) {
        const pt = ends[key];
        const icon = L.divIcon({
          className: 'hv-icon-reset',
          html: `<div class="hv-handle"><i></i><b>${key.toUpperCase()}</b></div>`,
          iconSize: [46, 46], iconAnchor: [23, 23],
        });
        const m = L.marker([pt[1], pt[0]], {
          icon, draggable: !api.locked, autoPan: true, keyboard: false, zIndexOffset: 1000,
        }).addTo(map);
        let before = pt.slice();
        m.on('dragstart', () => { before = ends[key].slice(); wrap.classList.add('is-dragging'); });
        m.on('drag', () => {
          const ll = m.getLatLng();
          const next = [+ll.lng, +ll.lat];
          const other = key === 'a' ? ends.b : ends.a;
          // Never let the two ends collapse into one point — the server would
          // reject a zero-length line.
          const px1 = map.latLngToContainerPoint([next[1], next[0]]);
          const px2 = map.latLngToContainerPoint([other[1], other[0]]);
          if (px1.distanceTo(px2) < 24) { m.setLatLng([before[1], before[0]]); return; }
          ends[key] = next;
          before = next.slice();
          redraw();
        });
        m.on('dragend', () => { wrap.classList.remove('is-dragging'); snd(api, 'click'); });
        return m;
      }

      // ── "Line" mode: dragging on the map slides the whole line ─────────────
      // Pointer events (not mouse events) so this works the same with a finger.
      // A second finger cancels the slide and lets Leaflet pinch-zoom instead.
      let dragId = null, lastLL = null;
      function onMultiTouch(e) { if (e.touches && e.touches.length > 1) { takeOver(); dragId = null; lastLL = null; } }
      function onDown(e) {
        if (api.locked || mode !== 'line' || dragId !== null) return;
        if (e.target.closest && e.target.closest('.leaflet-marker-icon')) return;   // that's a handle
        dragId = e.pointerId;
        lastLL = map.mouseEventToLatLng(e);
        wrap.classList.add('is-dragging');
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not fatal */ }
      }
      function onMove(e) {
        if (dragId !== e.pointerId || !lastLL) return;
        const ll = map.mouseEventToLatLng(e);
        const dLat = ll.lat - lastLL.lat, dLng = ll.lng - lastLL.lng;
        lastLL = ll;
        ends = {
          a: [ends.a[0] + dLng, Math.max(-85, Math.min(85, ends.a[1] + dLat))],
          b: [ends.b[0] + dLng, Math.max(-85, Math.min(85, ends.b[1] + dLat))],
        };
        moveHandles(); redraw();
      }
      function onUp(e) {
        if (dragId !== e.pointerId) return;
        dragId = null; lastLL = null;
        wrap.classList.remove('is-dragging');
        try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      function attachDrag() {
        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('pointercancel', onUp);
      }
      function detachDrag() {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
      }

      // ── Toolbar: Line/Pan toggle and the zoom buttons ──────────────────────
      function setMode(next) {
        mode = next;
        if (map) { if (next === 'pan') map.dragging.enable(); else map.dragging.disable(); }
        wrap.classList.toggle('is-pan', next === 'pan');
        tools.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === next));
        if (!api.locked) hint(next === 'pan' ? 'Pan and zoom the map — switch back to Line to move the cut'
                                             : 'Drag the two ends to aim the line · drag the map to slide it');
      }
      if (tools) tools.addEventListener('click', e => {
        const modeBtn = e.target.closest('[data-mode]');
        const zoomBtn = e.target.closest('[data-zoom]');
        if (modeBtn) { snd(api, 'click'); setMode(modeBtn.dataset.mode); }
        else if (zoomBtn && map) { snd(api, 'click'); takeOver(); map.setZoom(map.getZoom() + Number(zoomBtn.dataset.zoom) * 0.5); }
      });

      // ── Lock in ────────────────────────────────────────────────────────────
      function freeze() {
        wrap.classList.add('is-locked');
        detachDrag();
        if (handleA && handleA.dragging) handleA.dragging.disable();
        if (handleB && handleB.dragging) handleB.dragging.disable();
        if (map) map.dragging.enable();                 // still allow a look around
        if (tools) tools.querySelectorAll('[data-mode]').forEach(b => { b.disabled = true; });
        if (lockBtn) { lockBtn.disabled = true; lockBtn.textContent = 'Locked in ✓'; }
      }
      if (lockBtn) lockBtn.addEventListener('click', () => {
        if (api.locked) return;
        const r4 = v => +Number(v).toFixed(4);
        snd(api, 'lock');
        freeze();
        hint('Locked in — waiting for the others');
        api.submit({ a: [r4(ends.a[0]), r4(ends.a[1])], b: [r4(ends.b[0]), r4(ends.b[1])] });
      });

      // The server can reject an answer (e.g. it arrived in the wrong state);
      // the core then unlocks and we hand the controls back.
      if (!passive && typeof api.onUnlock === 'function') api.onUnlock(() => {
        wrap.classList.remove('is-locked');
        if (handleA && handleA.dragging) handleA.dragging.enable();
        if (handleB && handleB.dragging) handleB.dragging.enable();
        if (tools) tools.querySelectorAll('[data-mode]').forEach(b => { b.disabled = false; });
        if (lockBtn) { lockBtn.disabled = false; lockBtn.textContent = 'Lock in'; }
        setMode(mode); attachDrag();
      });

      // ── TV host: a slowly turning line so the screen is not static ─────────
      function startSpin() {
        let ang = Math.random() * Math.PI;
        const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
        const rx = (bbox[2] - bbox[0]) * 0.45, ry = (bbox[3] - bbox[1]) * 0.45;
        spinTimer = setInterval(() => {
          ang += 0.012;
          const dx = Math.cos(ang) * rx, dy = Math.sin(ang) * ry;
          ends = { a: [cx - dx, cy - dy], b: [cx + dx, cy + dy] };
          redraw();
        }, 60);
      }

      return {
        destroy() {
          destroyed = true;
          if (raf) raf();
          if (spinTimer) clearInterval(spinTimer);
          detachDrag();
          canvas.removeEventListener('wheel', takeOver);
          canvas.removeEventListener('touchstart', onMultiTouch);
          if (unwatch) unwatch();
          if (map) { map.off(); map.remove(); map = null; }
          wrap.remove();
        },
        // Called by the core with the server's answer-result (also when
        // reconnecting after having answered): show the split and the perfect
        // line right on the map for the second before the result screen.
        onResult(data) {
          if (!data || !map) return;
          freeze();
          const [ra, rb] = roundPair(data.pctA);
          hint(`Your cut: ${ra} / ${rb}`);
          if (data.ideal && data.ideal.a && data.ideal.b && !idealLine) {
            idealLine = L.polyline(extended(map, data.ideal.a, data.ideal.b), {
              color: '#c8922a', weight: 3, opacity: .9, dashArray: '10 8', interactive: false,
            }).addTo(map);
            map.on('move zoom resize', () => idealLine && idealLine.setLatLngs(extended(map, data.ideal.a, data.ideal.b)));
          }
        },
      };
    },

    // ── The personal result screen (dark left panel) ─────────────────────────
    result(data) {
      const pctA = Number(data.pctA) || 0, pctB = Number(data.pctB) || 0;
      const off  = Math.abs(pctA - 50);                    // how far from a perfect cut
      const [ra, rb] = roundPair(pctA);

      // Which side of the line is which, in compass terms — much clearer than
      // "side A" when your line runs diagonally.
      const your = data.yourLine || {};
      const cos  = cosOf(data.bbox || [0, 0, 1, 1]);
      const f    = your.a && your.b ? frame(your.a, your.b, cos) : null;
      const nameA = f ? capitalise(compassName(f.nx, f.ny)) : 'Side A';
      const nameB = f ? capitalise(compassName(-f.nx, -f.ny)) : 'Side B';

      // How far the perfect line at the same angle sat from the player's line.
      let idealText = 'The perfect cut ran along the same line.';
      if (f && data.ideal && data.ideal.a) {
        const km = signedKm(data.ideal.a, your.a, your.b, cos);
        const dir = km >= 0 ? nameA.toLowerCase() : nameB.toLowerCase();
        const d = Math.abs(Math.round(km));
        idealText = d < 8 ? 'You were within a few km of the perfect cut.'
                          : `The 50/50 line sat ${d.toLocaleString('en-US')} km further ${dir}.`;
      }

      const tier =
        off <= 1.5 ? { icon: '⚖️', iconColor: 'var(--correct)',    heading: 'Dead even!' } :
        off <= 4   ? { icon: '⚖️', iconColor: 'var(--correct)',    heading: 'Almost perfect' } :
        off <= 9   ? { icon: '🧮', iconColor: 'var(--gold)',       heading: 'A good cut' } :
        off <= 18  ? { icon: '🧮', iconColor: 'var(--gold-muted)', heading: 'A bit lopsided' } :
        off <= 30  ? { icon: '📐', iconColor: 'var(--gold-muted)', heading: 'Heavily one-sided' } :
                     { icon: '✗',  iconColor: 'var(--wrong)',      heading: 'Nearly everyone on one side' };

      return Object.assign({}, tier, {
        subtitle: `${esc(data.name || 'This country')} — ${fmtPop(data.total)} people`,
        html: `
          <div class="hv-r">
            <div class="hv-r-bar" role="img" aria-label="${ra} percent versus ${rb} percent">
              <span class="hv-r-a" style="width:${pctA.toFixed(1)}%"></span>
              <span class="hv-r-b" style="width:${pctB.toFixed(1)}%"></span>
              <span class="hv-r-mid" aria-hidden="true"></span>
            </div>
            <div class="hv-r-legend">
              <span class="hv-r-side"><i class="a"></i>${esc(nameA)} <b>${ra}%</b> <small>${fmtPop(data.popA)}</small></span>
              <span class="hv-r-side"><i class="b"></i>${esc(nameB)} <b>${rb}%</b> <small>${fmtPop(data.popB)}</small></span>
            </div>
            <p class="hv-r-ideal">${esc(idealText)}</p>
            <p class="hv-r-pending">Rank points — see leaderboard</p>
          </div>`,
      });
    },

    // ── The shared leaderboard moment ────────────────────────────────────────
    reveal(container, revealData, ctx) {
      const bbox    = revealData.bbox || [-10, -10, 10, 10];
      const me      = (ctx && ctx.myNickname) || null;
      const players = (ctx && ctx.players) || [];
      const lines   = (revealData.lines || []).filter(l => l && l.a && l.b);
      // Same colour a player has on the leaderboard, with an index fallback.
      const colorOf = nick => {
        if (typeof QG.util.colorForName === 'function') return QG.util.colorForName(nick);
        const i = players.findIndex(p => p.nickname === nick);
        return QG.util.colorFor(i >= 0 ? i : lines.findIndex(l => l.nickname === nick));
      };

      // Best cut = closest to a 50/50 split. Their "perfect line" is the gold one.
      const best = lines.slice().sort((x, y) => Math.abs((x.pctA || 0) - 50) - Math.abs((y.pctA || 0) - 50))[0] || null;

      const wrap = document.createElement('div');
      wrap.className = 'hv-reveal';
      wrap.innerHTML = `
        <div class="hv-rv-head">
          <span class="hv-rv-title">Where the people actually live</span>
          <span class="hv-rv-scale"><small>fewer</small><i class="hv-rv-ramp"></i><small>more</small></span>
        </div>
        <div class="hv-rv-canvas"></div>
        <div class="hv-rv-legend"></div>`;
      container.appendChild(wrap);

      const canvas = wrap.querySelector('.hv-rv-canvas');
      const legend = wrap.querySelector('.hv-rv-legend');
      const timers = [];
      let map = null, unwatch = null, raf = null, touched = false;
      const drawn = [];                                   // { a, b, poly, halo } — re-extended on zoom

      function redrawAll() {
        if (!map) return;
        for (const d of drawn) {
          const pts = extended(map, d.a, d.b);
          d.poly.setLatLngs(pts);
          if (d.halo) d.halo.setLatLngs(pts);
        }
      }

      // Add one line to the map with a short "drawing" animation.
      function addLine(a, b, opts) {
        const pts = extended(map, a, b);
        const halo = opts.halo === false ? null
          : L.polyline(pts, { color: '#f5ede0', weight: (opts.weight || 4) + 5, opacity: .5, interactive: false }).addTo(map);
        const poly = L.polyline(pts, {
          color: opts.color, weight: opts.weight || 4, opacity: .95,
          dashArray: opts.dashArray || null, interactive: true, className: 'hv-rv-line',
        }).addTo(map);
        if (opts.tooltip) poly.bindTooltip(opts.tooltip, { sticky: true });
        drawn.push({ a, b, poly, halo });
        // Stroke-dash "draw on" effect (skipped when the player asked for less motion).
        if (!reducedMotion()) {
          const el = poly.getElement();
          if (el && typeof el.getTotalLength === 'function') {
            const len = el.getTotalLength();
            el.style.strokeDasharray = `${len}`;
            el.style.strokeDashoffset = `${len}`;
            void el.getBoundingClientRect();
            el.style.transition = 'stroke-dashoffset .55s ease-out';
            el.style.strokeDashoffset = '0';
            timers.push(setTimeout(() => {
              el.style.transition = ''; el.style.strokeDashoffset = '';
              el.style.strokeDasharray = opts.dashArray || '';
            }, 640));
          }
        }
        return poly;
      }

      raf = QG.util.nextFrame(() => {
        map = L.map(canvas, {
          zoomControl: true, attributionControl: false, zoomSnap: 0.25,
          minZoom: 1, maxZoom: 12, boxZoom: false, keyboard: false,
        });
        // The basemap is faded right down: this screen is about the population
        // pattern, and a full-strength terrain map drowns the heat colours.
        const base = QG.util.tiles.streets();
        base.setOpacity(BASEMAP_FADE);
        base.addTo(map);
        const fit = () => map.fitBounds(bboxBounds(bbox), { padding: [12, 12] });
        fit();
        // Same guard as in mount(): re-fit until somebody touches the map.
        unwatch = watchSize(canvas, map, () => { if (!touched) fit(); });
        map.on('dragstart zoomanim', () => { touched = true; });
        canvas.addEventListener('wheel', () => { touched = true; }, { passive: true });
        map.on('move zoom resize', redrawAll);

        // 1. the country, 2. the population heat, 3. the capital
        drawOutline(map, revealData.outline, { color: '#2c1e0f', weight: 1.8, fillColor: '#f5ede0', fillOpacity: .35 });
        if (revealData.heat && revealData.heat.values && revealData.heat.values.length) {
          const h = revealData.heat;
          L.imageOverlay(heatImageUrl(h), bboxBounds(h.bbox || bbox), {
            opacity: .95, interactive: false, className: 'hv-heat',
          }).addTo(map);
        }
        drawCapital(map, revealData.capital);

        // 4. every player's line, one at a time
        const step = reducedMotion() ? 0 : 340;
        lines.forEach((l, i) => {
          timers.push(setTimeout(() => {
            if (!map) return;
            const [ra, rb] = roundPair(l.pctA);
            addLine(l.a, l.b, {
              color: colorOf(l.nickname), weight: l.nickname === me ? 5 : 4,
              tooltip: `<b>${esc(l.nickname)}</b><br>${ra} / ${rb}`,
            });
            const chip = document.createElement('span');
            chip.className = 'hv-rv-chip' + (l.nickname === me ? ' is-me' : '');
            chip.innerHTML = `<i style="background:${colorOf(l.nickname)}"></i>${esc(l.nickname)} <b>${ra} / ${rb}</b>`;
            legend.appendChild(chip);
          }, 500 + i * step));
        });

        // 5. finally the gold "perfect" line for the best cut
        if (best && best.ideal && best.ideal.a && best.ideal.b) {
          timers.push(setTimeout(() => {
            if (!map) return;
            addLine(best.ideal.a, best.ideal.b, {
              color: '#c8922a', weight: 4, dashArray: '10 8',
              tooltip: `A perfect 50/50 cut at ${esc(best.nickname)}'s angle`,
            });
            const chip = document.createElement('span');
            chip.className = 'hv-rv-chip is-ideal';
            chip.innerHTML = `<i class="gold"></i>Perfect cut at ${esc(best.nickname)}’s angle <b>50 / 50</b>`;
            legend.appendChild(chip);
          }, 500 + lines.length * step + 200));
        }

        if (!lines.length) legend.innerHTML = '<span class="hv-rv-nobody">Nobody drew a line this round.</span>';
      });

      return {
        destroy() {
          if (raf) raf();
          timers.forEach(clearTimeout);
          if (unwatch) unwatch();
          if (map) { map.off(); map.remove(); map = null; }
          wrap.remove();
        },
      };
    },

    // ── Leaderboard row label: "52 / 48" ─────────────────────────────────────
    metric(detail) {
      if (!detail || !Number.isFinite(Number(detail.pctA))) return '';
      const [a, b] = roundPair(detail.pctA);
      return `${a} / ${b}`;
    },
  });
})();
