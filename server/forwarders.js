// Optional sample forwarding to external resources.
//
// After a successful upload the server already filters GPS outliers and saves
// the clean samples to its own DB. When forwarding is configured, those SAME
// filtered samples are also POSTed to one or more external resources (other
// instances of this server, or any service speaking the same /api/samples
// protocol). Forwarding is fire-and-forget: it runs in the background after the
// upload response is sent, never throws, and one failed resource does not affect
// the others or the upload itself.
//
// Config: the `forwarders` section of config/meshwar.yaml — an array of
//   [{ name, url }]
// `url` is the full POST endpoint, including any auth — the wardrive upload
// protocol carries its token in the query string (?token=...), so the token
// simply lives in the url here. Example:
//   forwarders:
//     - name: community-map
//       url: https://map.example.org/api/samples?token=secret
// Read ONCE at boot. An entry without a url, or a non-http(s) url, is skipped
// (logged). An empty/missing list = forwarding disabled.

const http = require('http');
const https = require('https');
const config = require('./config');

const REQUEST_TIMEOUT_MS = 10000; // per forwarder

/**
 * Parse & validate the forwarders list once at boot. Never throws — a broken
 * entry is skipped (logged), never fatal. Returns the valid { name, url }[].
 */
function parseForwarders(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const targets = [];
  list.forEach((e, i) => {
    const name = (e && typeof e === 'object' && typeof e.name === 'string') ? e.name : `#${i}`;
    const url = (e && typeof e.url === 'string') ? e.url.trim() : '';
    if (!url) {
      console.error(`[forwarders] entry "${name}": missing url — skipped`);
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      console.error(`[forwarders] entry "${name}": url must start with http(s):// — skipped`);
      return;
    }
    targets.push({ name, url });
  });
  return targets;
}

const TARGETS = parseForwarders(config.forwarders);
if (TARGETS.length) {
  console.log(`[forwarders] ${TARGETS.length} resource(s) configured: ${TARGETS.map((p) => p.name).join(', ')}`);
} else {
  console.log('[forwarders] forwarding disabled (no resources configured)');
}

/**
 * POST samples to one forwarder. Resolves to { name, ok, status, error? }.
 * Never rejects.
 */
function postOne(target, samples) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ samples });
    let req;
    const timer = setTimeout(() => {
      try { req.destroy(); } catch {}
      resolve({ name: target.name, ok: false, status: 0, error: 'timeout' });
    }, REQUEST_TIMEOUT_MS);

    try {
      const lib = target.url.startsWith('https:') ? https : http;
      req = lib.request(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'meshwar-forwarder/1.0',
        },
      }, (res) => {
        res.resume(); // drain
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ name: target.name, ok, status: res.statusCode });
        });
      });
      req.on('error', (e) => {
        clearTimeout(timer);
        resolve({ name: target.name, ok: false, status: 0, error: e.message });
      });
      req.write(body);
      req.end();
    } catch (e) {
      clearTimeout(timer);
      resolve({ name: target.name, ok: false, status: 0, error: e.message });
    }
  });
}

/**
 * Forward a list of (already filtered) samples to every configured resource,
 * in parallel. No-op when nothing is configured. Never throws — call it without
 * await from the upload handler; results are logged, not returned.
 */
async function forwardSamples(samples) {
  if (!TARGETS.length || !samples || !samples.length) return;

  const results = await Promise.all(TARGETS.map((t) => postOne(t, samples)));
  for (const r of results) {
    if (r.ok) {
      console.log(`[forwarders] ${samples.length} sample(s) -> ${r.name} (HTTP ${r.status})`);
    } else {
      console.error(`[forwarders] ${r.name} failed: ${r.error || ('HTTP ' + r.status)}`);
    }
  }
}

module.exports = {
  forwardSamples,
  config: {
    enabled: TARGETS.length > 0,
    count: TARGETS.length,
  },
};
