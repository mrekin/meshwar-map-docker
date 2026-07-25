#!/usr/bin/env node
// MeshCore Repeater Contacts Import Tool
// Imports repeater locations into the database for map display.
//
// Usage:
//   node import-repeaters.js <file.json> [--added-by NAME]
//
// JSON format (array of objects):
//   [{ "node_id": "BAD5DC49", "name": "Hilltop Repeater", "lat": 47.6, "lon": -122.3 }, ...]
//
// Also accepts wardrive app export format with "id", "latitude", "longitude" fields.

const path = require('path');
const fs = require('fs');

// db.js resolves the DB path from config/meshwar.yaml (storage.db_path),
// falling back to data/meshwar.db — no env var needed.
const db = require('../server/db');

const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('--'));
const addedByIdx = args.indexOf('--added-by');
const addedBy = addedByIdx >= 0 ? args[addedByIdx + 1] : null;

if (!inputFile) {
  console.error('Usage: node import-repeaters.js <file.json> [--added-by NAME]');
  process.exit(1);
}

if (!fs.existsSync(inputFile)) {
  console.error(`Error: File not found: ${inputFile}`);
  process.exit(1);
}

try {
  const rawData = fs.readFileSync(inputFile, 'utf8');
  const data = JSON.parse(rawData);

  const repeaters = Array.isArray(data) ? data : (data.repeaters || []);

  if (repeaters.length === 0) {
    console.error('Error: No repeater data found in file.');
    process.exit(1);
  }

  const result = db.importRepeaters(repeaters, addedBy);

  console.log(`Repeater import complete:`);
  console.log(`  Inserted: ${result.inserted}`);
  console.log(`  Updated:  ${result.updated}`);
  console.log(`  Total:    ${db.getRepeaters().length} repeaters in database`);
  if (addedBy) console.log(`  Added by: ${addedBy}`);

  db.close();
  process.exit(0);

} catch (err) {
  console.error(`Critical Error: ${err.message}`);
  process.exit(1);
}
