// Map tile proxy with optional on-disk cache.
//
// Frontend always loads tiles through /tiles/:theme/:z/:x/:y.png. The proxy:
//   - rotates CARTO subdomains and falls back CARTO -> ... -> OSM on failure;
//   - when tiles.cache_enabled: caches tiles on disk, serves them even when
//     stale (stale-while-error), refreshes expired tiles in the background
//     (stale-while-revalidate), and evicts oldest tiles when the cache exceeds
//     tiles.max_mb (asynchronously, at request time);
//   - when tiles.cache_enabled: false: stateless relay, nothing is written to disk
//     (failover + in-memory blank/negative cache still apply);
//   - last resort (all upstreams down, no cached copy): a solid blank tile.
//
// Cache metadata is the filesystem itself: a tile's mtime is its cached-at time
// (TTL = now - mtime). Total size is summed by an async directory walk, which is
// throttled to at most once per tiles.prune_interval_sec (default 15s) and only
// triggered when a new tile is written.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const config = require('./config');

const router = express.Router();

// ---- config (config/meshwar.yaml, via server/config.js) ----
const tc = config.tiles;
const CACHE_ENABLED = tc.cache_enabled !== false;
const TTL_MS = Math.max(1, Number(tc.ttl_days) || 30) * 864e5;
const MAX_BYTES = Math.max(1, Number(tc.max_mb) || 500) * 1e6;
const UPSTREAM_COOLDOWN_MS = 30e3;  // fast-fail cache misses while all upstreams are unreachable
const FETCH_TIMEOUT_MS = 6000;      // per-upstream timeout
const PRUNE_MIN_INTERVAL_MS = Math.max(1, Number(tc.prune_interval_sec) || 15) * 1000; // min gap between eviction walks (only on new writes)

const ROOT = path.join(__dirname, '..', 'data', 'tiles');
if (CACHE_ENABLED) fs.mkdirSync(ROOT, { recursive: true });

// ---- upstream SOCKS5 proxy (optional) ----
// When tiles.upstream_proxy is set (e.g. socks5h://user:pass@host:1080), upstream
// tile fetches (CARTO/OSM) are tunneled through it. Empty/absent = direct.
// Requires the "socks-proxy-agent" npm package; falls back to direct if missing.
const PROXY_URL = tc.upstream_proxy || '';
let proxyAgent = undefined;
if (PROXY_URL) {
  try {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    proxyAgent = new SocksProxyAgent(PROXY_URL);
  } catch (e) {
    console.error(`[tiles] tiles.upstream_proxy set but "socks-proxy-agent" not installed; using direct. (${e.message})`);
  }
}

// ---- blank tile (last resort), generated in memory, no deps ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function solidPng(r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); // 1x1
  ihdr[8] = 8; ihdr[9] = 2;                        // 8-bit RGB
  const idat = zlib.deflateSync(Buffer.from([0, r, g, b])); // filter 0 + 1 pixel
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
const BLANK = { dark: solidPng(20, 20, 20), voyager: solidPng(238, 233, 223), light: solidPng(225, 225, 225), osm: solidPng(235, 230, 220) };

// ---- runtime state ----
const inflight = new Map();  // key -> Promise  (dedup parallel fetches)
let upstreamDownUntil = 0;   // while in the future, skip upstream and serve blank on cache miss
let totalBytes = null;       // unknown until first eviction walk reconciles it
let pruneAt = 0, pruning = false;

// ---- upstream failover ----
const CARTO_SUBS = ['a', 'b', 'c', 'd'];
const OSM_SUBS = ['a', 'b', 'c'];
function upstreams(theme, z, x, y) {
  // 'osm' = the OpenStreetMap standard style, sourced straight from the OSM tile
  // servers (a/b/c subdomains). All three subdomains serve the same tiles, so they
  // double as the failover chain; the blank tile is the last resort.
  if (theme === 'osm') {
    const so1 = OSM_SUBS[(x + y) % 3];
    const so2 = OSM_SUBS[(x + y + 1) % 3];
    return [
      `https://${so1}.tile.openstreetmap.org/${z}/${x}/${y}.png`,
      `https://${so2}.tile.openstreetmap.org/${z}/${x}/${y}.png`,
      `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    ];
  }
  const t = theme === 'dark' ? 'dark_all'
          : theme === 'voyager' ? 'rastertiles/voyager'
          : 'light_all';
  const s1 = CARTO_SUBS[(x + y) % 4];
  const s2 = CARTO_SUBS[(x + y + 2) % 4];
  return [
    `https://${s1}.basemaps.cartocdn.com/${t}/${z}/${x}/${y}.png`,
    `https://${s2}.basemaps.cartocdn.com/${t}/${z}/${x}/${y}.png`,
    `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  ];
}
function fetchOne(url) {
  // Uses node http/https + an optional agent so the same path works direct or
  // through a SOCKS5 proxy (agent = undefined => direct connection).
  return new Promise((resolve) => {
    let settled = false, req;
    const t = setTimeout(() => { settled = true; try { req.destroy(); } catch {} resolve(null); }, FETCH_TIMEOUT_MS);
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(t); resolve(v); };
    try {
      req = (url.startsWith('https:') ? https : http).get(url, {
        agent: proxyAgent,
        headers: { 'User-Agent': 'meshwar-tile-proxy/1.0' },
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(null); }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => { const b = Buffer.concat(chunks); finish(b.length ? b : null); });
      });
      req.on('error', () => finish(null));
    } catch { finish(null); }
  });
}
async function fetchWithFailover(theme, z, x, y) {
  for (const u of upstreams(theme, z, x, y)) {
    const buf = await fetchOne(u);
    if (buf) return buf;
  }
  return null;
}

// ---- paths ----
const fileFor = (theme, z, x, y) => path.join(ROOT, theme, String(z), String(x), `${y}.png`);
const keyFor = (theme, z, x, y) => `${theme}/${z}/${x}/${y}`;

// ---- disk write (write-through) + size accounting ----
async function writeTile(theme, z, x, y, buf) {
  const f = fileFor(theme, z, x, y);
  await fsp.mkdir(path.dirname(f), { recursive: true });
  await fsp.writeFile(f, buf);
  totalBytes = (totalBytes || 0) + buf.length;
  maybePrune();
}

// ---- stale-while-revalidate: refresh expired tile without blocking the response ----
function backgroundRefresh(theme, z, x, y) {
  const key = keyFor(theme, z, x, y);
  if (inflight.has(key)) return;
  if (Date.now() < upstreamDownUntil) return; // upstream unreachable — skip refresh
  const p = fetchWithFailover(theme, z, x, y)
    .then(buf => { if (buf) return writeTile(theme, z, x, y, buf); })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
}

// ---- eviction: async, throttled (>=15s apart), oldest-mtime first until <= 90% of cap.
//      Triggered only from writeTile (i.e. when a new tile is cached). ----
function maybePrune() {
  if (!CACHE_ENABLED || pruning || Date.now() < pruneAt) return;
  pruning = true;
  pruneAt = Date.now() + PRUNE_MIN_INTERVAL_MS;
  setImmediate(async () => {
    try {
      const files = [];
      (function walk(d) {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          const p = path.join(d, ent.name);
          if (ent.isDirectory()) walk(p); else files.push(p);
        }
      })(ROOT);
      const sized = await Promise.all(files.map(async p => {
        const st = await fsp.stat(p);
        return { p, s: st.size, m: st.mtimeMs };
      }));
      totalBytes = sized.reduce((a, f) => a + f.s, 0);
      if (totalBytes > MAX_BYTES) {
        sized.sort((a, b) => a.m - b.m);
        for (const f of sized) {
          if (totalBytes <= MAX_BYTES * 0.9) break;
          await fsp.unlink(f.p).catch(() => {});
          totalBytes -= f.s;
        }
      }
    } catch { /* best-effort */ }
    finally { pruning = false; }
  });
}
if (CACHE_ENABLED) maybePrune(); // reconcile totalBytes on boot

// ---- route ----
router.get('/:theme/:z/:x/:y.png', async (req, res) => {
  const { theme, z, x, y } = req.params;
  if (!['dark', 'voyager', 'light', 'osm'].includes(theme)) return res.status(404).end();
  const zi = +z, xi = +x, yi = +y;
  if (!Number.isInteger(zi) || zi < 0 || zi > 19 || xi < 0 || yi < 0) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');

  // 1) Cached? Serve always (stale-while-error); refresh in background if stale.
  if (CACHE_ENABLED) {
    try {
      const f = fileFor(theme, zi, xi, yi);
      const st = await fsp.stat(f);
      const buf = await fsp.readFile(f);
      res.type('png').send(buf);
      if (Date.now() - st.mtimeMs > TTL_MS) backgroundRefresh(theme, zi, xi, yi);
      return;
    } catch { /* miss */ }
  }

  // 2) Upstream known unreachable? Fast-fail this cache miss to a blank tile.
  //    The cooldown is GLOBAL (not per-tile) and clears on the first successful
  //    fetch, so no tile gets "stuck" blank after the upstream recovers.
  if (Date.now() < upstreamDownUntil) return res.type('png').send(BLANK[theme]);

  // 3) Live fetch with failover.
  const buf = await fetchWithFailover(theme, zi, xi, yi);
  if (buf) {
    upstreamDownUntil = 0;  // upstream healthy again — clear the cooldown
    if (CACHE_ENABLED) writeTile(theme, zi, xi, yi, buf).catch(() => {});
    return res.type('png').send(buf);
  }

  // 4) All upstreams failed -> blank + global cooldown (>= one failover cycle,
  //    so concurrent misses don't launch overlapping probes). Self-heals ~30s.
  upstreamDownUntil = Date.now() + UPSTREAM_COOLDOWN_MS;
  res.type('png').send(BLANK[theme]);
});

router.config = { enabled: CACHE_ENABLED, ttlDays: TTL_MS / 864e5, maxMb: MAX_BYTES / 1e6, upstreamProxy: !!proxyAgent };
module.exports = router;
