// ─────────────────────────────────────────────────────────────────────────────
// public/games/compass.js — client module for direction-guessing questions
// (type "compass"). Two cities are named; the player rotates a needle to point
// from the first towards the second along the great-circle (shortest-path)
// bearing — which is often surprisingly far from "as the crow seems to fly" on
// a flat map, because great circles curve towards the poles.
//
// Answer: { bearing } in degrees, clockwise from north, any finite number
// (normalised server-side into [0, 360)).
//
// Reveal: a big rose with everyone's needle plus a small non-interactive map
// tracing the actual great-circle curve, so players can see *why* the answer
// looked so odd. See docs/games/compass.md for the full server contract.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG  = window.QuizGames;
  const esc = s => QG.util.escapeHtml(String(s == null ? '' : s));
  function snd(api, name) { const s = api && api.sound; if (s && typeof s[name] === 'function') s[name](); }
  const fmtKm = km => `${Math.round(km).toLocaleString('en-US')} km`;
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ═══════════════════════════════════════════════════════════════════════════
  // Compass maths — mirrors games/compass.js on the server so the LIVE readout
  // while dragging matches what the server will compute once submitted.
  // ═══════════════════════════════════════════════════════════════════════════
  const POINTS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function normalize(deg) { return ((deg % 360) + 360) % 360; }
  function pointName(deg) { return POINTS16[Math.round(normalize(deg) / 22.5) % 16]; }
  function angularError(a, b) { const d = Math.abs(normalize(a) - normalize(b)); return Math.min(d, 360 - d); }

  // Great-circle spherical interpolation between two lat/lng points (degrees).
  // Returns `n` points tracing the SHORTEST path — this is the curve that makes
  // the "surprising" bearings make sense once you see it on a map.
  function greatCirclePoints(lat1, lng1, lat2, lng2, n) {
    const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
    const phi1 = toRad(lat1), lam1 = toRad(lng1), phi2 = toRad(lat2), lam2 = toRad(lng2);
    const x1 = Math.cos(phi1) * Math.cos(lam1), y1 = Math.cos(phi1) * Math.sin(lam1), z1 = Math.sin(phi1);
    const x2 = Math.cos(phi2) * Math.cos(lam2), y2 = Math.cos(phi2) * Math.sin(lam2), z2 = Math.sin(phi2);
    const dot = Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2));
    const d = Math.acos(dot);
    const pts = [];
    if (d < 1e-9) { for (let i = 0; i < n; i++) pts.push([lat1, lng1]); return pts; }
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const A = Math.sin((1 - t) * d) / Math.sin(d), B = Math.sin(t * d) / Math.sin(d);
      const x = A * x1 + B * x2, y = A * y1 + B * y2, z = A * z1 + B * z2;
      pts.push([toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))]);
    }
    return pts;
  }

  // Initial bearing of the RHUMB line (constant-compass-heading path) between
  // two points. Used only to decide whether a straight contrast line is worth
  // drawing next to the great-circle curve (they coincide for short hops).
  function rhumbBearing(lat1, lng1, lat2, lng2) {
    const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
    const phi1 = toRad(lat1), phi2 = toRad(lat2);
    let dLng = toRad(lng2 - lng1);
    if (Math.abs(dLng) > Math.PI) dLng = dLng > 0 ? dLng - 2 * Math.PI : dLng + 2 * Math.PI;
    const dPsi = Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
    return normalize(toDeg(Math.atan2(dLng, dPsi)));
  }

  // Keep Leaflet's size in sync with its container (rotations, layout shifts).
  function watchSize(el, map) {
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(() => map.invalidateSize()); ro.observe(el); }
    const onOrient = () => setTimeout(() => map.invalidateSize(), 200);
    window.addEventListener('orientationchange', onOrient);
    return () => { if (ro) ro.disconnect(); window.removeEventListener('orientationchange', onOrient); };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The compass rose — a plain SVG built with DOM calls (no template strings)
  // so needle <g> elements can be added/rotated/removed independently. Reused
  // by mount() (interactive), result() (small "you vs. true" rose) and
  // reveal() (big animated rose with everyone's needle).
  //
  // Local coordinate system: a 200×200 box, centre (100,100). `pad` widens the
  // viewBox (without moving the centre) so labels can sit outside the ring —
  // used only by the reveal rose, which prints a nickname at every needle tip.
  // ═══════════════════════════════════════════════════════════════════════════
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CX = 100, CY = 100;
  const RING_R = 78, FACE_R = 68, LABEL_MAJOR_R = 50, LABEL_MINOR_R = 55;
  const NEEDLE_LEN = 60, TAIL_LEN = 46, NEEDLE_W = 7, TAIL_W = 5;

  function svgEl(name, attrs) {
    const n = document.createElementNS(SVG_NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  // Screen position of a bearing (0° = up/north, clockwise) at radius r from centre.
  function bearingXY(deg, r) {
    const rad = deg * Math.PI / 180;
    return [CX + r * Math.sin(rad), CY - r * Math.cos(rad)];
  }
  // A thin filled "pie slice" from (deg-half) to (deg+half) at radius r — the
  // translucent gold "perfect zone" wedge around the true bearing.
  function wedgePath(deg, half, r) {
    const [x1, y1] = bearingXY(deg - half, r), [x2, y2] = bearingXY(deg + half, r);
    return `M${CX},${CY} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 0 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
  }

  // Static face: outer ring, ticks every 10° (longer at 30s, longest at the
  // cardinals), the 8 point labels (N NE E SE S SW W NW), and the hub. North
  // is always straight up — the rose never rotates, only the needles do.
  function buildFace(opts) {
    opts = opts || {};
    const pad = opts.pad || 0;
    const svg = svgEl('svg', { viewBox: `${-pad} ${-pad} ${200 + 2 * pad} ${200 + 2 * pad}`, class: 'cp-rose-svg', 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(svgEl('circle', { cx: CX, cy: CY, r: RING_R, class: 'cp-face-ring' }));
    svg.appendChild(svgEl('circle', { cx: CX, cy: CY, r: FACE_R, class: 'cp-face-inner' }));
    if (typeof opts.wedgeDeg === 'number') {
      svg.appendChild(svgEl('path', { d: wedgePath(opts.wedgeDeg, 4, FACE_R), class: 'cp-wedge' }));
    }
    for (let d = 0; d < 360; d += 10) {
      const isCardinal = d % 90 === 0, isThirty = d % 30 === 0;
      const len = isCardinal ? 13 : isThirty ? 9 : 5;
      const [x1, y1] = bearingXY(d, RING_R), [x2, y2] = bearingXY(d, RING_R - len);
      svg.appendChild(svgEl('line', { x1, y1, x2, y2, class: 'cp-tick' + (isCardinal ? ' is-major' : isThirty ? ' is-mid' : '') }));
    }
    [[0, 'N', true], [45, 'NE', false], [90, 'E', true], [135, 'SE', false], [180, 'S', true], [225, 'SW', false], [270, 'W', true], [315, 'NW', false]]
      .forEach(([d, txt, major]) => {
        const [x, y] = bearingXY(d, major ? LABEL_MAJOR_R : LABEL_MINOR_R);
        const t = svgEl('text', { x, y, class: 'cp-label' + (major ? ' is-major' : ''), 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        t.textContent = txt;
        svg.appendChild(t);
      });
    svg.appendChild(svgEl('circle', { cx: CX, cy: CY, r: 5, class: 'cp-hub' }));
    return svg;
  }

  // A needle: a wide coloured front (points at `deg`) and a thin dark tail,
  // as one rotatable <g>. Colour is set via CSS custom property so a single
  // stylesheet rule paints both halves consistently.
  function makeNeedle(color, extraClass) {
    const g = svgEl('g', { class: 'cp-needle ' + (extraClass || ''), style: `--needle-color:${color}`, transform: `rotate(0 ${CX} ${CY})` });
    g.appendChild(svgEl('path', { d: `M${CX},${CY - NEEDLE_LEN} L${CX + NEEDLE_W},${CY} L${CX - NEEDLE_W},${CY} Z`, class: 'cp-needle-front' }));
    g.appendChild(svgEl('path', { d: `M${CX},${CY + TAIL_LEN} L${CX + TAIL_W},${CY} L${CX - TAIL_W},${CY} Z`, class: 'cp-needle-tail' }));
    return g;
  }
  function setNeedleDeg(g, deg) { g.setAttribute('transform', `rotate(${deg} ${CX} ${CY})`); }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE
  // ═══════════════════════════════════════════════════════════════════════════
  QG.register({
    type: 'compass',

    mount(container, payload, api) {
      container.innerHTML = '';
      const passive = api.role === 'host';
      const from = payload.from || {};
      const wrap = document.createElement('div');
      wrap.className = 'cp-wrap' + (api.tvMode ? ' is-tv' : '');
      wrap.innerHTML = `
        <div class="cp-body">
          <p class="cp-hint">${passive ? 'Players are pointing their needles…' : (api.locked ? 'Locked in — waiting for the others' : 'Drag anywhere on the rose to aim, then lock in')}</p>
          <div class="cp-stage">
            <div class="cp-rose-host"></div>
            <div class="cp-center-label">${esc(from.name || '')}</div>
          </div>
          ${passive ? '' : `
          <div class="cp-readout"><span class="cp-readout-deg">0°</span><span class="cp-readout-pt">N</span></div>
          <div class="cp-nudge-row">
            <button type="button" class="btn btn-mini cp-nudge" data-delta="-5">−5°</button>
            <button type="button" class="btn btn-mini cp-nudge" data-delta="5">+5°</button>
          </div>`}
          ${typeof from.lat === 'number' ? '<div class="cp-locator" aria-hidden="true"></div>' : ''}
          ${passive ? '' : `<button type="button" class="btn btn-red cp-lock" disabled>Lock in</button>`}
        </div>`;
      container.appendChild(wrap);

      const roseHost  = wrap.querySelector('.cp-rose-host');
      const svg       = buildFace();
      roseHost.appendChild(svg);
      const needle    = passive ? null : makeNeedle('var(--lapis)', 'is-player');
      if (needle) svg.appendChild(needle);

      const readoutDeg = wrap.querySelector('.cp-readout-deg');
      const readoutPt  = wrap.querySelector('.cp-readout-pt');
      const lockBtn    = wrap.querySelector('.cp-lock');
      const nudgeBtns  = wrap.querySelectorAll('.cp-nudge');

      // Random start bearing so the resting needle never hints at the answer.
      let bearing = Math.round(Math.random() * 359);
      function paint() {
        if (needle) setNeedleDeg(needle, bearing);
        if (readoutDeg) { readoutDeg.textContent = `${Math.round(bearing)}°`; readoutPt.textContent = pointName(bearing); }
      }
      paint();

      // Pointer anywhere on the rose sets the needle angle from the centre —
      // no need to grab the needle tip itself.
      function angleFromEvent(e) {
        const rect = svg.getBoundingClientRect();
        const dx = e.clientX - (rect.left + rect.width / 2), dy = e.clientY - (rect.top + rect.height / 2);
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return bearing;   // ignore a tap dead on the hub
        return normalize(Math.atan2(dx, -dy) * 180 / Math.PI);
      }
      let dragging = false;
      function onDown(e) {
        if (passive || api.locked) return;
        dragging = true;
        try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        bearing = angleFromEvent(e);
        paint();
        e.preventDefault();
      }
      function onMove(e) { if (dragging) { bearing = angleFromEvent(e); paint(); } }
      function onUp(e) {
        if (!dragging) return;
        dragging = false;
        try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        if (lockBtn) lockBtn.disabled = false;
        snd(api, 'click');
      }
      if (!passive) {
        svg.addEventListener('pointerdown', onDown);
        svg.addEventListener('pointermove', onMove);
        svg.addEventListener('pointerup', onUp);
        svg.addEventListener('pointercancel', onUp);
      }

      // Fine-tune buttons + arrow keys for precision without a steady hand.
      function nudge(delta) {
        if (passive || api.locked) return;
        bearing = normalize(bearing + delta);
        paint();
        if (lockBtn) lockBtn.disabled = false;
        snd(api, 'click');
      }
      nudgeBtns.forEach(b => b.addEventListener('click', () => nudge(+b.dataset.delta)));
      if (!passive) {
        svg.setAttribute('tabindex', '0');
        svg.setAttribute('role', 'slider');
        svg.addEventListener('keydown', e => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { nudge(-1); e.preventDefault(); }
          else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { nudge(1); e.preventDefault(); }
        });
      }

      function freeze(label) {
        wrap.classList.add('is-locked');
        if (lockBtn) { lockBtn.disabled = true; lockBtn.textContent = label || 'Locked in ✓'; }
        nudgeBtns.forEach(b => { b.disabled = true; });
      }
      function unfreeze() {
        wrap.classList.remove('is-locked');
        if (lockBtn) { lockBtn.disabled = false; lockBtn.textContent = 'Lock in'; }
        nudgeBtns.forEach(b => { b.disabled = false; });
      }
      if (passive || api.locked) freeze();
      if (!passive && typeof api.onUnlock === 'function') api.onUnlock(unfreeze);

      if (lockBtn) lockBtn.addEventListener('click', () => {
        if (api.locked) return;
        snd(api, 'lock');
        freeze();
        api.submit({ bearing });
      });

      // Small non-interactive locator map: reminds the player where the FROM
      // city is. Never shows the target — its position is the whole puzzle.
      let locMap = null, locRaf = null, locUnwatch = null;
      const locEl = wrap.querySelector('.cp-locator');
      if (locEl && typeof from.lat === 'number') {
        locRaf = QG.util.nextFrame(() => {
          locMap = L.map(locEl, {
            zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
            doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false, zoomSnap: 0.25,
          });
          QG.util.tiles.streets().addTo(locMap);
          locMap.setView([from.lat, from.lng], 3);
          L.marker([from.lat, from.lng], {
            icon: L.divIcon({ html: '<div class="cp-locator-pin"></div>', className: 'cp-icon-reset', iconSize: [14, 14], iconAnchor: [7, 7] }),
            keyboard: false,
          }).addTo(locMap);
          locUnwatch = watchSize(locEl, locMap);
        });
      }

      return {
        destroy() {
          if (locRaf) locRaf();
          if (locUnwatch) locUnwatch();
          if (locMap) { locMap.remove(); locMap = null; }
          wrap.remove();
        },
        // The core calls this with the server's answer-result. It matters most
        // on a RECONNECT: the question is remounted from scratch, so the needle
        // would sit at a fresh random bearing. Snapping it back to the bearing
        // the player actually locked in keeps the frozen screen truthful.
        onResult(data) {
          if (!data || !Number.isFinite(data.yourBearing)) return;
          bearing = normalize(data.yourBearing);
          paint();
          freeze('Locked in ✓');
        },
      };
    },

    result(data) {
      const err = data.err;
      let t;
      if (err <= 4)       t = { icon: '🎯', iconColor: 'var(--gold)',       heading: 'Spot on!' };
      else if (err <= 20) t = { icon: '🧭', iconColor: 'var(--correct)',    heading: `Close — ${Math.round(err)}° off` };
      else if (err <= 60) t = { icon: '🧭', iconColor: 'var(--gold-muted)', heading: `${Math.round(err)}° off` };
      else                t = { icon: '🌀', iconColor: 'var(--wrong)',      heading: `Way off — ${Math.round(err)}°` };

      const svg = buildFace();
      const trueN = makeNeedle('var(--gold-bright)', 'is-true'); setNeedleDeg(trueN, data.trueBearing); svg.appendChild(trueN);
      const yourN = makeNeedle('var(--lapis-light)', 'is-you');  setNeedleDeg(yourN, data.yourBearing);  svg.appendChild(yourN);

      return {
        ...t,
        subtitle: `${data.to.name} is ${Math.round(data.trueBearing)}° (${data.trueName}) from ${data.from.name} · ${fmtKm(data.distanceKm)}`,
        html: `<div class="cp-cmp-rose">${svg.outerHTML}</div>
               <div class="cp-cmp">
                 <div class="cp-cmp-cell"><span class="cp-cmp-label">Your needle</span><span class="cp-cmp-value">${Math.round(data.yourBearing)}° ${esc(data.yourName)}</span></div>
                 <div class="cp-cmp-cell is-correct"><span class="cp-cmp-label">True bearing</span><span class="cp-cmp-value">${Math.round(data.trueBearing)}° ${esc(data.trueName)}</span></div>
               </div>`,
      };
    },

    reveal(container, reveal, ctx) {
      const me      = ctx && ctx.myNickname;
      const players = (ctx && ctx.players) || [];
      const arrows  = reveal.arrows || [];
      const colorIdx = nick => { const i = players.findIndex(p => p.nickname === nick); return i >= 0 ? i : arrows.findIndex(a => a.nickname === nick); };
      const colorOf  = nick => typeof QG.util.colorForName === 'function' ? QG.util.colorForName(nick) : QG.util.colorFor(colorIdx(nick));

      const wrap = document.createElement('div');
      wrap.className = 'cp-reveal';
      wrap.innerHTML = `
        <div class="cp-rv-rose-host"></div>
        <div class="cp-rv-legend"></div>
        <div class="cp-rv-map-frame"><div class="cp-rv-map"></div></div>
        <p class="cp-rv-caption"></p>`;
      container.appendChild(wrap);

      // ── Big rose: gold true bearing, one coloured needle per player ────────
      const roseHost = wrap.querySelector('.cp-rv-rose-host');
      const svg = buildFace({ pad: 34, wedgeDeg: reveal.trueBearing });
      roseHost.appendChild(svg);

      const timers = [];
      const step = reducedMotion() ? 0 : 260;
      arrows.forEach((a, i) => {
        timers.push(setTimeout(() => {
          const g = makeNeedle(colorOf(a.nickname), 'is-player' + (a.nickname === me ? ' is-me' : ''));
          setNeedleDeg(g, a.bearing);
          svg.appendChild(g);
          const r = NEEDLE_LEN + 20 + (i % 3) * 9;                    // stagger radius so tip labels overlap less
          const [lx, ly] = bearingXY(a.bearing, r);
          const label = svgEl('text', { x: lx, y: ly, class: 'cp-rv-tiplabel' + (a.nickname === me ? ' is-me' : ''), 'text-anchor': 'middle', 'dominant-baseline': 'central' });
          label.textContent = a.nickname;
          svg.appendChild(label);
        }, 250 + i * step));
      });
      timers.push(setTimeout(() => {
        const g = makeNeedle('var(--gold-bright)', 'is-true');
        setNeedleDeg(g, reveal.trueBearing);
        svg.appendChild(g);
        const [lx, ly] = bearingXY(reveal.trueBearing, NEEDLE_LEN + 26);
        const label = svgEl('text', { x: lx, y: ly, class: 'cp-rv-tiplabel is-true', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        label.textContent = reveal.to.name;
        svg.appendChild(label);
      }, 250 + arrows.length * step + 150));

      // ── Legend: names + swatches sorted by accuracy ────────────────────────
      // The needle tips alone become an unreadable smear once several players
      // guess close to the true bearing (a common case — most guesses cluster
      // near the answer), so — matching slider/trace/curve/halves/sizeup —
      // give viewers a sorted, always-legible fallback list.
      const legend = wrap.querySelector('.cp-rv-legend');
      arrows.slice().sort((a, b) => (a.err ?? 999) - (b.err ?? 999)).forEach((a, i) => {
        const chip = document.createElement('span');
        chip.className = 'cp-rv-chip' + (a.nickname === me ? ' is-me' : '');
        chip.style.animationDelay = `${400 + i * 120}ms`;
        chip.innerHTML = `<i style="background:${colorOf(a.nickname)}"></i>${esc(a.nickname)} <b>${Math.round(a.bearing)}°</b><small>${Number.isFinite(a.err) ? `${Math.round(a.err)}° off` : ''}</small>`;
        legend.appendChild(chip);
      });
      if (!arrows.length) legend.innerHTML = '<span class="cp-rv-nobody">Nobody answered this one.</span>';

      // ── Small great-circle map: shows WHY the bearing looked so odd ────────
      let map = null, mapRaf = null, mapUnwatch = null;
      mapRaf = QG.util.nextFrame(() => {
        const mapEl = wrap.querySelector('.cp-rv-map');
        map = L.map(mapEl, {
          zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false,
          doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false, zoomSnap: 0.25,
        });
        QG.util.tiles.streets().addTo(map);

        const gcPoints = greatCirclePoints(reveal.from.lat, reveal.from.lng, reveal.to.lat, reveal.to.lng, 40);
        const gcLine = L.polyline(gcPoints, { color: '#c8922a', weight: 3, opacity: .92, interactive: false }).addTo(map);

        // A short straight line only when it would actually look different
        // from the curve — i.e. the rhumb (constant-heading) bearing disagrees
        // with the great-circle bearing by more than 15°.
        const rBearing = rhumbBearing(reveal.from.lat, reveal.from.lng, reveal.to.lat, reveal.to.lng);
        if (angularError(rBearing, reveal.trueBearing) > 15) {
          L.polyline([[reveal.from.lat, reveal.from.lng], [reveal.to.lat, reveal.to.lng]], { color: '#4a3828', weight: 1.5, dashArray: '5 6', opacity: .6, interactive: false }).addTo(map);
        }
        L.circleMarker([reveal.from.lat, reveal.from.lng], { radius: 5, color: '#1e3a6e', weight: 2, fillColor: '#2c5299', fillOpacity: 1 }).addTo(map).bindPopup(esc(reveal.from.name));
        L.circleMarker([reveal.to.lat, reveal.to.lng], { radius: 6, color: '#a0711a', weight: 2, fillColor: '#d4a035', fillOpacity: 1 }).addTo(map).bindPopup(esc(reveal.to.name));

        map.fitBounds(gcLine.getBounds().pad(0.25));
        mapUnwatch = watchSize(mapEl, map);
      });

      wrap.querySelector('.cp-rv-caption').textContent =
        `Shortest path: ${fmtKm(reveal.distanceKm)}, starting ${Math.round(reveal.trueBearing)}° ${reveal.trueName}`;

      return {
        destroy() {
          timers.forEach(clearTimeout);
          if (mapRaf) mapRaf();
          if (mapUnwatch) mapUnwatch();
          if (map) { map.remove(); map = null; }
          wrap.remove();
        },
      };
    },

    metric(detail) {
      if (!detail || !Number.isFinite(detail.err)) return '';
      return detail.err <= 4 ? 'Spot on' : `${Math.round(detail.err)}° off`;
    },
  });
})();
