'use strict';

// Version arithmetic for releases, kept separate from the script that performs
// one so the decisions can be tested without touching git.
//
// There is no semver dependency because this app has no runtime dependencies at
// all, and the subset needed here is small and closed: parse, bump, format,
// compare a tag against package.json. Anything this rejects is something a
// release should stop for anyway.

// `MAJOR.MINOR.PATCH`, optionally `-prerelease`, and nothing else. Deliberately
// stricter than semver proper: build metadata (`+sha`) is not accepted, because
// electron-builder puts the version straight into filenames and `+` is awkward
// in a URL. Prerelease identifiers are limited to the same alphabet for the
// same reason.
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

const LEVELS = ['major', 'minor', 'patch'];

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
 * The next release version.
 *
 * A prerelease is dropped rather than bumped: `1.2.0-dev.abc` releasing as a
 * patch is `1.2.0`, not `1.2.1`. The prerelease was always a build heading
 * *towards* that number, so bumping past it would silently skip a version.
 */
function next(current, level) {
  const v = parse(current);
  if (!v) throw new Error(`not a releasable version: ${current}`);
  if (!LEVELS.includes(level)) throw new Error(`unknown bump level: ${level} (want ${LEVELS.join('|')})`);

  if (v.prerelease && level === 'patch') return format({ ...v, prerelease: null });
  if (level === 'major') return format({ major: v.major + 1, minor: 0, patch: 0 });
  if (level === 'minor') return format({ major: v.major, minor: v.minor + 1, patch: 0 });
  return format({ major: v.major, minor: v.minor, patch: v.patch + 1 });
}

/** The git tag for a version. One direction, one format, no variants. */
function tagFor(version) {
  if (!parse(version)) throw new Error(`not a releasable version: ${version}`);
  return `v${version}`;
}

/**
 * The version a tag or ref names, or null.
 *
 * Accepts both the bare tag and the full ref, because CI hands over
 * `refs/tags/v1.2.3` while a person types `v1.2.3`.
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

module.exports = { parse, format, next, tagFor, versionFromTag, devVersion, checkTag, LEVELS };
