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
