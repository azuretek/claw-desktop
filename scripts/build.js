'use strict';

// Run a build with the version this tree actually deserves.
//
//   npm run build:mac
//   npm run build:win
//   npm run pack
//   npm run build:mac -- --arm64        # extra flags pass straight through
//
// The problem this fixes: `artifactName` in electron-builder.yml interpolates
// `${version}` from package.json, which only moves on a release. So every local
// build produced `ClawDesktop-1.0.0-arm64.dmg` -- the same filename as an actual
// 1.0.0 release, and the same filename as every other local build. CI grew a
// `--config.extraMetadata.version` flag to fix that for itself, and local builds
// kept the old behaviour, which is the worst arrangement: the machine you
// iterate on is the one that cannot tell its builds apart.
//
// Now both go through here, so "what version is this build" has one owner.
// CI passes CLAW_BUILD_VERSION (decided by the workflow's version job, which
// also checks a tag against package.json); locally it is worked out from git.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const version = require('./version');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');

/** A git command, or null if git has nothing to say. Never throws. */
function git(...args) {
  try {
    const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The version to build as, and why.
 *
 * Order matters: an explicit override wins, then a release tag on this exact
 * commit, then the commit itself. Only the first is a decision made elsewhere;
 * the other two are read off the tree being compiled.
 */
function resolveVersion(packageVersion, env = process.env) {
  if (env.CLAW_BUILD_VERSION) {
    return { version: env.CLAW_BUILD_VERSION, note: 'from CLAW_BUILD_VERSION' };
  }

  const dirty = git('status', '--porcelain') ? true : false;

  // A tag on HEAD means this commit *is* a release -- but only if the tag and
  // package.json agree, and only if the tree is clean. Building "1.0.1" from a
  // modified checkout would produce something that is not 1.0.1.
  const tags = (git('tag', '--points-at', 'HEAD') || '').split('\n').filter(Boolean);
  const released = tags.map((t) => version.versionFromTag(t)).find((v) => v === packageVersion);
  if (released && !dirty) return { version: released, note: `tagged v${released}` };
  if (released && dirty) {
    return {
      version: version.devVersion(packageVersion, git('rev-parse', 'HEAD'), { dirty: true }),
      note: `tagged v${released} but the tree is modified, so this is not that release`,
    };
  }

  const sha = git('rev-parse', 'HEAD');
  return {
    version: version.devVersion(packageVersion, sha, { dirty }),
    note: sha ? `dev build of ${String(sha).slice(0, 10)}${dirty ? ' (modified tree)' : ''}` : 'no git metadata',
  };
}

/**
 * electron-builder's own entry script.
 *
 * Resolved as a module rather than found on PATH so it is the copy in this
 * project's node_modules, never a global install of another version.
 */
function builderEntry() {
  return require.resolve('electron-builder/cli.js');
}

/**
 * Whether to notarize this run.
 *
 * Notarization is a credential, not a config choice — the same rule the mac
 * block in electron-builder.yml already follows for signing. `notarize` stays
 * false there so a build with no Apple credentials still succeeds, which is CI
 * today and any checkout that is not the signing machine; when the App Store
 * Connect variables are all present, turn it on for that run.
 *
 * All three or none: app-builder-lib throws InvalidConfigurationError when only
 * some are set, so a half-configured environment must not reach it.
 */
function notarizeArgs(env = process.env) {
  const ready = Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);
  return ready ? ['--config.mac.notarize=true'] : [];
}

/** The full argument list handed to electron-builder. */
function builderArgs(argv, version, env = process.env) {
  return [...argv, '--publish', 'never', `--config.extraMetadata.version=${version}`, ...notarizeArgs(env)];
}

/** The DMGs this build produced, or [] when there are none. */
function builtDmgs(dir = path.join(ROOT, 'dist')) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.dmg'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Notarize and staple each DMG.
 *
 * electron-builder notarizes the .app and staples it, then wraps it in a DMG,
 * so the container itself is never submitted. The result passes the check people
 * do not perform (the app, once dragged out) and fails the one they do (opening
 * the download): Gatekeeper reports the app as "Notarized Developer ID" and the
 * DMG around it as "rejected, no usable signature".
 *
 * Stapling embeds the ticket in the DMG so it validates without a network call.
 * It rewrites the file, which is why dmg.writeUpdateInfo is false — see
 * electron-builder.yml for why nothing that updates reads a DMG checksum.
 *
 * The DMG must already be signed, which dmg.sign in electron-builder.yml does.
 * A ticket staples to a code signature, so stapling an unsigned DMG does
 * nothing while still reporting success: `stapler validate` falls back to
 * fetching the ticket from Apple, so it passes on a file Gatekeeper then
 * rejects for "no usable signature". That is checked here rather than trusted,
 * because the failure is otherwise invisible until someone downloads a release.
 *
 * Gated on the same credentials that enabled notarization, so a build without
 * them is unaffected, and on darwin, where xcrun exists.
 */
function stapleDmgs(opts = {}) {
  const {
    env = process.env,
    run = spawnSync,
    platform = process.platform,
    dmgs = builtDmgs(),
    log = console.log,
    err = console.error,
  } = opts;
  if (notarizeArgs(env).length === 0 || platform !== 'darwin') return 0;

  for (const dmg of dmgs) {
    const name = path.basename(dmg);

    // Fail loudly rather than staple into the void if dmg.sign ever regresses.
    if (run('codesign', ['-dv', dmg], { stdio: 'ignore' }).status !== 0) {
      err(`  ! ${name} is not signed, so a ticket cannot be stapled to it`);
      return 1;
    }

    log(`  • notarizing ${name}`);
    const auth = ['--key', env.APPLE_API_KEY, '--key-id', env.APPLE_API_KEY_ID, '--issuer', env.APPLE_API_ISSUER];
    const sub = run('xcrun', ['notarytool', 'submit', dmg, ...auth, '--wait'], { cwd: ROOT, stdio: 'inherit' });
    if (sub.status !== 0) {
      err(`  ! notarization failed for ${name}`);
      return 1;
    }
    const staple = run('xcrun', ['stapler', 'staple', dmg], { cwd: ROOT, stdio: 'inherit' });
    if (staple.status !== 0) {
      err(`  ! stapling failed for ${name}`);
      return 1;
    }
  }
  return 0;
}

function main(argv) {
  const packageVersion = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
  const resolved = resolveVersion(packageVersion);

  console.log(`  • building ${resolved.version}  (${resolved.note})`);

  // `--publish never` on every path. Publishing is the release workflow's job,
  // and electron-builder will otherwise try to publish whenever it detects CI.
  const args = builderArgs(argv, resolved.version);

  // Run electron-builder's own entry script with this node, rather than looking
  // for the `electron-builder` command. Two Windows failures avoided at once:
  // npm installs a `.cmd` shim there, which spawnSync cannot execute without a
  // shell, and prepending to PATH by hand needs `path.delimiter` (`;`, not `:`)
  // — getting that wrong corrupts PATH instead of extending it, which is
  // exactly how this failed the first time. `require.resolve` also means the
  // build cannot silently use a globally installed electron-builder of another
  // version.
  const run = spawnSync(process.execPath, [builderEntry(), ...args], { cwd: ROOT, stdio: 'inherit' });
  if (run.error) {
    console.error(`  ! could not run electron-builder: ${run.error.message}`);
    process.exit(1);
  }
  if (run.status !== 0) process.exit(run.status === null ? 1 : run.status);

  // Only after a successful build: there is nothing to notarize otherwise, and
  // a failed build must keep its own exit code.
  process.exit(stapleDmgs());
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { resolveVersion, builderEntry, builderArgs, notarizeArgs, builtDmgs, stapleDmgs };
