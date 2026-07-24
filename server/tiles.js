// Map tile proxy with optional on-disk cache.
//
// Frontend always loads tiles through /tiles/:theme/:z/:x/:y.png. The proxy:
//   - rotates CARTO subdomains and falls back CARTO -> ... -> OSM on failure;
//   - when TILE_CACHE_ENABLED=true: caches tiles on disk, serves them even when
//     stale (stale-while-error), refreshes expired tiles in the background
//     (stale-while-revalidate), and evicts oldest tiles when the cache exceeds
//     TILE_MAX_MB (asynchronously, at request time);
//   - when TILE_CACHE_ENABLED=false: stateless relay, nothing is written to disk
//     (failover + in-memory blank/negative cache still apply);
//   - last resort (all upstreams down, no cached copy): a solid blank tile.
//
// Cache metadata is the filesystem itself: a tile's mtime is its cached-at time
// (TTL = now - mtime). Total size is summed by an async directory walk, which is
// throttled to at most once per TILE_PRUNE_INTERVAL_SEC (default 15s) and only
// triggered when a new tile is written.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');

const router = express.Router();

// ---- config (env) ----
const CACHE_ENABLED = (process.env.TILE_CACHE_ENABLED ?? 'true') !== 'false';
const TTL_MS = Math.max(1, parseInt(process.env.TILE_TTL_DAYS) || 30) * 864e5;
const MAX_BYTES = Math.max(1, parseInt(process.env.TILE_MAX_MB) || 500) * 1e6;
const NEG_TTL_MS = 10 * 60e3;       // remember "all upstreams failed" for this long
const FETCH_TIMEOUT_MS = 6000;      // per-upstream timeout
const PRUNE_MIN_INTERVAL_MS = Math.max(1, parseInt(process.env.TILE_PRUNE_INTERVAL_SEC) || 15) * 1000; // min gap between eviction walks (only on new writes)

const ROOT = path.join(__dirname, '..', 'data', 'tiles');
if (CACHE_ENABLED) fs.mkdirSync(ROOT, { recursive: true });

// ---- upstream SOCKS5 proxy (optional) ----
// When TILE_UPSTREAM_PROXY is set (e.g. socks5h://user:pass@host:1080), upstream
// tile fetches (CARTO/OSM) are tunneled through it. Empty/absent = direct.
// Requires the "socks-proxy-agent" npm package; falls back to direct if missing.
const PROXY_URL = process.env.TILE_UPSTREAM_PROXY || '';
let proxyAgent = undefined;
if (PROXY_URL) {
  try {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    proxyAgent = new SocksProxyAgent(PROXY_URL);
  } catch (e) {
    console.error(`[tiles] TILE_UPSTREAM_PROXY set but "socks-proxy-agent" not installed; using direct. (${e.message})`);
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
const BLANK = { dark: solidPng(20, 20, 20), light: solidPng(225, 225, 225) };

// ---- runtime state ----
const inflight = new Map();  // key -> Promise  (dedup parallel fetches)
const neg = new Map();       // key -> expiry ms (short-lived, in-memory)
let totalBytes = null;       // unknown until first eviction walk reconciles it
let pruneAt = 0, pruning = false;

// ---- upstream failover ----
const CARTO_SUBS = ['a', 'b', 'c', 'd'];
function upstreams(theme, z, x, y) {
  const t = theme === 'dark' ? 'dark_all' : 'light_all';
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
  if (theme !== 'dark' && theme !== 'light') return res.status(404).end();
  const zi = +z, xi = +x, yi = +y;
  if (!Number.isInteger(zi) || zi < 0 || zi > 19 || xi < 0 || yi < 0) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');

  const key = keyFor(theme, zi, xi, yi);

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

  // 2) Negative cache still active? Serve blank without hitting upstreams.
  const ne = neg.get(key);
  if (ne && ne > Date.now()) return res.type('png').send(BLANK[theme]);

  // 3) Live fetch with failover.
  const buf = await fetchWithFailover(theme, zi, xi, yi);
  if (buf) {
    if (CACHE_ENABLED) writeTile(theme, zi, xi, yi, buf).catch(() => {});
    return res.type('png').send(buf);
  }

  // 4) All upstreams down -> blank + short negative cache.
  neg.set(key, Date.now() + NEG_TTL_MS);
  res.type('png').send(BLANK[theme]);
});

router.config = { enabled: CACHE_ENABLED, ttlDays: TTL_MS / 864e5, maxMb: MAX_BYTES / 1e6, upstreamProxy: !!proxyAgent };
module.exports = router;
