'use strict';

// Dropping the Control UI's cached copy of itself — and knowing when to.
//
// The Control UI is a PWA. Its service worker keys a Cache Storage bucket on a
// build id embedded in sw.js (`openclaw-control-<version>`) and serves anything
// under /assets/ cache-first, with no revalidation. That is correct for hashed
// filenames, and upstream's worker does prune old buckets on activate — but all
// of it depends on the browser re-fetching sw.js, which only happens on a
// navigation. This app closes to tray rather than quitting, so its document can
// live for weeks without one. An upgraded gateway then sits behind a worker
// that never noticed.
//
// WHAT MUST NOT BE CLEARED, and why this file does not simply call
// `clearStorageData()` with no `storages` list: the gateway's paired device
// identity lives in origin storage. Wiping localStorage/IndexedDB/cookies makes
// the Gateway see a brand-new client and report a login from an unrecognised
// device — the same failure the per-gateway partition scheme caused, described
// at length in main.js. Caches are disposable; storage is not. The two are
// separated here so that stays true even when someone is in a hurry.

// Cache- and code-cache-only. Deliberately the older `clearStorageData` API
// rather than `clearData`: `clearData`'s `dataTypes` has no `cachestorage`
// member and its docs warn it "can potentially include data types not
// explicitly listed", which is exactly the guarantee this needs to not have.
const CACHE_STORAGES = ['serviceworkers', 'cachestorage'];

/**
 * The build id the Control UI's service worker keys its cache on.
 *
 * Read from sw.js rather than from any API because it is the same string the
 * worker itself compares: if this changes, the worker is holding a bucket for a
 * build that is no longer being served.
 *
 * @param {string|null|undefined} source  Contents of sw.js.
 * @returns {string|null}
 */
function parseServiceWorkerVersion(source) {
  if (typeof source !== 'string') return null;
  const match = source.match(/EMBEDDED_CACHE_VERSION\s*=\s*"([^"]+)"/);
  if (!match) return null;
  const version = match[1];
  // The placeholder a dev build leaves unsubstituted. Treating it as a real id
  // would clear the cache once and then never again for any later dev build.
  if (version === '__OPENCLAW_CONTROL_UI_BUILD_ID__') return null;
  return version;
}

/**
 * A value that changes whenever a *different build* of this app is installed.
 *
 * Deliberately not `app.getVersion()` alone. The version in package.json is
 * hand-maintained and in practice does not move — the build that introduced
 * this code and the one before it are both `1.0.0` — so comparing versions
 * would never fire and the app-upgrade clear would be decoration. The app
 * bundle's size and mtime do change on every install.
 *
 * @param {{version: string, size: number, mtimeMs: number}} stat
 * @returns {string}
 */
function buildFingerprint({ version, size, mtimeMs }) {
  // mtime is rounded because filesystems disagree about sub-millisecond
  // precision, and a fingerprint that drifts on its own would clear the cache
  // on every single launch.
  return `${version}:${size}:${Math.round(mtimeMs)}`;
}

/**
 * What to do about a build id we just read.
 *
 * `record` on a first sighting is the important case: an origin we have never
 * probed has nothing stale to clear, and clearing there would fire on every
 * fresh profile and every newly added gateway for no reason.
 *
 * @param {string|null} seen     Build id recorded for this origin, if any.
 * @param {string|null} current  Build id just read from the gateway.
 * @returns {{action: 'none'|'record'|'clear', reason: string}}
 */
function decideRefresh(seen, current) {
  if (!current) return { action: 'none', reason: 'probe-failed' };
  if (!seen) return { action: 'record', reason: 'first-seen' };
  if (seen === current) return { action: 'none', reason: 'unchanged' };
  return { action: 'clear', reason: 'build-changed' };
}

/**
 * Fetch sw.js from inside the page.
 *
 * Runs in the page rather than through `net`/`session.fetch` on purpose. The
 * page has already cleared every hurdle a probe would otherwise have to clear
 * again on its own: the TOFU certificate pin (certs.js hooks
 * `app.on('certificate-error')`, which covers webContents and *not* net
 * requests), any proxy auth headers, and the gateway's base path. A probe that
 * reimplemented those would be a second, quietly diverging copy of them.
 *
 * `cache: 'no-store'` is what makes the answer trustworthy — without it the
 * very worker being interrogated could serve its own stale sw.js back.
 *
 * Returns the raw text, not a parsed id: the regex has one owner, above, where
 * it is testable without Electron.
 */
const SW_SOURCE_PROBE = [
  '(() => {',
  "  const base = document.documentElement.getAttribute('data-openclaw-control-ui-base-path') || '';",
  "  const url = new URL(base + '/sw.js', location.origin);",
  "  return fetch(url.href, { cache: 'no-store', credentials: 'same-origin' })",
  '    .then((r) => (r.ok ? r.text() : null))',
  '    .catch(() => null);',
  '})()',
].join('\n');

/**
 * Drop cached code for the given origins, leaving their storage untouched.
 *
 * Each step is independently guarded: a session that refuses one of these must
 * not stop the others, because a partial clear still fixes most of the problem
 * and a thrown error here would abort the reload that follows.
 *
 * `clearCache` and `clearCodeCaches` are session-wide — Chromium exposes no
 * per-origin filter for either. That is acceptable: the only other origin this
 * session ever serves is our own `file://` pages, which are read from disk.
 *
 * @param {Electron.Session} ses
 * @param {string[]} origins  `scheme://host:port`, as `window.location.origin`.
 */
async function clear(ses, origins = []) {
  const results = [];
  for (const origin of origins.filter(Boolean)) {
    try {
      await ses.clearStorageData({ origin, storages: CACHE_STORAGES });
      results.push({ origin, ok: true });
    } catch (err) {
      results.push({ origin, ok: false, error: err.message });
    }
  }
  try {
    await ses.clearCache();
  } catch (err) {
    results.push({ origin: '*', ok: false, error: `clearCache: ${err.message}` });
  }
  try {
    // Empty list means every entry, per Electron's docs. Compiled-code caches
    // survive an HTTP cache clear and are keyed by resource URL, so a rebuilt
    // bundle that reuses a URL would otherwise still run yesterday's code.
    await ses.clearCodeCaches({ urls: [] });
  } catch (err) {
    results.push({ origin: '*', ok: false, error: `clearCodeCaches: ${err.message}` });
  }
  return results;
}

module.exports = {
  CACHE_STORAGES,
  SW_SOURCE_PROBE,
  buildFingerprint,
  parseServiceWorkerVersion,
  decideRefresh,
  clear,
};
