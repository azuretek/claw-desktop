'use strict';

// Decide the version a CI build should carry, and refuse the build if a tag
// disagrees with package.json.
//
// Two jobs, one file, because they are the same decision seen from either side
// of a tag:
//
//   tag build       the tag IS the version. It must already equal package.json,
//                   because `artifactName` interpolates package.json -- so a
//                   mismatch publishes a release whose files are named for
//                   another version, invisibly and permanently.
//   untagged build  there is no version, so one is derived from the commit.
//                   Otherwise every dispatch build is named for whatever
//                   package.json last said, and three different installers
//                   arrive called ClawDesktop-Setup-1.0.0-x64.exe.
//
// Prints a GitHub Actions output line (`version=…`) plus a human line, and
// exits non-zero with an explanation when a tag build is inconsistent.
//
//   node scripts/build-version.js               # reads GITHUB_REF / GITHUB_SHA
//   node scripts/build-version.js --ref refs/tags/v1.2.0 --sha abc1234

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const version = require('./version');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');

function arg(argv, name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

/**
 * @returns {{ok: true, version: string, tagged: boolean, build: boolean, note: string}
 *          | {ok: false, reason: string}}
 */
function decide({ ref, sha, packageVersion, eventName = 'push', headTags = [] }) {
  const tagged = version.versionFromTag(ref);
  if (tagged) {
    const check = version.checkTag(ref, packageVersion);
    if (!check.ok) return { ok: false, reason: check.reason };
    return { ok: true, version: check.version, tagged: true, build: true, note: `tag ${ref} matches package.json` };
  }

  const dev = version.devVersion(packageVersion, sha);
  const result = {
    ok: true,
    version: dev,
    tagged: false,
    build: true,
    note: dev === packageVersion
      ? 'untagged build with no usable commit; falling back to the package version'
      : 'untagged build named for its commit',
  };

  // `git push --follow-tags` pushes the release commit and its tag together, and
  // GitHub raises a separate event for each. Without this, every release builds
  // the same commit twice — once as a release and once as a dev build — and
  // uploads two artifact sets for identical code, the dev one named misleadingly.
  //
  // The tag run is the one that matters, so the branch run stands down. A manual
  // dispatch is always honoured: someone asked for it explicitly.
  const releaseTag = headTags.map((t) => version.versionFromTag(t)).find(Boolean);
  if (eventName !== 'workflow_dispatch' && releaseTag) {
    return { ...result, build: false, note: `commit is tagged v${releaseTag}; its tag build publishes it` };
  }

  return result;
}

/** Tags pointing at HEAD. Empty if git has nothing to say — never throws. */
function headTags() {
  try {
    const out = execFileSync('git', ['tag', '--points-at', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    // A shallow checkout without tags looks the same as a commit with none. The
    // cost of being wrong here is one redundant dev build, not a broken release.
    return [];
  }
}

function main(argv) {
  const packageVersion = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
  const result = decide({
    ref: arg(argv, 'ref', process.env.GITHUB_REF || ''),
    sha: arg(argv, 'sha', process.env.GITHUB_SHA || ''),
    eventName: arg(argv, 'event', process.env.GITHUB_EVENT_NAME || 'push'),
    headTags: headTags(),
    packageVersion,
  });

  if (!result.ok) {
    console.error(`\n  version check failed: ${result.reason}\n`);
    process.exit(1);
  }

  console.log(result.build
    ? `  • building version ${result.version}  (${result.note})`
    : `  • skipping this build  (${result.note})`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `version=${result.version}\nbuild=${result.build}\ntagged=${result.tagged}\n`);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { decide };
