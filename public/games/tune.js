// ─────────────────────────────────────────────────────────────────────────────
// public/games/tune.js — client module for "Name That Tune" (type "tune").
//
// There are no audio files. The server sends a melody as a list of
// [midiNoteNumber, lengthInBeats] pairs plus a tempo (bpm) and a waveform name.
// We turn that into sound right here in the browser with the Web Audio API:
// one oscillator per note, scheduled ahead of time against the AudioContext's
// own clock so the rhythm never jitters (a per-note setTimeout would drift).
//
// MIDI note numbers: 60 = middle C (C4); +1 = one semitone up; 0 = a rest
// (silence). Beats are fractions of a quarter note (1 = quarter, 0.5 = eighth).
//
// Mechanically this is a multiple-choice question (one correct title out of
// four), so the answer grid and the bar-chart reveal are borrowed straight
// from mc.js's shared kit (QuizGames.util._mcKit) — see docs/games/tune.md §8.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const QG  = window.QuizGames;
  const esc = s => QG.util.escapeHtml(String(s == null ? '' : s));
  function snd(api, name) { const s = api && api.sound; if (s && typeof s[name] === 'function') s[name](); }
  const LETTERS = ['A', 'B', 'C', 'D'];

  // The four-button choice grid and the bar-chart reveal live on mc.js's
  // shared kit (QuizGames.util._mcKit) — see mc.js and flag.js, which reuses
  // it the same way. The core loads every module in parallel in no fixed
  // order, so if mc.js has not registered yet we fetch it on demand.
  let kitPromise = null;
  function getKit() {
    if (QG.util._mcKit) return Promise.resolve(QG.util._mcKit);
    if (!kitPromise) {
      kitPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/games/mc.js';
        s.onload  = () => QG.util._mcKit ? resolve(QG.util._mcKit) : reject(new Error('mc kit missing'));
        s.onerror = () => reject(new Error('could not load /games/mc.js'));
        document.head.appendChild(s);
      });
    }
    return kitPromise;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Web Audio helpers
  // ═══════════════════════════════════════════════════════════════════════════

  // A4 (MIDI 69) = 440 Hz; every semitone is a factor of 2^(1/12).
  const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);

  // One AudioContext shared by every tune question on this page (mount/result/
  // reveal all reuse it). Created lazily — building it before any user gesture
  // is fine, it just starts life "suspended" until resumed.
  let sharedCtx = null;
  function getCtx() {
    if (!sharedCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;                       // very old browser: no Web Audio at all
      sharedCtx = new AC();
    }
    return sharedCtx;
  }

  // Builds a playback session: schedules one oscillator per note (skipping
  // rests) starting a fraction of a second from now, and calls onNote(i, atMs)
  // / onNoteEnd(i, atMs) so the caller can drive a visualiser. `gainScale`
  // trims the peak volume (used to play the reveal quietly on the TV).
  // Returns { totalMs, stop() }.
  function schedule(ctx, notes, bpm, wave, gainScale, onNoteStart, onNoteEnd) {
    const spb   = 60 / bpm;                         // seconds per beat
    const lead  = 0.08;                              // small lead-in so note 1 is never clipped
    const start = ctx.currentTime + lead;
    const peak  = 0.22 * (gainScale == null ? 1 : gainScale);   // square waves are loud — keep it gentle
    const nodes = [];
    const timers = [];
    let t = 0;                                        // running offset in seconds from `start`

    notes.forEach((note, i) => {
      const midi  = Array.isArray(note) ? note[0] : 0;
      const beats = Array.isArray(note) ? note[1] : 1;
      const dur   = Math.max(0, beats) * spb;
      if (midi > 0) {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = wave || 'square';
        osc.frequency.value = midiToHz(midi);
        const at = start + t;
        // Short attack/release envelope — without it every note clicks audibly.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
        gain.gain.setValueAtTime(peak, at + Math.max(0.02, dur * 0.75));
        gain.gain.exponentialRampToValueAtTime(0.0001, at + dur * 0.95);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + dur);
        nodes.push(osc);
      }
      // Visualiser timing is cosmetic only, so plain setTimeout (ms from now) is fine here.
      if (onNoteStart) timers.push(setTimeout(() => onNoteStart(i), Math.max(0, t * 1000)));
      if (onNoteEnd)   timers.push(setTimeout(() => onNoteEnd(i), Math.max(0, (t + dur) * 1000)));
      t += dur;                                        // rests (midi 0) just advance the clock
    });

    return {
      totalMs: t * 1000 + lead * 1000,
      stop() {
        nodes.forEach(o => { try { o.stop(); } catch (e) { /* already stopped */ } });
        timers.forEach(clearTimeout);
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Note visualiser — a row of bars, one per note, sized by pitch and lit up
  // as the melody plays. Purely decorative.
  // ═══════════════════════════════════════════════════════════════════════════
  function buildVisualizer(notes) {
    const vis = document.createElement('div');
    vis.className = 'tune-vis';
    const pitched = notes.map(n => (Array.isArray(n) ? n[0] : 0)).filter(m => m > 0);
    const lo = pitched.length ? Math.min(...pitched) : 48;
    const hi = pitched.length ? Math.max(...pitched) : 72;
    const span = Math.max(1, hi - lo);
    const bars = notes.map(n => {
      const midi = Array.isArray(n) ? n[0] : 0;
      const bar = document.createElement('span');
      bar.className = 'tune-bar' + (midi > 0 ? '' : ' is-rest');
      const pct = midi > 0 ? 20 + Math.round(((midi - lo) / span) * 78) : 10;
      bar.style.setProperty('--h', pct + '%');
      vis.appendChild(bar);
      return bar;
    });
    return { el: vis, bars };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // "Listen" panel: visualiser + Play/Replay button, shared by mount() for
  // both the player view and the passive TV-host view.
  // cfg = { notes, bpm, wave, gainScale, onSubmitStop:fn (called just before
  //         audio is stopped for a submit, or null) }
  // Returns { el, play(), stopAndFreeze() }.
  // ═══════════════════════════════════════════════════════════════════════════
  function buildListenPanel(cfg) {
    const { notes, bpm, wave, gainScale } = cfg;
    const panel = document.createElement('div');
    panel.className = 'tune-panel';

    const { el: visEl, bars } = buildVisualizer(notes);
    panel.appendChild(visEl);

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'btn btn-primary tune-play-btn';
    playBtn.textContent = '▶ Play';
    panel.appendChild(playBtn);

    const hint = document.createElement('p');
    hint.className = 'tune-hint';
    hint.textContent = '';
    panel.appendChild(hint);

    let session = null;
    let ctx = null;

    function clearBars() { bars.forEach(b => b.classList.remove('is-active')); }

    function play() {
      if (session) return false;                    // already playing — Replay is disabled meanwhile
      try {
        ctx = getCtx();
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      } catch (e) { ctx = null; }
      if (!ctx || ctx.state !== 'running') {
        hint.textContent = 'Tap ▶ Play to hear it';
        return false;
      }
      hint.textContent = '';
      playBtn.disabled = true;
      playBtn.textContent = '♪ Playing…';
      clearBars();
      session = schedule(ctx, notes, bpm, wave, gainScale,
        i => { const b = bars[i]; if (b) b.classList.add('is-active'); },
        i => { const b = bars[i]; if (b) b.classList.remove('is-active'); });
      setTimeout(() => {
        if (!session) return;                        // already stopped (submit or destroy)
        session = null;
        playBtn.disabled = false;
        playBtn.textContent = '↻ Replay';
      }, session.totalMs);
      return true;
    }

    function stop() {
      if (session) { session.stop(); session = null; }
      clearBars();
    }

    // Called once the player has locked in an answer: stop audio, freeze the button.
    function stopAndFreeze() {
      stop();
      playBtn.disabled = true;
      playBtn.textContent = '⏹ Locked in';
      hint.textContent = '';
    }

    playBtn.addEventListener('click', () => { snd(cfg.api, 'click'); play(); });

    return { el: panel, play, stop, stopAndFreeze };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE: tune
  // ═══════════════════════════════════════════════════════════════════════════
  QG.register({
    type: 'tune',

    mount(container, payload, api) {
      container.innerHTML = '';
      const notes   = payload.notes || [];
      const bpm     = payload.bpm || 120;
      const wave    = payload.wave || 'square';
      const answers = payload.answers || [];
      const isTvHost = api.role === 'host';           // TV device: passive, plays the tune, no buttons

      const listen = buildListenPanel({ notes, bpm, wave, gainScale: 1, api });
      container.appendChild(listen.el);

      let choice = null, destroyed = false, pendingResult = null;
      if (isTvHost) {
        // The TV is the shared speaker for the room — show the four titles as
        // a plain, large list (no buttons; players answer on their phones).
        const list = document.createElement('div');
        list.className = 'tune-host-list' + (api.tvMode ? ' is-tv' : '');
        answers.forEach((text, i) => {
          const row = document.createElement('div');
          row.className = 'tune-host-item';
          row.innerHTML = `<span class="tune-host-letter">${LETTERS[i]}</span><span class="tune-host-text">${esc(text)}</span>`;
          list.appendChild(row);
        });
        container.appendChild(list);
        const hostHint = document.createElement('p');
        hostHint.className = 'mc-host-hint';
        hostHint.textContent = 'Players are listening and choosing on their phones…';
        container.appendChild(hostHint);
      } else {
        // Wrap api.submit so we stop the audio and freeze the play button the
        // instant the player taps an answer — the module contract says the UI
        // must freeze completely once locked in.
        const wrappedApi = Object.assign(Object.create(api), {
          submit(answer) { listen.stopAndFreeze(); api.submit(answer); },
        });
        const choiceHost = document.createElement('div');
        container.appendChild(choiceHost);
        getKit().then(kit => {
          if (destroyed) return;
          choice = kit.buildChoice(choiceHost, answers, wrappedApi);
          if (pendingResult) choice.onResult(pendingResult);
        }).catch(err => {
          choiceHost.innerHTML = `<p class="tune-error">${esc(err.message)}</p>`;
        });
      }

      // Auto-play once on mount (best effort — the browser may still have the
      // AudioContext suspended if no gesture has happened yet on this device;
      // in that case the panel already shows "Tap ▶ Play to hear it").
      listen.play();

      return {
        onResult(data) { if (choice) choice.onResult(data); else pendingResult = data; },
        onTick() { /* nothing time-based to do here */ },
        destroy() {
          destroyed = true;
          listen.stop();
          if (choice) choice.destroy();
        },
      };
    },

    // ── Result screen (player only) ────────────────────────────────────────
    // No replay here on purpose — the result screen is brief and several
    // devices playing at once would overlap into noise.
    result(data) {
      const kit = QG.util._mcKit;
      if (kit) return kit.choiceResult(data);
      // Fallback in the unlikely case mc.js never finished loading.
      return data.isCorrect
        ? { icon: '✓', iconColor: 'var(--correct)', heading: 'Correct!', subtitle: data.yourText ? `You picked “${data.yourText}”` : '' }
        : { icon: '✗', iconColor: 'var(--wrong)', heading: 'Not this time', subtitle: `The answer was “${data.correctText}”` };
    },

    // ── Leaderboard reveal (everyone) ──────────────────────────────────────
    reveal(container, reveal, ctx) {
      container.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.className = 'tune-reveal-wrap';

      // "Hear it again" — now with the title visible, the satisfying payoff.
      const replayRow = document.createElement('div');
      replayRow.className = 'tune-replay-row';
      const replayBtn = document.createElement('button');
      replayBtn.type = 'button';
      replayBtn.className = 'btn tune-replay-btn';
      replayBtn.innerHTML = '▶ Hear it again';
      replayRow.appendChild(replayBtn);
      wrap.appendChild(replayRow);

      const barsHost = document.createElement('div');
      wrap.appendChild(barsHost);
      container.appendChild(wrap);

      let barsHandle = null;
      getKit().then(kit => { if (wrap.isConnected) barsHandle = kit.renderBars(barsHost, reveal, ctx); })
        .catch(err => { barsHost.innerHTML = `<p class="tune-error">${esc(err.message)}</p>`; });

      const notes = reveal.notes || [], bpm = reveal.bpm || 120, wave = reveal.wave || 'square';
      let session = null, ctxA = null;
      function play(gainScale) {
        if (session) return;
        try { ctxA = getCtx(); if (ctxA && ctxA.state === 'suspended') ctxA.resume().catch(() => {}); } catch (e) { ctxA = null; }
        if (!ctxA || ctxA.state !== 'running') return;
        replayBtn.disabled = true;
        session = schedule(ctxA, notes, bpm, wave, gainScale, null, null);
        setTimeout(() => { session = null; replayBtn.disabled = false; }, session.totalMs);
      }
      replayBtn.addEventListener('click', () => play(1));

      // On the shared TV screen, play it once automatically and quietly as the
      // leaderboard animates in. On a player's own phone, require a tap so the
      // room does not turn into a canon of eight overlapping phones.
      const isTvScreen = document.body.classList.contains('tv');
      let autoPlayTimer = null;
      if (isTvScreen) autoPlayTimer = setTimeout(() => { autoPlayTimer = null; play(0.55); }, 350);

      return {
        destroy() {
          // Cancel the pending auto-play if this reveal is torn down (e.g. a
          // rematch starts a new game) before the 350 ms timer has fired —
          // otherwise play() would fire later against this closure's stale
          // `notes`/`bpm`, after `wrap` has already been removed below.
          if (autoPlayTimer) { clearTimeout(autoPlayTimer); autoPlayTimer = null; }
          if (session) { session.stop(); session = null; }
          if (barsHandle && barsHandle.destroy) barsHandle.destroy();
          wrap.remove();
        },
      };
    },

    metric(detail) {
      const kit = QG.util._mcKit;
      if (kit) return kit.choiceMetric(detail);
      return detail ? (detail.isCorrect ? '✓ Correct' : `✗ ${detail.answerText || ''}`) : '';
    },
  });
})();
