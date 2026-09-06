// ─────────────────────────────────────────────────────────────────────────────
// games/map.js — drop a pin on a world map. Used by the four geo categories and
// by Bird's Eye (a satellite close-up is shown first; the player must work out
// where on Earth it is).
//
// Satellite tiles are proxied through /map/sat/:token/:z/:dx/:dy so the client
// never learns the real coordinates before the reveal. The token maps to the
// hidden centre for a few minutes only.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const { validateCommon, haversineKm } = require('./_shared');

const SAT_TTL_MS = 15 * 60 * 1000;
const satTokens  = new Map();   // token → { lat, lng, zoom, expires }
const tileCache  = new Map();   // "z/x/y" → Buffer (bounded)

function distanceQuality(effectiveKm) {
  if (effectiveKm <= 5) return 1;
  return Math.exp(-Math.pow((effectiveKm - 5) / 300, 0.7));
}

// Web-Mercator tile maths
function lngToTileX(lng, z) { return (lng + 180) / 360 * Math.pow(2, z); }
function latToTileY(lat, z) {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
}

module.exports = {
  type: 'map',
  categories: [
    { id: 'birdseye',    label: "Bird's Eye",     emoji: '🛰️', group: 'map', order: 5,
      blurb: 'A satellite close-up. Where on Earth is it?',
      howTo:  'Study the aerial view, then drop your pin on the world map. Closest pin wins.' },
    { id: 'geo-natural', label: 'Natural Wonders', emoji: '🏔️', group: 'map', order: 10,
      blurb: 'Mountains, lakes, deserts and waterfalls.',
      howTo:  'Tap the map to drop your pin, then lock in. Closest pin wins.' },
    { id: 'geo-built',   label: 'Built World',     emoji: '🏛️', group: 'map', order: 20,
      blurb: 'Monuments, temples and famous buildings.',
      howTo:  'Tap the map to drop your pin, then lock in. Closest pin wins.' },
    { id: 'geo-cities',  label: 'Cities',          emoji: '🏙️', group: 'map', order: 30,
      blurb: 'Urban centres around the globe.',
      howTo:  'Tap the map to drop your pin, then lock in. Closest pin wins.' },
    { id: 'geo-history', label: 'Where in History', emoji: '⚔️', group: 'map', order: 40,
      blurb: 'Battlefields, ruins and the places history happened.',
      howTo:  'Tap the map to drop your pin, then lock in. Closest pin wins.' },
  ],
  timeLimit: 35,
  revealPause: 10,
  earlyPause: 5000,
  speedScored: false,
  usesRegion: true,

  validate(q) {
    const errors = validateCommon(q);
    if (typeof q.correctLat !== 'number' || q.correctLat < -90  || q.correctLat > 90)  errors.push('"correctLat" must be a number between -90 and 90');
    if (typeof q.correctLng !== 'number' || q.correctLng < -180 || q.correctLng > 180) errors.push('"correctLng" must be a number between -180 and 180');
    if (q.toleranceKm !== undefined && (typeof q.toleranceKm !== 'number' || q.toleranceKm < 0)) errors.push('"toleranceKm" must be a positive number');
    if (q.satellite !== undefined && (typeof q.satellite !== 'object' || typeof q.satellite.zoom !== 'number')) errors.push('"satellite" must be { zoom }');
    if (q.category === 'birdseye' && !q.satellite) errors.push('birdseye questions need "satellite": { zoom }');
    return errors;
  },

  toRow(q) {
    const extra = { correctLat: q.correctLat, correctLng: q.correctLng, locationName: q.locationName || '' };
    if (q.toleranceKm) extra.toleranceKm = q.toleranceKm;
    if (q.satellite)   extra.satellite   = { zoom: q.satellite.zoom };
    return { correct: null, extra };
  },
  fromRow(row, extra) {
    const out = { correctLat: extra.correctLat, correctLng: extra.correctLng, locationName: extra.locationName || '' };
    if (extra.toleranceKm) out.toleranceKm = extra.toleranceKm;
    if (extra.satellite)   out.satellite   = extra.satellite;
    return out;
  },

  payload(q) {
    const p = { question: q.question, imageUrl: q.imageUrl || null, toleranceKm: q.toleranceKm || 0, satellite: null };
    if (q.satellite) {
      const token = crypto.randomBytes(8).toString('hex');
      const zoom  = q.satellite.zoom;
      satTokens.set(token, { lat: q.correctLat, lng: q.correctLng, zoom, expires: Date.now() + SAT_TTL_MS });
      const tx = lngToTileX(q.correctLng, zoom), ty = latToTileY(q.correctLat, zoom);
      // fx / fy = where the target sits inside the centre tile (0..1). Reveals nothing about the world position.
      p.satellite = { token, zoom, fx: tx - Math.floor(tx), fy: ty - Math.floor(ty) };
    }
    return p;
  },

  evaluate(q, answer) {
    const lat = answer && Number(answer.lat), lng = answer && Number(answer.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    const dist          = haversineKm(lat, lng, q.correctLat, q.correctLng);
    const effectiveDist = Math.max(0, dist - (q.toleranceKm || 0));
    const quality       = distanceQuality(effectiveDist);
    return {
      quality,
      detail: { lat, lng, distanceKm: Math.round(dist), effectiveKm: Math.round(effectiveDist) },
      result: { lat, lng, distanceKm: Math.round(dist), insideTolerance: effectiveDist === 0 && (q.toleranceKm || 0) > 0,
                locationName: q.locationName, correctLat: q.correctLat, correctLng: q.correctLng, accuracyPct: Math.round(quality * 100) },
    };
  },

  reveal(q, answers) {
    return {
      correctLat: q.correctLat, correctLng: q.correctLng, locationName: q.locationName,
      toleranceKm: q.toleranceKm || 0, satelliteZoom: q.satellite ? q.satellite.zoom : null,
      pins: answers.map(a => ({ nickname: a.nickname, lat: a.detail.lat, lng: a.detail.lng, distanceKm: a.detail.distanceKm })),
    };
  },

  correctText(q) { return q.locationName || `${q.correctLat.toFixed(2)}, ${q.correctLng.toFixed(2)}`; },
  sampleAnswer()  { return { lat: -60 + Math.random() * 130, lng: -180 + Math.random() * 360 }; },

  // ── Satellite tile proxy ────────────────────────────────────────────────────
  routes(app) {
    app.get('/map/sat/:token/:z/:dx/:dy', async (req, res) => {
      const entry = satTokens.get(req.params.token);
      if (!entry || entry.expires < Date.now()) return res.status(404).end();
      const z  = parseInt(req.params.z, 10);
      const dx = parseInt(req.params.dx, 10), dy = parseInt(req.params.dy, 10);
      // The zoom is pinned to the one the question was authored at. The token is
      // handed to every player in the question payload, and the whole point of
      // proxying is that the browser must not learn the real coordinates before
      // the reveal — but each tile is *centred* on the secret point, so allowing
      // any z meant a player could ask for /map/sat/<their own token>/3/0/0 and
      // get a continent-scale tile centred on the answer. The client only ever
      // requests sat.zoom (its "Zoom out" button widens the tile grid via dx/dy,
      // it does not change z), so nothing legitimate needs any other value.
      if (!Number.isInteger(z) || z !== entry.zoom) return res.status(400).end();
      // Number.isInteger, not just a magnitude check: Math.abs(NaN) > 3 is false,
      // so a non-numeric dx/dy used to slip through into the tile key.
      if (!Number.isInteger(dx) || !Number.isInteger(dy) || Math.abs(dx) > 3 || Math.abs(dy) > 3) return res.status(400).end();
      const n = Math.pow(2, z);
      const x = (((Math.floor(lngToTileX(entry.lng, z)) + dx) % n) + n) % n;
      const y = Math.floor(latToTileY(entry.lat, z)) + dy;
      if (y < 0 || y >= n) return res.status(404).end();
      const key = `${z}/${x}/${y}`;
      try {
        let buf = tileCache.get(key);
        if (!buf) {
          const r = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`);
          if (!r.ok) return res.status(502).end();
          buf = Buffer.from(await r.arrayBuffer());
          if (tileCache.size > 600) tileCache.delete(tileCache.keys().next().value);
          tileCache.set(key, buf);
        }
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'private, max-age=600');
        res.send(buf);
      } catch (e) {
        res.status(502).end();
      }
    });
    // Housekeeping: drop expired tokens once a minute
    setInterval(() => { const now = Date.now(); for (const [t, e] of satTokens) if (e.expires < now) satTokens.delete(t); }, 60 * 1000).unref();
  },

  _distanceQuality: distanceQuality,
};
