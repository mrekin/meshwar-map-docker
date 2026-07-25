// Tests for the GPS outlier filter (server/gpsfilter.js).
// Run with: npm test  (uses Node's built-in test runner — no extra deps).
//
// Env is read at module load, so we pin deterministic values before the first
// require and re-require with different env for the bbox / disabled cases.

const test = require('node:test');
const assert = require('node:assert');

// Deterministic default config before first require.
process.env.GPS_FILTER_ENABLED = 'true';
process.env.GPS_SAMPLE_INTERVAL_SEC = '25'; // fallback only; interval is estimated from data
process.env.GPS_MAX_SPEED_KMH = '150';
process.env.GPS_GROUP_GAP_FACTOR = '3';
process.env.GPS_MIN_GROUP_SIZE = '3';
process.env.GPS_FILTER_MAX_FRACTION = '0.5';
process.env.GPS_MIN_OUTLIER_KM = '0.5';
delete process.env.GPS_BBOX;

const filter = require('../gpsfilter');

const T0 = Date.parse('2024-01-01T00:00:00Z');
// pt(lat, lon, sec, extra): sec is absolute seconds from T0. Default cadence 25s,
// ~0.0003 deg ≈ 33 m per step (slow wardrive); a glitch is +0.09 deg ≈ 10 km.
function pt(lat, lon, sec, extra = {}) {
  return {
    latitude: lat,
    longitude: lon,
    timestamp: new Date(T0 + sec * 1000).toISOString(),
    pingSuccess: true,
    ...extra,
  };
}

/** Re-require the module with a custom env, run fn(module), then restore env. */
function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    process.env[k] = env[k];
  }
  delete require.cache[require.resolve('../gpsfilter')];
  const mod = require('../gpsfilter');
  try {
    return fn(mod);
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('haversine: Seattle–New York is ~3900 km', () => {
  const d = filter.haversineKm({ lat: 47.6, lon: -122.3 }, { lat: 40.7, lon: -74.0 });
  assert.ok(d > 3800 && d < 4000, `got ${d}`);
});

test('estimateIntervalMs: median gap ignores the one big cross-session gap', () => {
  const pts = [{ t: 0 }, { t: 1000 }, { t: 2000 }, { t: 100000 }, { t: 101000 }];
  assert.strictEqual(filter.estimateIntervalMs(pts), 1000);
});

test('tight session: single ~10 km glitch is dropped (center of gravity)', () => {
  const samples = [
    pt(47.6, -122.3, 0, { id: 'a0' }),
    pt(47.6003, -122.3, 25, { id: 'a1' }),
    pt(47.69, -122.3, 50, { id: 'a2' }), // glitch
    pt(47.6009, -122.3, 75, { id: 'a3' }),
    pt(47.6012, -122.3, 100, { id: 'a4' }),
  ];
  const r = filter.filterSamples(samples);
  assert.strictEqual(r.rejected, 1);
  assert.deepStrictEqual(r.samples.map((s) => s.id), ['a0', 'a1', 'a3', 'a4']);
});

test('tight session: 3-sample drift is dropped entirely', () => {
  const samples = [
    pt(47.6, -122.3, 0, { id: 'b0' }),
    pt(47.6003, -122.3, 25, { id: 'b1' }),
    pt(47.69, -122.3, 50, { id: 'b2' }),
    pt(47.6903, -122.3, 75, { id: 'b3' }),
    pt(47.6906, -122.3, 100, { id: 'b4' }),
    pt(47.6009, -122.3, 125, { id: 'b5' }),
    pt(47.6012, -122.3, 150, { id: 'b6' }),
  ];
  const r = filter.filterSamples(samples);
  assert.strictEqual(r.rejected, 3);
  assert.deepStrictEqual(r.samples.map((s) => s.id), ['b0', 'b1', 'b5', 'b6']);
});

test('relocation across a time gap is kept — two sessions, no false positive', () => {
  const samples = [
    pt(47.6, -122.3, 0, { id: 'c0' }),
    pt(47.6003, -122.3, 25, { id: 'c1' }),
    pt(47.6006, -122.3, 50, { id: 'c2' }),
    pt(40.7, -74.0, 1000, { id: 'c3' }), // 950 s gap → new session
    pt(40.7003, -74.0, 1025, { id: 'c4' }),
    pt(40.7006, -74.0, 1050, { id: 'c5' }),
  ];
  const r = filter.filterSamples(samples);
  assert.strictEqual(r.rejected, 0);
  assert.strictEqual(r.samples.length, 6);
});

test('moving session (long drive) is kept — center not representative, fraction cap', () => {
  const samples = [];
  for (let i = 0; i < 8; i++) samples.push(pt(47.6 + i * 0.008, -122.3, i * 25, { id: `d${i}` }));
  const r = filter.filterSamples(samples);
  assert.strictEqual(r.rejected, 0);
  assert.strictEqual(r.samples.length, 8);
});

test('lone glitch in a session is dropped even when the route moves', () => {
  const samples = [
    pt(47.6, -122.3, 0, { id: 'e0' }),
    pt(47.6004, -122.3, 25, { id: 'e1' }),
    pt(47.69, -122.3, 50, { id: 'e2' }), // glitch
    pt(47.6008, -122.3, 75, { id: 'e3' }),
    pt(47.6012, -122.3, 100, { id: 'e4' }),
  ];
  const r = filter.filterSamples(samples);
  assert.strictEqual(r.rejected, 1);
  assert.deepStrictEqual(r.samples.map((s) => s.id), ['e0', 'e1', 'e3', 'e4']);
});

test('bad GPS start is dropped — center is the consensus, not the first point', () => {
  const samples = [
    pt(47.69, -122.3, 0, { id: 'f0' }), // bad start
    pt(47.6, -122.3, 25, { id: 'f1' }),
    pt(47.6003, -122.3, 50, { id: 'f2' }),
    pt(47.6006, -122.3, 75, { id: 'f3' }),
    pt(47.6009, -122.3, 100, { id: 'f4' }),
    pt(47.6012, -122.3, 125, { id: 'f5' }),
  ];
  const r = filter.filterSamples(samples);
  assert.strictEqual(r.rejected, 1);
  assert.deepStrictEqual(r.samples.map((s) => s.id), ['f1', 'f2', 'f3', 'f4', 'f5']);
});

test('on-the-fly interval: 10 s cadence still catches a 10 km glitch', () => {
  const samples = [
    pt(47.6, -122.3, 0, { id: 'g0' }),
    pt(47.6002, -122.3, 10, { id: 'g1' }),
    pt(47.69, -122.3, 20, { id: 'g2' }), // glitch
    pt(47.6004, -122.3, 30, { id: 'g3' }),
    pt(47.6006, -122.3, 40, { id: 'g4' }),
  ];
  const r = filter.filterSamples(samples);
  assert.strictEqual(r.rejected, 1);
  assert.deepStrictEqual(r.samples.map((s) => s.id), ['g0', 'g1', 'g3', 'g4']);
});

test('tiny session (< MIN_GROUP_SIZE) is left untouched', () => {
  const samples = [pt(47.6, -122.3, 0, { id: 'h0' }), pt(47.69, -122.3, 25, { id: 'h1' })];
  const r = filter.filterSamples(samples);
  assert.strictEqual(r.rejected, 0);
  assert.strictEqual(r.samples.length, 2);
});

test('optional GPS_BBOX drops samples outside the configured region', () => {
  withEnv({ GPS_BBOX: '-122.5,47.5,-122.1,47.7' }, (f) => {
    const samples = [
      pt(47.6, -122.3, 0, { id: 'k0' }), // inside
      pt(40.7, -74.0, 25, { id: 'k1' }), // outside → rejected
      pt(47.6003, -122.3, 50, { id: 'k2' }), // inside
    ];
    const r = f.filterSamples(samples);
    assert.strictEqual(r.rejected, 1);
    assert.deepStrictEqual(r.samples.map((s) => s.id).sort(), ['k0', 'k2']);
  });
});

test('GPS_FILTER_ENABLED=false passes everything through untouched', () => {
  withEnv({ GPS_FILTER_ENABLED: 'false' }, (f) => {
    const samples = [
      pt(47.6, -122.3, 0, { id: 'm0' }),
      pt(47.69, -122.3, 25, { id: 'm1' }),
      pt(47.6003, -122.3, 50, { id: 'm2' }),
    ];
    const r = f.filterSamples(samples);
    assert.strictEqual(r.rejected, 0);
    assert.strictEqual(r.samples.length, 3);
  });
});
