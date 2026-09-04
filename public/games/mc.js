// ─────────────────────────────────────────────────────────────────────────────
// public/games/mc.js — client module for plain multiple choice (type "mc").
//
// Four big answer buttons (A–D). The fastest correct answer scores most, so the
// button is submitted the moment it is tapped — there is no "lock in" step.
//
// This file also publishes a small shared toolkit on QuizGames.util._mcKit
// (buttons, result text, bar-chart reveal, metric) that flag.js reuses, so the
// two modules look and behave identically.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG   = window.QuizGames;
  const noop = () => {};
  const LETTERS = ['A', 'B', 'C', 'D'];

  // Play a sound if the core provides it (older cores may lack lock()/whoosh()).
  function snd(api, name) { const s = api && api.sound; if (s && typeof s[name] === 'function') s[name](); }
  const esc = s => QG.util.escapeHtml(String(s == null ? '' : s));

  // ═══════════════════════════════════════════════════════════════════════════
  // SHARED KIT (also used by flag.js)
  // ═══════════════════════════════════════════════════════════════════════════

  // Builds the 2×2 answer grid inside `host`. Returns { onResult, destroy }.
  //   answers  – 4 strings
  //   api      – the module api (submit, locked, isHost, role, sound …)
  function buildChoice(host, answers, api) {
    const grid = document.createElement('div');
    grid.className = 'mc-grid' + (api.tvMode ? ' is-tv' : '');
    const passive = api.role === 'host';                     // TV host cannot answer
    let picked = -1;

    const buttons = answers.map((text, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `mc-btn mc-${LETTERS[i].toLowerCase()}`;
      btn.style.animationDelay = `${i * 70}ms`;
      btn.innerHTML = `<span class="mc-letter">${LETTERS[i]}</span><span class="mc-text">${esc(text)}</span>`;
      btn.disabled = passive || !!api.locked;
      btn.addEventListener('click', () => {
        if (api.locked || passive || picked >= 0) return;
        picked = i;
        snd(api, 'click');
        btn.classList.add('mc-picked');
        buttons.forEach(b => { b.disabled = true; });
        api.submit({ index: i });
      });
      grid.appendChild(btn);
      return btn;
    });
    host.appendChild(grid);

    if (passive) {
      const hint = document.createElement('p');
      hint.className = 'mc-host-hint';
      hint.textContent = 'Players are choosing on their phones…';
      host.appendChild(hint);
    }

    // The server can reject a submitted answer (e.g. it arrived mid-transition)
    // without ever recording it — the core flips api.locked back to false and
    // calls every onUnlock listener so the player can try again.
    if (typeof api.onUnlock === 'function') {
      api.onUnlock(() => {
        picked = -1;
        buttons.forEach(b => {
          b.disabled = passive;
          b.classList.remove('mc-picked');
        });
      });
    }

    return {
      // Called by the core right before the result screen: colour the buttons.
      onResult(data) {
        const ci = data && data.correctIndex;
        buttons.forEach((b, i) => {
          b.disabled = true;
          b.style.animation = 'none';                        // stop the entrance animation replaying
          if (i === ci)                       b.classList.add('mc-correct');
          else if (i === picked)              b.classList.add('mc-wrong');
          else                                b.classList.add('mc-faded');
        });
      },
      destroy() { grid.remove(); },
    };
  }

  // Result-screen description for MC-style answers.
  function choiceResult(data) {
    if (data.isCorrect) {
      return { icon: '✓', iconColor: 'var(--correct)', heading: 'Correct!',
               subtitle: data.yourText ? `You picked “${data.yourText}”` : '' };
    }
    return {
      icon: '✗', iconColor: 'var(--wrong)', heading: 'Not this time',
      subtitle: `The answer was “${data.correctText}”`,
      html: `<div class="mc-cmp">
               <div class="mc-cmp-cell mc-cmp-mine"><span class="mc-cmp-label">Your pick</span><span class="mc-cmp-value">${esc(data.yourText)}</span></div>
               <div class="mc-cmp-cell mc-cmp-right"><span class="mc-cmp-label">Correct</span><span class="mc-cmp-value">${esc(data.correctText)}</span></div>
             </div>`,
    };
  }

  // Leaderboard reveal: one horizontal bar per option, correct one in green,
  // player names under each bar. `reveal` = { answers, correctIndex, counts, pickedBy }.
  function renderBars(host, reveal, ctx) {
    const wrap = document.createElement('div');
    wrap.className = 'mc-reveal';
    const total = Math.max(1, reveal.counts.reduce((a, b) => a + b, 0));
    const max   = Math.max(1, ...reveal.counts);
    const me    = ctx && ctx.myNickname;

    reveal.answers.forEach((text, i) => {
      const isCorrect = i === reveal.correctIndex;
      const count = reveal.counts[i] || 0;
      const names = (reveal.pickedBy[i] || []).map(n =>
        `<span class="mc-rv-name${n === me ? ' is-me' : ''}">${esc(n)}</span>`).join('');
      const row = document.createElement('div');
      row.className = 'mc-rv-row' + (isCorrect ? ' is-correct' : '');
      row.style.animationDelay = `${i * 90}ms`;
      row.innerHTML = `
        <div class="mc-rv-head">
          <span class="mc-rv-letter">${LETTERS[i]}</span>
          <span class="mc-rv-text">${esc(text)}</span>
          <span class="mc-rv-count">${count}<span class="mc-rv-pct">${Math.round(count / total * 100)}%</span></span>
        </div>
        <div class="mc-rv-track"><div class="mc-rv-bar" data-w="${Math.round(count / max * 100)}"></div></div>
        <div class="mc-rv-names">${names || '<span class="mc-rv-nobody">nobody</span>'}</div>`;
      wrap.appendChild(row);
    });
    host.appendChild(wrap);

    // Grow the bars on the next frame so the CSS transition runs.
    QG.util.nextFrame(() => QG.util.nextFrame(() => {
      wrap.querySelectorAll('.mc-rv-bar').forEach(b => { b.style.width = `${Math.max(2, +b.dataset.w)}%`; });
    }));
    return { destroy() { wrap.remove(); } };
  }

  // Leaderboard row metric from the stored detail { isCorrect, index, answerText }.
  function choiceMetric(detail) {
    if (!detail) return '';
    return detail.isCorrect ? '✓ Correct' : `✗ ${detail.answerText || ''}`;
  }

  QG.util._mcKit = { buildChoice, choiceResult, renderBars, choiceMetric, LETTERS };

  // ═══════════════════════════════════════════════════════════════════════════
  // EMOJI PROMPTS — the "emoji" category shows a riddle like "🦁👑" as the
  // question. The core writes the text; we just make it big.
  // ═══════════════════════════════════════════════════════════════════════════
  function looksLikeEmojiRiddle(text) {
    if (typeof text !== 'string') return false;
    const t = text.replace(/\s/g, '');
    if (!t || t.length > 24) return false;
    let pict = 0, other = 0;
    for (const ch of t) {
      if (/\p{Extended_Pictographic}/u.test(ch)) pict++;
      else if (!/[‍️⃣]/.test(ch) && !/\p{Emoji_Modifier}/u.test(ch)) other++;   // skip joiners / skin tones
    }
    return pict >= 2 && pict >= other;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE
  // ═══════════════════════════════════════════════════════════════════════════
  QG.register({
    type: 'mc',

    mount(container, payload, api) {
      container.innerHTML = '';
      const emoji = looksLikeEmojiRiddle(payload.question);
      if (emoji) document.body.classList.add('emoji-prompt');

      const choice = buildChoice(container, payload.answers || [], api);
      return {
        onResult(data) { choice.onResult(data); },
        destroy() {
          choice.destroy();
          document.body.classList.remove('emoji-prompt');
        },
      };
    },

    result(data) { return choiceResult(data); },

    reveal(container, reveal, ctx) { return renderBars(container, reveal, ctx); },

    metric(detail) { return choiceMetric(detail); },
  });
})();
