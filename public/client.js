// ═════════════════════════════════════════════════════════════════════════════
// client.js — the core browser client of QuizBlast v2.
//
// What lives here (in this order):
//   1. window.QuizGames   — the tiny "plugin system" game modules register with,
//                           plus shared utilities (formatting, colours, map tiles)
//   2. Sound engine       — Web Audio synth, no audio files
//   3. State + DOM helpers, screen switching, toasts
//   4. Module loader      — fetches /api/games, injects /core/geo.js and /games/<type>.js
//   5. Host config screen — generated from the catalogue
//   6. Lobbies + join
//   7. Timer ring
//   8. Question flow      — intro → question → result
//   9. Leaderboard        — reveal, rows, FLIP re-sort, countdown
//  10. Game over          — podium, confetti, awards, standings, rematch
//  11. Socket events + boot (reconnect with a saved token)
//
// The answer UI for each game type is NOT here — see /games/<type>.js.
// Contract between this file and those modules: docs/ARCHITECTURE.md §5.
// ═════════════════════════════════════════════════════════════════════════════

'use strict';

// ═════════════════════════════════════════════════════════════════════════════
// 1. QuizGames — module registry + shared utilities
// ═════════════════════════════════════════════════════════════════════════════

// A dozen distinct colours that sit well on parchment and on ink.
// None of them may be gold: every reveal draws the CORRECT answer in
// var(--gold) (#c8922a), so a player wearing that colour would be
// indistinguishable from the truth on the map / curve / axis reveals.
// (The 4th entry used to be exactly #c8922a — that is why it is a plum now.)
const PLAYER_COLORS = [
  '#b8402f', '#1e5aa8', '#2a8a5a', '#8f4a6b', '#7a3fa0', '#d0642a',
  '#1f8a98', '#a8286e', '#5a7a2a', '#8a5a2a', '#3a4fb8', '#c23a5a',
];

// Optional CARTO basemap API key. Leave '' to use the keyless Esri fallback —
// see QuizGames.util.tiles.streets() below for what changes.
const CARTO_KEY = '';

// Every player gets a stable colour index the first time we see their name.
const playerIndexByName = new Map();
function playerIndex(nickname) {
  if (!playerIndexByName.has(nickname)) playerIndexByName.set(nickname, playerIndexByName.size);
  return playerIndexByName.get(nickname);
}

window.QuizGames = {
  modules: {},                                   // type → module object
  catalog: null,                                 // result of GET /api/games (cached)
  register(mod) { this.modules[mod.type] = mod; },
  get(type)     { return this.modules[type] || null; },

  util: {
    // Turn user text into something safe to drop into innerHTML.
    escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    // -323 → "323 BCE", 800 → "800 CE", 1969 → "1969"
    formatYear(y) {
      const n = Math.round(y);
      if (n < 0)    return `${Math.abs(n)} BCE`;
      if (n < 1000) return `${n} CE`;
      return String(n);
    },
    // 1 → "1st", 2 → "2nd", 11 → "11th"
    ordinal(n) {
      const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    },
    // 1234 → "1,234 km"
    fmtNum(n, unit) {
      const str = Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
      return unit ? `${str} ${unit}` : str;
    },
    haversineKm(lat1, lng1, lat2, lng2) {
      const R = 6371, toRad = d => d * Math.PI / 180;
      const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    },
    // Run `fn` on the next animation frame. Browsers STOP calling requestAnimationFrame
    // whenever the page is not being painted — a background tab, a phone with the screen
    // off, a window hidden behind another one. Anything built inside a plain rAF callback
    // would then never appear (the question UI, the leaderboard reveal…), so we race the
    // frame against a short timer and take whichever comes first.
    // Returns a function that cancels the pending call.
    nextFrame(fn) {
      let done = false;
      const run = () => { if (done) return; done = true; clearTimeout(timeoutId); cancelAnimationFrame(rafId); fn(); };
      const timeoutId = setTimeout(run, 32);         // safety net: fires even when rAF is asleep
      const rafId     = requestAnimationFrame(run);  // normal case: the very next painted frame
      return () => { done = true; clearTimeout(timeoutId); cancelAnimationFrame(rafId); };
    },
    colorFor(i) { return PLAYER_COLORS[Math.abs(i | 0) % PLAYER_COLORS.length]; },
    colorForName(nickname) { return PLAYER_COLORS[playerIndex(nickname) % PLAYER_COLORS.length]; },
    playerInitial(nickname) {
      const s = String(nickname || '').trim();
      // Keep an emoji intact if the nickname starts with one
      const first = s.match(/^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*|.)/u);
      return first ? first[0].toUpperCase() : '?';
    },
    tiles: {
      // Label-free world map for the pin-drop questions. Labels would give the
      // answer away, so we can only use "no labels" basemaps.
      //
      // CARTO (the basemap v1 used) now stamps "API KEY REQUIRED" across every
      // tile that is requested without a key, so it is only used when the app
      // owner puts a key in CARTO_KEY below (get one free at carto.com). Without
      // a key we fall back to Esri's World Physical Map: no labels, no key, and
      // its warm terrain colours suit the parchment theme. It only has real
      // tiles up to zoom 8, so `maxNativeZoom` tells Leaflet to stretch the z8
      // tiles for closer zooms instead of showing empty squares.
      //
      // Tried and REJECTED (2026-09-04) — do not switch to these:
      //   Canvas/World_Light_Gray_Base   has borders, but its tiles are printed
      //     WITH country and ocean names ("FRANCE", "Atlantic Ocean"), which
      //     hands the player the answer to every pin-drop question.
      //   World_Terrain_Base             label-free, but no borders at all and
      //     its bright cyan sea clashes with the parchment theme.
      // A keyless, label-free basemap that still shows borders does not seem to
      // exist; a CARTO key stays the only way to get one back.
      streets() {
        if (CARTO_KEY) {
          return L.tileLayer(`https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png?api_key=${encodeURIComponent(CARTO_KEY)}`, {
            attribution: '© OpenStreetMap © CARTO', maxZoom: 19,
          });
        }
        return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/{z}/{y}/{x}', {
          attribution: '© Esri', maxZoom: 19, maxNativeZoom: 8,
        });
      },
      satellite() {
        return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          attribution: '© Esri', maxZoom: 19,
        });
      },
    },
  },

  sound: null,   // filled in below
};

// ═════════════════════════════════════════════════════════════════════════════
// 2. Sound engine — small synthesised cues via the Web Audio API
//    Browsers only allow audio after a user gesture, so the AudioContext is
//    created lazily on first use and resumed on the first tap/click.
// ═════════════════════════════════════════════════════════════════════════════
const Sound = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('qb_muted') === '1'; } catch (e) { /* private mode */ }

  function audio() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // One tone. `offset` schedules it into the future (seconds).
  function note(freq, dur, type = 'sine', vol = 0.22, offset = 0) {
    if (muted) return;
    try {
      const c = audio(), osc = c.createOscillator(), gain = c.createGain();
      osc.connect(gain); gain.connect(c.destination);
      osc.type = type; osc.frequency.value = freq;
      const t = c.currentTime + offset;
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.start(t); osc.stop(t + dur + 0.02);
    } catch (e) { /* no audio available */ }
  }

  // A short burst of filtered noise with a sweeping filter — the "whoosh".
  function whoosh() {
    if (muted) return;
    try {
      const c = audio(), len = 0.35, buf = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = c.createBufferSource(); src.buffer = buf;
      const filt = c.createBiquadFilter(); filt.type = 'bandpass'; filt.Q.value = 1.2;
      const gain = c.createGain();
      const t = c.currentTime;
      filt.frequency.setValueAtTime(400, t);
      filt.frequency.exponentialRampToValueAtTime(3200, t + len);
      gain.gain.setValueAtTime(0.18, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + len);
      src.connect(filt); filt.connect(gain); gain.connect(c.destination);
      src.start(t); src.stop(t + len);
    } catch (e) { /* ignore */ }
  }

  const api = {
    get muted() { return muted; },
    setMuted(v) {
      muted = !!v;
      try { localStorage.setItem('qb_muted', muted ? '1' : '0'); } catch (e) { /* ignore */ }
      document.querySelectorAll('.mute-btn').forEach(b => { b.textContent = muted ? '🔇' : '🔊'; b.classList.toggle('is-muted', muted); });
    },
    unlock() { try { audio(); } catch (e) { /* ignore */ } },
    correct()  { note(523, 0.13); note(659, 0.13, 'sine', 0.22, 0.13); note(784, 0.28, 'sine', 0.22, 0.26); },
    wrong()    { note(260, 0.12, 'sawtooth', 0.16); note(190, 0.28, 'sawtooth', 0.16, 0.12); },
    tick()     { note(880, 0.04, 'square', 0.06); },
    click()    { note(1200, 0.03, 'sine', 0.08); },
    lock()     { note(660, 0.06, 'triangle', 0.16); note(990, 0.12, 'triangle', 0.16, 0.07); },
    whoosh,
    question() { note(440, 0.09); note(554, 0.14, 'sine', 0.2, 0.1); },
    fanfare()  { note(392, 0.1, 'sine', 0.18); note(523, 0.1, 'sine', 0.18, 0.12); note(659, 0.22, 'sine', 0.22, 0.24); },
    gameOver() { note(523, 0.1, 'sine', 0.2); note(659, 0.1, 'sine', 0.2, 0.12); note(784, 0.1, 'sine', 0.2, 0.24); note(1047, 0.4, 'sine', 0.25, 0.36); },
  };
  return api;
})();
QuizGames.sound = Sound;

// First user gesture unlocks audio (browsers require this)
['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, () => { Sound.unlock(); window.__qbTapped = true; }, { once: true, passive: true }));

// ═════════════════════════════════════════════════════════════════════════════
// 3. State, DOM helpers, screens, toasts
// ═════════════════════════════════════════════════════════════════════════════
const socket = io();
const $  = id => document.getElementById(id);
const esc = QuizGames.util.escapeHtml;
// Frame scheduler that keeps working when the tab is hidden (see util.nextFrame).
const nextFrame = fn => QuizGames.util.nextFrame(fn);
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  amHost: false,          // this browser created the game
  gameMode: 'mobile',     // 'mobile' | 'tv'
  autoplay: true,
  finalDouble: null,      // only the host knows this for sure (from its config)
  gameId: null,
  myNickname: null,
  totalQuestions: 0,
  lobbyPlayers: [],
  paused: false,
  myStreak: 0,            // from the last leaderboard I saw
  // per-question
  question: null,         // last new-question payload
  handle: null,           // module handle from mount()
  api: null,              // api object given to the module
  revealHandle: null,
  lbLoad: null,           // token identifying the newest leaderboard (see showLeaderboard)
  resultTimeout: null,
  flipTimeout: null,
  lbCountdown: null,      // interval for the autoplay countdown
  lbEndAt: 0,
  lbRemainingMs: 0,
  lbTotalMs: 0,           // full length of the current leaderboard pause (for the drain bar)
  lbIsLast: false,
};

// Am I the "host" role (TV-mode host who watches) or a "player"?
function myRole() { return (state.amHost && state.gameMode === 'tv') ? 'host' : 'player'; }
function isTv()   { return state.amHost && state.gameMode === 'tv'; }

function speedScored(type) {
  const t = QuizGames.catalog && QuizGames.catalog.types.find(x => x.type === type);
  return !!(t && t.speedScored);
}

// ── Screen switching (240 ms crossfade) ──────────────────────────────────────
let currentScreen = 'screen-home';
function showScreen(id) {
  if (currentScreen === id) return;
  const prev = $(currentScreen), next = $(id);
  currentScreen = id;
  document.body.className = document.body.className.replace(/\bscreen-\S+/g, '').trim();
  document.body.classList.add(id);
  if (prev) { prev.classList.remove('active', 'entering'); }
  next.classList.add('active', 'entering');
  next.addEventListener('animationend', () => next.classList.remove('entering'), { once: true });
  window.scrollTo({ top: 0 });
  closeHostMenu();
}

// ── Toasts ───────────────────────────────────────────────────────────────────
function toast(msg, opts = {}) {
  const root = $('toast-root');
  const el = document.createElement('div');
  el.className = 'toast' + (opts.kind ? ` toast-${opts.kind}` : '');
  el.textContent = msg;
  root.appendChild(el);
  nextFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, opts.ms || 2600);
}

function showError(id, msg) { const el = $(id); el.textContent = msg; el.classList.remove('hidden'); }
function clearError(id)     { $(id).classList.add('hidden'); }

function avatarHtml(nickname, cls = '') {
  return `<span class="avatar ${cls}" style="background:${QuizGames.util.colorForName(nickname)}">${esc(QuizGames.util.playerInitial(nickname))}</span>`;
}
function setAvatar(el, nickname) {
  el.textContent = nickname ? QuizGames.util.playerInitial(nickname) : '?';
  el.style.background = nickname ? QuizGames.util.colorForName(nickname) : '';
}

// Counts a number up (or down) inside an element with an ease-out curve.
function animateCount(el, from, to, duration = 700) {
  if (REDUCED_MOTION) { el.textContent = Math.round(to).toLocaleString('en-US'); return; }
  const start = performance.now(), delta = to - from;
  let finished = false;
  (function tick(now) {
    if (finished) return;
    const p = Math.min((now - start) / duration, 1), eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + eased * delta).toLocaleString('en-US');
    if (p < 1) requestAnimationFrame(tick); else finished = true;
  })(start);
  // If the page is not painting, the loop above never runs — make sure the final
  // number still lands instead of leaving the old score on screen.
  setTimeout(() => { if (!finished) { finished = true; el.textContent = Math.round(to).toLocaleString('en-US'); } }, duration + 250);
}

// Short buzz on a phone. Browsers refuse (and log an error) before the first tap,
// so we only ask once the player has actually touched the page.
function vibrate(pattern) {
  if (!window.__qbTapped) return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* ignore */ }
}

// The reconnect token, plus the game it belongs to. The game id is what lets
// boot() tell "this player reloaded the page they are already playing on" from
// "this player opened a join link for a different game".
function saveToken(token) {
  try {
    localStorage.setItem('qb_token', token);
    if (state.gameId) localStorage.setItem('qb_game', state.gameId);
  } catch (e) { /* ignore */ }
}
function clearToken()     { try { localStorage.removeItem('qb_token'); localStorage.removeItem('qb_game'); } catch (e) { /* ignore */ } }
function loadToken()      { try { return localStorage.getItem('qb_token'); } catch (e) { return null; } }
function loadGameId()     { try { return localStorage.getItem('qb_game'); } catch (e) { return null; } }

// ═════════════════════════════════════════════════════════════════════════════
// 4. Module loader — /api/games tells us which game types exist; we then inject
//    <script src="/games/<type>.js"> (and its .css) so they register themselves.
// ═════════════════════════════════════════════════════════════════════════════
let catalogPromise = null;
let modulesReady   = null;

function loadCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch('/api/games').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(cat => { QuizGames.catalog = cat; return cat; });
  }
  return catalogPromise;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = false;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}
function loadStyle(href) {
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);   // a missing .css is fine — the 404 is silent
}

function loadModules() {
  if (!modulesReady) {
    modulesReady = loadCatalog().then(async cat => {
      await loadScript('/core/geo.js').catch(e => console.warn(e.message));
      // Only types that actually have questions can show up in a game — skipping
      // the empty ones avoids 404s for game types whose browser module is not written yet.
      const withQuestions = new Set(cat.categories.filter(c => c.count > 0).map(c => c.type));
      const types = cat.types.map(t => t.type).filter(t => withQuestions.has(t));
      await Promise.all(types.map(async type => {
        loadStyle(`/games/${type}.css`);
        await loadScript(`/games/${type}.js`).catch(e => console.warn(e.message));
      }));
      return cat;
    });
  }
  return modulesReady;
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. Host config screen — built from the catalogue, remembered in localStorage
// ═════════════════════════════════════════════════════════════════════════════
const config = {
  categories: null,     // null = "all with questions" (first run)
  regions: null,        // null = worldwide
  difficulty: 'mixed',
  rounds: '10',
  autoplay: true,
  intros: true,
  finalDouble: true,
  gameMode: 'mobile',
};
let configBuilt = false;

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('qb_config') || 'null');
    if (saved && typeof saved === 'object') Object.assign(config, saved);
  } catch (e) { /* ignore */ }
}
function saveConfig() {
  readConfigFromUI();
  try { localStorage.setItem('qb_config', JSON.stringify(config)); } catch (e) { /* ignore */ }
}

function readConfigFromUI() {
  config.categories = [...document.querySelectorAll('#config-groups input[type=checkbox]:checked')].map(cb => cb.value);
  const regions = [...document.querySelectorAll('#region-row .chip.active[data-region]')].map(c => c.dataset.region);
  config.regions = regions.length ? regions : null;
  const activeValue = (sel, fallback) => { const el = document.querySelector(sel); return el ? el.dataset.value : fallback; };
  config.difficulty  = activeValue('#difficulty-seg .active', 'mixed');
  config.rounds      = activeValue('#rounds-row .active', '10');
  config.gameMode    = activeValue('#mode-grid .active', 'mobile');
  config.autoplay    = $('opt-autoplay').checked;
  config.intros      = $('opt-intros').checked;
  config.finalDouble = $('opt-final-double').checked;
}

function buildConfigScreen(cat) {
  if (configBuilt) return;
  configBuilt = true;
  const u = QuizGames.util;

  // Presets
  $('preset-row').innerHTML = cat.presets.map(p =>
    `<button type="button" class="preset" data-preset="${esc(p.id)}" title="${esc(p.blurb || '')}">
       <span class="preset-emoji">${p.emoji || '✨'}</span><span class="preset-label">${esc(p.label)}</span>
     </button>`).join('');
  $('preset-row').addEventListener('click', e => {
    const btn = e.target.closest('.preset'); if (!btn) return;
    const preset = cat.presets.find(p => p.id === btn.dataset.preset); if (!preset) return;
    document.querySelectorAll('#config-groups input[type=checkbox]').forEach(cb => {
      cb.checked = !cb.disabled && preset.categories.includes(cb.value);
    });
    Sound.click(); refreshCategoryCards(); saveConfig();
  });

  // Groups + category cards
  $('config-groups').innerHTML = cat.groups.map(g => {
    const cats = cat.categories.filter(c => c.group === g.id);
    if (!cats.length) return '';
    return `
      <div class="group" data-group="${esc(g.id)}">
        <div class="group-head">
          <div class="group-title"><span class="group-emoji">${g.emoji || ''}</span><h3>${esc(g.label)}</h3><span class="group-blurb">${esc(g.blurb || '')}</span></div>
          <div class="group-links"><button type="button" class="btn-link" data-all="1">all</button><span>·</span><button type="button" class="btn-link" data-none="1">none</button></div>
        </div>
        <div class="cat-grid">
          ${cats.map(c => `
            <label class="cat-card ${c.count ? '' : 'disabled'}" data-cat="${esc(c.id)}" data-type="${esc(c.type)}"
                   ${c.count ? '' : 'title="No questions for this category yet."'}>
              <input type="checkbox" value="${esc(c.id)}" ${c.count ? '' : 'disabled'}>
              <span class="cat-emoji">${c.emoji || '❔'}</span>
              <span class="cat-main">
                <span class="cat-label">${esc(c.label)}</span>
                <span class="cat-blurb">${esc(c.blurb || '')}</span>
                <span class="cat-note"></span>
              </span>
              <span class="cat-side">
                <span class="cat-count">${c.count ? c.count : 'soon'}</span>
                <span class="cat-check" aria-hidden="true">✓</span>
              </span>
            </label>`).join('')}
        </div>
      </div>`;
  }).join('');

  $('config-groups').addEventListener('click', e => {
    const link = e.target.closest('.btn-link');
    if (link) {
      const group = link.closest('.group');
      group.querySelectorAll('input[type=checkbox]:not(:disabled)').forEach(cb => { cb.checked = !!link.dataset.all; });
      Sound.click(); refreshCategoryCards(); saveConfig();
    }
  });
  $('config-groups').addEventListener('change', () => { Sound.click(); refreshCategoryCards(); saveConfig(); });

  // Regions
  $('region-row').innerHTML =
    `<button type="button" class="chip active" data-world="1">🌍 Worldwide</button>` +
    cat.regions.map(r => `<button type="button" class="chip" data-region="${esc(r.id)}">${r.emoji || ''} ${esc(r.label)}</button>`).join('');
  $('region-row').addEventListener('click', e => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    const chips = [...$('region-row').querySelectorAll('.chip')];
    if (chip.dataset.world) { chips.forEach(c => c.classList.toggle('active', !!c.dataset.world)); }
    else {
      chip.classList.toggle('active');
      const any = chips.some(c => c.dataset.region && c.classList.contains('active'));
      chips[0].classList.toggle('active', !any);
    }
    Sound.click(); saveConfig();
  });

  // Segmented / pill / mode selectors share one behaviour: one active button
  ['difficulty-seg', 'rounds-row', 'mode-grid'].forEach(id => {
    $(id).addEventListener('click', e => {
      const btn = e.target.closest('button[data-value]'); if (!btn) return;
      $(id).querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      Sound.click(); saveConfig();
    });
  });
  ['opt-autoplay', 'opt-intros', 'opt-final-double'].forEach(id => $(id).addEventListener('change', saveConfig));

  applyConfigToUI(cat);
  markUnavailableModules();
  $('config-loading').classList.add('hidden');
  $('config-body').classList.remove('hidden');
  void u; // (util kept for future use)
}

function applyConfigToUI(cat) {
  const cbs = [...document.querySelectorAll('#config-groups input[type=checkbox]')];
  const chosen = Array.isArray(config.categories) ? config.categories : null;
  cbs.forEach(cb => { cb.checked = !cb.disabled && (chosen ? chosen.includes(cb.value) : true); });
  // If a saved config selects nothing that still exists, fall back to "everything"
  if (!cbs.some(cb => cb.checked)) cbs.forEach(cb => { cb.checked = !cb.disabled; });
  refreshCategoryCards();

  const chips = [...$('region-row').querySelectorAll('.chip')];
  const regions = Array.isArray(config.regions) ? config.regions : [];
  chips.forEach(c => c.classList.toggle('active', c.dataset.world ? !regions.length : regions.includes(c.dataset.region)));

  const pick = (id, value) => $(id).querySelectorAll('button[data-value]').forEach(b => b.classList.toggle('active', b.dataset.value === String(value)));
  pick('difficulty-seg', ['mixed', 'casual', 'expert'].includes(config.difficulty) ? config.difficulty : 'mixed');
  pick('rounds-row', config.rounds || '10');
  pick('mode-grid', config.gameMode === 'tv' ? 'tv' : 'mobile');
  $('opt-autoplay').checked = config.autoplay !== false;
  $('opt-intros').checked = config.intros !== false;
  $('opt-final-double').checked = config.finalDouble !== false;
  void cat;
}

function refreshCategoryCards() {
  const cat = QuizGames.catalog;
  let picked = 0, questions = 0;
  document.querySelectorAll('#config-groups .cat-card').forEach(card => {
    const cb = card.querySelector('input');
    card.classList.toggle('checked', cb.checked);
    if (!cb.checked) return;
    picked++;
    const c = cat && cat.categories.find(x => x.id === cb.value);
    questions += (c && c.count) || 0;
  });
  // Live recap under the category list ("6 games · 512 questions in the pot")
  const tally = $('config-tally');
  if (tally) {
    tally.textContent = picked
      ? `${picked} game${picked === 1 ? '' : 's'} · ${questions.toLocaleString('en-US')} questions in the pot`
      : 'Pick at least one game to start.';
    tally.classList.toggle('empty', !picked);
  }
}

// A game type can only be played if its browser module actually loaded. If a
// /games/<type>.js is missing or throws, the module never registers — so grey
// those categories out here instead of letting the host pick a game that would
// show "not available in your browser" mid-round.
function markUnavailableModules() {
  loadModules().catch(() => {}).then(() => {
    let blocked = 0;
    document.querySelectorAll('#config-groups .cat-card[data-type]').forEach(card => {
      const cb = card.querySelector('input');
      if (!cb || cb.disabled) return;                 // already off (no questions yet)
      if (QuizGames.get(card.dataset.type)) return;   // module is there — nothing to do
      blocked++;
      cb.checked = false;
      cb.disabled = true;
      card.classList.add('disabled', 'unavailable');
      card.title = 'This game needs a browser module that could not be loaded.';
      const note = card.querySelector('.cat-note');
      if (note) note.textContent = 'Unavailable in this browser';
      const count = card.querySelector('.cat-count');
      if (count) count.textContent = 'n/a';
    });
    if (blocked) { refreshCategoryCards(); saveConfig(); }
  });
}

function openConfig() {
  showScreen('screen-config');
  clearError('config-error');
  loadCatalog().then(buildConfigScreen).catch(() => {
    $('config-loading').textContent = 'Could not load the game catalogue. Is the server running?';
  });
  loadModules();   // start fetching game modules early so the first question is instant
}

function createGame() {
  clearError('config-error');
  saveConfig();
  if (!config.categories || !config.categories.length) return showError('config-error', 'Pick at least one category.');
  state.finalDouble = config.finalDouble;
  const testIds = new URLSearchParams(location.search).get('testIds') || undefined;
  socket.emit('create-game', {
    rounds: config.rounds, categories: config.categories, regions: config.regions,
    difficulty: config.difficulty, autoplay: config.autoplay, gameMode: config.gameMode,
    finalDouble: config.finalDouble, intros: config.intros, testIds,
  });
}

function settingsSummary() {
  const cat = QuizGames.catalog;
  const parts = [];
  parts.push(config.rounds === 'infinite' ? 'Endless rounds' : `${state.totalQuestions || config.rounds} rounds`);
  if (config.categories) parts.push(`${config.categories.length} categor${config.categories.length === 1 ? 'y' : 'ies'}`);
  if (config.regions && cat) parts.push(config.regions.map(r => (cat.regions.find(x => x.id === r) || {}).label || r).join(' + '));
  else parts.push('Worldwide');
  parts.push(config.difficulty === 'mixed' ? 'Mixed difficulty' : config.difficulty[0].toUpperCase() + config.difficulty.slice(1));
  parts.push(state.autoplay ? 'Autoplay' : 'Manual advance');
  if (config.finalDouble) parts.push('Final ×2');
  parts.push(state.gameMode === 'tv' ? 'TV mode' : 'Mobile mode');
  return parts.join(' · ');
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. Lobbies and joining
// ═════════════════════════════════════════════════════════════════════════════
function renderPlayerChips(container, players, { kickable = false } = {}) {
  container.innerHTML = players.map(p => `
    <span class="pchip ${p.connected === false ? 'offline' : ''} ${p.nickname === state.myNickname ? 'me' : ''}" data-nick="${esc(p.nickname)}">
      ${avatarHtml(p.nickname)}
      <span class="pchip-name">${esc(p.nickname)}</span>
      <span class="conn-dot" title="${p.connected === false ? 'offline' : 'online'}"></span>
      ${kickable ? `<button type="button" class="pchip-kick" aria-label="Remove ${esc(p.nickname)}" data-kick="${esc(p.nickname)}">×</button>` : ''}
    </span>`).join('');
}

function showHostLobby() {
  $('host-game-code').textContent = state.gameId;
  const link = `${location.origin}/?join=${state.gameId}`;
  $('host-join-link').textContent = link.replace(/^https?:\/\//, '');
  $('host-qr').src = `/qr/${state.gameId}`;
  $('host-qr').hidden = false;
  $('settings-summary').textContent = settingsSummary();
  const needsNick = state.gameMode === 'mobile' && !state.myNickname;
  $('host-nickname-section').classList.toggle('hidden', !needsNick);
  $('btn-start').textContent = needsNick ? '▶ Join & start' : '▶ Start game';
  clearError('start-error');
  renderLobbyPlayers();
  showScreen('screen-host-lobby');
}

function renderLobbyPlayers() {
  const players = state.lobbyPlayers;
  if (state.amHost) {
    $('host-player-count').textContent = players.length;
    renderPlayerChips($('host-player-chips'), players, { kickable: true });
    $('host-empty-hint').classList.toggle('hidden', players.length > 0);
  }
  renderPlayerChips($('player-lobby-chips'), players);
  const count = $('player-lobby-count');
  if (count) count.textContent = players.length === 1 ? '1 player in the lobby' : `${players.length} players in the lobby`;
}

function showPlayerLobby() {
  $('player-lobby-nick').textContent = state.myNickname;
  $('player-lobby-code').textContent = state.gameId;
  setAvatar($('player-lobby-avatar'), state.myNickname);
  renderLobbyPlayers();
  showScreen('screen-player-lobby');
}

function startGame() {
  clearError('start-error');
  if (state.gameMode === 'mobile' && !state.myNickname) {
    const nick = $('host-nickname-input').value.trim();
    if (!nick) return showError('start-error', 'Enter your nickname to join the game.');
    state.pendingHostNick = nick;
    socket.emit('start-game', { hostNickname: nick });
  } else {
    socket.emit('start-game', {});
  }
}

function joinGame() {
  clearError('join-error');
  const gameId = $('join-code').value.trim().toUpperCase();
  const nickname = $('join-nickname').value.trim();
  if (gameId.length !== 6) return showError('join-error', 'The game code has 6 characters.');
  if (!nickname) return showError('join-error', 'Please enter a nickname.');
  socket.emit('join-game', { gameId, nickname });
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. Timer ring — an SVG circle whose dash offset follows the remaining time.
//    We keep the absolute end time and read the clock every frame, so pausing
//    is just "stop reading the clock and remember what was left".
// ═════════════════════════════════════════════════════════════════════════════
const RING_C = 2 * Math.PI * 20;   // circumference of the r=20 circle
const timer = { endAt: 0, totalMs: 1, raf: null, timeout: null, remainingMs: 0, lastSec: null, running: false, tickListeners: [] };

function timerPaint(remainingMs) {
  const frac = Math.max(0, Math.min(1, remainingMs / timer.totalMs));
  $('timer-ring-fill').style.strokeDashoffset = String(RING_C * (1 - frac));
  const ring = $('timer-ring');
  ring.classList.toggle('warn', frac <= 0.5 && frac > 0.25);
  ring.classList.toggle('danger', frac <= 0.25);
}

function timerFrame() {
  if (!timer.running) return;
  const remaining = Math.max(0, timer.endAt - Date.now());
  timer.remainingMs = remaining;
  timerPaint(remaining);
  const sec = Math.ceil(remaining / 1000);
  if (sec !== timer.lastSec) {
    timer.lastSec = sec;
    $('timer-text').textContent = sec;
    $('timer-ring').classList.toggle('urgent', sec <= 5 && sec > 0);
    if (sec <= 5 && sec > 0) Sound.tick();
    for (const fn of timer.tickListeners) { try { fn(sec); } catch (e) { console.warn(e); } }
    if (state.handle && typeof state.handle.onTick === 'function') { try { state.handle.onTick(sec); } catch (e) { console.warn(e); } }
  }
  if (remaining > 0) scheduleTimerFrame();
  else timer.running = false;
}

// Ask for the next tick twice: once as an animation frame (smooth) and once as a
// timer (still fires when the page is not painting — background tab, screen off).
// Whichever arrives first re-enters timerFrame, which cancels the other.
function scheduleTimerFrame() {
  clearTimerHandles();
  timer.raf     = requestAnimationFrame(timerFrame);
  timer.timeout = setTimeout(timerFrame, 250);
}
function clearTimerHandles() {
  if (timer.raf) cancelAnimationFrame(timer.raf);
  if (timer.timeout) clearTimeout(timer.timeout);
  timer.raf = null; timer.timeout = null;
}

function startTimer(remainingMs, totalMs) {
  stopTimer();
  timer.totalMs = Math.max(1, totalMs);
  timer.endAt = Date.now() + remainingMs;
  timer.lastSec = null;
  timer.running = true;
  $('timer-ring').classList.remove('paused');
  timerFrame();
}
function pauseTimer(remainingMs) {
  timer.running = false;
  clearTimerHandles();
  timer.remainingMs = remainingMs != null ? remainingMs : Math.max(0, timer.endAt - Date.now());
  timerPaint(timer.remainingMs);
  $('timer-text').textContent = '⏸';
  $('timer-ring').classList.add('paused');
  $('timer-ring').classList.remove('urgent');
}
function resumeTimer(remainingMs) { startTimer(remainingMs != null ? remainingMs : timer.remainingMs, timer.totalMs); }
function stopTimer() {
  timer.running = false;
  clearTimerHandles();
  $('timer-ring').classList.remove('urgent', 'paused');
}
function remainingSeconds() {
  return Math.ceil((timer.running ? Math.max(0, timer.endAt - Date.now()) : timer.remainingMs) / 1000);
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. Question flow — intro splash, question screen, answer result
// ═════════════════════════════════════════════════════════════════════════════
function destroyQuestion() {
  clearTimeout(state.resultTimeout); state.resultTimeout = null;
  if (state.handle && typeof state.handle.destroy === 'function') { try { state.handle.destroy(); } catch (e) { console.warn(e); } }
  state.handle = null;
  timer.tickListeners = [];
  stopTimer();
}
function destroyReveal() {
  // Dropping the token stops a reveal that is still waiting for its module to
  // load from painting itself into a screen that has already moved on.
  state.lbLoad = null;
  if (state.revealHandle && typeof state.revealHandle.destroy === 'function') { try { state.revealHandle.destroy(); } catch (e) { console.warn(e); } }
  state.revealHandle = null;
  $('reveal-area').innerHTML = '';
  $('reveal-area').classList.remove('has-reveal');
}

function showIntro(data) {
  destroyQuestion();
  destroyReveal();
  stopLbCountdown();
  const cat = data.category || {};
  $('intro-emoji').textContent = cat.emoji || '❔';
  $('intro-label').textContent = cat.label || '';
  $('intro-howto').textContent = cat.howTo || '';
  $('intro-round').textContent = `Round ${data.questionNumber} of ${data.totalQuestions}`;
  $('intro-ribbon').classList.toggle('hidden', !data.firstTime);
  const isLast = data.questionNumber === data.totalQuestions;
  $('intro-final').classList.toggle('hidden', !isLast);
  $('intro-final').textContent = state.finalDouble ? 'Final round · ×2 points' : 'Final round';
  // Progress bar: reset to 0 then let CSS animate it to full over durationMs
  const bar = $('intro-progress');
  bar.style.transition = 'none'; bar.style.width = '0%';
  showScreen('screen-intro');
  nextFrame(() => nextFrame(() => {
    bar.style.transition = `width ${Math.max(200, data.durationMs || 1800)}ms linear`;
    bar.style.width = '100%';
  }));
  if (data.firstTime) Sound.whoosh();
}

async function showQuestion(data) {
  destroyQuestion();
  destroyReveal();
  stopLbCountdown();
  state.question = data;
  state.paused = !!data.paused;
  state.pendingAnswer = undefined;
  const cat = data.category || {};
  const payload = data.payload || {};

  // Play bar
  $('play-cat-emoji').textContent = cat.emoji || '❔';
  $('play-cat-label').textContent = cat.label || data.type;
  $('play-round').textContent = `${data.questionNumber} / ${data.totalQuestions}`;
  $('question-final-badge').classList.toggle('hidden', !(data.isLast && data.multiplier === 2));
  $('host-menu').classList.toggle('hidden', !state.amHost);
  updatePauseButtons();

  // Prompt card
  const hasText = typeof payload.question === 'string' && payload.question.trim().length > 0;
  $('question-text').textContent = hasText ? payload.question : '';
  const photo = $('question-photo');
  if (payload.imageUrl) { photo.src = payload.imageUrl; photo.hidden = false; } else { photo.removeAttribute('src'); photo.hidden = true; }
  $('prompt-card').classList.toggle('hidden', !hasText && !payload.imageUrl);

  // Locked banner (only when reconnecting after having answered)
  $('locked-banner').classList.toggle('hidden', !data.answered);
  $('locked-text').textContent = 'Locked in — waiting for others';

  // Host's "N / M answered" line
  $('answer-progress').classList.toggle('hidden', !state.amHost);
  if (state.amHost) setAnswerProgress(0, state.lobbyPlayers.length || 0);

  const area = $('game-area');
  area.innerHTML = '';
  showScreen('screen-question');
  Sound.question();

  // Timer
  const totalMs = (data.timeLimit || 30) * 1000;
  const remainingMs = typeof data.remainingMs === 'number' ? data.remainingMs : totalMs;
  startTimer(remainingMs, totalMs);
  if (data.paused) pauseTimer(remainingMs);

  // Module API
  const api = {
    locked: !!data.answered,
    isHost: state.amHost,
    role: myRole(),
    // "Am I the big shared screen?" — true only on the TV-mode host's device.
    // Players in a TV-mode game are on their phones, so they must NOT get the
    // oversized TV layout.
    tvMode: isTv(),
    timeLimit: data.timeLimit,
    myNickname: state.myNickname,
    sound: QuizGames.sound,
    util: QuizGames.util,
    remainingSeconds,
    onTick(fn) { if (typeof fn === 'function') timer.tickListeners.push(fn); },
    // Called when the server rejects a submitted answer (e.g. it arrived in an
    // invalid state) and the player should be allowed to try again. The core
    // flips api.locked back to false and then calls every registered listener
    // so the module can re-enable its buttons/inputs.
    unlockListeners: [],
    onUnlock(fn) { if (typeof fn === 'function') api.unlockListeners.push(fn); },
    submit(answer) {
      if (api.locked || state.question !== data) return;
      api.locked = true;
      $('locked-banner').classList.remove('hidden');
      Sound.lock();
      // The server ignores answers while the host has paused — keep it and send it on resume.
      if (state.paused) {
        state.pendingAnswer = answer;
        $('locked-text').textContent = 'Locked in — sent when the host resumes';
        return;
      }
      socket.emit('submit-answer', { answer });
    },
  };
  state.api = api;

  // Wait for module scripts (normally already loaded), then mount on the next frame
  try { await loadModules(); } catch (e) { console.warn(e); }
  if (state.question !== data) return;   // a newer question arrived meanwhile
  nextFrame(() => {
    if (state.question !== data) return;
    const mod = QuizGames.get(data.type);
    if (!mod) {
      area.innerHTML = `<div class="module-missing">This game type (<b>${esc(data.type)}</b>) is not available in your browser yet.</div>`;
      return;
    }
    try { state.handle = mod.mount(area, payload, api) || { destroy() {} }; }
    catch (e) {
      console.error(`mount() failed for ${data.type}`, e);
      area.innerHTML = `<div class="module-missing">Something went wrong showing this question.</div>`;
    }
    // Reconnecting after already having answered: the server sends back what we
    // answered (myResult) alongside answered:true. Feed it through the same
    // onResult() path a live answer uses so the module can show the picked/
    // correct state (e.g. MC highlights the chosen + correct buttons) instead
    // of a plain frozen, unlabeled UI.
    if (data.answered && data.myResult && state.handle && typeof state.handle.onResult === 'function') {
      try { state.handle.onResult(data.myResult); } catch (e) { console.warn(e); }
    }
  });
}

function setAnswerProgress(answered, total) {
  $('answer-progress-text').textContent = `${answered} / ${total} answered`;
  $('answer-progress-fill').style.width = total ? `${Math.round(answered / total * 100)}%` : '0%';
}

// ── Answer result ────────────────────────────────────────────────────────────
function onAnswerResult(data) {
  if (state.handle && typeof state.handle.onResult === 'function') { try { state.handle.onResult(data); } catch (e) { console.warn(e); } }
  if (data.soundCorrect) { Sound.correct(); vibrate(40); } else { Sound.wrong(); vibrate([60, 40, 60]); }
  const delay = speedScored(data.type) ? 1500 : 900;
  clearTimeout(state.resultTimeout);
  state.resultTimeout = setTimeout(() => showResultScreen(data), delay);
}

function showResultScreen(data) {
  const mod = QuizGames.get(data.type);
  let r = null;
  try { r = mod && mod.result ? mod.result(data) : null; } catch (e) { console.warn(e); }
  if (!r) {
    const good = data.quality !== null && data.quality >= 0.5;
    r = { icon: good ? '✓' : '✗', iconColor: good ? 'var(--correct)' : 'var(--wrong)', heading: good ? 'Nice!' : 'Not this time' };
  }

  const icon = $('result-icon');
  icon.textContent = r.icon || '✓';
  icon.style.color = r.iconColor || 'var(--gold)';
  icon.classList.remove('pop'); void icon.offsetWidth; icon.classList.add('pop');
  $('result-heading').textContent = r.heading || '';
  $('result-subtitle').textContent = r.subtitle || '';
  $('result-subtitle').classList.toggle('hidden', !r.subtitle);
  $('result-html').innerHTML = r.html || '';

  // Right panel: accuracy meter (or the speed-scored sentence)
  const isSpeed = speedScored(data.type);
  const pts = data.quality === null || data.quality === undefined ? 0 : Math.round(data.quality * 100);
  $('acc-meter').classList.toggle('hidden', isSpeed);
  $('acc-speed').classList.toggle('hidden', !isSpeed);
  if (isSpeed) {
    $('acc-speed').textContent = data.quality !== null ? 'Correct — speed decides your points' : '0 points';
    $('acc-speed').classList.toggle('zero', data.quality === null);
  } else {
    const fill = $('acc-fill'), C = 2 * Math.PI * 50;
    fill.style.strokeDasharray = String(C);
    fill.style.transition = 'none'; fill.style.strokeDashoffset = String(C);
    $('acc-num').textContent = '0';
    nextFrame(() => nextFrame(() => {
      fill.style.transition = REDUCED_MOTION ? 'none' : 'stroke-dashoffset .9s cubic-bezier(.2,.7,.2,1)';
      fill.style.strokeDashoffset = String(C * (1 - pts / 100));
      animateCount($('acc-num'), 0, pts, 900);
    }));
    fill.classList.toggle('low', pts < 40);
    fill.classList.toggle('high', pts >= 80);
  }
  $('acc-pending').textContent = pts > 2 || (isSpeed && data.quality !== null) ? 'Rank bonus decided at the leaderboard' : 'Better luck next round';

  // Streak flame: we know our streak from the last leaderboard
  const good = isSpeed ? data.quality !== null : pts >= 60;
  const streakNow = good ? state.myStreak + 1 : 0;
  $('result-streak').classList.toggle('hidden', streakNow < 2);
  $('result-streak').textContent = streakNow >= 3 ? `🔥 ${streakNow} in a row — streak bonus!` : `🔥 ${streakNow} in a row — one more for a bonus`;

  showScreen('screen-answer-result');
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. Leaderboard
// ═════════════════════════════════════════════════════════════════════════════
function showLeaderboard(data) {
  destroyQuestion();
  destroyReveal();
  stopLbCountdown();
  state.paused = !!data.paused;
  state.lbIsLast = !!data.isLast;
  Sound.fanfare();

  const cat = data.category || {};
  $('lb-title').textContent = `Round ${data.questionNumber} of ${data.totalQuestions}`;
  $('lb-final-badge').classList.toggle('hidden', data.multiplier !== 2);
  $('correct-tag').textContent = `${cat.emoji ? cat.emoji + ' ' : ''}${cat.label || ''}`;
  $('correct-text').textContent = data.correctText || '';
  $('correct-banner').classList.toggle('hidden', !data.correctText);

  // My streak (for the next result screen)
  const me = data.leaderboard.find(p => p.nickname === state.myNickname);
  state.myStreak = me ? (me.streak || 0) : 0;

  showScreen('screen-leaderboard');

  // Reveal (module-specific): maps, axes, grids…
  // The game modules may not have finished loading yet — that happens when a
  // player reconnects (or opens the page) straight onto a leaderboard, because
  // the server replays show-leaderboard immediately. So wait for them the same
  // way showQuestion() does, instead of silently skipping the reveal.
  // `state.lbLoad` is the "is this still the newest leaderboard?" token: a newer
  // one replaces it and the late callback then does nothing.
  const lbToken = state.lbLoad = {};
  if (data.reveal != null) {
    $('reveal-area').classList.add('has-reveal');
    loadModules().catch(() => {}).then(() => {
      if (state.lbLoad !== lbToken) return;
      const mod = QuizGames.get(data.type);
      if (!mod || typeof mod.reveal !== 'function') { $('reveal-area').classList.remove('has-reveal'); return; }
      nextFrame(() => {
        if (state.lbLoad !== lbToken) return;
        try { state.revealHandle = mod.reveal($('reveal-area'), data.reveal, { myNickname: state.myNickname, players: data.leaderboard, isHost: state.amHost }) || null; }
        catch (e) { console.error(`reveal() failed for ${data.type}`, e); $('reveal-area').classList.remove('has-reveal'); }
      });
    });
  }

  renderLeaderboardRows($('leaderboard-list'), data.leaderboard, data);

  // Footer: host button or autoplay countdown
  $('btn-next').classList.add('hidden');
  $('lb-countdown').hidden = !data.autoplay;
  $('btn-lb-pause').classList.toggle('hidden', !(state.amHost && data.autoplay));
  updatePauseButtons();
  if (data.autoplay) {
    const ms = typeof data.remainingMs === 'number' ? data.remainingMs : (data.revealSeconds || 8) * 1000;
    state.lbTotalMs = ms;
    startLbCountdown(ms, data.isLast);
    if (data.paused) pauseLbCountdown();
  } else if (state.amHost) {
    $('lb-hint').textContent = 'Ready when you are…';
    $('btn-next').textContent = data.isLast ? 'Final results →' : 'Next question →';
    $('btn-next').classList.remove('hidden');
  } else {
    $('lb-hint').textContent = data.isLast ? 'Final results when the host is ready…' : 'The host will start the next question…';
  }
}

// Text for the "+87 accuracy · +50 1st · +20 streak" chip line.
function breakdownText(e, data) {
  if (!e.roundPoints) return e.detail ? '0 points' : '';
  const parts = [];
  // Kept short on purpose: this line has to fit on one row of a 360 px phone.
  if (speedScored(data.type)) { if (e.accuracyPts) parts.push(`+${e.accuracyPts} speed`); }
  else if (e.accuracyPts) parts.push(`+${e.accuracyPts} accuracy`);
  if (e.rankBonus) parts.push(`+${e.rankBonus} ${QuizGames.util.ordinal(e.roundRank)}`);
  if (e.streakBonus) parts.push(`+${e.streakBonus} streak`);
  if (e.speedTiebreak) parts.push('faster ⚡');
  else if (e.speedTiebreakedOut) parts.push('slower ⚡');
  if (data.multiplier === 2) parts.push('×2');
  return parts.join(' · ');
}

function metricText(e, data) {
  if (!e.detail) return 'No answer';
  const mod = QuizGames.get(data.type);
  try { const m = mod && mod.metric ? mod.metric(e.detail) : ''; if (m) return m; } catch (err) { /* ignore */ }
  return e.quality === null ? 'Wrong' : `${Math.round((e.quality || 0) * 100)}% accuracy`;
}

// Phase 1: rows in "this round" order. Phase 2 (after ~3 s): FLIP into total-score order.
function renderLeaderboardRows(listEl, entries, data) {
  clearTimeout(state.flipTimeout); state.flipTimeout = null;
  listEl.innerHTML = '';
  const sortLabel = $('lb-sort-label');
  sortLabel.textContent = 'This round'; sortLabel.style.opacity = '1';

  const roundOrder = [...entries].sort((a, b) =>
    ((b.roundPoints || 0) - (a.roundPoints || 0)) ||
    ((a.roundRank || 999) - (b.roundRank || 999)) ||
    ((b.score || 0) - (a.score || 0)));

  roundOrder.forEach((e, i) => {
    const li = document.createElement('li');
    li.dataset.nickname = e.nickname;
    li.className = 'lb-row' + (e.nickname === state.myNickname ? ' me' : '') + (e.connected === false ? ' offline' : '');
    li.style.animationDelay = `${i * 70}ms`;
    const prev = (e.score || 0) - (e.roundPoints || 0);
    const chips = breakdownText(e, data);
    li.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      ${avatarHtml(e.nickname)}
      <div class="lb-body">
        <div class="lb-top">
          <span class="lb-name">${esc(e.nickname)}${e.nickname === state.myNickname ? '<span class="you">you</span>' : ''}${e.connected === false ? '<span class="offline-dot" title="offline"></span>' : ''}${(e.streak || 0) >= 3 ? `<span class="flame" title="${e.streak} in a row">🔥${e.streak}</span>` : ''}</span>
          <span class="lb-total">${prev.toLocaleString('en-US')}</span>
        </div>
        <div class="lb-detail">
          <span class="lb-metric">${esc(metricText(e, data))}</span>
          <span class="lb-round ${e.roundPoints ? '' : 'zero'}">${e.roundPoints ? '+' + e.roundPoints : '0'}</span>
        </div>
        ${chips ? `<div class="lb-chips">${esc(chips)}</div>` : ''}
      </div>`;
    listEl.appendChild(li);
    if (e.roundPoints) setTimeout(() => animateCount(li.querySelector('.lb-total'), prev, e.score), i * 70 + 500);
  });

  if (entries.length > 1) {
    const delay = (entries.length - 1) * 70 + 3000;
    state.flipTimeout = setTimeout(() => flipToTotalOrder(listEl, entries), delay);
  } else {
    sortLabel.textContent = 'Overall standing';
  }
}

// FLIP = First, Last, Invert, Play: measure, reorder the DOM, offset each row
// back to where it was, then let CSS animate the offset away.
function flipToTotalOrder(listEl, entries) {
  state.flipTimeout = null;
  const lis = [...listEl.children];
  const targetOrder = [...entries].sort((a, b) => (b.score || 0) - (a.score || 0)).map(e => e.nickname);
  const sortLabel = $('lb-sort-label');
  const swapLabel = () => {
    sortLabel.style.opacity = '0';
    setTimeout(() => { sortLabel.textContent = 'Overall standing'; sortLabel.style.opacity = '1'; }, 240);
  };
  if (lis.map(li => li.dataset.nickname).join('|') === targetOrder.join('|')) { swapLabel(); return; }

  const oldTops = new Map(lis.map(li => [li.dataset.nickname, li.getBoundingClientRect().top]));
  targetOrder.forEach((nick, i) => {
    const li = lis.find(l => l.dataset.nickname === nick);
    if (!li) return;
    listEl.appendChild(li);
    li.querySelector('.lb-rank').textContent = i + 1;
  });
  if (REDUCED_MOTION) { swapLabel(); return; }
  const newLis = [...listEl.children];
  newLis.forEach(li => {
    const dy = oldTops.get(li.dataset.nickname) - li.getBoundingClientRect().top;
    if (dy) { li.style.transition = 'none'; li.style.transform = `translateY(${dy}px)`; }
  });
  void listEl.offsetHeight;
  newLis.forEach(li => { li.style.transition = 'transform .6s cubic-bezier(.22,.8,.3,1)'; li.style.transform = ''; });
  swapLabel();
  setTimeout(() => newLis.forEach(li => { li.style.transition = ''; li.style.transform = ''; }), 700);
}

// ── Autoplay countdown on the leaderboard ────────────────────────────────────
// The thin bar under the list drains with one CSS transition on `transform`
// (never on `width`), so it costs no layout work while the reveal animates.
function paintLbBar(remainingMs, animate) {
  const bar = $('lb-countdown-fill');
  if (!bar) return;
  const total = state.lbTotalMs || remainingMs || 1;
  const frac = Math.max(0, Math.min(1, remainingMs / total));
  bar.style.transition = 'none';
  bar.style.transform = `scaleX(${frac})`;
  if (!animate || REDUCED_MOTION) return;
  nextFrame(() => nextFrame(() => {
    bar.style.transition = `transform ${Math.max(0, remainingMs)}ms linear`;
    bar.style.transform = 'scaleX(0)';
  }));
}

function startLbCountdown(ms, isLast) {
  stopLbCountdown();
  state.lbEndAt = Date.now() + ms;
  state.lbRemainingMs = ms;
  if (!state.lbTotalMs || state.lbTotalMs < ms) state.lbTotalMs = ms;
  $('lb-countdown').hidden = false;
  paintLbBar(ms, true);
  const paint = () => {
    const left = Math.max(0, state.lbEndAt - Date.now());
    state.lbRemainingMs = left;
    const s = Math.ceil(left / 1000);
    $('lb-hint').textContent = (isLast ? 'Final results in ' : 'Next question in ') + s + 's';
    if (left <= 0) stopLbCountdown();
  };
  paint();
  state.lbCountdown = setInterval(paint, 250);
}
function pauseLbCountdown() {
  if (state.lbCountdown) { clearInterval(state.lbCountdown); state.lbCountdown = null; }
  state.lbRemainingMs = Math.max(0, state.lbEndAt - Date.now());
  paintLbBar(state.lbRemainingMs, false);
  $('lb-hint').textContent = '⏸ Paused by the host';
}
function stopLbCountdown() { if (state.lbCountdown) { clearInterval(state.lbCountdown); state.lbCountdown = null; } }

function updatePauseButtons() {
  $('btn-pause').textContent = state.paused ? '▶ Resume' : '⏸ Pause';
  const lb = $('btn-lb-pause');
  lb.textContent = state.paused ? '▶' : '⏸';
  lb.setAttribute('aria-label', state.paused ? 'Resume' : 'Pause');
  lb.classList.toggle('is-paused', state.paused);
}

// ═════════════════════════════════════════════════════════════════════════════
// 10. Game over — podium, confetti, awards, standings
// ═════════════════════════════════════════════════════════════════════════════
function showGameOver(data) {
  destroyQuestion(); destroyReveal(); stopLbCountdown();
  clearTimeout(state.flipTimeout);
  Sound.gameOver();
  const lb = [...(data.leaderboard || [])].sort((a, b) => (b.score || 0) - (a.score || 0));

  // The server counts one round too many when the game runs to the end, so never
  // claim more rounds than the game was set up with.
  const played = Math.min(data.totalQuestions || Infinity, state.totalQuestions || Infinity);
  $('gameover-sub').textContent = Number.isFinite(played) ? `${played} round${played === 1 ? '' : 's'} played` : 'Game over';

  // Podium: 2nd | 1st | 3rd
  const slots = [lb[1], lb[0], lb[2]];
  const places = [2, 1, 3];
  $('podium').innerHTML = slots.map((p, i) => p ? `
    <div class="podium-slot place-${places[i]}" style="animation-delay:${[0.35, 0.7, 0.1][i]}s">
      ${avatarHtml(p.nickname, 'avatar-lg')}
      <div class="podium-name">${esc(p.nickname)}${p.nickname === state.myNickname ? '<span class="you">you</span>' : ''}</div>
      <div class="podium-score">${(p.score || 0).toLocaleString('en-US')}</div>
      <div class="podium-block"><span>${places[i] === 1 ? '🏆' : QuizGames.util.ordinal(places[i])}</span></div>
    </div>` : `<div class="podium-slot empty place-${places[i]}"></div>`).join('');

  // Awards
  const awards = data.awards || [];
  $('awards').innerHTML = awards.map((a, i) => `
    <div class="award" style="animation-delay:${1 + i * 0.15}s">
      <span class="award-emoji">${a.emoji || '🏅'}</span>
      <div class="award-body">
        <div class="award-title">${esc(a.title)}</div>
        <div class="award-who">${esc(a.nickname)}</div>
        <div class="award-detail">${esc(a.detail || '')}</div>
      </div>
    </div>`).join('');
  $('awards').classList.toggle('hidden', !awards.length);

  // Standings with stats
  $('final-standings').innerHTML = lb.map((e, i) => {
    const s = e.stats || {};
    const bits = [];
    if (s.avgAccuracy != null) bits.push(`${s.avgAccuracy} avg accuracy`);
    if (s.firsts) bits.push(`${s.firsts}× 1st`);
    if (s.perfects) bits.push(`${s.perfects} perfect`);
    if (s.longestStreak >= 2) bits.push(`streak ${s.longestStreak}`);
    return `
      <li class="lb-row ${e.nickname === state.myNickname ? 'me' : ''}" style="animation-delay:${i * 60}ms">
        <span class="lb-rank">${i + 1}</span>
        ${avatarHtml(e.nickname)}
        <div class="lb-body">
          <div class="lb-top"><span class="lb-name">${esc(e.nickname)}${e.nickname === state.myNickname ? '<span class="you">you</span>' : ''}</span><span class="lb-total">${(e.score || 0).toLocaleString('en-US')}</span></div>
          ${bits.length ? `<div class="lb-chips">${esc(bits.join(' · '))}</div>` : ''}
        </div>
      </li>`;
  }).join('');

  $('gameover-host-actions').classList.toggle('hidden', !state.amHost);
  $('gameover-wait').classList.toggle('hidden', state.amHost);
  showScreen('screen-game-over');
  if (!REDUCED_MOTION) confetti($('confetti'));
}

// Tiny confetti: a few hundred coloured rectangles falling for ~4 seconds.
function confetti(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.offsetWidth || window.innerWidth;
  const H = canvas.height = canvas.offsetHeight || window.innerHeight;
  // Gold-weighted palette (the theme colour appears three times) and a density
  // tied to the screen area, so a phone does not get the same 220 pieces a TV does.
  const colors = ['#c8922a', '#d4a035', '#e8c97a', '#1e3a6e', '#2a6e45', '#b8402f', '#f5ede0'];
  const count = Math.max(70, Math.min(260, Math.round(W * H / 5200)));
  const bits = Array.from({ length: count }, () => ({
    x: Math.random() * W, y: -20 - Math.random() * H * 0.6, w: 5 + Math.random() * 7, h: 7 + Math.random() * 9,
    vx: -1 + Math.random() * 2, vy: 2 + Math.random() * 3.2, rot: Math.random() * Math.PI, vr: -0.12 + Math.random() * 0.24,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(now) {
    const t = (now - start) / 1000;
    ctx.clearRect(0, 0, W, H);
    let alive = 0;
    for (const b of bits) {
      b.x += b.vx + Math.sin(t * 2 + b.y * 0.01); b.y += b.vy; b.rot += b.vr;
      if (b.y < H + 20) alive++;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot);
      ctx.fillStyle = b.c; ctx.globalAlpha = t > 3.5 ? Math.max(0, 1 - (t - 3.5)) : 1;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
    }
    if (alive && t < 4.5 && currentScreen === 'screen-game-over') requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, W, H);
  })(start);
}

function resetForNewGame() {
  destroyQuestion(); destroyReveal(); stopLbCountdown();
  clearTimeout(state.flipTimeout);
  state.paused = false; state.myStreak = 0; state.question = null;
  document.body.classList.remove('tv');
}

// ═════════════════════════════════════════════════════════════════════════════
// 11. Socket events
// ═════════════════════════════════════════════════════════════════════════════
socket.on('create-error', msg => showError('config-error', msg));

socket.on('game-created', ({ gameId, gameMode, autoplay, hostToken, totalQuestions }) => {
  state.amHost = true; state.gameId = gameId; state.gameMode = gameMode || 'mobile';
  state.autoplay = autoplay !== false; state.totalQuestions = totalQuestions || 0;
  state.myNickname = null; state.lobbyPlayers = [];
  document.body.classList.toggle('tv', isTv());
  if (hostToken) saveToken(hostToken);
  $('host-nickname-input').value = '';
  setAvatar($('host-avatar'), '');
  showHostLobby();
});

socket.on('join-success', ({ gameId, nickname, playerToken }) => {
  state.amHost = false; state.gameId = gameId; state.myNickname = nickname;
  document.body.classList.remove('tv');
  if (playerToken) saveToken(playerToken);
  clearError('join-error');
  showPlayerLobby();
});
socket.on('join-error', msg => showError('join-error', msg));
socket.on('start-error', msg => { state.pendingHostNick = null; showError('start-error', msg); });

socket.on('lobby-update', ({ players }) => {
  const before = new Set(state.lobbyPlayers.map(p => p.nickname));
  state.lobbyPlayers = players || [];
  players.forEach(p => playerIndex(p.nickname));
  renderLobbyPlayers();
  if (state.amHost) {
    const now = new Set(players.map(p => p.nickname));
    for (const n of before) if (!now.has(n) && currentScreen !== 'screen-host-lobby') toast(`${n} left`);
  }
});

socket.on('question-intro', data => {
  if (state.pendingHostNick) { state.myNickname = state.pendingHostNick; state.pendingHostNick = null; }
  showIntro(data);
});

socket.on('new-question', data => {
  if (state.pendingHostNick) { state.myNickname = state.pendingHostNick; state.pendingHostNick = null; }
  showQuestion(data);
});

socket.on('answer-result', data => onAnswerResult(data));
socket.on('answer-rejected', msg => {
  if (state.api) {
    state.api.locked = false;
    $('locked-banner').classList.add('hidden');
    // Let the mounted module re-enable its inputs so the player can retry.
    (state.api.unlockListeners || []).forEach(fn => { try { fn(); } catch (e) { console.warn(e); } });
  }
  toast(msg || 'Answer rejected — try again', { kind: 'warn' });
});
socket.on('answer-progress', ({ answered, total }) => setAnswerProgress(answered, total));

socket.on('game-paused', ({ remainingMs, state: gstate }) => {
  state.paused = true;
  updatePauseButtons();
  if (gstate === 'question' || currentScreen === 'screen-question') pauseTimer(remainingMs);
  if (gstate === 'leaderboard' || currentScreen === 'screen-leaderboard') pauseLbCountdown();
  if (!state.amHost) toast('Host paused the game');
});
socket.on('game-resumed', ({ remainingMs, state: gstate }) => {
  state.paused = false;
  updatePauseButtons();
  if (gstate === 'question') {
    resumeTimer(remainingMs);
    if (state.pendingAnswer !== undefined && state.api && state.api.locked) {
      socket.emit('submit-answer', { answer: state.pendingAnswer });
      $('locked-text').textContent = 'Locked in — waiting for others';
    }
  }
  state.pendingAnswer = undefined;
  if (gstate === 'leaderboard') startLbCountdown(remainingMs, state.lbIsLast);
  if (!state.amHost) toast('Game resumed');
});

socket.on('show-leaderboard', data => showLeaderboard(data));
socket.on('waiting-for-host', () => {
  if (currentScreen !== 'screen-leaderboard') return;
  $('lb-hint').textContent = 'Ready when you are…';
  $('btn-next').classList.remove('hidden');
});

socket.on('game-over', data => showGameOver(data));

socket.on('rematch', ({ gameId, gameMode, autoplay, totalQuestions, players }) => {
  resetForNewGame();
  state.gameId = gameId; state.gameMode = gameMode || state.gameMode; state.autoplay = autoplay !== false;
  state.totalQuestions = totalQuestions || 0; state.lobbyPlayers = players || [];
  document.body.classList.toggle('tv', isTv());
  // A rematch keeps the token but gives everyone a NEW game id — remember it so
  // a reload during the rematch still reconnects (see boot()).
  const t = loadToken(); if (t) saveToken(t);
  toast('Rematch! Same players, fresh questions');
  if (state.amHost) showHostLobby(); else showPlayerLobby();
});

socket.on('rejoin-success', ({ role, gameId, nickname, gameMode, autoplay, state: gstate, totalQuestions }) => {
  state.amHost = role === 'host'; state.gameId = gameId; state.myNickname = nickname || null;
  state.gameMode = gameMode || 'mobile'; state.autoplay = autoplay !== false; state.totalQuestions = totalQuestions || 0;
  document.body.classList.toggle('tv', isTv());
  toast('Reconnected');
  if (gstate === 'lobby') { if (state.amHost) showHostLobby(); else showPlayerLobby(); }
  // any other state: the server sends the matching state event right after this
});
socket.on('rejoin-error', () => { clearToken(); });

socket.on('host-left', () => {
  resetForNewGame(); clearToken();
  toast('The host left the game', { kind: 'warn', ms: 4000 });
  setTimeout(() => location.replace(location.pathname), 1200);
});
socket.on('kicked', () => {
  resetForNewGame(); clearToken();
  toast('You were removed from the game', { kind: 'warn', ms: 4000 });
  setTimeout(() => location.replace(location.pathname), 1200);
});

socket.on('disconnect', () => { if (state.gameId) toast('Connection lost — reconnecting…', { kind: 'warn' }); });
socket.io.on('reconnect', () => { const t = loadToken(); if (t && state.gameId) socket.emit('rejoin', { token: t }); });

// ═════════════════════════════════════════════════════════════════════════════
// 12. Wiring up buttons + boot
// ═════════════════════════════════════════════════════════════════════════════
function closeHostMenu() { const p = $('host-menu-pop'); if (p) p.classList.add('hidden'); }

function wireUI() {
  // Home
  $('btn-host').addEventListener('click', () => { Sound.click(); openConfig(); });
  $('btn-join').addEventListener('click', () => { Sound.click(); showScreen('screen-join'); setTimeout(() => $('join-code').focus(), 260); });
  $('btn-config-back').addEventListener('click', () => showScreen('screen-home'));
  $('btn-create').addEventListener('click', () => { Sound.click(); createGame(); });

  // Host lobby
  $('btn-start').addEventListener('click', () => { Sound.click(); startGame(); });
  $('host-nickname-input').addEventListener('input', e => setAvatar($('host-avatar'), e.target.value.trim()));
  $('host-nickname-input').addEventListener('keydown', e => { if (e.key === 'Enter') startGame(); });
  $('btn-copy-link').addEventListener('click', async () => {
    const link = `${location.origin}/?join=${state.gameId}`;
    try { await navigator.clipboard.writeText(link); toast('Link copied'); }
    catch (e) { prompt('Copy this link:', link); }
  });
  $('host-player-chips').addEventListener('click', e => {
    const b = e.target.closest('[data-kick]'); if (!b) return;
    socket.emit('kick-player', { nickname: b.dataset.kick });
  });

  // Join
  $('join-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
  $('join-nickname').addEventListener('input', e => setAvatar($('join-avatar'), e.target.value.trim()));
  ['join-code', 'join-nickname'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); }));
  $('btn-join-go').addEventListener('click', () => { Sound.click(); joinGame(); });
  $('btn-join-back').addEventListener('click', () => showScreen('screen-home'));

  // Mute buttons (there are several — one per screen that has a play bar)
  document.querySelectorAll('.mute-btn').forEach(b => b.addEventListener('click', () => { Sound.setMuted(!Sound.muted); if (!Sound.muted) Sound.click(); }));
  Sound.setMuted(Sound.muted);

  // Host menu on the question screen
  $('btn-host-menu').addEventListener('click', e => { e.stopPropagation(); $('host-menu-pop').classList.toggle('hidden'); });
  document.addEventListener('click', e => { if (!e.target.closest('#host-menu')) closeHostMenu(); });
  $('btn-pause').addEventListener('click', () => { socket.emit(state.paused ? 'resume-game' : 'pause-game'); closeHostMenu(); });
  $('btn-skip').addEventListener('click', () => { socket.emit('skip-question'); closeHostMenu(); });
  $('btn-end').addEventListener('click', () => { if (confirm('End the game now and show the final results?')) socket.emit('end-game'); closeHostMenu(); });
  $('btn-lb-pause').addEventListener('click', () => socket.emit(state.paused ? 'resume-game' : 'pause-game'));
  $('btn-next').addEventListener('click', () => { Sound.click(); $('btn-next').classList.add('hidden'); socket.emit('next-question'); });

  // Game over
  $('btn-rematch').addEventListener('click', () => { Sound.click(); socket.emit('rematch'); });
  $('btn-new-game').addEventListener('click', () => { clearToken(); location.replace(location.pathname); });

  // Springy press feedback on every button
  document.addEventListener('pointerdown', e => { const b = e.target.closest('button'); if (b) b.classList.add('pressed'); }, { passive: true });
  ['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, () => document.querySelectorAll('button.pressed').forEach(b => b.classList.remove('pressed')), { passive: true }));
}

function boot() {
  loadConfig();
  wireUI();
  loadCatalog().catch(() => {});   // warm the cache

  const joinCode = new URLSearchParams(location.search).get('join');
  const token = loadToken();
  if (joinCode) {
    const code = joinCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    $('join-code').value = code;
    showScreen('screen-join');
    loadModules();
    // Almost everyone joins by scanning the QR code, so the join link stays in
    // the address bar for the whole game. Reloading (or coming back after the
    // phone locked) must therefore NOT drop the player onto an empty join form
    // — the game has already started by then and re-joining would be refused.
    // If the saved token belongs to THIS game, reconnect instead. A token from
    // some other game is ignored, so a fresh join link still works normally.
    if (token && loadGameId() === code) {
      state.gameId = code;
      socket.emit('rejoin', { token });
      socket.once('rejoin-error', () => { state.gameId = null; setTimeout(() => $('join-nickname').focus(), 100); });
    } else {
      setTimeout(() => $('join-nickname').focus(), 300);
    }
    return;
  }
  if (token) {
    state.gameId = '?';   // so a failed rejoin does not toast "connection lost" forever
    socket.emit('rejoin', { token });
    loadModules();
    socket.once('rejoin-error', () => { state.gameId = null; });
  }
}

document.addEventListener('DOMContentLoaded', boot);
