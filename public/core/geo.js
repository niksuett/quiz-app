// ─────────────────────────────────────────────────────────────────────────────
// public/core/geo.js — shared browser geometry helpers.
//
// Pure functions only (no DOM, no Leaflet). They are merged into
// window.QuizGames.util so every game module can call e.g.
//   QuizGames.util.project(lng, lat, bbox, w, h)
// The drawing games (borders, rivers, silhouettes …) rely on these; the classic
// modules mostly use haversineKm from the core.
//
// Conventions
//   point   = [x, y]            (screen pixels)  or  [lng, lat] (degrees)
//   line    = [point, point …]  a polyline
//   bbox    = [minLng, minLat, maxLng, maxLat]   (an object with those keys works too)
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  // Make sure the namespace exists even if this file is loaded on its own.
  const QG = (window.QuizGames = window.QuizGames || {});
  QG.util = QG.util || {};

  // Accept bbox as an array or as an object with named keys.
  function readBox(bbox) {
    if (Array.isArray(bbox)) return { minLng: bbox[0], minLat: bbox[1], maxLng: bbox[2], maxLat: bbox[3] };
    return { minLng: bbox.minLng, minLat: bbox.minLat, maxLng: bbox.maxLng, maxLat: bbox.maxLat };
  }

  // Common maths for project / unproject: an equirectangular projection where
  // longitude is squeezed by cos(midLat) so shapes keep roughly the right aspect
  // ratio, scaled to fit inside a w×h box and centred in it.
  function frame(bbox, w, h) {
    const b       = readBox(bbox);
    const midLat  = (b.minLat + b.maxLat) / 2;
    const cosMid  = Math.max(0.05, Math.cos(midLat * Math.PI / 180));   // never 0 at the poles
    const lngSpan = Math.max(1e-9, (b.maxLng - b.minLng) * cosMid);
    const latSpan = Math.max(1e-9, b.maxLat - b.minLat);
    const scale   = Math.min(w / lngSpan, h / latSpan);                  // pixels per degree
    const offX    = (w - lngSpan * scale) / 2;                            // centring margins
    const offY    = (h - latSpan * scale) / 2;
    return { b, cosMid, scale, offX, offY };
  }

  // project(lng, lat, bbox, w, h) → [x, y]
  // Screen position of a geographic point inside a w×h pixel box that shows bbox.
  function project(lng, lat, bbox, w, h) {
    const f = frame(bbox, w, h);
    const x = f.offX + (lng - f.b.minLng) * f.cosMid * f.scale;
    const y = f.offY + (f.b.maxLat - lat) * f.scale;                      // y grows downwards
    return [x, y];
  }

  // unproject(x, y, bbox, w, h) → [lng, lat]   (inverse of project)
  function unproject(x, y, bbox, w, h) {
    const f = frame(bbox, w, h);
    const lng = f.b.minLng + (x - f.offX) / (f.cosMid * f.scale);
    const lat = f.b.maxLat - (y - f.offY) / f.scale;
    return [lng, lat];
  }

  // Distance from point p to the segment a–b (plain 2-D Euclidean).
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 0) t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    const qx = a[0] + t * dx, qy = a[1] + t * dy;
    return Math.hypot(p[0] - qx, p[1] - qy);
  }

  // polylineDist(pt, line) → shortest distance from pt to any segment of line.
  // Returns Infinity for an empty line; distance to the single point for a 1-point line.
  function polylineDist(pt, line) {
    if (!line || !line.length) return Infinity;
    if (line.length === 1) return Math.hypot(pt[0] - line[0][0], pt[1] - line[0][1]);
    let best = Infinity;
    for (let i = 1; i < line.length; i++) {
      const d = segDist(pt, line[i - 1], line[i]);
      if (d < best) best = d;
    }
    return best;
  }

  // pathLength(line) → total length of the polyline (sum of segment lengths).
  function pathLength(line) {
    let len = 0;
    for (let i = 1; i < line.length; i++) len += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
    return len;
  }

  // resample(line, n) → n points evenly spaced along the line (first and last kept).
  // Useful for comparing two drawn lines point-by-point.
  function resample(line, n) {
    if (!line || !line.length) return [];
    if (line.length === 1 || n <= 1) return [line[0].slice()];
    const total = pathLength(line);
    if (total === 0) return Array.from({ length: n }, () => line[0].slice());
    const step = total / (n - 1);
    const out  = [line[0].slice()];
    let segIdx = 1, segStart = 0;                                         // distance at start of current segment
    let segLen = Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]);
    for (let k = 1; k < n - 1; k++) {
      const target = k * step;
      while (segIdx < line.length - 1 && segStart + segLen < target) {  // advance to the segment that holds `target`
        segStart += segLen; segIdx++;
        segLen = Math.hypot(line[segIdx][0] - line[segIdx - 1][0], line[segIdx][1] - line[segIdx - 1][1]);
      }
      const t = segLen > 0 ? (target - segStart) / segLen : 0;
      const a = line[segIdx - 1], b = line[segIdx];
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    out.push(line[line.length - 1].slice());
    return out;
  }

  // simplify(line, tolerance) → Douglas-Peucker: drops points that deviate less than
  // `tolerance` from the straight line between their neighbours. Keeps the end points.
  function simplify(line, tolerance) {
    if (!line || line.length <= 2) return (line || []).slice();
    const tol = tolerance || 0;
    const keep = new Array(line.length).fill(false);
    keep[0] = keep[line.length - 1] = true;
    const stack = [[0, line.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let maxD = -1, idx = -1;
      for (let i = s + 1; i < e; i++) {
        const d = segDist(line[i], line[s], line[e]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol && idx > 0) { keep[idx] = true; stack.push([s, idx], [idx, e]); }
    }
    return line.filter((_, i) => keep[i]);
  }

  // bbox(points) → [minX, minY, maxX, maxY] of a list of points (any 2-D unit).
  function bbox(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points || []) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    return [minX, minY, maxX, maxY];
  }

  // lineToPath(points) → SVG path data string "M x y L x y …" (empty string for no points).
  function lineToPath(points) {
    if (!points || !points.length) return '';
    const r = n => Math.round(n * 100) / 100;
    let d = `M ${r(points[0][0])} ${r(points[0][1])}`;
    for (let i = 1; i < points.length; i++) d += ` L ${r(points[i][0])} ${r(points[i][1])}`;
    return d;
  }

  Object.assign(QG.util, { project, unproject, polylineDist, resample, simplify, pathLength, bbox, lineToPath });
})();
