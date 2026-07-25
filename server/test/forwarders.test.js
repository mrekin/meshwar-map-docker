// Tests for the sample forwarder (server/forwarders.js).
// Run with: npm test  (uses Node's built-in test runner — no extra deps).
//
// Each test writes its own meshwar.yaml (forwarders: section) to a temp path,
// points the loader at it via CONFIG_PATH (read once at require), and re-requires
// config + forwarders fresh. A local http.createServer stands in for the external
// resources so we can assert exactly what got POSTed (body + ?token= in the url).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const yaml = require('js-yaml');

const CONFIG = require.resolve('../config');
const FORWARDERS = require.resolve('../forwarders');

/** Serialize a forwarders list to a minimal meshwar.yaml. */
function forwardersYaml(list) {
  return yaml.dump({ forwarders: list });
}

/** Point CONFIG_PATH at a temp meshwar.yaml, write contents, require fresh. */
function withConfig(yamlContent, fn) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-')), 'meshwar.yaml');
  if (yamlContent !== undefined) fs.writeFileSync(tmp, yamlContent);
  const prev = process.env.CONFIG_PATH;
  process.env.CONFIG_PATH = tmp;
  delete require.cache[CONFIG];
  delete require.cache[FORWARDERS];
  const mod = require('../forwarders');
  return Promise.resolve()
    .then(() => fn(mod, tmp))
    .finally(() => {
      if (prev === undefined) delete process.env.CONFIG_PATH;
      else process.env.CONFIG_PATH = prev;
      delete require.cache[CONFIG];
      delete require.cache[FORWARDERS];
      try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch {}
    });
}

/** Start a local http server recording each request. Returns { server, hits, url }. */
function startRecorder() {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        hits.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"success":true}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, hits, url: (p) => `http://127.0.0.1:${port}${p}` });
    });
  });
}

const SAMPLES = [{ latitude: 47.6, longitude: -122.3, pingSuccess: true, timestamp: '2024-01-01T00:00:00Z' }];

test('missing config file => forwarding disabled (count 0), forwardSamples is a no-op', () =>
  withConfig(undefined, async (mod) => {
    // temp path that we never write → stat throws ENOENT → defaults → no forwarders.
    assert.strictEqual(mod.config.enabled, false);
    assert.strictEqual(mod.config.count, 0);
    await assert.doesNotReject(mod.forwardSamples(SAMPLES));
  })
);

test('malformed YAML => disabled, does not throw', () =>
  withConfig('forwarders: [unclosed', async (mod) => {
    assert.strictEqual(mod.config.count, 0);
    await assert.doesNotReject(mod.forwardSamples(SAMPLES));
  })
);

test('empty forwarders list => disabled', () =>
  withConfig(forwardersYaml([]), (mod) => {
    assert.strictEqual(mod.config.count, 0);
    assert.strictEqual(mod.config.enabled, false);
  })
);

test('entries without url, or non-http url, are skipped => disabled', () =>
  withConfig(forwardersYaml([{ name: 'bad', url: 'ftp://x' }]), (mod) => {
    assert.strictEqual(mod.config.count, 0);
  })
);

test('valid config => count parsed, enabled true', () =>
  withConfig(forwardersYaml([{ name: 'a', url: 'http://x/api/samples' }, { name: 'b', url: 'https://y/api/samples' }]), (mod) => {
    assert.strictEqual(mod.config.count, 2);
    assert.strictEqual(mod.config.enabled, true);
  })
);

test('POSTs the samples to each resource, body is { samples }, url keeps its ?token=', async () => {
  const rec = await startRecorder();
  try {
    const cfg = forwardersYaml([{ name: 'community', url: rec.url('/api/samples?token=secret123') }]);
    await withConfig(cfg, async (mod) => {
      await mod.forwardSamples(SAMPLES);
      assert.strictEqual(rec.hits.length, 1);
      assert.strictEqual(rec.hits[0].method, 'POST');
      assert.strictEqual(rec.hits[0].url, '/api/samples?token=secret123');
      assert.deepStrictEqual(JSON.parse(rec.hits[0].body), { samples: SAMPLES });
    });
  } finally {
    await new Promise((r) => rec.server.close(r));
  }
});

test('multiple resources all receive the samples (parallel)', async () => {
  const rec = await startRecorder();
  try {
    const cfg = forwardersYaml([
      { name: 'one', url: rec.url('/api/samples') },
      { name: 'two', url: rec.url('/api/samples?token=t') },
    ]);
    await withConfig(cfg, async (mod) => {
      await mod.forwardSamples(SAMPLES);
      assert.strictEqual(rec.hits.length, 2);
      const urls = rec.hits.map((h) => h.url).sort();
      assert.deepStrictEqual(urls, ['/api/samples', '/api/samples?token=t']);
    });
  } finally {
    await new Promise((r) => rec.server.close(r));
  }
});

test('one resource failing (bad host) does not stop the others', async () => {
  const rec = await startRecorder();
  try {
    const cfg = forwardersYaml([
      { name: 'dead', url: 'http://127.0.0.1:1/api/samples' }, // connection refused
      { name: 'alive', url: rec.url('/api/samples') },
    ]);
    await withConfig(cfg, async (mod) => {
      // Must resolve (not reject) despite the dead target, and the alive one still got it.
      await assert.doesNotReject(mod.forwardSamples(SAMPLES));
      assert.strictEqual(rec.hits.length, 1);
      assert.strictEqual(rec.hits[0].url, '/api/samples');
    });
  } finally {
    await new Promise((r) => rec.server.close(r));
  }
});

test('forwardSamples([]) is a no-op even with resources configured', () =>
  withConfig(forwardersYaml([{ name: 'x', url: 'http://127.0.0.1:1/api/samples' }]), (mod) =>
    assert.doesNotReject(mod.forwardSamples([]))
  )
);
