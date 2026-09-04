'use strict';

// Plain `node --test` — no Electron. src/updates.js takes `platform` and
// `packaged` as arguments for exactly this reason, so every platform's policy
// is exercised from one run on one machine.
//
// What matters here is that the app never *claims* it can update itself where
// it cannot. An unsigned macOS build that downloads 130MB and then fails inside
// Squirrel.Mac is worse than one that says plainly it cannot.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const updates = require('../src/updates');

const packaged = (platform, macSigned) => updates.policy({ platform, packaged: true, macSigned });

/* ------------------------------------------------------------------ Windows */

test('Windows installs updates, signed or not', () => {
  // NsisUpdater.verifySignature() returns null when the build has no
  // publisherName, so verification is skipped and the update proceeds.
  const p = packaged('win32');
  assert.equal(p.action, updates.INSTALL);
  assert.equal(p.check, true);
  assert.equal(p.autoDownload, true);
});

/* -------------------------------------------------------------------- macOS */

test('unsigned macOS notifies instead of pretending it can install', () => {
  const p = packaged('darwin', false);
  assert.equal(p.action, updates.NOTIFY);
  assert.equal(p.check, true, 'still worth telling someone a release exists');
  assert.match(p.reason, /Squirrel\.Mac/);
});

test('unsigned macOS does not download what it cannot install', () => {
  // ~130MB to arrive at the same dialog.
  assert.equal(packaged('darwin', false).autoDownload, false);
});

test('signed macOS gets the same treatment as Windows', () => {
  // The one line that changes when a Developer ID exists.
  const p = packaged('darwin', true);
  assert.equal(p.action, updates.INSTALL);
  assert.equal(p.autoDownload, true);
});

test('macOS ships signed, and the flag says so', () => {
  // The constant is compiled in, so it has to track what the release workflow
  // actually produces. These two move together in both directions: a true flag
  // on an unsigned build fails inside Squirrel with no explanation, and a false
  // one on a signed build gives up an install it could have done.
  assert.equal(updates.MAC_SIGNED, true);
  assert.equal(updates.policy({ platform: 'darwin', packaged: true }).action, updates.INSTALL);
});

/* -------------------------------------------------------------------- Linux */

test('Linux notifies rather than claiming an untested install path', () => {
  assert.equal(packaged('linux').action, updates.NOTIFY);
});

/* ------------------------------------------------------------- source runs */

test('a source run does not check at all', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const p = updates.policy({ platform, packaged: false });
    assert.equal(p.action, updates.NONE, `for ${platform}`);
    assert.equal(p.check, false);
  }
});

test('not-packaged beats every platform rule', () => {
  // electron-updater guards this itself, but by logging an error that reads
  // like a fault on every `npm start`.
  assert.equal(updates.policy({ platform: 'win32', packaged: false }).action, updates.NONE);
  assert.equal(updates.policy({ platform: 'darwin', packaged: false, macSigned: true }).action, updates.NONE);
});

test('every policy explains itself', () => {
  // The reason is logged at startup and shown in the "no updates here" dialog,
  // so an empty one turns a clear answer into a shrug.
  for (const packagedState of [true, false]) {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const p = updates.policy({ platform, packaged: packagedState });
      assert.ok(p.reason && p.reason.length > 10, `${platform}/${packagedState}: "${p.reason}"`);
    }
  }
});

/* ----------------------------------------------------------------- messages */

test('the install message offers a restart', () => {
  const m = updates.availableMessage({ action: updates.INSTALL, version: '1.1.0', current: '1.0.0' });
  assert.match(m.message, /1\.1\.0 is available/);
  assert.match(m.detail, /restart/i);
  assert.match(m.detail, /1\.0\.0/, 'says which version you are on');
});

test('the notify message says why it cannot update itself', () => {
  // Otherwise "a new version is available" with no install button reads as a
  // broken updater rather than a deliberate limit.
  const m = updates.availableMessage({ action: updates.NOTIFY, version: '1.1.0', current: '1.0.0' });
  assert.match(m.detail, /not code signed/);
  assert.doesNotMatch(m.detail, /restart/i);
});

/* ------------------------------------------------------------------ quietness */

test('only a manual check reports that there is nothing to do', () => {
  assert.equal(updates.shouldReportNoUpdate('manual'), true);
  // A scheduled check announcing "up to date" every six hours is noise.
  assert.equal(updates.shouldReportNoUpdate('scheduled'), false);
  assert.equal(updates.shouldReportNoUpdate('startup'), false);
});

/* ------------------------------------------------------- what About reports */

// Updating succeeds silently, and the only trace it ever ran is a file in a
// cache directory nobody opens. These assertions are about the app being able
// to answer "is it actually checking?" without anyone going looking.

test('the status line names the channel, the behaviour and the last check', () => {
  const line = updates.statusLine({
    action: updates.INSTALL,
    reason: 'NSIS updates do not require a signed build',
    channel: 'dev',
    checkedAt: 1000,
    result: 'up to date',
    now: 1000 + 5 * 60 * 1000,
  });
  assert.match(line, /dev channel/);
  assert.match(line, /installed automatically/);
  assert.match(line, /last checked 5 minutes ago, up to date/);
});

test('a build with no prerelease component says stable', () => {
  const line = updates.statusLine({ action: updates.INSTALL, reason: 'r', channel: null, checkedAt: 0, now: 0 });
  assert.match(line, /stable channel/);
});

test('before the first check it says so rather than implying one happened', () => {
  const line = updates.statusLine({ action: updates.INSTALL, reason: 'r', channel: 'dev' });
  assert.match(line, /no check yet this run/);
  assert.doesNotMatch(line, /last checked/);
});

test('a build that cannot update says why instead of pretending to check', () => {
  const p = updates.policy({ platform: 'darwin', packaged: false });
  const line = updates.statusLine({ action: p.action, reason: p.reason });
  assert.match(line, /not checked/);
  assert.match(line, /running from source/);
});

test('a notify-only build does not claim it installs anything', () => {
  const line = updates.statusLine({ action: updates.NOTIFY, reason: 'unsigned', channel: null, checkedAt: 0, now: 0 });
  assert.doesNotMatch(line, /installed automatically/);
  assert.match(line, /by hand/);
});

test('elapsed time reads in the largest unit that still means something', () => {
  assert.equal(updates.ago(30 * 1000), 'just now');
  assert.equal(updates.ago(60 * 1000), '1 minute ago');
  assert.equal(updates.ago(90 * 60 * 1000), '1 hour ago');
  assert.equal(updates.ago(50 * 60 * 60 * 1000), '2 days ago');
  // A clock that moved backwards must not produce "-3 minutes ago".
  assert.equal(updates.ago(-1), null);
});
