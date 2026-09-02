'use strict';

// Plain `node --test` — no Electron. src/cache.js keeps its two decisions
// (what the build id is, and whether it moved) free of Electron for exactly
// this reason; `clear` is exercised against a stub session.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const cache = require('../src/cache');

/* ------------------------------------------------ parseServiceWorkerVersion */

// A real excerpt, kept verbatim: the point of this parser is that it matches
// what the gateway actually serves, so a paraphrase would prove nothing.
const REAL_SW = `// OpenClaw Control – Service Worker
const CACHE_PREFIX = "openclaw-control-";
const EMBEDDED_CACHE_VERSION = "2026.8.2-0965053fe6b9-2026-09-01T09-44-31.342Z";
const URL_CACHE_VERSION = new URL(self.location.href).searchParams.get("v");
`;

test('reads the embedded build id out of sw.js', () => {
  assert.equal(
    cache.parseServiceWorkerVersion(REAL_SW),
    '2026.8.2-0965053fe6b9-2026-09-01T09-44-31.342Z',
  );
});

test('treats the unsubstituted dev placeholder as no version', () => {
  const dev = 'const EMBEDDED_CACHE_VERSION = "__OPENCLAW_CONTROL_UI_BUILD_ID__";';
  // Otherwise the first dev build would clear once and then match forever.
  assert.equal(cache.parseServiceWorkerVersion(dev), null);
});

test('returns null rather than throwing on anything unexpected', () => {
  for (const input of [null, undefined, '', 42, {}, '<!doctype html><html>404</html>']) {
    assert.equal(cache.parseServiceWorkerVersion(input), null);
  }
});

/* --------------------------------------------------------- buildFingerprint */

test('two builds of the same version fingerprint differently', () => {
  // The case that matters: nothing bumps package.json, so 1.0.0 -> 1.0.0 is the
  // normal upgrade and a version-only comparison would never fire.
  const before = cache.buildFingerprint({ version: '1.0.0', size: 168933, mtimeMs: 1788300000000 });
  const after = cache.buildFingerprint({ version: '1.0.0', size: 171204, mtimeMs: 1788390000000 });
  assert.notEqual(before, after);
});

test('the same build fingerprints identically across launches', () => {
  const stat = { version: '1.0.0', size: 168933, mtimeMs: 1788300000000.4 };
  assert.equal(cache.buildFingerprint(stat), cache.buildFingerprint({ ...stat, mtimeMs: 1788300000000.2 }));
});

/* ------------------------------------------------------------ decideRefresh */

test('a first sighting records without clearing', () => {
  // A newly added gateway, or a fresh profile, has no stale cache to drop.
  assert.deepEqual(
    cache.decideRefresh(null, 'build-a'),
    { action: 'record', reason: 'first-seen' },
  );
});

test('an unchanged build id does nothing', () => {
  assert.equal(cache.decideRefresh('build-a', 'build-a').action, 'none');
});

test('a changed build id clears', () => {
  assert.deepEqual(
    cache.decideRefresh('build-a', 'build-b'),
    { action: 'clear', reason: 'build-changed' },
  );
});

test('a failed probe never clears', () => {
  // The probe returns null for a gateway that is down, mid-navigation, or not
  // a Control UI. Clearing on that would wipe the cache on every hiccup.
  assert.equal(cache.decideRefresh('build-a', null).action, 'none');
  assert.equal(cache.decideRefresh(null, null).action, 'none');
});

/* -------------------------------------------------------------------- clear */

function stubSession(failOn = null) {
  const calls = [];
  const maybeFail = (name) => {
    calls.push(name);
    return name === failOn ? Promise.reject(new Error('nope')) : Promise.resolve();
  };
  return {
    calls,
    clearStorageData: (opts) => { calls.push(['clearStorageData', opts]); return failOn === 'clearStorageData' ? Promise.reject(new Error('nope')) : Promise.resolve(); },
    clearCache: () => maybeFail('clearCache'),
    clearCodeCaches: (opts) => { calls.push(['clearCodeCaches', opts]); return failOn === 'clearCodeCaches' ? Promise.reject(new Error('nope')) : Promise.resolve(); },
  };
}

test('clears caches for each origin and never touches storage', async () => {
  const ses = stubSession();
  await cache.clear(ses, ['https://a.example', 'https://b.example:18789']);

  const storageCalls = ses.calls.filter((c) => Array.isArray(c) && c[0] === 'clearStorageData');
  assert.equal(storageCalls.length, 2);
  for (const [, opts] of storageCalls) {
    // The whole safety property of this module: cookies, localStorage and
    // indexdb hold the paired device identity and must survive.
    assert.deepEqual(opts.storages, ['serviceworkers', 'cachestorage']);
    assert.ok(opts.origin);
  }
  assert.ok(ses.calls.includes('clearCache'));
});

test('skips empty origins instead of clearing every origin at once', async () => {
  const ses = stubSession();
  // `clearStorageData` with no `origin` clears the storage type globally, so a
  // null slipping through here would be a much bigger operation than intended.
  await cache.clear(ses, [null, undefined, '']);
  assert.equal(ses.calls.filter((c) => Array.isArray(c) && c[0] === 'clearStorageData').length, 0);
});

test('one failing step does not abort the rest', async () => {
  const ses = stubSession('clearCache');
  const results = await cache.clear(ses, ['https://a.example']);
  // A partial clear still fixes most of the problem, and throwing here would
  // abort the reload the caller does next.
  assert.ok(ses.calls.some((c) => Array.isArray(c) && c[0] === 'clearCodeCaches'));
  assert.ok(results.some((r) => r.ok === false));
});

/* ------------------------------------------------------------ SW_SOURCE_PROBE */

test('the probe fetches sw.js uncached and swallows its own errors', () => {
  // Asserted as text because it runs in the page, where a typo is invisible
  // until an upgrade silently stops being detected.
  assert.match(cache.SW_SOURCE_PROBE, /cache: 'no-store'/);
  assert.match(cache.SW_SOURCE_PROBE, /data-openclaw-control-ui-base-path/);
  assert.match(cache.SW_SOURCE_PROBE, /\.catch\(\(\) => null\)/);
});
