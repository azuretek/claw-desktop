'use strict';

// Cut a release: bump the version, tag it, push, and let CI build and publish.
//
//   npm run release            # patch
//   npm run release -- minor
//   npm run release -- major
//   npm run release -- patch --dry-run
//
// Releasing used to be four manual steps in a required order, none of which
// checked the others. The failure it protects against is not hypothetical: the
// version in package.json is what electron-builder interpolates into every
// installer filename, so a tag that disagrees with it publishes a release whose
// files are named for a different version -- and nothing in the build log says
// so. This does both edits from one input, so they cannot drift.
//
// Everything that can be checked is checked BEFORE anything is written. A
// release that stops with nothing done is recoverable; one that stops after
// tagging but before pushing leaves a tag only on this machine, which is the
// state that later produces "why did CI build the wrong commit".

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const version = require('./version');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const RELEASE_BRANCH = 'main';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts }).trim();

const git = (...args) => run('git', args);

/** Fail with a message that says what to do, not just what went wrong. */
function stop(message) {
  console.error(`\n  release stopped: ${message}\n`);
  process.exit(1);
}

function preflight() {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== RELEASE_BRANCH) {
    stop(`on branch ${branch}, not ${RELEASE_BRANCH}. Releases are cut from ${RELEASE_BRANCH} so the tag is on the line everyone builds.`);
  }

  // Untracked files count. They are inside `src/**` for packaging purposes, so
  // they can change what ships while leaving the commit looking clean.
  if (git('status', '--porcelain')) {
    stop('the working tree is dirty. Commit or stash first — a release must name a commit that exists.');
  }

  git('fetch', 'origin', RELEASE_BRANCH, '--tags');
  const local = git('rev-parse', 'HEAD');
  const remote = git('rev-parse', `origin/${RELEASE_BRANCH}`);
  if (local !== remote) {
    const ahead = git('rev-list', '--count', `origin/${RELEASE_BRANCH}..HEAD`);
    const behind = git('rev-list', '--count', `HEAD..origin/${RELEASE_BRANCH}`);
    stop(`HEAD and origin/${RELEASE_BRANCH} disagree (${ahead} ahead, ${behind} behind). Push or pull first — CI builds the remote, not this checkout.`);
  }
  return local;
}

function main(argv) {
  const args = argv.filter((a) => a !== '--dry-run');
  const dryRun = argv.includes('--dry-run');
  const level = args[0] || 'patch';

  if (!version.LEVELS.includes(level)) {
    stop(`unknown bump level "${level}". Want one of: ${version.LEVELS.join(', ')}.`);
  }

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const current = pkg.version;
  let next;
  try {
    next = version.next(current, level);
  } catch (err) {
    stop(err.message);
  }
  const tag = version.tagFor(next);

  const head = preflight();

  // Checked here rather than left to `git tag` so the message names the cause.
  // A re-run after a failed push is the common way to land on an existing tag.
  const tags = git('tag', '--list', tag);
  if (tags) stop(`tag ${tag} already exists. Delete it (git tag -d ${tag}) or pick another level.`);

  console.log(`\n  ${current}  ->  ${next}   (${level})`);
  console.log(`  tag           ${tag}`);
  console.log(`  commit        ${head.slice(0, 10)}`);

  console.log('\n  running tests…');
  try {
    run('npm', ['test'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    stop(`tests failed, so there is nothing to release.\n${(err.stderr || err.stdout || '').toString().trim()}`);
  }
  console.log('  tests passed');

  if (dryRun) {
    console.log(`\n  --dry-run: stopping here. Would bump, tag ${tag}, and push to origin.\n`);
    return;
  }

  // `npm version` writes package.json AND package-lock.json, commits both, and
  // tags -- one operation, so the three can never disagree. `-m` keeps the
  // commit subject in the same shape as the tag.
  console.log('\n  bumping and tagging…');
  run('npm', ['version', next, '-m', 'Release v%s']);

  console.log('  pushing…');
  git('push', 'origin', RELEASE_BRANCH);
  git('push', 'origin', tag);

  const repo = (git('remote', 'get-url', 'origin') || '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');

  console.log(`\n  released ${tag}`);
  console.log(`  CI is building it now: ${repo}/actions`);
  console.log(`  installers will appear at: ${repo}/releases/tag/${tag}\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main, RELEASE_BRANCH };
