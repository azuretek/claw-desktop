'use strict';

// Plain `node --test` — no Electron. src/build-info.js keeps its parsing and
// formatting free of Electron for exactly this reason; only `read` touches the
// disk, and it takes a path so it can be pointed at a fixture.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const buildInfo = require('../src/build-info');
const cache = require('../src/cache');

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const CLEAN = { commit: SHA, branch: 'main', dirty: false, builtAt: '2026-09-02T08:41:07Z' };

/* ------------------------------------------------------------------ normalize */

test('keeps a real 40-character commit and derives the short form', () => {
  const info = buildInfo.normalize(CLEAN);
  assert.equal(info.commit, SHA);
  assert.equal(info.shortCommit, 'a1b2c3d4e5');
  assert.equal(info.shortCommit.length, buildInfo.SHORT_LENGTH);
});

test('uppercase hashes are folded, so the same build never looks like two', () => {
  assert.equal(buildInfo.normalize({ ...CLEAN, commit: SHA.toUpperCase() }).commit, SHA);
});

test('anything that is not a 40-char hash is no commit at all', () => {
  // Half a hash is worse than none: it would still be shown, and it would still
  // be compared, while identifying nothing.
  for (const commit of ['a1b2c3d', 'main', '', null, 42, `${SHA}extra`, 'z'.repeat(40)]) {
    assert.equal(buildInfo.normalize({ ...CLEAN, commit }).commit, null, `for ${String(commit)}`);
  }
});

test('a corrupt or empty file degrades instead of throwing', () => {
  for (const raw of [null, undefined, '', 0, [], 'nonsense']) {
    assert.deepEqual(buildInfo.normalize(raw), {
      commit: null, shortCommit: null, branch: null, dirty: false, builtAt: null,
    });
  }
});

test('dirty is only true when it is literally true', () => {
  // A truthy-but-not-true value ("false", 1) must not silently mark a release
  // build as dirty — it would suppress the commit as a cache fingerprint.
  assert.equal(buildInfo.normalize({ ...CLEAN, dirty: 'false' }).dirty, false);
  assert.equal(buildInfo.normalize({ ...CLEAN, dirty: true }).dirty, true);
});

/* ------------------------------------------------------------------- describe */

test('a packaged build on main reads as version, commit and date', () => {
  assert.equal(
    buildInfo.describe('1.0.0', CLEAN),
    '1.0.0 (a1b2c3d4e5, built 2026-09-02 08:41Z)',
  );
});

test('a branch other than main is named, because that is the surprising case', () => {
  assert.equal(
    buildInfo.describe('1.0.0', { ...CLEAN, branch: 'fix-clicks' }),
    '1.0.0 (fix-clicks a1b2c3d4e5, built 2026-09-02 08:41Z)',
  );
});

test('a dirty tree says so — its hash does not describe what was built', () => {
  assert.match(buildInfo.describe('1.0.0', { ...CLEAN, dirty: true }), /a1b2c3d4e5-dirty/);
});

test('running from source claims no commit rather than inventing one', () => {
  // npm start and the tests both land here; it is a normal state, not an error.
  assert.equal(buildInfo.describe('1.0.0', buildInfo.normalize(null)), '1.0.0 (source build)');
});

test('a missing build date drops the clause instead of printing a broken one', () => {
  assert.equal(buildInfo.describe('1.0.0', { ...CLEAN, builtAt: null }), '1.0.0 (a1b2c3d4e5)');
  assert.equal(buildInfo.describe('1.0.0', { ...CLEAN, builtAt: 'whenever' }), '1.0.0 (a1b2c3d4e5)');
});

/* -------------------------------------------------------------------- buildId */

test('a clean packaged build identifies itself by commit', () => {
  assert.equal(buildInfo.buildId(CLEAN), SHA);
});

test('a dirty build has no usable id', () => {
  // Every build from a dirty tree shares one hash, so trusting it would stop
  // detecting upgrades during precisely the work that rebuilds most often.
  assert.equal(buildInfo.buildId({ ...CLEAN, dirty: true }), null);
  assert.equal(buildInfo.buildId(buildInfo.normalize(null)), null);
});

/* ----------------------------------------------------------------------- read */

test('a missing build-info.json is the source-build shape, not a crash', () => {
  const missing = path.join(os.tmpdir(), 'claw-desktop-no-such-build-info.json');
  fs.rmSync(missing, { force: true });
  assert.equal(buildInfo.read(missing).commit, null);
});

test('reads a real generated file back', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claw-bi-')), 'build-info.json');
  fs.writeFileSync(file, JSON.stringify(CLEAN));
  assert.equal(buildInfo.read(file).shortCommit, 'a1b2c3d4e5');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('malformed JSON on disk falls back rather than taking startup down', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claw-bi-')), 'build-info.json');
  fs.writeFileSync(file, '{"commit": "a1b2c3');
  assert.equal(buildInfo.read(file).commit, null);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

/* ------------------------------------------- the fingerprint it feeds into */

test('the commit is the fingerprint when there is one', () => {
  assert.equal(
    cache.buildFingerprint({ version: '1.0.0', commit: SHA }),
    `1.0.0:${SHA}`,
  );
});

test('two builds of one version differ by commit alone', () => {
  // The bug this replaces: both builds are 1.0.0, and before the stamp existed
  // the only thing separating them was the app bundle's mtime.
  assert.notEqual(
    cache.buildFingerprint({ version: '1.0.0', commit: SHA }),
    cache.buildFingerprint({ version: '1.0.0', commit: SHA.replace(/^a/, 'b') }),
  );
});

test('with no commit it still falls back to size and mtime', () => {
  assert.equal(
    cache.buildFingerprint({ version: '1.0.0', size: 171204, mtimeMs: 1788390000000, commit: null }),
    '1.0.0:171204:1788390000000',
  );
});

/* --------------------------------------------------- the generator, offline */

test('the generator reads the repo it lives in', () => {
  // Not asserting a specific hash — it moves every commit. What must hold is
  // that it produces a usable stamp for THIS checkout, which is the only way to
  // catch the git invocation itself breaking.
  const info = require('../scripts/build-info').collect();
  assert.match(info.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof info.dirty, 'boolean');
  assert.match(info.builtAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('CI environment variables stand in when git is unavailable', () => {
  // A build from a tarball or an image with no .git — the workflow still knows
  // what it checked out.
  const info = require('../scripts/build-info').collect({
    GITHUB_SHA: SHA, GITHUB_REF_NAME: 'v1.2.3', PATH: '/nonexistent',
  });
  assert.ok(info.commit, 'a commit should be resolved from somewhere');
});

/* ---------------------------------------------------------------- the About box */

test('About carries the build identity, the update line and the runtime', () => {
  const about = buildInfo.about({
    version: '1.0.1-dev.40.00aeecf142',
    info: CLEAN,
    updateStatus: 'Updates: dev channel, installed automatically; last checked 5 minutes ago, up to date',
    electron: '44.1.1',
    chrome: '140.0.0.0',
    platform: 'win32',
    arch: 'x64',
  });
  assert.equal(about.message, 'Claw Desktop');
  assert.match(about.detail, /1\.0\.1-dev\.40\.00aeecf142 \(a1b2c3d4e5, built 2026-09-02 08:41Z\)/);
  assert.match(about.detail, /dev channel/);
  assert.match(about.detail, /Electron 44\.1\.1, Chromium 140\.0\.0\.0/);
  // process.platform is what the runtime calls it; About is read by a person.
  assert.match(about.detail, /Windows x64/);
  assert.doesNotMatch(about.detail, /win32/);
});

test('About degrades to the version alone when nothing else is known', () => {
  const about = buildInfo.about({ version: '1.0.0', info: null });
  assert.equal(about.detail, '1.0.0 (source build)');
});
