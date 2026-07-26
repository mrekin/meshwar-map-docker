#!/usr/bin/env node
// MeshCore Repeater Contacts Import Tool (GPX)
// Imports repeater locations from a meshcore-open GPX export into the database
// for map display (true positions for the "Show repeaters" / "Show Edges" layers).
//
// Usage:
//   node import-repeaters-gpx.js <file.gpx> [--added-by NAME]
//
// GPX format (meshcore-open exporter): <wpt lat=".." lon=".."> waypoints with
//   <name>..</name> and <desc>Type: <Type> Public Key: <64hex></desc>
// Only "Type: Repeater" waypoints are imported. node_id = first 8 hex chars of
// the public key (uppercase) — matches the wardrive-app upload convention so
// edge lines link to the right coverage cells. Idempotent (re-run updates).

const path = require('path');
const fs = require('fs');

// db.js resolves the DB path from config/meshwar.yaml (storage.db_path),
// falling back to data/meshwar.db — no env var needed.
const db = require('../server/db');

const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('--'));
const addedByIdx = args.indexOf('--added-by');
const addedBy = (addedByIdx >= 0 && args[addedByIdx + 1]) ? args[addedByIdx + 1] : 'gpx-import';

if (!inputFile) {
  console.error('Usage: node import-repeaters-gpx.js <file.gpx> [--added-by NAME]');
  process.exit(1);
}

if (!fs.existsSync(inputFile)) {
  console.error(`Error: File not found: ${inputFile}`);
  process.exit(1);
}

// Minimal XML entity decoder (names/desc may contain entities; CDATA unsupported).
function decodeEntities(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Decode entities, strip C0/DEL control chars, trim. The meshcore-open exporter
// encodes nameless repeaters as e.g. "&#x1;"; return null so the frontend falls
// back to node_id instead of rendering a control char.
function cleanName(s) {
  const decoded = decodeEntities(s);
  if (!decoded) return null;
  const cleaned = decoded.replace(/[\x00-\x1F\x7F]/g, '').trim();
  return cleaned || null;
}

// Parse GPX text -> { repeaters, stats }. Pure, no I/O.
function parseGpx(xmlText) {
  const repeaters = [];
  const stats = { waypoints: 0, repeaters: 0, rooms: 0, noKey: 0, malformed: 0 };

  const blockRe = /<wpt\b[^>]*>([\s\S]*?)<\/wpt>/g;
  const latRe = /<wpt\b[^>]*?\slat\s*=\s*["']([^"']+)["']/i;
  const lonRe = /<wpt\b[^>]*?\slon\s*=\s*["']([^"']+)["']/i;
  const nameRe = /<name>([^<]*)<\/name>/;
  const descRe = /<desc>([^<]*)<\/desc>/;
  const typeRe = /Type:\s*([A-Za-z0-9_-]+)/;
  const keyRe = /Public Key:\s*([0-9a-fA-F]{64})/;

  // Single export date for the whole file (meshcore-open writes it in
  // <metadata><time>). Used as the per-batch source date for the staleness guard.
  const metaTimeRe = /<metadata>[\s\S]*?<time>([^<]+)<\/time>/i;
  const fileDate = ((metaTimeRe.exec(xmlText) || [])[1] || '').trim() || null;

  let m;
  while ((m = blockRe.exec(xmlText)) !== null) {
    const full = m[0];   // whole <wpt ...> ... </wpt> (for lat/lon on opening tag)
    const inner = m[1];  // children only (name/desc)
    stats.waypoints++;

    const lat = parseFloat((latRe.exec(full) || [])[1]);
    const lon = parseFloat((lonRe.exec(full) || [])[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { stats.malformed++; continue; }

    const name = cleanName((nameRe.exec(inner) || [])[1]);
    const desc = decodeEntities((descRe.exec(inner) || [, ''])[1]);

    const type = (typeRe.exec(desc) || [])[1];
    if (type !== 'Repeater') { stats.rooms++; continue; }  // Room and any other type

    const pubkey = (keyRe.exec(desc) || [])[1];
    if (!pubkey) { stats.noKey++; continue; }

    repeaters.push({
      node_id: pubkey.substring(0, 8).toUpperCase(),
      latitude: lat,
      longitude: lon,
      name,
      elevation: null,
    });
    stats.repeaters++;
  }

  return { repeaters, stats, fileDate };
}

try {
  const xml = fs.readFileSync(inputFile, 'utf8');
  const { repeaters, stats, fileDate } = parseGpx(xml);

  console.log(`GPX: ${path.basename(inputFile)} — ${stats.waypoints} waypoints ` +
    `(${stats.repeaters} repeaters, ${stats.rooms} rooms/other, ${stats.noKey} no key, ${stats.malformed} malformed)`);
  console.log(`  Source date:       ${fileDate || '(none — staleness check disabled)'}`);

  if (repeaters.length === 0) {
    console.error('No importable Type:Repeater waypoints with a public key found.');
    db.close();
    process.exit(1);
  }

  const result = db.importRepeaters(repeaters, addedBy, fileDate);
  const skipped = repeaters.length - result.inserted - result.updated - result.skippedStale;

  console.log(`Import complete:`);
  console.log(`  Inserted:          ${result.inserted}`);
  console.log(`  Updated:           ${result.updated}`);
  console.log(`  Skipped (0,0/oob): ${skipped}`);
  if (result.skippedStale > 0) {
    console.log(`  Skipped (stale):   ${result.skippedStale} (older than existing data)`);
  }
  console.log(`  Total in DB:       ${db.getRepeaters().length} repeaters`);
  console.log(`  Added by:          ${addedBy}`);

  db.close();
  process.exit(0);
} catch (err) {
  console.error(`Critical Error: ${err.message}`);
  process.exit(1);
}
