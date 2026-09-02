'use strict';

// Plain `node --test` — no Electron, no git. scripts/version.js is pure and
// scripts/build-version.js takes its inputs as an object for exactly this
// reason, so the release decisions can be exercised without cutting one.
//
// The failure being guarded against is quiet and permanent: package.json's
// version is what electron-builder interpolates into every installer filename,
// so a tag that disagrees with it publishes a GitHub Release whose files are
// named for a different version, with nothing in the build log to say so.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const version = require('../scripts/version');
const buildVersion = require('../scripts/build-version');

const SHA = '758853d6569b8acc491a7dc6ab5db4eb3b0639d0';

/* --------------------------------------------------------------------- parse */

test('parses a plain release version', () => {
  assert.deepEqual(version.parse('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: null });
});

test('parses a prerelease', () => {
  assert.equal(version.parse('1.2.3-dev.abc1234').prerelease, 'dev.abc1234');
});

test('rejects anything that is not a version we would release', () => {
  // `+build` metadata is rejected on purpose: it goes straight into filenames
  // and URLs, where `+` is ambiguous.
  for (const bad of ['1.2', 'v1.2.3', '1.2.3.4', '1.2.3+abc', 'latest', '', null, undefined, '1.2.-3']) {
    assert.equal(version.parse(bad), null, `for ${String(bad)}`);
  }
});

test('tolerates surrounding whitespace, which is how a version arrives from a shell', () => {
  assert.equal(version.parse('  1.2.3\n').major, 1);
});

/* -------------------------------------------------------------- tags <-> refs */

test('the parser reads exactly the tag release-it is configured to write', () => {
  // Two owners, one format: .release-it.cjs writes the tag, versionFromTag
  // reads it, and nothing else connects them. If someone changes tagName to
  // `release-${version}` this fails here rather than in CI on a real release.
  const { tagName } = require('../.release-it.cjs').git;
  const produced = tagName.replace('${version}', '1.2.3');
  assert.equal(version.versionFromTag(produced), '1.2.3', `release-it writes "${tagName}"`);
});

test('reads a version from both a bare tag and a full ref', () => {
  assert.equal(version.versionFromTag('v1.2.3'), '1.2.3');
  assert.equal(version.versionFromTag('refs/tags/v1.2.3'), '1.2.3');
});

test('a ref that does not name a version reads as none', () => {
  for (const ref of ['refs/heads/main', 'v', 'vNext', '1.2.3', 'refs/tags/1.2.3', '', null]) {
    assert.equal(version.versionFromTag(ref), null, `for ${String(ref)}`);
  }
});

test('release-it is configured not to publish the GitHub Release itself', () => {
  // CI owns the release, because electron-builder's update metadata does not
  // exist until the build runs. Two publishers writing one release is how
  // assets go missing from it.
  const cfg = require('../.release-it.cjs');
  assert.equal(cfg.github.release, false);
  assert.equal(cfg.npm.publish, false, 'this is an app, not a package');
});

/* --------------------------------------------------------------- dev versions */

test('an untagged build is named for its commit', () => {
  assert.equal(version.devVersion('1.0.0', SHA), '1.0.0-dev.758853d656');
});

test('the dev version sorts below the release it heads towards', () => {
  // Not decoration: it means a machine left on a dev build is *behind* the
  // release rather than stranded above it.
  //
  // Asserted structurally, because semver ordering is NOT string ordering —
  // lexically '1.0.0' < '1.0.0-dev.x', the exact opposite. Semver §11 is what
  // makes the claim true: same numeric triple, and "a pre-release version has
  // lower precedence than the associated normal version".
  const dev = version.parse(version.devVersion('1.0.0', SHA));
  const base = version.parse('1.0.0');
  assert.deepEqual(
    [dev.major, dev.minor, dev.patch],
    [base.major, base.minor, base.patch],
    'a dev build must not change the numbers it is heading towards',
  );
  assert.ok(dev.prerelease, 'and must carry a prerelease tag, which is what puts it below');
  assert.equal(base.prerelease, null);
});

test('two commits give two different installer names', () => {
  // The whole point. Three dispatch builds once produced three byte-different
  // files all called ClawDesktop-Setup-1.0.0-x64.exe.
  const a = version.devVersion('1.0.0', SHA);
  const b = version.devVersion('1.0.0', '93dbc4e1122334455667788990011223344556677');
  assert.notEqual(a, b);
});

test('dev is a separate identifier from the sha', () => {
  // Without the dot, an all-digit sha would be compared numerically against
  // `dev` by semver rather than as its own identifier.
  assert.match(version.devVersion('1.0.0', SHA), /-dev\.[0-9a-f]{10}$/);
});

test('an unusable commit falls back to the plain version rather than inventing one', () => {
  for (const sha of ['', null, undefined, 'HEAD', 'zzzzzzz', '12345']) {
    assert.equal(version.devVersion('1.0.0', sha), '1.0.0', `for ${String(sha)}`);
  }
});

test('an uppercase sha is folded, so one commit is one version', () => {
  assert.equal(version.devVersion('1.0.0', SHA.toUpperCase()), version.devVersion('1.0.0', SHA));
});

/* ------------------------------------------------------------------ checkTag */

test('a matching tag passes', () => {
  assert.deepEqual(version.checkTag('refs/tags/v1.2.3', '1.2.3'), { ok: true, version: '1.2.3' });
});

test('a tag that disagrees with package.json is refused, and says how to fix it', () => {
  const r = version.checkTag('refs/tags/v1.1.0', '1.0.0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /tag says 1\.1\.0 but package\.json says 1\.0\.0/);
  assert.match(r.reason, /npm run release/);
});

test('a ref that is not a version tag is refused', () => {
  assert.equal(version.checkTag('refs/heads/main', '1.0.0').ok, false);
});

/* -------------------------------------------------------------- build-version */

test('a tag build builds exactly the tagged version', () => {
  const r = buildVersion.decide({ ref: 'refs/tags/v1.2.3', sha: SHA, packageVersion: '1.2.3' });
  assert.deepEqual({ ok: r.ok, version: r.version, tagged: r.tagged }, { ok: true, version: '1.2.3', tagged: true });
});

test('a tag build that disagrees fails the whole run before anything is built', () => {
  const r = buildVersion.decide({ ref: 'refs/tags/v9.9.9', sha: SHA, packageVersion: '1.0.0' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /named for the wrong version/);
});

test('a dispatch build gets a commit-named dev version', () => {
  const r = buildVersion.decide({ ref: 'refs/heads/main', sha: SHA, packageVersion: '1.0.0' });
  assert.deepEqual({ ok: r.ok, version: r.version, tagged: r.tagged },
    { ok: true, version: '1.0.0-dev.758853d656', tagged: false });
});

test('a dispatch build with no usable commit still builds, under the plain version', () => {
  // Degrading to the old behaviour beats failing a build over a cosmetic name.
  const r = buildVersion.decide({ ref: '', sha: '', packageVersion: '1.0.0' });
  assert.equal(r.ok, true);
  assert.equal(r.version, '1.0.0');
  assert.match(r.note, /falling back/);
});

/* --------------------------------------------------- build-or-stand-down */

test('an ordinary push to main builds', () => {
  const r = buildVersion.decide({ ref: 'refs/heads/main', sha: SHA, packageVersion: '1.0.0', headTags: [] });
  assert.equal(r.build, true);
});

test('a tag build always builds', () => {
  const r = buildVersion.decide({ ref: 'refs/tags/v1.2.3', sha: SHA, packageVersion: '1.2.3', headTags: ['v1.2.3'] });
  assert.equal(r.build, true);
});

test('the branch half of a release push stands down', () => {
  // `git push --follow-tags` raises a branch event AND a tag event for the same
  // commit. Without this, every release builds twice and uploads two artifact
  // sets for identical code — the dev one named misleadingly.
  const r = buildVersion.decide({
    ref: 'refs/heads/main', sha: SHA, packageVersion: '1.0.1', headTags: ['v1.0.1'],
  });
  assert.equal(r.build, false);
  assert.match(r.note, /tag build publishes it/);
});

test('a non-version tag on the commit does not stop the dev build', () => {
  // Only a release tag means "something else is publishing this".
  const r = buildVersion.decide({
    ref: 'refs/heads/main', sha: SHA, packageVersion: '1.0.0', headTags: ['nightly', 'sprint-4'],
  });
  assert.equal(r.build, true);
});

test('an explicit dispatch is honoured even on a tagged commit', () => {
  // Someone asked for this build by hand; second-guessing them is wrong.
  const r = buildVersion.decide({
    ref: 'refs/heads/main', sha: SHA, packageVersion: '1.0.1',
    eventName: 'workflow_dispatch', headTags: ['v1.0.1'],
  });
  assert.equal(r.build, true);
});

test('a stood-down build still reports a version, so the output is never empty', () => {
  // The workflow reads `version` from the same step whether or not it builds;
  // an empty output would fail the expression rather than skip cleanly.
  const r = buildVersion.decide({
    ref: 'refs/heads/main', sha: SHA, packageVersion: '1.0.1', headTags: ['v1.0.1'],
  });
  assert.equal(r.version, '1.0.1-dev.758853d656');
});
