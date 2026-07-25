const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const config = require('./config');
const db = require('./db');
const tiles = require('./tiles');
const gpsFilter = require('./gpsfilter');
const forwarders = require('./forwarders');
const pkg = require('./package.json');

const app = express();
const PORT = process.env.PORT || 3000;                     // env: docker-compose needs it for host port mapping
const ALLOW_UPLOAD = config.server.allow_upload === true;  // config/meshwar.yaml: server.allow_upload

// Token guarding write endpoints. The wardrive client app can only put the
// token in the URL, so we read it from ?token=... (header X-API-Key is also
// accepted for other clients). Unset => writes stay open (back-compat). This is
// a SECRET, so it stays in .env (never in the YAML).
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireToken(req, res, next) {
  if (!UPLOAD_TOKEN) return next();
  const provided = req.query.token || req.get('X-API-Key') || '';
  if (!provided || !timingSafeEqualStr(provided, UPLOAD_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid token (pass ?token=...)' });
  }
  next();
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static frontend (no-cache for JS/CSS during development)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// Map tile proxy — on-disk cache + upstream failover. See server/tiles.js.
// Tiles live under data/tiles/ (on the persisted data volume).
app.use('/tiles', tiles);

// Serve map config (center, zoom) from config/meshwar.yaml
app.get('/api/config', (req, res) => {
  res.json({
    center: [config.map.center_lat, config.map.center_lon],
    zoom: config.map.zoom,
    version: pkg.version,
    tileCache: tiles.config,
    gpsFilter: gpsFilter.config,
    forwarders: forwarders.config,
  });
});

// ==================== GET /api/samples ====================
// Returns coverage data in the same format as the Cloudflare version
// so the existing frontend works without modification.
app.get('/api/samples', (req, res) => {
  try {
    const contributor = req.query.contributor || null;
    const coverage = db.getCoverage(contributor);
    const stats = db.getGlobalStats();
    
    res.json({
      coverage,
      totalCells: stats.totalCells,
      totalSamples: stats.totalSamples,
      version: 1,
    });
  } catch (err) {
    console.error('Error fetching coverage:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== POST /api/samples ====================
// Accept uploads from the wardrive app (disabled by default)
app.post('/api/samples', requireToken, (req, res) => {
  if (!ALLOW_UPLOAD) {
    return res.status(403).json({
      error: 'Uploads disabled. Use the import tool or set server.allow_upload: true in config/meshwar.yaml.'
    });
  }
  
  try {
    const { samples } = req.body;

    if (!samples || !Array.isArray(samples)) {
      return res.status(400).json({ error: 'Invalid request: samples array required' });
    }

    // Filter GPS outliers once here, then pass the clean set both to the DB
    // (prefiltered, so it skips its own filter pass) and to the forwarders —
    // external resources get the SAME filtered samples we keep.
    const { samples: clean, rejected } = gpsFilter.filterSamples(samples);
    const result = db.insertSamples(clean, { prefiltered: true });
    const stats = db.getGlobalStats();

    // One-line ingest summary so filter activity is visible in the server logs.
    if (result.rejected > 0 || rejected > 0) {
      console.log(`[upload] rejected ${rejected} GPS outlier sample(s) of ${samples.length} received (inserted=${result.inserted}, deduped=${result.skipped})`);
    }

    // Forward the filtered samples to external resources, if any are configured.
    // Fire-and-forget: runs in the background, never affects this response.
    if (clean.length && forwarders.config.count > 0) {
      forwarders.forwardSamples(clean).catch((e) => console.error('[forwarders] unexpected:', e.message));
    }

    res.json({
      success: true,
      samplesReceived: samples.length,
      samplesProcessed: result.inserted,
      samplesDeduped: result.skipped,
      samplesRejected: result.rejected,
      totalCells: stats.totalCells,
    });
  } catch (err) {
    console.error('Error processing upload:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== GET /api/stats ====================
// Global stats summary
app.get('/api/stats', (req, res) => {
  try {
    const stats = db.getGlobalStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== GET /api/contributors ====================
// Contributor leaderboard
app.get('/api/contributors', (req, res) => {
  try {
    // Get 'days' from the query string, default to 0 (Lifetime)
    const days = parseInt(req.query.days) || 0;
    const contributors = db.getContributorStats(days);
    res.json({ contributors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== GET /api/repeaters ====================
// Returns all repeater contacts for map display
app.get('/api/repeaters', (req, res) => {
  try {
    const repeaters = db.getRepeaters();
    res.json({ repeaters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== POST /api/repeaters ====================
// Import repeater contacts (JSON array)
app.post('/api/repeaters', requireToken, (req, res) => {
  try {
    const { repeaters } = req.body;
    
    if (!repeaters || !Array.isArray(repeaters)) {
      return res.status(400).json({ error: 'Invalid request: repeaters array required' });
    }
    
    const addedBy = req.body.addedBy || null;
    const result = db.importRepeaters(repeaters, addedBy);
    
    res.json({
      success: true,
      inserted: result.inserted,
      updated: result.updated,
      total: db.getRepeaters().length,
    });
  } catch (err) {
    console.error('Error importing repeaters:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== DELETE /api/repeaters/:nodeId ====================
app.delete('/api/repeaters/:nodeId', requireToken, (req, res) => {
  try {
    db.deleteRepeater(req.params.nodeId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== Start Server ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  MeshCore Wardrive Map Server`);
  console.log(`  ──────────────────────────────`);
  console.log(`  🗺️  Map:     http://localhost:${PORT}`);
  console.log(`  📡 API:     http://localhost:${PORT}/api/samples`);
  console.log(`  📊 Stats:   http://localhost:${PORT}/api/stats`);
  console.log(`  👥 Leaders: http://localhost:${PORT}/api/contributors`);
  console.log(`  📤 Upload:  ${ALLOW_UPLOAD ? 'ENABLED' : 'DISABLED (set server.allow_upload: true in config/meshwar.yaml)'}`);
  console.log(`  🔐 Token:   ${UPLOAD_TOKEN ? 'ENABLED (?token=... on write endpoints)' : 'disabled (writes open)'}`);
  console.log(`  🛰️  Filter:  ${gpsFilter.config.enabled ? `ENABLED (rejects GPS outliers >${gpsFilter.config.maxSpeedKmh} km/h jumps)` : 'disabled'}`);
  console.log(`  📤 Forward: ${forwarders.config.count > 0 ? `ENABLED (${forwarders.config.count} resource(s))` : 'disabled'}`);
  console.log(`  💾 DB:      ${config.storage.db_path || 'data/meshwar.db'}`);
  console.log();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
