'use strict';

// What version a CI build carries, and whether a tag build is self-consistent.
//
// Bumping and tagging are release-it's job (see .release-it.cjs); this is the
// half release-it cannot do, because it concerns builds that are not releases:
// naming an untagged build for its commit, and refusing a tag that disagrees
// with package.json.
//
// No semver dependency: the app has no runtime dependencies, this runs in CI
// where installing one is not free, and the subset needed is small and closed.
// Anything this rejects is something a build should stop for anyway.

// `MAJOR.MINOR.PATCH`, optionally `-prerelease`, and nothing else. Deliberately
// stricter than semver proper: build metadata (`+sha`) is not accepted, because
// electron-builder puts the version straight into filenames and `+` is awkward
// in a URL. Prerelease identifiers are limited to the same alphabet for the
// same reason.
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Parse a version string, or null if it is not one we will release. */
function parse(version) {
  const m = VERSION_RE.exec(String(version || '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || null,
  };
}

function format({ major, minor, patch, prerelease }) {
  return `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ''}`;
}

/**
 * The version a tag or ref names, or null.
 *
 * Accepts both the bare tag and the full ref, because CI hands over
 * `refs/tags/v1.2.3` while a person types `v1.2.3`.
 *
 * The `v` prefix is not decided here — `.release-it.cjs` owns `tagName` — so
 * this only has to read what that produces.
 */
function versionFromTag(ref) {
  const tag = String(ref || '').replace(/^refs\/tags\//, '');
  if (!tag.startsWith('v')) return null;
  const version = tag.slice(1);
  return parse(version) ? version : null;
}

/**
 * The version an untagged build should carry.
 *
 * Every `workflow_dispatch` build used to be named for whatever was in
 * package.json, so three different installers arrived called
 * `ClawDesktop-Setup-1.0.0-x64.exe` and only an Actions run id told them apart.
 * Naming the commit in the version fixes the filename *and* what the app reports
 * about itself, which is the same fact in two places rather than two facts.
 *
 * It sorts *below* the release it is named for, which is the useful direction:
 * a dev build is a thing heading towards that version, not past it, so a machine
 * left on one is behind the release rather than stranded above it.
 */
function devVersion(base, commit) {
  const v = parse(base);
  if (!v) throw new Error(`not a releasable version: ${base}`);
  const sha = String(commit || '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return base;
  // Dots rather than a bare concatenation so semver reads `dev` and the sha as
  // separate identifiers; a sha that is all digits would otherwise be compared
  // numerically against `dev`.
  return format({ ...v, prerelease: `dev.${sha.slice(0, 10)}` });
}

/**
 * Check that a tag build is building the version it claims.
 *
 * The whole point: `artifactName` interpolates package.json's version, so a tag
 * that disagrees with it publishes a release whose files are named for a
 * different version. It is invisible in the build log and permanent once the
 * release is published.
 *
 * release-it makes the two agree by construction, which is exactly why this
 * still exists: a tag pushed by hand bypasses release-it entirely, and that is
 * the case worth catching.
 *
 * @returns {{ok: true, version: string} | {ok: false, reason: string}}
 */
function checkTag(ref, packageVersion) {
  const tagged = versionFromTag(ref);
  if (!tagged) return { ok: false, reason: `ref ${ref} does not name a version (want refs/tags/vX.Y.Z)` };
  if (tagged !== packageVersion) {
    return {
      ok: false,
      reason: `tag says ${tagged} but package.json says ${packageVersion} — `
        + 'the installers would be named for the wrong version. Bump with `npm run release`, which does both.',
    };
  }
  return { ok: true, version: tagged };
}

module.exports = { parse, format, versionFromTag, devVersion, checkTag };
