const Database = require('better-sqlite3');
const path = require('path');
const config = require('./config');
const geohash = require('./geohash');
const gpsFilter = require('./gpsfilter');

const DB_PATH = config.storage.db_path || path.join(__dirname, '..', 'data', 'meshwar.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  const d = getDb();
  
  d.exec(`
    CREATE TABLE IF NOT EXISTS samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_id TEXT UNIQUE,
      geohash TEXT NOT NULL,
      node_id TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      rssi INTEGER,
      snr INTEGER,
      ping_success INTEGER,
      timestamp TEXT NOT NULL,
      app_version TEXT,
      contributor TEXT,
      import_date TEXT,
      region TEXT
    )
  `);
  
  d.exec(`CREATE INDEX IF NOT EXISTS idx_samples_geohash ON samples (geohash)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_samples_timestamp ON samples (timestamp)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_samples_contributor ON samples (contributor)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_samples_sample_id ON samples (sample_id)`);
  
  // Repeater contacts table
  d.exec(`
    CREATE TABLE IF NOT EXISTS repeaters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT UNIQUE NOT NULL,
      name TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      elevation REAL,
      added_at TEXT NOT NULL,
      added_by TEXT
    )
  `);
}

/**
 * Get aggregated coverage data in the same format as the Cloudflare version.
 * Returns { coverage: { geohash: { received, lost, samples, repeaters, lastUpdate, appVersion } } }
 */
function getCoverage(contributorFilter = null) {
  const d = getDb();
  const cutoff = '1970-01-01T00:00:00.000Z';
  
  // Get all non-expired samples with actual ping data
  let query = `
    SELECT geohash, node_id, latitude, longitude, rssi, snr, 
           ping_success, timestamp, app_version, contributor
    FROM samples
    WHERE timestamp > ? AND ping_success IS NOT NULL
  `;
  const params = [cutoff];
  
  if (contributorFilter) {
    query += ' AND contributor = ?';
    params.push(contributorFilter);
  }
  
  query += ' ORDER BY timestamp ASC';
  const rows = d.prepare(query).all(...params);
  
  const coverage = {};
  
  for (const row of rows) {
    const hash = row.geohash;
    
    if (!coverage[hash]) {
      coverage[hash] = {
        received: 0,
        lost: 0,
        samples: 0,
        repeaters: {},
        firstSeen: row.timestamp,
        lastUpdate: row.timestamp,
        appVersion: row.app_version || 'unknown',
      };
    }
    
    const cell = coverage[hash];
    const success = row.ping_success === 1;
    const failed = row.ping_success === 0;
    
    if (success) {
      cell.received += 1;
      
      if (row.node_id && row.node_id !== 'none' && row.node_id !== 'Unknown') {
        const nodeId = row.node_id.length > 8 
          ? row.node_id.substring(0, 8).toUpperCase() 
          : row.node_id.toUpperCase();
        
        const sampleTime = new Date(row.timestamp).getTime();
        if (!cell.repeaters[nodeId] || 
            new Date(cell.repeaters[nodeId].lastSeen).getTime() < sampleTime) {
          cell.repeaters[nodeId] = {
            name: nodeId,
            rssi: row.rssi || null,
            snr: row.snr || null,
            lastSeen: row.timestamp,
          };
        }
      }
    } else if (failed) {
      cell.lost += 1;
    }
    
    cell.samples += 1;
    
    if (row.timestamp > cell.lastUpdate) {
      cell.lastUpdate = row.timestamp;
    }
    if (row.app_version && row.app_version !== 'unknown') {
      cell.appVersion = row.app_version;
    }
  }
  
  // Filter out cells with no ping data
  for (const hash of Object.keys(coverage)) {
    if ((coverage[hash].received + coverage[hash].lost) === 0) {
      delete coverage[hash];
    }
  }
  
  return coverage;
}

/**
 * Insert samples from an upload or import.
 * Deduplicates by sample_id. Drops GPS outliers via the pre-pass filter.
 *
 * Options (second arg) — or, for back-compat, the legacy positional call
 * insertSamples(samples, contributor, region) still works:
 *   - prefiltered: already-filtered sample array; skips the GPS filter pass
 *                  (use this when the caller filtered & wants the clean set
 *                  back, e.g. the HTTP upload path that forwards it).
 *   - contributor / region: same as the positional args.
 * Returns { inserted, skipped, rejected }
 */
function insertSamples(samples, opts) {
  // Back-compat: legacy positional call insertSamples(samples, contributor, region).
  let contributor, region, prefiltered;
  if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
    ({ contributor = null, region = null, prefiltered } = opts);
  } else {
    contributor = opts ?? null;
    region = arguments[2] ?? null;
  }

  const d = getDb();
  const importDate = new Date().toISOString();

  // Pre-pass: drop GPS outliers (implausible-speed excursions + optional bbox).
  // Skipped when the caller passes an already-filtered set (prefiltered=true);
  // then `samples` IS the filtered set, so use it directly.
  let clean, rejected;
  if (prefiltered) {
    clean = samples;
    rejected = 0;
  } else {
    ({ samples: clean, rejected } = gpsFilter.filterSamples(samples));
  }

  const insert = d.prepare(`
    INSERT OR IGNORE INTO samples
    (sample_id, geohash, node_id, latitude, longitude, rssi, snr,
     ping_success, timestamp, app_version, contributor, import_date, region)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let skipped = 0;

  const tx = d.transaction((samples) => {
    for (const s of samples) {
      const lat = s.latitude || s.lat;
      const lon = s.longitude || s.lon;
      
      if (!lat || !lon) { skipped++; continue; }
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) { skipped++; continue; }
      
      // Skip GPS-only samples
      if (s.pingSuccess === null || s.pingSuccess === undefined) { skipped++; continue; }
      
      const hash = geohash.encode(lat, lon, 7);
      const nodeId = s.nodeId || s.node_id || s.path || null;
      const sampleId = s.id || `${lat.toFixed(6)}|${lon.toFixed(6)}|${s.timestamp}|${nodeId}`;
      const pingSuccess = s.pingSuccess === true ? 1 : (s.pingSuccess === false ? 0 : null);
      
      const result = insert.run(
        sampleId,
        hash,
        nodeId,
        lat,
        lon,
        s.rssi ?? null,
        s.snr ?? null,
        pingSuccess,
        s.timestamp || new Date().toISOString(),
        s.appVersion || s.app_version || null,
        contributor || s.source || null,
        importDate,
        region || null
      );
      
      if (result.changes > 0) inserted++;
      else skipped++;
    }
  });
  
  tx(clean);
  return { inserted, skipped, rejected };
}

/**
 * Calculates discovery credit. A discovery is awarded to the contributor
 * who uploaded the EARLIEST timestamped sample for a specific node_id.
 */
function getRepeaterDiscoveryStats() {
    const d = getDb();
    return d.prepare(`
        WITH FirstDiscovery AS (
            SELECT 
                node_id, 
                contributor,
                MIN(timestamp) as first_time
            FROM samples
            WHERE node_id IS NOT NULL
            GROUP BY node_id
        )
        SELECT 
            COALESCE(contributor, 'Anonymous') as name, 
            COUNT(node_id) as discoveredCount
        FROM FirstDiscovery
        GROUP BY name
    `).all();
}

/**
 * Get stats per contributor. 
 * If days is 0, it fetches Lifetime data.
 */
function getContributorStats(days = 0) {
    const d = getDb();
    
    let cutoff;
    if (days > 0) {
        cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    } else {
        cutoff = '1970-01-01T00:00:00.000Z'; // Lifetime
    }

    const rows = d.prepare(`
        SELECT 
            COALESCE(contributor, 'Anonymous') as name,
            COUNT(*) as total_samples,
            SUM(CASE WHEN ping_success = 1 THEN 1 ELSE 0 END) as successes,
            SUM(CASE WHEN ping_success = 0 THEN 1 ELSE 0 END) as failures,
            COUNT(DISTINCT geohash) as unique_cells,
            MIN(timestamp) as first_seen,
            MAX(timestamp) as last_seen,
            COUNT(DISTINCT import_date) as import_count
        FROM samples
        WHERE timestamp > ?
        GROUP BY COALESCE(contributor, 'Anonymous')
        ORDER BY total_samples DESC
    `).all(cutoff);

    // Get the discovery trophies
    const discoveries = getRepeaterDiscoveryStats();

    return rows.map(r => {
        const discoveryEntry = discoveries.find(disc => disc.name === r.name);
        return {
            name: r.name,
            totalSamples: r.total_samples,
            successes: r.successes,
            failures: r.failures,
            successRate: r.total_samples > 0 
                ? ((r.successes / r.total_samples) * 100).toFixed(1) 
                : '0.0',
            uniqueCells: r.unique_cells,
            discoveredRepeaters: discoveryEntry ? discoveryEntry.discoveredCount : 0,
            firstSeen: r.first_seen,
            lastSeen: r.last_seen,
            importCount: r.import_count,
        };
    });
}

/**
 * Get global stats summary.
 */
function getGlobalStats() {
  const d = getDb();
  
  const row = d.prepare(`
    SELECT 
      COUNT(*) as total_samples,
      COUNT(DISTINCT geohash) as total_cells,
      COUNT(DISTINCT COALESCE(contributor, 'Anonymous')) as total_contributors,
      COUNT(DISTINCT node_id) as total_repeaters,
      MAX(timestamp) as last_update
    FROM samples
    WHERE ping_success IS NOT NULL
  `).get();
  
  return {
    totalSamples: row.total_samples,
    totalCells: row.total_cells,
    totalContributors: row.total_contributors,
    totalRepeaters: row.total_repeaters,
    lastUpdate: row.last_update,
  };
}

// ============================================================================
// REPEATER CONTACTS
// ============================================================================

/**
 * Get all repeater contacts.
 */
function getRepeaters() {
  const d = getDb();
  return d.prepare('SELECT * FROM repeaters ORDER BY name, node_id').all();
}

/**
 * Add or update a repeater contact.
 * Uses node_id as unique key — updates if exists.
 */
function upsertRepeater(nodeId, lat, lon, name = null, elevation = null, addedBy = null) {
  const d = getDb();
  return d.prepare(`
    INSERT INTO repeaters (node_id, name, latitude, longitude, elevation, added_at, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET
      name = COALESCE(excluded.name, repeaters.name),
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      elevation = COALESCE(excluded.elevation, repeaters.elevation),
      added_by = COALESCE(excluded.added_by, repeaters.added_by)
  `).run(nodeId, name, lat, lon, elevation, new Date().toISOString(), addedBy);
}

/**
 * Import multiple repeater contacts.
 * Returns { inserted, updated }
 */
function importRepeaters(repeaters, addedBy = null) {
  const d = getDb();
  let inserted = 0, updated = 0;
  
  const tx = d.transaction((list) => {
    for (const r of list) {
      const nodeId = r.node_id || r.nodeId || r.id;
      const lat = r.latitude || r.lat;
      const lon = r.longitude || r.lon;
      
      if (!nodeId || !lat || !lon) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      // Skip 0,0 positions (unknown location)
      if (lat === 0 && lon === 0) continue;
      
      const existing = d.prepare('SELECT id FROM repeaters WHERE node_id = ?').get(nodeId);
      upsertRepeater(nodeId, lat, lon, r.name || null, r.elevation || null, addedBy);
      
      if (existing) updated++;
      else inserted++;
    }
  });
  
  tx(repeaters);
  return { inserted, updated };
}

/**
 * Delete a repeater contact by node_id.
 */
function deleteRepeater(nodeId) {
  const d = getDb();
  return d.prepare('DELETE FROM repeaters WHERE node_id = ?').run(nodeId);
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { getDb, getCoverage, insertSamples, getContributorStats, getGlobalStats, getRepeaters, upsertRepeater, importRepeaters, deleteRepeater, close };
