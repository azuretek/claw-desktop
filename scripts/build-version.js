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
 * @returns {{ok: true, version: string, tagged: boolean, note: string}
 *          | {ok: false, reason: string}}
 */
function decide({ ref, sha, packageVersion }) {
  const tagged = version.versionFromTag(ref);
  if (tagged) {
    const check = version.checkTag(ref, packageVersion);
    if (!check.ok) return { ok: false, reason: check.reason };
    return { ok: true, version: check.version, tagged: true, note: `tag ${ref} matches package.json` };
  }

  const dev = version.devVersion(packageVersion, sha);
  return {
    ok: true,
    version: dev,
    tagged: false,
    note: dev === packageVersion
      ? 'untagged build with no usable commit; falling back to the package version'
      : `untagged build named for its commit`,
  };
}

function main(argv) {
  const packageVersion = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
  const result = decide({
    ref: arg(argv, 'ref', process.env.GITHUB_REF || ''),
    sha: arg(argv, 'sha', process.env.GITHUB_SHA || ''),
    packageVersion,
  });

  if (!result.ok) {
    console.error(`\n  version check failed: ${result.reason}\n`);
    process.exit(1);
  }

  console.log(`  • building version ${result.version}  (${result.note})`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\n`);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { decide };
