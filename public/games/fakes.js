// ─────────────────────────────────────────────────────────────────────────────
// public/games/fakes.js — client module for "Spot the Fakes" (type "fakes").
//
// Six short names/terms are shown as tappable tiles (2×3 grid). Some of them
// are invented — the player taps every one they believe is fake, then locks
// in. Some question sets rename the idea (payload.fakeLabel, e.g. "Drugs" for
// a "Pokémon or pharmaceutical?" set) but the tap-to-mark mechanic never
// changes. See docs/games/fakes.md for the full payload / answer / result /
// reveal shapes — this file follows games/fakes.js (the server module) as the
// source of truth whenever the two disagree.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG  = window.QuizGames;
  const esc = s => QG.util.escapeHtml(String(s == null ? '' : s));
  function snd(api, name) { const s = api && api.sound; if (s && typeof s[name] === 'function') s[name](); }

  QG.register({
    type: 'fakes',

    // ── Answering UI: 2×3 grid of toggle tiles + a "Lock in" button ───────────
    mount(container, payload, api) {
      container.innerHTML = '';
      const passive   = api.role === 'host';               // TV host watches, cannot tap
      const items     = Array.isArray(payload.items) ? payload.items : [];
      const fakeCount = Number.isInteger(payload.fakeCount) ? payload.fakeCount : 3;
      const label     = (payload.fakeLabel && String(payload.fakeLabel).trim()) || 'Fakes';
      const picked    = new Set();                          // indices into `items` the player has tapped
      let locked = !!api.locked;

      const wrap = document.createElement('div');
      wrap.className = 'fk-wrap' + (api.tvMode ? ' is-tv' : '') + (passive ? ' is-passive' : '');
      wrap.innerHTML = `
        <p class="fk-head">Tap every <b>${esc(label)}</b> you spot</p>
        <div class="fk-grid"></div>
        ${passive
          ? `<p class="fk-host-hint">Players are tapping the ${esc(label.toLowerCase())} on their phones…</p>`
          : `<div class="fk-footer">
               <span class="fk-counter">0 of ${fakeCount} ${esc(label.toLowerCase())} picked</span>
               <button type="button" class="btn btn-red fk-lock" disabled>Lock in</button>
             </div>`}`;
      container.appendChild(wrap);

      const grid      = wrap.querySelector('.fk-grid');
      const counterEl = wrap.querySelector('.fk-counter');
      const lockBtn   = wrap.querySelector('.fk-lock');

      // One tile per item. Tapping toggles membership in `picked`; tapping the
      // same tile again un-picks it. No client-side cap — a player can pick
      // anywhere from 0 to 6 (scoring naturally penalises over/under-picking).
      const tiles = items.map((text, i) => {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'fk-tile';
        tile.style.animationDelay = `${i * 55}ms`;
        tile.disabled = passive || locked;
        tile.setAttribute('aria-pressed', 'false');
        tile.innerHTML = `<span class="fk-tile-text">${esc(text)}</span><span class="fk-tile-badge" aria-hidden="true">✗</span>`;
        if (!passive) {
          tile.addEventListener('click', () => {
            if (locked || api.locked) return;
            if (picked.has(i)) picked.delete(i); else picked.add(i);
            const isPicked = picked.has(i);
            tile.classList.toggle('is-picked', isPicked);
            tile.setAttribute('aria-pressed', String(isPicked));
            snd(api, 'click');
            updateFooter();
          });
        }
        grid.appendChild(tile);
        return tile;
      });

      function updateFooter() {
        if (counterEl) counterEl.textContent = `${picked.size} of ${fakeCount} ${label.toLowerCase()} picked`;
        if (lockBtn) lockBtn.disabled = picked.size < 1 || locked;
      }
      updateFooter();

      function freeze(text) {
        locked = true;
        wrap.classList.add('is-locked');
        tiles.forEach(t => { t.disabled = true; });
        if (lockBtn) { lockBtn.disabled = true; lockBtn.textContent = text || 'Locked in ✓'; }
      }
      // Re-enable tiles + lock button after an answer-rejected unlock so the
      // player can adjust their picks and lock in again.
      function unfreeze() {
        locked = false;
        wrap.classList.remove('is-locked');
        tiles.forEach(t => { t.disabled = passive; });
        updateFooter();
        if (lockBtn) lockBtn.textContent = 'Lock in';
      }
      if (passive || locked) freeze();
      if (!passive && typeof api.onUnlock === 'function') api.onUnlock(unfreeze);

      if (lockBtn) lockBtn.addEventListener('click', () => {
        if (locked || api.locked || picked.size < 1) return;
        snd(api, 'lock');
        freeze('Locked in ✓');
        api.submit({ picks: [...picked].sort((a, b) => a - b) });
      });

      return {
        // Called by the core right before the result screen: colour every tile
        // by the truth (real vs. fake) and mark whether the player's tap
        // decision on it was right, while we're still on the question screen.
        onResult(data) {
          const list = Array.isArray(data.items) ? data.items : [];
          tiles.forEach((t, i) => {
            const it = list[i];
            t.disabled = true;
            t.style.animation = 'none';                    // stop the entrance animation replaying
            if (!it) return;
            t.classList.toggle('is-fake', !!it.fake);
            t.classList.toggle('is-real', !it.fake);
            t.classList.toggle('is-correct-call', it.picked === it.fake);
            t.classList.toggle('is-wrong-call', it.picked !== it.fake);
          });
        },
        destroy() { wrap.remove(); },
      };
    },

    // ── Result screen (player only) ───────────────────────────────────────────
    result(data) {
      const n = data.correct, total = data.total || 6;
      const label = data.fakeLabel || 'Fake';
      let h;
      if (n === total)  h = { icon: '🕵️', iconColor: 'var(--correct)',    heading: 'Perfect eye!' };
      else if (n >= 5)  h = { icon: '✓',  iconColor: 'var(--correct)',    heading: 'Sharp eye!' };
      else if (n >= 4)  h = { icon: '~',  iconColor: 'var(--gold)',       heading: 'Not bad' };
      else if (n === 3) h = { icon: '~',  iconColor: 'var(--gold-muted)', heading: 'Coin-flip territory' };
      else              h = { icon: '✗',  iconColor: 'var(--wrong)',      heading: 'Fooled you!' };

      const rows = (data.items || []).map(it => {
        const ok = it.picked === it.fake;
        return `<div class="compare-row ${ok ? 'match' : 'miss'}">
                  <span class="fk-cmp-tick">${ok ? '✓' : '✗'}</span>
                  <span class="fk-cmp-text">${esc(it.text)}</span>
                  <span class="fk-cmp-tag ${it.fake ? 'is-fake' : ''}">${it.fake ? esc(label) : 'Real'}</span>
                </div>`;
      }).join('');

      return {
        ...h,
        subtitle: `${n} of ${total} correct`,
        html: `<div class="compare-list">${rows}</div>`,
      };
    },

    // ── Leaderboard reveal (everyone) ─────────────────────────────────────────
    reveal(container, reveal, ctx) {
      const me      = ctx && ctx.myNickname;
      const players = (ctx && ctx.players) || [];
      const colorIdx = nick => { const i = players.findIndex(p => p.nickname === nick); return i >= 0 ? i : 0; };
      const colorOf  = nick => typeof QG.util.colorForName === 'function' ? QG.util.colorForName(nick) : QG.util.colorFor(colorIdx(nick));
      const label = reveal.fakeLabel || 'Fakes';

      const wrap = document.createElement('div');
      wrap.className = 'fk-reveal';
      wrap.innerHTML = `<div class="fk-rv-title">The ${esc(label)} were…</div><div class="fk-rv-grid"></div>`;
      const grid = wrap.querySelector('.fk-rv-grid');

      (reveal.items || []).forEach((it, i) => {
        const cell = document.createElement('div');
        cell.className = 'fk-rv-cell' + (it.fake ? ' is-fake' : ' is-real');
        cell.style.animationDelay = `${i * 130}ms`;
        const names = (it.pickedBy || []).map(n =>
          `<span class="fk-rv-name${n === me ? ' is-me' : ''}"><i style="background:${colorOf(n)}"></i>${esc(n)}</span>`).join('');
        cell.innerHTML = `
          <div class="fk-rv-head">
            <span class="fk-rv-mark" aria-hidden="true">${it.fake ? '★' : ''}</span>
            <span class="fk-rv-text">${esc(it.text)}</span>
          </div>
          <div class="fk-rv-names">${names || '<span class="fk-rv-nobody">nobody tapped this</span>'}</div>`;
        grid.appendChild(cell);
      });
      container.appendChild(wrap);
      return { destroy() { wrap.remove(); } };
    },

    // Leaderboard row metric from the stored detail { picks, correct }.
    metric(detail) {
      if (!detail || !Number.isFinite(detail.correct)) return '';
      return `${detail.correct} / 6 decisions right`;
    },
  });
})();
