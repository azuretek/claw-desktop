'use strict';

// Stamp the commit a build was made from into the app bundle.
//
// The version in package.json is hand-maintained and in practice does not move
// — every build so far is `1.0.0` — so it cannot answer the one question that
// actually comes up: *is the thing installed on that machine the thing I just
// built?* Working that out has meant stat-ing `app.asar` and comparing its
// mtime against a commit timestamp, which is guesswork dressed up as evidence.
//
// This runs as electron-builder's `beforePack` hook, so it covers `npm run
// pack`, every `build:*` script and CI from one place. It is also runnable on
// its own (`node scripts/build-info.js`) when regenerating by hand.
//
// The output is generated, never committed: a commit cannot contain its own
// hash, so a checked-in copy would be wrong by construction. `npm start` and
// the tests run with no file at all, which src/build-info.js reports as a
// source build rather than inventing an identity.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'build-info.json');

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
 * Collect the identity of the tree being packaged.
 *
 * Git is asked first and the environment second, because git describes the
 * source that is actually being compiled while `GITHUB_SHA` describes what the
 * workflow was triggered for. They agree for our tag and dispatch builds; where
 * they could differ, the compiled tree is the honest answer.
 */
function collect(env = process.env) {
  const commit = git('rev-parse', 'HEAD') || env.GITHUB_SHA || null;

  // `--porcelain` prints one line per modified path and nothing at all for a
  // clean tree, so emptiness is the test. Untracked files count: they are
  // inside `src/**` for packaging purposes and can change what ships.
  const status = git('status', '--porcelain');
  const dirty = status !== null && status !== '';

  // Detached HEAD — which is how actions/checkout leaves a tag build — reports
  // the branch as the literal "HEAD", which names nothing.
  const head = git('rev-parse', '--abbrev-ref', 'HEAD');
  const branch = (head && head !== 'HEAD' ? head : null) || env.GITHUB_REF_NAME || null;

  return {
    commit,
    branch,
    dirty,
    // Second precision: this is read by a human, and a fingerprint that carried
    // millisecond noise would differ between two builds of the same commit.
    builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

function write(info = collect(), file = OUT) {
  fs.writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

// electron-builder awaits the default export before packing. Logging the stamp
// is deliberate: a CI log that does not say which commit it built is the same
// hole this file exists to close.
module.exports = async function beforePack() {
  const info = write();
  const label = info.commit ? info.commit.slice(0, 10) : 'unknown';
  console.log(`  • stamping build  commit=${label}${info.dirty ? ' (dirty)' : ''} branch=${info.branch || '-'}`);
};

module.exports.collect = collect;
module.exports.write = write;
module.exports.OUT = OUT;

if (require.main === module) {
  const info = write();
  console.log(`${OUT}\n${JSON.stringify(info, null, 2)}`);
}
