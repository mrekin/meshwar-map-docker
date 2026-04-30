const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOW_UPLOAD = process.env.ALLOW_UPLOAD === 'true';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve map config (center, zoom) from environment variables
app.get('/api/config', (req, res) => {
  res.json({
    center: [
      parseFloat(process.env.MAP_CENTER_LAT || '47.6062'),
      parseFloat(process.env.MAP_CENTER_LON || '-122.3321'),
    ],
    zoom: parseInt(process.env.MAP_ZOOM || '10'),
  });
});

// ==================== GET /api/samples ====================
// Returns coverage data in the same format as the Cloudflare version
// so the existing frontend works without modification.
app.get('/api/samples', (req, res) => {
  try {
    const coverage = db.getCoverage();
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
app.post('/api/samples', (req, res) => {
  if (!ALLOW_UPLOAD) {
    return res.status(403).json({ 
      error: 'Uploads disabled. Use the import tool or set ALLOW_UPLOAD=true.' 
    });
  }
  
  try {
    const { samples } = req.body;
    
    if (!samples || !Array.isArray(samples)) {
      return res.status(400).json({ error: 'Invalid request: samples array required' });
    }
    
    const result = db.insertSamples(samples);
    const stats = db.getGlobalStats();
    
    res.json({
      success: true,
      samplesReceived: samples.length,
      samplesProcessed: result.inserted,
      samplesDeduped: result.skipped,
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

// ==================== Start Server ====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  MeshCore Wardrive Map Server`);
  console.log(`  ──────────────────────────────`);
  console.log(`  🗺️  Map:     http://localhost:${PORT}`);
  console.log(`  📡 API:     http://localhost:${PORT}/api/samples`);
  console.log(`  📊 Stats:   http://localhost:${PORT}/api/stats`);
  console.log(`  👥 Leaders: http://localhost:${PORT}/api/contributors`);
  console.log(`  📤 Upload:  ${ALLOW_UPLOAD ? 'ENABLED' : 'DISABLED (set ALLOW_UPLOAD=true to enable)'}`);
  console.log(`  💾 DB:      ${process.env.DB_PATH || 'data/meshwar.db'}`);
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
