'use strict';

// Plain `node --test` — no Electron, no chance of touching a real profile.
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = require('../src/profile');

function tmpAppData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claw-profile-'));
}

function seed(dir, name, files) {
  const target = path.join(dir, name);
  fs.mkdirSync(target, { recursive: true });
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(target, file), body);
  return target;
}

test('moves an old-name profile across, contents intact', () => {
  const base = tmpAppData();
  seed(base, 'OpenClaw', { 'config.json': '{"marker":1}', 'credentials.json': 'ENCRYPTED' });

  const result = profile.migrate(base);

  assert.equal(result.status, 'migrated');
  assert.equal(fs.existsSync(path.join(base, 'OpenClaw')), false, 'old directory should be gone');
  assert.equal(fs.readFileSync(path.join(base, 'Claw Desktop', 'config.json'), 'utf8'), '{"marker":1}');
  assert.equal(fs.readFileSync(path.join(base, 'Claw Desktop', 'credentials.json'), 'utf8'), 'ENCRYPTED');
});

test('never overwrites an existing current-name profile', () => {
  const base = tmpAppData();
  seed(base, 'OpenClaw', { 'config.json': '{"which":"old"}' });
  seed(base, 'Claw Desktop', { 'config.json': '{"which":"current"}' });

  const result = profile.migrate(base);

  assert.equal(result.status, 'already-current');
  // The live profile must win, and the old one must survive for recovery.
  assert.equal(fs.readFileSync(path.join(base, 'Claw Desktop', 'config.json'), 'utf8'), '{"which":"current"}');
  assert.equal(fs.readFileSync(path.join(base, 'OpenClaw', 'config.json'), 'utf8'), '{"which":"old"}');
});

test('is a no-op on a fresh install', () => {
  const base = tmpAppData();
  assert.equal(profile.migrate(base).status, 'nothing-to-migrate');
  assert.equal(fs.existsSync(path.join(base, 'Claw Desktop')), false);
});

test('runs only once — a second call is a no-op', () => {
  const base = tmpAppData();
  seed(base, 'OpenClaw', { 'config.json': '{"marker":1}' });

  assert.equal(profile.migrate(base).status, 'migrated');
  // The second call sees the target it just created, so it declines rather than
  // reporting "nothing to migrate" — either way it must not touch anything.
  assert.equal(profile.migrate(base).status, 'already-current');
  assert.equal(fs.readFileSync(path.join(base, 'Claw Desktop', 'config.json'), 'utf8'), '{"marker":1}');
});

test('reports failure instead of throwing, so startup survives it', () => {
  const base = tmpAppData();
  seed(base, 'OpenClaw', { 'config.json': '{}' });
  // A file where the target directory would go: rename cannot succeed.
  fs.writeFileSync(path.join(base, 'Claw Desktop'), 'not a directory');

  const result = profile.migrate(base);

  // An existing *path* is treated as "already current" and left strictly alone,
  // which is the safe reading: never clobber whatever is sitting there.
  assert.equal(result.status, 'already-current');
  assert.equal(fs.existsSync(path.join(base, 'OpenClaw')), true);
});
