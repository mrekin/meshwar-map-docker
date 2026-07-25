// Unified configuration loader.
//
// All behavioral settings live in ONE YAML file (default config/meshwar.yaml —
// ./config/ on the host, /app/config/ in the Docker container). It is parsed
// with js-yaml and deep-merged over the built-in DEFAULTS below, so any omitted
// key falls back to its default: the app runs unchanged with NO config file at
// all. See config/meshwar.example.yaml for the full, commented schema.
//
// Only three things stay in .env:
//   - PORT           — docker-compose needs it for host port mapping BEFORE the
//                      app starts, so it can't live in the YAML.
//   - CONFIG_PATH    — points here (this loader); optional, has a default.
//   - UPLOAD_TOKEN   — a secret (auth for write endpoints).
//
// A MISSING file is the normal "no custom config" case (silent, defaults used).
// A MALFORMED file is logged and falls back to defaults — parsing never throws,
// so a typo in the YAML never crashes the app (mirrors the forwarders' philosophy).
//
// This module depends only on js-yaml, so tools/* can require it safely.

const fs = require('fs');
const path = require('path');

let yaml = null;
try {
  yaml = require('js-yaml');
} catch {
  // js-yaml is a declared dependency; if it is somehow missing we degrade to
  // defaults rather than crash. The install step is expected to provide it.
}

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '..', 'config', 'meshwar.yaml');

// Safe defaults for every key. Mirrors the previous `process.env.X || default`
// fallbacks one-to-one. storage.db_path is intentionally '' — when empty, each
// consumer falls back to its computed default path (data/meshwar.db).
const DEFAULTS = {
  server: { allow_upload: false },
  map: { center_lat: 47.6062, center_lon: -122.3321, zoom: 10 },
  storage: { db_path: '' },
  tiles: {
    cache_enabled: true,
    ttl_days: 30,
    max_mb: 500,
    prune_interval_sec: 15,
    upstream_proxy: '',
  },
  gps_filter: {
    enabled: true,
    sample_interval_sec: 25,
    max_speed_kmh: 150,
    group_gap_factor: 3,
    min_group_size: 3,
    keep_fraction: 0.5,
    min_outlier_km: 0.5,
    bbox: '',
    debug: false,
    dump_batches: false,
  },
  forwarders: [],
};

/**
 * Deep-merge `over` onto `base`. Objects recurse; arrays and scalars from
 * `over` replace `base` wholesale (a YAML array replaces the default array,
 * it is not concatenated). `undefined` in `over` keeps `base`.
 */
function deepMerge(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(over) || Array.isArray(base)) return over;
  if (typeof base !== 'object' || base === null || typeof over !== 'object' || over === null) {
    return over;
  }
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

/** Read & parse CONFIG_PATH, merged over DEFAULTS. Missing file => defaults. */
function loadConfig() {
  let parsed = {};
  if (!yaml) {
    console.error('[config] js-yaml not installed — using defaults');
    return deepMerge(DEFAULTS, parsed);
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const data = yaml.load(raw);
    if (data == null) {
      parsed = {}; // empty file
    } else if (typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`top level must be a mapping of sections, got ${Array.isArray(data) ? 'array' : typeof data}`);
    } else {
      parsed = data;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[config] failed to read ${CONFIG_PATH}: ${e.message} — using defaults`);
    }
    parsed = {};
  }
  return deepMerge(DEFAULTS, parsed);
}

const config = loadConfig();

module.exports = config;
module.exports.configPath = CONFIG_PATH;
module.exports.DEFAULTS = DEFAULTS;
module.exports._loadConfig = loadConfig;
