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
const build = require('../scripts/build');

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

test('nextPatch bumps the patch and drops any prerelease', () => {
  assert.equal(version.nextPatch('1.0.0'), '1.0.1');
  assert.equal(version.nextPatch('2.9.13'), '2.9.14');
  assert.equal(version.nextPatch('1.0.1-dev.5.abc1234567'), '1.0.2');
});

test('an untagged build carries its commit count and sha', () => {
  assert.equal(version.devVersion('1.0.0', SHA, { count: 148 }), '1.0.1-dev.148.758853d656');
});

test('a dev build sorts ABOVE the release it follows and below the next', () => {
  // Reversed deliberately. While dev builds were only CI artifacts, naming them
  // for the current version put them below it, which read as "heading towards"
  // that release. Now they are a channel people install, so every build after
  // the 1.0.0 release must look NEWER than 1.0.0, not older.
  //
  // Asserted structurally, because semver ordering is NOT string ordering:
  // lexically '1.0.1-dev.148' < '1.0.1', which here happens to agree, but
  // '1.0.0' < '1.0.0-dev.x' is the exact opposite of the truth. Semver §11 is
  // what makes the claim hold — a higher patch outranks, and a prerelease has
  // lower precedence than its associated normal version.
  const dev = version.parse(version.devVersion('1.0.0', SHA, { count: 148 }));
  assert.deepEqual([dev.major, dev.minor, dev.patch], [1, 0, 1], 'must name the NEXT patch');
  assert.ok(dev.prerelease, 'and stay a prerelease, which keeps it below that release');
});

test('a later commit gives a higher version, by a numeric identifier', () => {
  // The property the count exists for. A sha does not order: semver compares
  // alphanumeric identifiers ASCII-lexically, so two hashes sort by which
  // happens to be smaller. These must compare as numbers, at the same position.
  const a = version.parse(version.devVersion('1.0.0', SHA, { count: 9 })).prerelease.split('.');
  const b = version.parse(version.devVersion('1.0.0', SHA, { count: 10 })).prerelease.split('.');
  assert.equal(a[0], b[0], 'same channel identifier');
  assert.ok(/^\d+$/.test(a[1]) && /^\d+$/.test(b[1]), 'the count must be a numeric identifier');
  assert.ok(Number(a[1]) < Number(b[1]), '9 must sort below 10, which it would not as a string');
});

test('two commits give two different installer names', () => {
  // Three dispatch builds once produced three byte-different files all called
  // ClawDesktop-Setup-1.0.0-x64.exe.
  const a = version.devVersion('1.0.0', SHA, { count: 148 });
  const b = version.devVersion('1.0.0', '93dbc4e1122334455667788990011223344556677', { count: 149 });
  assert.notEqual(a, b);
});

test('the sha follows the count, so it never decides the ordering', () => {
  // The sha is there to name the exact code, not to sort. It sits after the
  // count, which differs for any two distinct commits, so it is only ever
  // reached on a tie — and a tie means the same commit, hence the same sha.
  const parts = version.parse(version.devVersion('1.0.0', SHA, { count: 148 })).prerelease.split('.');
  assert.deepEqual(parts.slice(0, 2), ['dev', '148']);
  assert.match(parts[2], /^[0-9a-f]{10}$/);
});

test('a missing count still builds, rather than inventing an order', () => {
  // A shallow checkout has no count. The build must not stop, but it must not
  // pretend either: no count means no ordering guarantee, and build-version.js
  // says so in its note.
  assert.equal(version.devVersion('1.0.0', SHA), '1.0.1-dev.758853d656');
  for (const bad of [0, -1, 1.5, '12', null]) {
    assert.equal(version.devVersion('1.0.0', SHA, { count: bad }), '1.0.1-dev.758853d656', `for ${String(bad)}`);
  }
});

test('an unusable commit still yields a buildable dev version', () => {
  for (const sha of ['', null, undefined, 'HEAD', 'zzzzzzz', '12345']) {
    assert.equal(version.devVersion('1.0.0', sha, { count: 148 }), '1.0.1-dev.148', `for ${String(sha)}`);
  }
});

test('an uppercase sha is folded, so one commit is one version', () => {
  const opts = { count: 148 };
  assert.equal(version.devVersion('1.0.0', SHA.toUpperCase(), opts), version.devVersion('1.0.0', SHA, opts));
});

test('a modified tree says so in the version', () => {
  // Same reason build-info.js records `dirty`: a commit hash on a build made
  // from a modified tree names something that was never committed.
  const v = version.devVersion('1.0.0', SHA, { dirty: true, count: 148 });
  assert.equal(v, '1.0.1-dev.148.758853d656.dirty');
  assert.equal(version.parse(v).prerelease, 'dev.148.758853d656.dirty');
});

test('a modified tree with no usable commit still admits it is dirty', () => {
  assert.equal(version.devVersion('1.0.0', '', { dirty: true, count: 148 }), '1.0.1-dev.148.dirty');
});

/* ------------------------------------------------- local build versioning */

test('an explicit override wins over anything git says', () => {
  // This is how CI hands down the version its own job decided.
  const r = build.resolveVersion('1.0.0', { CLAW_BUILD_VERSION: '9.9.9-dev.abc' });
  assert.equal(r.version, '9.9.9-dev.abc');
  assert.match(r.note, /CLAW_BUILD_VERSION/);
});

test('resolveVersion always returns something buildable', () => {
  // Whatever this repo's working state is right now, a build must be nameable.
  const r = build.resolveVersion('1.0.0', {});
  assert.ok(version.parse(r.version), `not a version: ${r.version}`);
  assert.ok(r.note && r.note.length > 3);
});

test('electron-builder is launched as a script, not as a command on PATH', () => {
  // This is the shape that fixed a Windows-only failure. Looking for an
  // `electron-builder` command means npm's `.cmd` shim, which spawnSync cannot
  // execute without a shell — and prepending to PATH by hand needs
  // path.delimiter, which is `;` on Windows. Hardcoding `:` corrupted PATH and
  // the build died one line after printing its version.
  const entry = build.builderEntry();
  assert.match(entry, /electron-builder[/\\]cli\.js$/);
  assert.ok(require('node:fs').existsSync(entry), `${entry} does not exist`);
});

// An explicit env on every call: these assert an exact argument list, and
// notarization adds to it, so reading the ambient process.env would make them
// pass or fail depending on whose shell ran them.
test('every build refuses to publish and carries its version', () => {
  const args = build.builderArgs(['--mac'], '1.2.3-dev.abc', {});
  assert.deepEqual(args, ['--mac', '--publish', 'never', '--config.extraMetadata.version=1.2.3-dev.abc']);
});

test('caller flags come first, so they cannot be overridden by ours', () => {
  const args = build.builderArgs(['--win', '--x64'], '1.0.0', {});
  assert.deepEqual(args.slice(0, 2), ['--win', '--x64']);
  assert.ok(args.includes('--publish') && args[args.indexOf('--publish') + 1] === 'never');
});

/* -------------------------------------------------------------- notarizeArgs */

const ASC = {
  APPLE_API_KEY: '/tmp/AuthKey.p8',
  APPLE_API_KEY_ID: 'GFUPBM2MG7',
  APPLE_API_ISSUER: '701a18c6-1987-41b2-8edf-fe0d3e263d44',
};

test('no Apple credentials means no notarization, so the build still succeeds', () => {
  assert.deepEqual(build.notarizeArgs({}), []);
});

test('a complete App Store Connect environment turns notarization on', () => {
  assert.deepEqual(build.notarizeArgs(ASC), ['--config.mac.notarize=true']);
  assert.ok(build.builderArgs(['--mac'], '1.0.0', ASC).includes('--config.mac.notarize=true'));
});

// app-builder-lib throws InvalidConfigurationError when only some are set, so a
// partial environment must read as "not configured" rather than reaching it.
test('a partial App Store Connect environment does not enable notarization', () => {
  for (const key of Object.keys(ASC)) {
    const partial = { ...ASC };
    delete partial[key];
    assert.deepEqual(build.notarizeArgs(partial), [], `missing ${key} should not notarize`);
  }
});

/* --------------------------------------------------------------- stapleDmgs */

/** A spawnSync stand-in that records calls and returns the given exit codes. */
function recorder(...statuses) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: statuses.length ? statuses.shift() : 0 };
  };
  run.calls = calls;
  return run;
}

const DMGS = ['/d/A-arm64.dmg', '/d/A-x64.dmg'];

// The function narrates to the console; a passing test run should not look like
// a failing build.
const quiet = { log: () => {}, err: () => {} };

test('no Apple credentials means the DMGs are left alone', () => {
  const run = recorder();
  assert.equal(build.stapleDmgs({ env: {}, run, platform: 'darwin', dmgs: DMGS, ...quiet }), 0);
  assert.deepEqual(run.calls, []);
});

// The build also runs on Windows, where there is no xcrun to call.
test('a non-darwin build never shells out to xcrun', () => {
  const run = recorder();
  assert.equal(build.stapleDmgs({ env: ASC, run, platform: 'win32', dmgs: DMGS, ...quiet }), 0);
  assert.deepEqual(run.calls, []);
});

test('each DMG is checked for a signature, submitted, then stapled', () => {
  const run = recorder();
  assert.equal(build.stapleDmgs({ env: ASC, run, platform: 'darwin', dmgs: DMGS, ...quiet }), 0);
  assert.equal(run.calls.length, 6);
  for (const [i, dmg] of DMGS.entries()) {
    assert.deepEqual(run.calls[i * 3], ['codesign', '-dv', dmg]);
    const submit = run.calls[i * 3 + 1];
    assert.deepEqual(submit.slice(0, 4), ['xcrun', 'notarytool', 'submit', dmg]);
    // --wait, or the staple below races a submission Apple has not finished.
    assert.ok(submit.includes('--wait'), 'submit must wait for the result');
    assert.ok(submit.includes(ASC.APPLE_API_ISSUER), 'a Team key needs its issuer');
    assert.deepEqual(run.calls[i * 3 + 2], ['xcrun', 'stapler', 'staple', dmg]);
  }
});

// A ticket staples to a code signature. Stapling an unsigned DMG reports
// success and changes nothing, and `stapler validate` then passes by fetching
// the ticket from Apple -- so the build has to catch this, not the check after.
test('an unsigned DMG fails the build instead of being stapled into the void', () => {
  const run = recorder(1);
  assert.equal(build.stapleDmgs({ env: ASC, run, platform: 'darwin', dmgs: DMGS, ...quiet }), 1);
  assert.equal(run.calls.length, 1, 'must not submit a DMG that cannot hold a ticket');
  assert.equal(run.calls[0][0], 'codesign');
});

test('a failed notarization stops the build and never staples', () => {
  const run = recorder(0, 1);
  assert.equal(build.stapleDmgs({ env: ASC, run, platform: 'darwin', dmgs: DMGS, ...quiet }), 1);
  assert.equal(run.calls.length, 2, 'must not staple a DMG Apple rejected');
});

test('a failed staple is reported rather than passing as success', () => {
  const run = recorder(0, 0, 1);
  assert.equal(build.stapleDmgs({ env: ASC, run, platform: 'darwin', dmgs: DMGS, ...quiet }), 1);
});

test('builtDmgs returns nothing when there is no dist directory', () => {
  assert.deepEqual(build.builtDmgs('/nope/not/a/dir'), []);
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

test('a dispatch build is versioned by commit count and sha', () => {
  const r = buildVersion.decide({ ref: 'refs/heads/main', sha: SHA, packageVersion: '1.0.0', count: 148 });
  assert.deepEqual({ ok: r.ok, version: r.version, tagged: r.tagged },
    { ok: true, version: '1.0.1-dev.148.758853d656', tagged: false });
});

test('a shallow checkout still builds, and says the count is missing', () => {
  // Failing the build would be worse, but absorbing it silently would be too:
  // with no count every dev build orders arbitrarily, which is the one property
  // the scheme exists to provide. The note has to name the likely cause.
  const r = buildVersion.decide({ ref: 'refs/heads/main', sha: SHA, packageVersion: '1.0.0' });
  assert.equal(r.ok, true);
  assert.equal(r.version, '1.0.1-dev.758853d656');
  assert.match(r.note, /NO COMMIT COUNT/);
  assert.match(r.note, /fetch-depth/);
});

test('a dispatch build with no usable commit still builds', () => {
  const r = buildVersion.decide({ ref: '', sha: '', packageVersion: '1.0.0', count: 148 });
  assert.equal(r.ok, true);
  assert.equal(r.version, '1.0.1-dev.148');
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
    ref: 'refs/heads/main', sha: SHA, packageVersion: '1.0.1', headTags: ['v1.0.1'], count: 148,
  });
  assert.equal(r.version, '1.0.2-dev.148.758853d656');
});
