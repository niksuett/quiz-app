// ─────────────────────────────────────────────────────────────────────────────
// public/games/map.js — client module for pin-drop questions (type "map").
//
// A Leaflet world map; tap anywhere to drop a pin, tap again to move it, then
// "Lock in". Bird's Eye questions (payload.satellite) additionally show an
// aerial close-up above the map, assembled from proxied satellite tiles that
// never reveal the real coordinates (see games/map.js on the server).
//
// Reveal: gold star at the right spot, an optional tolerance circle, then every
// player's pin flies in with a dashed line back to the star.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG  = window.QuizGames;
  const esc = s => QG.util.escapeHtml(String(s == null ? '' : s));
  function snd(api, name) { const s = api && api.sound; if (s && typeof s[name] === 'function') s[name](); }
  const fmtKm = km => `${Math.round(km).toLocaleString('en-US')} km`;
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Rough world view that fits nicely on both a phone and a TV.
  const WORLD = [[-58, -170], [78, 170]];

  function pinIcon(cls, inner, size) {
    return L.divIcon({ html: `<div class="${cls}">${inner || ''}</div>`, className: 'map-icon-reset', iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2 - 4] });
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
  // Aerial view panel (Bird's Eye). A grid of proxied tiles is shifted so the
  // hidden target sits exactly under the crosshair. "Zoom out" shows a wider
  // 5×5 grid at half scale (same tiles, so the centring stays exact).
  // ═══════════════════════════════════════════════════════════════════════════
  function buildAerial(sat, api) {
    const panel = document.createElement('div');
    panel.className = 'map-aerial';
    panel.innerHTML = `
      <div class="map-aerial-view">
        <div class="map-aerial-grid"></div>
        <div class="map-aerial-cross" aria-hidden="true"></div>
      </div>
      <div class="map-aerial-bar">
        <span class="map-aerial-label">Aerial view</span>
        <button type="button" class="map-aerial-zoom">Zoom out</button>
      </div>`;
    const grid = panel.querySelector('.map-aerial-grid');
    const btn  = panel.querySelector('.map-aerial-zoom');
    let wide = false;

    function render() {
      const radius = wide ? 2 : 1, scale = wide ? 0.5 : 1;
      const n = radius * 2 + 1, px = n * 256;
      grid.innerHTML = '';
      grid.style.width = grid.style.height = `${px}px`;
      grid.style.marginLeft = grid.style.marginTop = `${-px / 2}px`;
      // Shift so the target (at fx,fy inside the centre tile) lands on the centre, then scale.
      grid.style.transform = `scale(${scale}) translate(${(0.5 - sat.fx) * 256}px, ${(0.5 - sat.fy) * 256}px)`;
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        const img = document.createElement('img');
        img.alt = '';
        img.draggable = false;
        img.src = `/map/sat/${encodeURIComponent(sat.token)}/${sat.zoom}/${dx}/${dy}`;
        img.style.left = `${(dx + radius) * 256}px`;
        img.style.top  = `${(dy + radius) * 256}px`;
        grid.appendChild(img);
      }
      btn.textContent = wide ? 'Zoom in' : 'Zoom out';
      panel.classList.toggle('is-wide', wide);
    }
    btn.addEventListener('click', () => { wide = !wide; snd(api, 'click'); render(); });
    render();
    return panel;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE
  // ═══════════════════════════════════════════════════════════════════════════
  QG.register({
    type: 'map',

    mount(container, payload, api) {
      container.innerHTML = '';
      const passive = api.role === 'host';
      const wrap = document.createElement('div');
      wrap.className = 'map-wrap' + (api.tvMode ? ' is-tv' : '') + (payload.satellite ? ' has-aerial' : '');
      if (payload.satellite) wrap.appendChild(buildAerial(payload.satellite, api));

      const body = document.createElement('div');
      body.className = 'map-body';
      body.innerHTML = `
        <p class="map-hint">${passive ? 'Players are dropping their pins…' : (api.locked ? 'Locked in — waiting for the others' : 'Tap the map to drop your pin')}</p>
        <div class="map-canvas" role="application" aria-label="World map"></div>
        ${passive ? '' : `<button type="button" class="btn btn-red map-lock" disabled>${api.locked ? 'Locked in ✓' : 'Lock in'}</button>`}`;
      wrap.appendChild(body);
      container.appendChild(wrap);

      const canvas  = body.querySelector('.map-canvas');
      const hint    = body.querySelector('.map-hint');
      const lockBtn = body.querySelector('.map-lock');
      let map = null, pin = null, coords = null, unwatch = null, raf = null, destroyed = false;

      // Leaflet must measure a visible container, so build it on the next frame.
      raf = QG.util.nextFrame(() => {
        if (destroyed) return;
        map = L.map(canvas, {
          zoomControl: !passive, attributionControl: false, worldCopyJump: true,
          zoomSnap: 0.25, minZoom: 1, maxZoom: 18,
          dragging: !passive, scrollWheelZoom: !passive, doubleClickZoom: !passive, touchZoom: !passive, boxZoom: false, keyboard: !passive,
        });
        QG.util.tiles.streets().addTo(map);
        map.fitBounds(WORLD);
        unwatch = watchSize(canvas, map);

        if (!passive && !api.locked) attachClickHandler();
      });

      // Registers the map's click-to-drop-pin handler. Pulled out of mount so
      // it can be re-attached after an answer-rejected unlock.
      function attachClickHandler() {
        if (!map) return;
        map.on('click', e => {
          if (api.locked) return;
          const ll = e.latlng.wrap();                          // keep lng within -180..180
          coords = { lat: +ll.lat.toFixed(5), lng: +ll.lng.toFixed(5) };
          if (pin) pin.setLatLng(ll);
          else pin = L.marker(ll, { icon: pinIcon('map-pin', '<i></i>', 28), keyboard: false }).addTo(map);
          snd(api, 'click');
          lockBtn.disabled = false;
          hint.textContent = 'Pin dropped — tap elsewhere to move it, then lock in';
        });
      }

      if (lockBtn) lockBtn.addEventListener('click', () => {
        if (api.locked || !coords) return;
        snd(api, 'lock');
        lockBtn.disabled = true; lockBtn.textContent = 'Locked in ✓';
        wrap.classList.add('is-locked');
        hint.textContent = 'Locked in — waiting for the others';
        if (map) map.off('click');
        api.submit({ lat: coords.lat, lng: coords.lng });
      });

      // The server can reject a submitted answer without ever recording it —
      // the core flips api.locked back to false and calls onUnlock listeners
      // so the player can drop a new pin and lock in again.
      if (!passive && typeof api.onUnlock === 'function') {
        api.onUnlock(() => {
          wrap.classList.remove('is-locked');
          if (lockBtn) { lockBtn.disabled = !coords; lockBtn.textContent = 'Lock in'; }
          hint.textContent = coords ? 'Pin dropped — tap elsewhere to move it, then lock in' : 'Tap the map to drop your pin';
          if (map) { map.off('click'); attachClickHandler(); }
        });
      }

      return {
        destroy() {
          destroyed = true;
          if (raf) raf();
          if (unwatch) unwatch();
          if (map) { map.remove(); map = null; }
          wrap.remove();
        },
        // Called by the core with the server's answer-result. Live, the pin is
        // already on the map and nothing needs doing. After a RECONNECT the map
        // is rebuilt empty, and the server's result does not carry the player's
        // own lat/lng (only the distance), so the pin cannot be restored — say
        // so instead of leaving a blank map under a "Locked in" banner.
        // (Adding lat/lng to games/map.js's `result` would let us redraw it.)
        onResult() {
          if (!passive && !pin) hint.textContent = 'Locked in — your pin appears on the leaderboard';
        },
      };
    },

    result(data) {
      const km = data.distanceKm;
      let t;
      if (data.insideTolerance)  t = { icon: '🎯', iconColor: 'var(--correct)',    heading: 'Inside the zone!' };
      else if (km < 10)          t = { icon: '🎯', iconColor: 'var(--correct)',    heading: 'Pinpoint!' };
      else if (km < 50)          t = { icon: '📍', iconColor: 'var(--correct)',    heading: 'Very close!' };
      else if (km < 200)         t = { icon: '📍', iconColor: 'var(--gold)',       heading: 'In the area' };
      else if (km < 800)         t = { icon: '📍', iconColor: 'var(--gold-muted)', heading: 'Not quite…' };
      else                       t = { icon: '✗',  iconColor: 'var(--wrong)',      heading: 'Way off!' };
      return {
        ...t,
        html: `<div class="map-cmp">
                 <div class="map-cmp-cell"><span class="map-cmp-label">Distance</span><span class="map-cmp-value">${fmtKm(km)}</span></div>
                 <div class="map-cmp-cell is-correct"><span class="map-cmp-label">It was</span><span class="map-cmp-value map-cmp-sm">${esc(data.locationName || `${data.correctLat}, ${data.correctLng}`)}</span></div>
               </div>`,
      };
    },

    reveal(container, reveal, ctx) {
      const me = ctx && ctx.myNickname;
      const players = (ctx && ctx.players) || [];
      const colorIdx = nick => { const i = players.findIndex(p => p.nickname === nick); return i >= 0 ? i : reveal.pins.findIndex(p => p.nickname === nick); };
      const colorOf  = nick => typeof QG.util.colorForName === 'function' ? QG.util.colorForName(nick) : QG.util.colorFor(colorIdx(nick));   // matches the leaderboard avatar

      const wrap = document.createElement('div');
      wrap.className = 'map-reveal';
      wrap.innerHTML = `<div class="map-rv-canvas"></div>` +
        (reveal.satelliteZoom ? `<p class="map-rv-label">The aerial view showed <strong>${esc(reveal.locationName)}</strong></p>` : '');
      container.appendChild(wrap);
      const canvas = wrap.querySelector('.map-rv-canvas');
      const timers = [];
      let map = null, unwatch = null, raf = null;

      raf = QG.util.nextFrame(() => {
        map = L.map(canvas, { zoomControl: true, attributionControl: false, worldCopyJump: true, zoomSnap: 0.25, minZoom: 1 });
        QG.util.tiles.streets().addTo(map);
        const target = [reveal.correctLat, reveal.correctLng];
        map.setView(target, 4);
        unwatch = watchSize(canvas, map);

        const bounds = L.latLngBounds([target]);
        if (reveal.toleranceKm > 0) {
          const circle = L.circle(target, { radius: reveal.toleranceKm * 1000, color: '#c8922a', weight: 2, opacity: .85, fillColor: '#c8922a', fillOpacity: .14, interactive: false }).addTo(map);
          bounds.extend(circle.getBounds());
        }
        L.marker(target, { icon: pinIcon('map-star', '★', 36), zIndexOffset: 1000, keyboard: false }).addTo(map)
          .bindPopup(`<b>${esc(reveal.locationName || 'Correct location')}</b>`);

        const step = reducedMotion() ? 0 : 380;
        const pins = reveal.pins || [];
        pins.forEach((p, i) => {
          timers.push(setTimeout(() => {
            const ll = [p.lat, p.lng];
            bounds.extend(ll);
            L.polyline([ll, target], { color: '#4a3828', weight: 1.5, dashArray: '5 6', opacity: .55, interactive: false }).addTo(map);
            const color = colorOf(p.nickname);
            const icon  = pinIcon('map-rv-pin' + (p.nickname === me ? ' is-me' : ''), `<i style="background:${color}"></i><b>${esc(QG.util.playerInitial(p.nickname))}</b>`, 30);
            L.marker(ll, { icon, keyboard: false }).addTo(map)
              .bindPopup(`<b>${esc(p.nickname)}</b><br>${fmtKm(p.distanceKm)} away`);
            if (i === pins.length - 1) timers.push(setTimeout(() => map.fitBounds(bounds.pad(0.15), { maxZoom: 7, animate: !reducedMotion() }), 350));
          }, 600 + i * step));
        });
        if (!pins.length) map.fitBounds(bounds.pad(0.5), { maxZoom: 6 });
      });

      return {
        destroy() {
          if (raf) raf();
          timers.forEach(clearTimeout);
          if (unwatch) unwatch();
          if (map) { map.remove(); map = null; }
          wrap.remove();
        },
      };
    },

    metric(detail) {
      if (!detail || !Number.isFinite(detail.distanceKm)) return '';
      if (detail.distanceKm <= 5) return 'Pinpoint!';
      if (detail.effectiveKm === 0) return 'Inside the zone';
      return `${fmtKm(detail.distanceKm)} away`;
    },
  });
})();
