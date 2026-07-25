#!/usr/bin/env node
// MeshCore Wardrive Data Import Tool
// Validates and imports wardrive JSON exports into the SQLite database.
//
// Usage:
//   node import.js <file.json> [--dry-run] [--contributor NAME] [--region CODE]
//
// Supports both formats:
//   - Plain array: [{ lat, lon, pingSuccess, ... }, ...]
//   - Unified export: { samples: [...], sessions: [...] }

const path = require('path');
const fs = require('fs');

// Set DB_PATH before requiring db.js
if (!process.env.DB_PATH) {
  process.env.DB_PATH = path.join(__dirname, '..', 'data', 'meshwar.db');
}
const db = require('../server/db');

const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('--'));
const isDryRun = args.includes('--dry-run');
const contributorIdx = args.indexOf('--contributor');
const contributor = contributorIdx >= 0 ? args[contributorIdx + 1] : null;
const regionIdx = args.indexOf('--region');
const region = regionIdx >= 0 ? args[regionIdx + 1] : null;

if (!inputFile) {
  console.error('Usage: node import.js <file.json> [--dry-run] [--contributor NAME] [--region CODE]');
  process.exit(1);
}

if (!fs.existsSync(inputFile)) {
  console.error(`Error: File not found: ${inputFile}`);
  process.exit(1);
}

try {
  const rawData = fs.readFileSync(inputFile, 'utf8');
  const data = JSON.parse(rawData);
  
  // Support both plain array and unified export format
  let samples;
  if (Array.isArray(data)) {
    samples = data;
  } else if (data.samples && Array.isArray(data.samples)) {
    samples = data.samples;
  } else {
    console.error('Error: JSON must be an array of samples or { samples: [...] }');
    process.exit(1);
  }
  
  if (samples.length === 0) {
    console.error('Error: No samples found in file.');
    process.exit(1);
  }
  
  // Validation
  let valid = 0;
  let invalid = 0;
  const errors = [];
  
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const lat = s.latitude || s.lat;
    const lon = s.longitude || s.lon;
    
    if (!lat || !lon) {
      invalid++;
      if (errors.length < 5) errors.push(`Row ${i}: missing coordinates`);
      continue;
    }
    
    if (typeof lat !== 'number' || typeof lon !== 'number') {
      invalid++;
      if (errors.length < 5) errors.push(`Row ${i}: non-numeric coordinates`);
      continue;
    }
    
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      invalid++;
      if (errors.length < 5) errors.push(`Row ${i}: coordinates out of range (${lat}, ${lon})`);
      continue;
    }
    
    if (!s.timestamp) {
      invalid++;
      if (errors.length < 5) errors.push(`Row ${i}: missing timestamp`);
      continue;
    }
    
    valid++;
  }
  
  if (isDryRun) {
    // Output count for shell script compatibility
    if (errors.length === 0) {
      console.log(valid);
    } else {
      console.error(`Validation: ${valid} valid, ${invalid} invalid`);
      errors.forEach(e => console.error(`  ${e}`));
      if (invalid > errors.length) {
        console.error(`  ... and ${invalid - errors.length} more errors`);
      }
      process.exit(1);
    }
    process.exit(0);
  }
  
  // Actual import
  const result = db.insertSamples(samples, contributor, region);
  
  // Import repeater contacts if present in unified export
  let repeatersResult = { inserted: 0, updated: 0 };
  if (!Array.isArray(data) && data.repeaters && Array.isArray(data.repeaters)) {
    repeatersResult = db.importRepeaters(data.repeaters, contributor);
  }
  
  console.log(`Import complete:`);
  console.log(`  Samples inserted: ${result.inserted}`);
  console.log(`  Samples skipped:  ${result.skipped} (duplicates or GPS-only)`);
  console.log(`  Samples rejected: ${result.rejected} (GPS outliers)`);
  console.log(`  Total samples:    ${samples.length}`);
  if (repeatersResult.inserted > 0 || repeatersResult.updated > 0) {
    console.log(`  Repeaters added:  ${repeatersResult.inserted} new, ${repeatersResult.updated} updated`);
  }
  if (contributor) console.log(`  Contributor: ${contributor}`);
  if (region) console.log(`  Region: ${region}`);
  
  db.close();
  process.exit(0);
  
} catch (err) {
  console.error(`Critical Error: ${err.message}`);
  process.exit(1);
}
