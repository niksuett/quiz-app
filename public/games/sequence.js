// ─────────────────────────────────────────────────────────────────────────────
// public/games/sequence.js — client module for drag-to-order (type "sequence").
//
// Four items arrive shuffled; the player drags them into the right order (first /
// earliest at the top) and presses "Lock in". Dragging uses Pointer Events so it
// works with a finger and a mouse; every item also has ▲ ▼ buttons as an
// accessible alternative. Items slide smoothly (FLIP animation) as they reorder.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG  = window.QuizGames;
  const esc = s => QG.util.escapeHtml(String(s == null ? '' : s));
  function snd(api, name) { const s = api && api.sound; if (s && typeof s[name] === 'function') s[name](); }
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // FLIP helper: call `mutate()` (which reorders the DOM) and animate every
  // element in `els` from its old position to its new one.
  function flip(els, mutate) {
    const before = new Map(els.map(el => [el, el.offsetTop]));
    mutate();
    if (reducedMotion()) return;
    els.forEach(el => {
      const dy = before.get(el) - el.offsetTop;
      if (!dy) return;
      el.style.transition = 'none';
      el.style.transform  = `translateY(${dy}px)`;
      void el.offsetHeight;                                    // force the browser to apply the start position
      el.style.transition = 'transform .22s cubic-bezier(.22,1,.36,1)';
      el.style.transform  = '';
    });
  }

  function itemsOf(list) { return Array.from(list.querySelectorAll('.seq-item')); }

  // ═══════════════════════════════════════════════════════════════════════════
  // Drag-to-reorder. The grabbed item follows the pointer with a transform; when
  // its centre crosses a neighbour's midpoint the DOM order changes and the
  // neighbour slides into the gap.
  // ═══════════════════════════════════════════════════════════════════════════
  function enableDrag(list, api, isLocked) {
    let drag = null;   // { item, grabOffset, pointerId }

    function positionDragged(clientY) {
      const listTop  = list.getBoundingClientRect().top;
      const wantTop  = clientY - listTop - drag.grabOffset;            // where the item's top should be (relative to list)
      drag.item.style.transform = `translateY(${wantTop - drag.item.offsetTop}px)`;
      return wantTop + drag.item.offsetHeight / 2;                      // centre of the dragged item
    }

    list.addEventListener('pointerdown', e => {
      if (isLocked() || drag || e.button > 0) return;
      if (e.target.closest('button')) return;                           // arrows handle themselves
      const item = e.target.closest('.seq-item');
      if (!item) return;
      e.preventDefault();
      const r = item.getBoundingClientRect();
      drag = { item, grabOffset: e.clientY - r.top, pointerId: e.pointerId };
      item.setPointerCapture(e.pointerId);
      item.classList.add('is-grabbed');
      item.style.transition = 'none';
      snd(api, 'click');
    });

    list.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const centre = positionDragged(e.clientY);
      const items  = itemsOf(list);
      const others = items.filter(el => el !== drag.item);
      // The dragged item belongs before the first sibling whose midpoint is below its centre.
      let newIndex = others.length;
      for (let i = 0; i < others.length; i++) {
        if (centre < others[i].offsetTop + others[i].offsetHeight / 2) { newIndex = i; break; }
      }
      if (items.indexOf(drag.item) === newIndex) return;
      flip(others, () => {
        if (newIndex >= others.length) list.appendChild(drag.item);
        else list.insertBefore(drag.item, others[newIndex]);
      });
      positionDragged(e.clientY);                                       // its offsetTop changed → recompute transform
    });

    const end = e => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const item = drag.item;
      drag = null;
      item.classList.remove('is-grabbed');
      item.style.transition = reducedMotion() ? 'none' : 'transform .18s cubic-bezier(.22,1,.36,1)';
      item.style.transform  = '';
      setTimeout(() => { item.style.transition = ''; }, 200);
    };
    list.addEventListener('pointerup', end);
    list.addEventListener('pointercancel', end);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE
  // ═══════════════════════════════════════════════════════════════════════════
  QG.register({
    type: 'sequence',

    mount(container, payload, api) {
      container.innerHTML = '';
      const passive = api.role === 'host';
      let locked = !!api.locked;

      const wrap = document.createElement('div');
      wrap.className = 'seq-wrap' + (api.tvMode ? ' is-tv' : '') + (passive ? ' is-passive' : '');
      wrap.innerHTML = `
        <p class="seq-hint">${passive ? 'Players are putting these in order…' : 'Drag into order — first / earliest at the top'}</p>
        <ol class="seq-list"></ol>
        ${passive ? '' : `<button type="button" class="btn btn-red seq-lock">${locked ? 'Locked in ✓' : 'Lock in'}</button>`}`;
      const list = wrap.querySelector('.seq-list');
      (payload.items || []).forEach((text, i) => {
        const li = document.createElement('li');
        li.className = 'seq-item';
        li.dataset.text = text;
        li.style.animationDelay = `${i * 60}ms`;
        // Once the entrance animation is done, drop it — a finished "forwards"
        // animation would otherwise override the inline transforms used for dragging.
        li.addEventListener('animationend', () => li.classList.add('is-in'), { once: true });
        li.innerHTML = `
          <span class="seq-num" aria-hidden="true"></span>
          <span class="seq-grip" aria-hidden="true">⋮⋮</span>
          <span class="seq-text">${esc(text)}</span>
          ${passive ? '' : `<span class="seq-arrows">
            <button type="button" class="seq-up" aria-label="Move up">▲</button>
            <button type="button" class="seq-down" aria-label="Move down">▼</button>
          </span>`}`;
        list.appendChild(li);
      });
      container.appendChild(wrap);

      const lockBtn = wrap.querySelector('.seq-lock');
      function freeze() {
        locked = true;
        wrap.classList.add('is-locked');
        wrap.querySelectorAll('button').forEach(b => { b.disabled = true; });
        if (lockBtn) lockBtn.textContent = 'Locked in ✓';
      }
      // Re-enable dragging + arrow buttons + lock button after an
      // answer-rejected unlock so the player can reorder and lock in again.
      function unfreeze() {
        locked = false;
        wrap.classList.remove('is-locked');
        wrap.querySelectorAll('button').forEach(b => { b.disabled = false; });
        if (lockBtn) lockBtn.textContent = 'Lock in';
      }

      if (!passive) {
        enableDrag(list, api, () => locked || api.locked);
        // Arrow buttons: move one step with the same slide animation
        list.addEventListener('click', e => {
          const btn = e.target.closest('.seq-up, .seq-down');
          if (!btn || locked || api.locked) return;
          const item = btn.closest('.seq-item');
          const items = itemsOf(list);
          const idx = items.indexOf(item);
          const target = btn.classList.contains('seq-up') ? idx - 1 : idx + 1;
          if (target < 0 || target >= items.length) return;
          snd(api, 'click');
          flip(items, () => {
            if (btn.classList.contains('seq-up')) list.insertBefore(item, items[target]);
            else list.insertBefore(items[target], item);
          });
          btn.focus();
        });
        lockBtn.addEventListener('click', () => {
          if (locked || api.locked) return;
          const order = itemsOf(list).map(li => li.dataset.text);
          snd(api, 'lock');
          freeze();
          api.submit({ order });
        });
        if (locked) freeze();
        if (typeof api.onUnlock === 'function') api.onUnlock(unfreeze);
      }

      return { destroy() { wrap.remove(); } };
    },

    result(data) {
      const n = data.correctCount, t = data.totalItems || 4;
      let h;
      if (n === t)      h = { icon: '🎯', iconColor: 'var(--correct)',    heading: 'Perfect order!' };
      else if (n >= 3)  h = { icon: '✓',  iconColor: 'var(--correct)',    heading: 'Almost perfect!' };
      else if (n === 2) h = { icon: '~',  iconColor: 'var(--gold)',       heading: 'Halfway there' };
      else if (n === 1) h = { icon: '~',  iconColor: 'var(--gold-muted)', heading: 'One in place' };
      else              h = { icon: '✗',  iconColor: 'var(--wrong)',      heading: 'All mixed up' };
      const rows = data.correctOrder.map((correct, i) => {
        const mine = data.playerOrder[i] || '—';
        const ok = mine === correct;
        return `<div class="seq-cmp-row ${ok ? 'is-ok' : 'is-miss'}">
                  <span class="seq-cmp-pos">${i + 1}</span>
                  <span class="seq-cmp-body"><span class="seq-cmp-mine">${esc(mine)}</span>${ok ? '' : `<span class="seq-cmp-fix">→ ${esc(correct)}</span>`}</span>
                  <span class="seq-cmp-tick">${ok ? '✓' : '✗'}</span>
                </div>`;
      }).join('');
      return {
        ...h,
        subtitle: `${n} of ${t} in the right place · ${data.pairsCorrect}/${data.pairsTotal} pairs in order`,
        html: `<div class="seq-cmp">${rows}</div>`,
      };
    },

    reveal(container, reveal, ctx) {
      const me = ctx && ctx.myNickname;
      const players = (ctx && ctx.players) || [];
      const colorIdx = nick => { const i = players.findIndex(p => p.nickname === nick); return i >= 0 ? i : 0; };
      const colorOf  = nick => typeof QG.util.colorForName === 'function' ? QG.util.colorForName(nick) : QG.util.colorFor(colorIdx(nick));   // matches the leaderboard avatar
      const wrap = document.createElement('div');
      wrap.className = 'seq-reveal';
      wrap.innerHTML = `
        <div class="seq-rv-title">Correct order</div>
        <ol class="seq-rv-correct">${reveal.correctOrder.map((t, i) => `<li style="animation-delay:${i * 70}ms">${esc(t)}</li>`).join('')}</ol>
        <div class="seq-rv-players"></div>`;
      const box = wrap.querySelector('.seq-rv-players');
      (reveal.playerAnswers || []).forEach((pa, pi) => {
        const block = document.createElement('div');
        block.className = 'seq-rv-player' + (pa.nickname === me ? ' is-me' : '');
        block.style.animationDelay = `${350 + pi * 160}ms`;
        const cells = reveal.correctOrder.map((correct, i) => {
          const mine = pa.playerOrder[i] || '—';
          return `<div class="seq-rv-cell ${mine === correct ? 'is-ok' : 'is-miss'}"><span class="seq-rv-cellnum">${i + 1}</span>${esc(mine)}</div>`;
        }).join('');
        block.innerHTML = `
          <div class="seq-rv-name"><i style="background:${colorOf(pa.nickname)}"></i>${esc(pa.nickname)}<span>${pa.correctCount}/${reveal.correctOrder.length}</span></div>
          <div class="seq-rv-grid">${cells}</div>`;
        box.appendChild(block);
      });
      if (!reveal.playerAnswers || !reveal.playerAnswers.length) box.innerHTML = '<p class="seq-rv-nobody">Nobody answered this one.</p>';
      container.appendChild(wrap);
      return { destroy() { wrap.remove(); } };
    },

    metric(detail) {
      if (!detail || !Number.isFinite(detail.correctCount)) return '';
      const total = detail.playerOrder ? detail.playerOrder.length : 4;
      return `${detail.correctCount}/${total} in place`;
    },
  });
})();
