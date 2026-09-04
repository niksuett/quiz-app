// ─────────────────────────────────────────────────────────────────────────────
// public/games/slider.js — client module for estimation questions (type "slider").
//
// A draggable range slider plus an editable number box that stay in sync. The
// thumb starts at a random spot inside the middle 80% of the range so its start
// position never hints at the answer. The player presses "Lock in" to submit.
//
// This file also publishes QuizGames.util._scaleKit — the slider UI builder,
// the "Your guess | Correct" compare block and the leaderboard axis reveal —
// which timeline.js reuses with year formatting.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG  = window.QuizGames;
  const esc = s => QG.util.escapeHtml(String(s == null ? '' : s));
  function snd(api, name) { const s = api && api.sound; if (s && typeof s[name] === 'function') s[name](); }
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // Number of decimals implied by a step (0.5 → 1, 0.01 → 2), for rounding.
  function decimalsOf(step) {
    const s = String(step);
    const i = s.indexOf('.');
    return i < 0 ? 0 : Math.min(6, s.length - i - 1);
  }
  const fmtNum = (n, unit) => QG.util.fmtNum(n, unit);

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED: the slider question UI
  //   cfg = { min, max, step, unit, inputType:'number'|'text', format(v)→string,
  //           parse(text)→number|null, tickLabels:[string]|null, hint:string|null,
  //           hostHint:string }
  // Returns { destroy }.
  // ═══════════════════════════════════════════════════════════════════════════
  function buildRangeUI(host, cfg, api) {
    const { min, max } = cfg;
    const step   = cfg.step > 0 ? cfg.step : 1;
    const dec    = decimalsOf(step);
    const passive = api.role === 'host';
    const round  = v => +(Math.round((v - min) / step) * step + min).toFixed(dec);

    // Random start inside the inner 80% of the range (never the midpoint)
    const margin = (max - min) * 0.1;
    const start  = clamp(round(min + margin + Math.random() * (max - min - 2 * margin)), min, max);

    const wrap = document.createElement('div');
    wrap.className = 'sl-wrap' + (api.tvMode ? ' is-tv' : '');
    wrap.innerHTML = `
      <div class="sl-value-row">
        <input class="sl-number" type="${cfg.inputType || 'number'}" inputmode="${cfg.inputType === 'text' ? 'text' : 'decimal'}"
               ${cfg.inputType === 'text' ? '' : `min="${min}" max="${max}" step="${step}"`}
               value="${esc(cfg.format(start))}" aria-label="Your guess" autocomplete="off">
        ${cfg.unit ? `<span class="sl-unit">${esc(cfg.unit)}</span>` : ''}
      </div>
      ${cfg.hint ? `<p class="sl-hint">${cfg.hint}</p>` : ''}
      <div class="sl-track-wrap">
        <input class="sl-range" type="range" min="${min}" max="${max}" step="${step}" value="${start}" aria-label="Slide to guess">
      </div>
      ${cfg.tickLabels
        ? `<div class="sl-ticks">${cfg.tickLabels.map(t => `<span>${esc(t)}</span>`).join('')}</div>`
        : `<div class="sl-bounds"><span>${esc(cfg.format(min))}${cfg.unit ? ' ' + esc(cfg.unit) : ''}</span><span>${esc(cfg.format(max))}${cfg.unit ? ' ' + esc(cfg.unit) : ''}</span></div>`}
      ${passive
        ? `<p class="sl-host-hint">${esc(cfg.hostHint || 'Players are sliding…')}</p>`
        : `<button type="button" class="btn btn-red sl-lock">Lock in</button>`}`;
    host.appendChild(wrap);

    const numEl   = wrap.querySelector('.sl-number');
    const rangeEl = wrap.querySelector('.sl-range');
    const lockBtn = wrap.querySelector('.sl-lock');
    let value = start;

    // Paint the filled part of the track (CSS reads --sl-pct)
    const paint = () => { rangeEl.style.setProperty('--sl-pct', `${((value - min) / (max - min)) * 100}%`); };
    paint();

    // Thumb moved → update the number box
    rangeEl.addEventListener('input', () => {
      value = round(+rangeEl.value);
      numEl.value = cfg.format(value);
      paint();
    });
    rangeEl.addEventListener('change', () => snd(api, 'click'));

    // Typed a number → move the thumb (do not clamp while typing; that fights the user)
    numEl.addEventListener('input', () => {
      const n = cfg.parse(numEl.value);
      if (n === null || !Number.isFinite(n)) return;
      value = clamp(n, min, max);
      rangeEl.value = value;
      paint();
    });
    // Leaving the box → clamp and re-format
    const settle = () => {
      const n = cfg.parse(numEl.value);
      value = clamp(n === null || !Number.isFinite(n) ? value : round(n), min, max);
      rangeEl.value = value; numEl.value = cfg.format(value); paint();
    };
    numEl.addEventListener('blur', settle);
    numEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); numEl.blur(); if (lockBtn) lockBtn.focus(); } });

    function freeze(label) {
      numEl.disabled = true; rangeEl.disabled = true;
      wrap.classList.add('is-locked');
      if (lockBtn) { lockBtn.disabled = true; lockBtn.textContent = label || 'Locked in ✓'; }
    }
    // Re-enable the slider + number box + lock button after an answer-rejected
    // unlock so the player can adjust their guess and lock in again.
    function unfreeze() {
      numEl.disabled = false; rangeEl.disabled = false;
      wrap.classList.remove('is-locked');
      if (lockBtn) { lockBtn.disabled = false; lockBtn.textContent = 'Lock in'; }
    }
    if (passive || api.locked) freeze();
    if (!passive && typeof api.onUnlock === 'function') api.onUnlock(unfreeze);

    if (lockBtn) lockBtn.addEventListener('click', () => {
      if (api.locked) return;
      settle();
      snd(api, 'lock');
      freeze('Locked in ✓');
      api.submit({ value });
    });

    return { destroy() { wrap.remove(); } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED: result screen helpers
  // ═══════════════════════════════════════════════════════════════════════════
  function tier(pct, nearIcon) {
    if (pct >= 95) return { icon: '🎯', iconColor: 'var(--correct)',    heading: 'Spot on!' };
    if (pct >= 70) return { icon: nearIcon, iconColor: 'var(--correct)', heading: 'Very close!' };
    if (pct >= 40) return { icon: nearIcon, iconColor: 'var(--gold)',    heading: 'In the ballpark' };
    if (pct >= 15) return { icon: nearIcon, iconColor: 'var(--gold-muted)', heading: 'Not quite…' };
    return { icon: '✗', iconColor: 'var(--wrong)', heading: 'Way off!' };
  }

  // "Your guess | Correct" cells for the dark result panel.
  function compareHtml(yourText, correctText, diffText) {
    return `<div class="sl-cmp">
              <div class="sl-cmp-cell"><span class="sl-cmp-label">Your guess</span><span class="sl-cmp-value">${esc(yourText)}</span></div>
              <div class="sl-cmp-cell is-correct"><span class="sl-cmp-label">Correct</span><span class="sl-cmp-value">${esc(correctText)}</span></div>
            </div>
            <div class="sl-cmp-diff">${esc(diffText)}</div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED: leaderboard axis reveal
  //   cfg = { correctValue, min, max, guesses:[{nickname,value,diff}], fmt(v)→string,
  //           fmtDiff(diff)→string }
  // Draws one horizontal axis: a gold star at the correct value and a coloured
  // pin per player. Pins that would overlap are lifted onto higher "lanes".
  // ═══════════════════════════════════════════════════════════════════════════
  function niceStep(rough) {
    const p = Math.pow(10, Math.floor(Math.log10(rough)));
    const m = rough / p;
    const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
    return n * p;
  }

  function renderAxis(host, cfg, ctx) {
    const guesses = (cfg.guesses || []).filter(g => Number.isFinite(g.value));
    const me      = ctx && ctx.myNickname;
    const players = (ctx && ctx.players) || [];
    const colorIdx = nick => { const i = players.findIndex(p => p.nickname === nick); return i >= 0 ? i : guesses.findIndex(g => g.nickname === nick); };
    // Same colour as the player's avatar in the leaderboard (stable per nickname), falling back to the index.
    const colorOf  = nick => typeof QG.util.colorForName === 'function' ? QG.util.colorForName(nick) : QG.util.colorFor(colorIdx(nick));

    // Visible window: everything that was guessed, plus a little padding — but
    // never narrower than 15% of the question range so the axis stays readable.
    const vals = [cfg.correctValue, ...guesses.map(g => g.value)];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const fullSpan = Math.max(1e-9, cfg.max - cfg.min);
    const half = Math.max((hi - lo) / 2, fullSpan * 0.075, 1e-9);
    const c = (lo + hi) / 2;
    let visMin = c - half * 1.25, visMax = c + half * 1.25;
    // Shift back inside the question range when we overshoot on one side only
    if (visMin < cfg.min && visMax <= cfg.max) { visMax = Math.min(cfg.max, visMax + (cfg.min - visMin)); visMin = cfg.min; }
    if (visMax > cfg.max && visMin >= cfg.min) { visMin = Math.max(cfg.min, visMin - (visMax - cfg.max)); visMax = cfg.max; }
    visMin = Math.max(cfg.min, visMin); visMax = Math.min(cfg.max, visMax);
    const visSpan = Math.max(1e-9, visMax - visMin);
    const pct = v => clamp(((v - visMin) / visSpan) * 100, 2, 98);

    const wrap = document.createElement('div');
    wrap.className = 'sl-reveal';
    wrap.innerHTML = `
      <div class="sl-rv-title">Where everyone landed</div>
      <div class="sl-rv-track"><div class="sl-rv-axis"></div></div>
      <div class="sl-rv-labels"></div>
      <div class="sl-rv-legend"></div>`;
    host.appendChild(wrap);
    const track  = wrap.querySelector('.sl-rv-track');
    const labels = wrap.querySelector('.sl-rv-labels');
    const legend = wrap.querySelector('.sl-rv-legend');

    // Tick marks at "nice" round values
    const stepV = niceStep(visSpan / 4);
    for (let v = Math.ceil(visMin / stepV) * stepV; v <= visMax + 1e-9; v += stepV) {
      const p = ((v - visMin) / visSpan) * 100;
      if (p < 1 || p > 99) continue;
      const t = document.createElement('div'); t.className = 'sl-rv-tick'; t.style.left = `${p}%`; track.appendChild(t);
      const l = document.createElement('span'); l.className = 'sl-rv-ticklabel'; l.style.left = `${p}%`;
      l.textContent = cfg.fmt(+v.toFixed(6)); labels.appendChild(l);
    }

    // Lane assignment: sort by position; a pin goes on the lowest lane whose
    // previous pin is far enough to the left.
    const width = Math.max(240, track.clientWidth || 320);
    const minGapPx = 30;
    const items = [{ star: true, value: cfg.correctValue, pos: pct(cfg.correctValue) }]
      .concat(guesses.map(g => ({ ...g, pos: pct(g.value) })))
      .sort((a, b) => a.pos - b.pos || (a.star ? -1 : 1));
    const laneLastX = [];
    for (const it of items) {
      const x = it.pos / 100 * width;
      let lane = 0;
      while (laneLastX[lane] !== undefined && x - laneLastX[lane] < minGapPx) lane++;
      laneLastX[lane] = x; it.lane = lane;
    }
    const laneH = 28;
    track.style.height = `${62 + Math.max(0, ...items.map(i => i.lane)) * laneH}px`;

    // Draw pins (star first, then players in guess order, staggered)
    items.forEach(it => {
      const pin = document.createElement('div');
      const isMe = !it.star && it.nickname === me;
      pin.className = 'sl-pin' + (it.star ? ' is-star' : '') + (isMe ? ' is-me' : '');
      pin.style.left = `${it.pos}%`;
      const order = it.star ? 0 : 1 + guesses.findIndex(g => g === it || g.nickname === it.nickname);
      pin.style.animationDelay = `${250 + order * 220}ms`;
      const color = it.star ? 'var(--gold-bright)' : colorOf(it.nickname);
      pin.style.setProperty('--pin-color', color);
      pin.title = it.star ? `Correct: ${cfg.fmt(it.value)}` : `${it.nickname}: ${cfg.fmt(it.value)}`;
      pin.innerHTML = `<div class="sl-pin-dot">${it.star ? '★' : esc(QG.util.playerInitial(it.nickname))}</div>
                       <div class="sl-pin-stem" style="height:${8 + it.lane * laneH}px"></div>
                       <div class="sl-pin-tip"></div>`;
      track.appendChild(pin);
    });

    // Legend: closest first
    guesses.slice().sort((a, b) => (a.diff ?? Math.abs(a.value - cfg.correctValue)) - (b.diff ?? Math.abs(b.value - cfg.correctValue)))
      .forEach((g, i) => {
        const chip = document.createElement('span');
        chip.className = 'sl-rv-chip' + (g.nickname === me ? ' is-me' : '');
        chip.style.animationDelay = `${400 + i * 120}ms`;
        const diff = g.diff ?? Math.abs(g.value - cfg.correctValue);
        chip.innerHTML = `<i style="background:${colorOf(g.nickname)}"></i>${esc(g.nickname)} <b>${esc(cfg.fmt(g.value))}</b><small>${esc(cfg.fmtDiff(diff))}</small>`;
        legend.appendChild(chip);
      });
    if (!guesses.length) legend.innerHTML = '<span class="sl-rv-nobody">Nobody answered this one.</span>';

    return { destroy() { wrap.remove(); } };
  }

  QG.util._scaleKit = { buildRangeUI, tier, compareHtml, renderAxis };

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE: slider
  // ═══════════════════════════════════════════════════════════════════════════
  QG.register({
    type: 'slider',

    mount(container, payload, api) {
      container.innerHTML = '';
      const step = payload.step > 0 ? payload.step : 1;
      const dec  = decimalsOf(step);
      return buildRangeUI(container, {
        min: payload.min, max: payload.max, step, unit: payload.unit || '',
        inputType: 'number',
        format: v => String(+(+v).toFixed(dec)),
        parse:  t => { const n = parseFloat(String(t).replace(/,/g, '')); return Number.isNaN(n) ? null : n; },
        tickLabels: null, hint: null, hostHint: 'Players are sliding to their guess…',
      }, api);
    },

    result(data) {
      const t = tier(data.accuracyPct, '📏');
      const diffText = data.diff === 0 ? 'Exact!' : `Off by ${fmtNum(data.diff, data.unit)}`;
      return { ...t, html: compareHtml(fmtNum(data.yourAnswer, data.unit), fmtNum(data.correctValue, data.unit), diffText) };
    },

    reveal(container, reveal, ctx) {
      return renderAxis(container, {
        correctValue: reveal.correctValue, min: reveal.min, max: reveal.max, guesses: reveal.guesses,
        fmt: v => fmtNum(v, reveal.unit),
        fmtDiff: d => d === 0 ? 'exact' : `off by ${fmtNum(d, reveal.unit)}`,
      }, ctx);
    },

    metric(detail) {
      if (!detail || !Number.isFinite(detail.diff)) return '';
      return detail.diff === 0 ? 'Exact!' : `Off by ${fmtNum(detail.diff, detail.unit)}`;
    },
  });
})();
