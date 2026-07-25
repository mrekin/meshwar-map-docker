// GPS outlier filter — drops "broken" samples whose coordinates don't connect
// to the real track by any physically possible step. Runs as a pre-pass inside
// db.insertSamples(), so it covers both the HTTP upload path (POST /api/samples)
// and the offline import tool.
//
// Model (time sessions + connectivity):
//   - A batch is just ~100 samples and may span several separate drives. We split
//     each contributor's stream into SESSIONS by time gap (a long gap = a new
//     drive) and detect outliers WITHIN a session only — never across a gap. This
//     is what stops a glitch in a long-span batch from being bridged to a real
//     track hours away.
//   - Within a session the sampling is continuous (~uniform cadence), so the real
//     track is a connected path: each sample is reachable from the next at a
//     plausible speed (distance <= gap_s * maxSpeed). A GPS glitch is a teleport
//     (a step needing thousands of km/h) → not connected.
//   - A short look-ahead bridges a few interleaved glitch samples (real→glitch→
//     real) so the real track stays connected. There is NO cap on route length.
//   - Two passes within a session:
//       1) spike: drop a point far from BOTH neighbours while they stay close
//          ("went out and came back") — catches lone glitches.
//       2) components: the real track is the large connected component(s); small
//          isolated glitch blobs are dropped.
//
// Safeguards (prefer keeping data over guessing wrong):
//   - Sessions smaller than MIN_GROUP_SIZE are kept as-is (can't analyse).
//   - A component is dropped only when a real track is clearly identifiable
//     (largest component >= DOMINANT_FRACTION of the session) and only components
//     much smaller than the largest (so a real track split by a glitch is kept).
//
// Batch boundary: each uploaded batch (~100) is filtered on its own. A glitch
// straddling two batches is analysed per half — safe, but a seam glitch may be
// missed. Bridging batches needs server-side state (future option).
//
// Config: env vars (see .env.example). Master switch: GPS_FILTER_ENABLED.
// Diagnostics: GPS_FILTER_DEBUG=true logs per-session stats; GPS_DUMP_BATCHES=true
// writes every batch (raw + verdict + per-component diagnostics) to data/debug/samples/.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// ---- config (env) ----
const ENABLED = (process.env.GPS_FILTER_ENABLED ?? 'true') !== 'false';
const FALLBACK_INTERVAL_SEC = Math.max(1, parseFloat(process.env.GPS_SAMPLE_INTERVAL_SEC) || 25); // only used when interval can't be estimated from data
const MAX_SPEED_KMH = Math.max(1, parseFloat(process.env.GPS_MAX_SPEED_KMH) || 150);
const MIN_GROUP_SIZE = Math.max(1, parseInt(process.env.GPS_MIN_GROUP_SIZE) || 3); // smaller components skip the spike pass
const KEEP_RATIO = Math.min(0.9, Math.max(0.1, parseFloat(process.env.GPS_FILTER_MAX_FRACTION) || 0.5)); // keep a component if its size >= this * largest
const MIN_OUTLIER_KM = Math.max(0, parseFloat(process.env.GPS_MIN_OUTLIER_KM) || 0.5); // floor on a plausible step (short-cadence jitter guard)
const GROUP_GAP_FACTOR = Math.max(1, parseFloat(process.env.GPS_GROUP_GAP_FACTOR) || 3); // a time gap > interval*factor starts a new session
const DOMINANT_FRACTION = 0.35; // largest component must be >= this share of points to be trusted as the real track
const WINDOW_SAMPLES = 8; // bridge brief GPS dropouts: link a point to a plausible partner up to this many samples ahead
const MERGE_FACTOR = 3; // merge components whose centroids are within threshold*MERGE_FACTOR (reunites a real track split by glitches)
const BBOX = parseBbox(process.env.GPS_BBOX || '');
const DEBUG = (process.env.GPS_FILTER_DEBUG ?? 'false') === 'true';
const DUMP = (process.env.GPS_DUMP_BATCHES ?? 'false') === 'true';
const DUMP_DIR = path.join(__dirname, '..', 'data', 'debug', 'samples');
if (DUMP) fs.mkdirSync(DUMP_DIR, { recursive: true });
let dumpSeq = 0;

/** Great-circle distance between two {lat, lon} points, in km. */
function haversineKm(a, b) {
  const R = 6371; // earth radius, km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function parseBbox(raw) {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLon, minLat, maxLon, maxLat] = parts;
  if (minLon > maxLon || minLat > maxLat) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function inBbox(lat, lon, bbox) {
  return (
    lon >= bbox.minLon &&
    lon <= bbox.maxLon &&
    lat >= bbox.minLat &&
    lat <= bbox.maxLat
  );
}

function parseTime(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Estimate the sampling interval (ms) from the data: the median gap between
 * consecutive (time-sorted) samples. The median ignores the few large cross-area
 * gaps, so it reflects the real cadence. Used only for the spike-pass threshold
 * and reporting — the component graph uses per-step gaps directly.
 */
function estimateIntervalMs(points) {
  if (points.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < points.length; i++) gaps.push(points[i].t - points[i - 1].t);
  return median(gaps);
}

/**
 * Split a time-sorted stream into sessions wherever the gap between consecutive
 * points exceeds sessionGapMs (a new drive / measurement elsewhere).
 */
function splitSessions(points, sessionGapMs) {
  const sessions = [];
  let cur = [];
  for (const p of points) {
    if (cur.length && p.t - cur[cur.length - 1].t > sessionGapMs) { sessions.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) sessions.push(cur);
  return sessions;
}

/**
 * Connected components within a time-ordered session. A point is linked to a
 * later point when the step between them is physically plausible (distance <=
 * gap_seconds * maxSpeed, floored at MIN_OUTLIER_KM). We look ahead up to
 * WINDOW_SAMPLES, not just the next point, so the real track stays connected
 * across a few interleaved glitch samples (real→glitch→real); a teleport is
 * never linked because no plausible partner exists within the window. Returns
 * arrays of points.
 */
function connectedComponents(points) {
  const n = points.length;
  if (n === 0) return [];
  const parent = new Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => { let r = x; while (parent[r] !== r) r = parent[r]; while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; } return r; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n && j <= i + WINDOW_SAMPLES; j++) {
      const gapSec = Math.max(1, (points[j].t - points[i].t) / 1000);
      const allowed = Math.max(MIN_OUTLIER_KM, (gapSec * MAX_SPEED_KMH) / 3600);
      if (haversineKm(points[i], points[j]) <= allowed) union(i, j);
    }
  }
  const map = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!map.has(r)) map.set(r, []); map.get(r).push(points[i]); }
  return [...map.values()];
}

/**
 * Merge components whose centroids are within mergeDistKm. A real track split
 * into several pieces by interleaved glitches has its pieces close together
 * (same area) → reunited; glitch blobs far away stay separate. Transitive.
 */
function mergeComponents(comps, mergeDistKm) {
  const n = comps.length;
  if (n <= 1) return comps;
  const cen = comps.map((c) => ({ lat: median(c.map((p) => p.lat)), lon: median(c.map((p) => p.lon)) }));
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { let r = x; while (parent[r] !== r) r = parent[r]; while (parent[x] !== r) { const nx = parent[x]; parent[x] = r; x = nx; } return r; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue;
      if (haversineKm(cen[i], cen[j]) <= mergeDistKm) union(i, j);
    }
  }
  const out = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!out.has(r)) out.set(r, []); out.get(r).push(i); }
  return [...out.values()].map((idx) => idx.flatMap((k) => comps[k]));
}

/**
 * Symmetric spike filter: drop an interior point farther than thresholdKm from
 * BOTH neighbours while the neighbours stay close to each other. No anchor, so
 * it's safe at any position. Returns the dropped points.
 */
function spikeFilter(session, thresholdKm) {
  const dropped = [];
  for (let i = 1; i < session.length - 1; i++) {
    const prev = session[i - 1];
    const cur = session[i];
    const next = session[i + 1];
    if (
      haversineKm(prev, cur) > thresholdKm &&
      haversineKm(cur, next) > thresholdKm &&
      haversineKm(prev, next) < thresholdKm
    ) {
      dropped.push(cur);
    }
  }
  return dropped;
}

function logComponentDebug(contributor, total, comps, dropped, intervalMs, thresholdKm) {
  console.log(
    `[gpsfilter] contributor="${contributor}" points=${total} components=${comps.length} ` +
      `interval~=${(intervalMs / 1000).toFixed(1)}s threshold=${thresholdKm.toFixed(2)}km dropped=${dropped}`
  );
  comps.forEach((c, i) => {
    const ctr = { lat: median(c.map((p) => p.lat)), lon: median(c.map((p) => p.lon)) };
    console.log(`[gpsfilter]   comp#${i} points=${c.length}${i === 0 ? ' (largest)' : ''} center=${ctr.lat.toFixed(3)},${ctr.lon.toFixed(3)}`);
  });
}

// When GPS_DUMP_BATCHES=true, write every incoming batch to data/debug/samples/
// as JSON: raw samples + per-sample verdict + per-component diagnostics.
//
// Filename = sha256(raw samples), so re-uploading the SAME batch overwrites the
// same file (no duplicates piling up across re-uploads); different batches get
// different files. receivedAt/batchIndex inside the JSON give order/timing.
function dumpBatch(list, decisions, compMetas, rejected) {
  const index = dumpSeq++;
  const receivedAt = new Date().toISOString();
  const samples = list.map((s, i) => {
    const d = (decisions && decisions.get(s)) || { verdict: 'kept', reason: decisions ? 'unknown' : 'filter-disabled' };
    const entry = { i, verdict: d.verdict, reason: d.reason };
    if (d.distanceKm != null) entry.distanceKm = d.distanceKm;
    entry.raw = s;
    return entry;
  });
  const payload = {
    receivedAt,
    batchIndex: index,
    batchSize: list.length,
    rejected,
    filterEnabled: ENABLED,
    config: {
      fallbackIntervalSec: FALLBACK_INTERVAL_SEC,
      maxSpeedKmh: MAX_SPEED_KMH,
      minGroupSize: MIN_GROUP_SIZE,
      keepRatio: KEEP_RATIO,
      dominantFraction: DOMINANT_FRACTION,
      minOutlierKm: MIN_OUTLIER_KM,
      bbox: BBOX,
    },
    components: compMetas || [],
    samples,
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 16);
  const name = `${hash}.json`;
  fsp.writeFile(path.join(DUMP_DIR, name), JSON.stringify(payload))
    .catch((e) => console.error('[gpsfilter] dump write failed:', e.message));
}

/**
 * Filter a batch of raw samples. Returns { samples: keptSamples, rejected }.
 * `rejected` counts only outliers removed here. Missing/non-finite coords,
 * out-of-range and GPS-only samples are left for db.insertSamples() to count
 * under its existing `skipped` path, so the upload accounting stays additive.
 */
function filterSamples(samples) {
  const list = Array.isArray(samples) ? samples : [];

  if (!ENABLED) {
    if (DUMP) dumpBatch(list, null, [], 0);
    return { samples: list, rejected: 0 };
  }

  const decisions = DUMP ? new Map() : null; // sample obj -> { verdict, reason, distanceKm? }
  const compMetas = DUMP ? [] : null;
  const seqPoints = [];   // eligible for analysis (valid coord + timestamp)
  const passThrough = []; // kept as-is (can't analyse: bad/no timestamp)
  let rejected = 0;

  for (const s of list) {
    const lat = s.latitude || s.lat;
    const lon = s.longitude || s.lon;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      passThrough.push(s); // insert loop counts this under `skipped`
      if (decisions) decisions.set(s, { verdict: 'kept', reason: 'no-coord' });
      continue;
    }
    if (BBOX && !inBbox(lat, lon, BBOX)) {
      rejected++; // outside configured geofence
      if (decisions) decisions.set(s, { verdict: 'rejected', reason: 'bbox' });
      continue;
    }
    const t = parseTime(s.timestamp);
    if (t === null) {
      passThrough.push(s); // no usable timestamp → keep, can't analyse
      if (decisions) decisions.set(s, { verdict: 'kept', reason: 'no-time' });
      continue;
    }
    seqPoints.push({ s, lat, lon, t });
  }

  // Group by contributor (|| source), sort by time, build components, filter.
  const groups = new Map();
  for (const p of seqPoints) {
    const key = p.s.contributor || p.s.source || '__unknown__';
    const arr = groups.get(key);
    if (arr) arr.push(p);
    else groups.set(key, [p]);
  }

  const acceptedSamples = [];
  for (const [contributor, points] of groups) {
    points.sort((a, b) => a.t - b.t);
    const intervalMs = estimateIntervalMs(points) ?? FALLBACK_INTERVAL_SEC * 1000;
    const thresholdKm = Math.max(MIN_OUTLIER_KM, ((intervalMs / 1000) * MAX_SPEED_KMH) / 3600);
    const sessionGapMs = intervalMs * GROUP_GAP_FACTOR;

    // A batch is just ~100 samples and may span several drives. Split into
    // time-based sessions (a long gap = a different drive) and detect outliers
    // WITHIN a session only — never across a gap. That's what keeps a glitch in a
    // long-span batch from being bridged to a real track on the other side.
    for (const session of splitSessions(points, sessionGapMs)) {
      if (session.length < MIN_GROUP_SIZE) {
        for (const p of session) {
          acceptedSamples.push(p.s);
          if (decisions) decisions.set(p.s, { verdict: 'kept', reason: 'small-session' });
        }
        if (compMetas) {
          const ctr = { lat: median(session.map((p) => p.lat)), lon: median(session.map((p) => p.lon)) };
          compMetas.push({ contributor, session: true, points: session.length, largest: true, kept: true, center: { lat: +ctr.lat.toFixed(5), lon: +ctr.lon.toFixed(5) }, intervalSec: +(intervalMs / 1000).toFixed(2), thresholdKm: +thresholdKm.toFixed(3) });
        }
        continue;
      }

      const dropped = new Set();
      const spikeDropped = new Set();
      // Pass 1: transient excursions — a point far from BOTH neighbours while they
      // stay close ("went out and came back"). Catches a lone glitch.
      for (const p of spikeFilter(session, thresholdKm)) { spikeDropped.add(p.s); dropped.add(p.s); }

      // Pass 2: sustained glitch blobs via connectivity on the survivors.
      const survivors = session.filter((p) => !dropped.has(p.s));
      const comps = mergeComponents(connectedComponents(survivors), thresholdKm * MERGE_FACTOR);
      comps.sort((a, b) => b.length - a.length);
      const largest = comps[0] || [];
      const total = survivors.length;
      const dominant = comps.length > 1 && largest.length / total >= DOMINANT_FRACTION;
      const keepSize = largest.length * KEEP_RATIO;
      // Within a session a real point must be reachable from the main track at a
      // plausible speed. A separate component farther than the session's time span
      // allows is unreachable → a glitch. (Catches far blobs in SMALL sessions,
      // where the relative keep-size rule alone is too loose.)
      const largestCenter = largest.length ? { lat: median(largest.map((p) => p.lat)), lon: median(largest.map((p) => p.lon)) } : null;
      const spanSec = session.length > 1 ? (session[session.length - 1].t - session[0].t) / 1000 : 0;
      const maxReachKm = Math.max(MIN_OUTLIER_KM, (spanSec * MAX_SPEED_KMH) / 3600);
      for (let i = 0; i < comps.length; i++) {
        const c = comps[i];
        const ctr = { lat: median(c.map((p) => p.lat)), lon: median(c.map((p) => p.lon)) };
        const far = largestCenter ? haversineKm(ctr, largestCenter) > maxReachKm : false;
        const dropComp = dominant && i !== 0 && (c.length < keepSize || far);
        if (dropComp) for (const p of c) dropped.add(p.s);
        if (compMetas) {
          compMetas.push({
            contributor, session: true, points: c.length, largest: i === 0, kept: !dropComp,
            center: { lat: +ctr.lat.toFixed(5), lon: +ctr.lon.toFixed(5) },
            intervalSec: +(intervalMs / 1000).toFixed(2), thresholdKm: +thresholdKm.toFixed(3),
          });
        }
      }
      rejected += dropped.size;
      if (DEBUG) logComponentDebug(contributor, session.length, comps, dropped.size, intervalMs, thresholdKm);

      const centroid = decisions && largest.length ? { lat: median(largest.map((p) => p.lat)), lon: median(largest.map((p) => p.lon)) } : null;
      for (const p of session) {
        if (dropped.has(p.s)) {
          if (decisions) decisions.set(p.s, { verdict: 'rejected', reason: spikeDropped.has(p.s) ? 'spike' : 'cluster', distanceKm: centroid ? +haversineKm(p, centroid).toFixed(3) : undefined });
        } else {
          acceptedSamples.push(p.s);
          if (decisions) decisions.set(p.s, { verdict: 'kept', reason: 'cluster' });
        }
      }
    }
  }

  if (DUMP) dumpBatch(list, decisions, compMetas, rejected);
  return { samples: [...passThrough, ...acceptedSamples], rejected };
}

module.exports = {
  filterSamples,
  haversineKm,
  estimateIntervalMs,
  connectedComponents,
  config: {
    enabled: ENABLED,
    dumpBatches: DUMP,
    fallbackIntervalSec: FALLBACK_INTERVAL_SEC,
    maxSpeedKmh: MAX_SPEED_KMH,
    minGroupSize: MIN_GROUP_SIZE,
    groupGapFactor: GROUP_GAP_FACTOR,
    keepRatio: KEEP_RATIO,
    dominantFraction: DOMINANT_FRACTION,
    minOutlierKm: MIN_OUTLIER_KM,
    bbox: !!BBOX,
  },
};
