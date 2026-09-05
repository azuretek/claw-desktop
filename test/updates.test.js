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

// appImage is pinned rather than left to default, so a stray APPIMAGE in the
// environment — or a test run from inside one — cannot change what these assert.
const packaged = (platform, macSigned) => updates.policy({ platform, packaged: true, macSigned, appImage: false });

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

const linux = (appImage) => updates.policy({ platform: 'linux', packaged: true, appImage });

test('an AppImage installs updates, like Windows', () => {
  // AppImageUpdater overwrites the file the process was started from. No
  // signature, no package manager, no root — the one Linux path that installs
  // without a privilege prompt.
  const p = linux(true);
  assert.equal(p.action, updates.INSTALL);
  assert.equal(p.check, true);
  assert.equal(p.autoDownload, true);
});

test('Linux outside an AppImage does not check at all', () => {
  // The distinction that matters: not "cannot install" but "cannot answer".
  // AppImageUpdater.isUpdaterActive() is false without APPIMAGE, so
  // checkForUpdates() resolves to null having emitted no event — neither
  // 'error' nor 'update-not-available'. Left checking, a manual check would
  // hang silently and About would say "no check yet this run" forever.
  const p = linux(false);
  assert.equal(p.check, false, 'a check that can only answer nothing must not be made');
  assert.equal(p.autoDownload, false);
  assert.match(p.reason, /AppImage/);
});

test('Linux update behaviour is a runtime fact, not a build-time one', () => {
  // Unlike MAC_SIGNED, which is compiled in because it only changes when the
  // pipeline does, this changes per launch: the same binary auto-updates when
  // run as an AppImage and cannot when unpacked next to it.
  assert.notEqual(linux(true).action, linux(false).action);
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
  const m = updates.availableMessage({
    action: updates.NOTIFY, version: '1.1.0', current: '1.0.0', reason: 'it is not code signed',
  });
  assert.match(m.detail, /because it is not code signed/);
  assert.doesNotMatch(m.detail, /restart/i);
});

test('the notify message takes its reason from the policy, not from a hardcoded one', () => {
  // It used to say "because it is not code signed" unconditionally, which was
  // true of the only platform that could reach it then. Linux can reach it now
  // for an entirely different reason, and a dialog naming the wrong cause is
  // worse than one naming none.
  const p = updates.policy({ platform: 'linux', packaged: true, appImage: false });
  const m = updates.availableMessage({ action: p.action, version: '1.1.0', current: '1.0.0', reason: p.reason });
  assert.match(m.detail, /AppImage/);
  assert.doesNotMatch(m.detail, /code signed/);
});

/* ------------------------------------------- the automatic-updates preference */

// The preference may only ever *narrow* what the platform allows. The failure
// worth guarding against is the other direction: a toggle that appears to
// enable something the build could never do, or one that quietly stops the app
// noticing releases at all.

const withPref = (platform, autoUpdate) => updates.policy({
  platform, packaged: true, macSigned: true, appImage: true, autoUpdate,
});

test('turning automatic updates off stops the download, not the check', () => {
  const p = withPref('win32', false);
  assert.equal(p.autoDownload, false, 'nothing arrives unasked');
  assert.equal(p.check, true, 'but the app still notices a release exists');
  assert.equal(p.action, updates.MANUAL);
});

test('off is MANUAL rather than NOTIFY, because this build really can install it', () => {
  // NOTIFY's wording sends people to the release page to replace the app by
  // hand. Saying that to someone whose app is one button away from doing it
  // itself is worse than saying nothing.
  const m = updates.availableMessage({
    action: withPref('win32', false).action, version: '1.2.0', current: '1.1.0',
  });
  assert.match(m.detail, /install it now/i);
  assert.doesNotMatch(m.detail, /replace the app/);
});

test('the preference cannot switch on a platform that could never install', () => {
  for (const p of [
    updates.policy({ platform: 'darwin', packaged: true, macSigned: false, autoUpdate: true }),
    updates.policy({ platform: 'linux', packaged: true, appImage: false, autoUpdate: true }),
    updates.policy({ platform: 'win32', packaged: false, autoUpdate: true }),
  ]) {
    assert.equal(p.canInstall, false);
    assert.equal(p.autoDownload, false);
    assert.notEqual(p.action, updates.INSTALL);
  }
});

test('canInstall reports the platform, not the preference', () => {
  // Settings disables the checkbox on canInstall and explains itself with
  // capabilityReason, so both have to keep describing the build even once the
  // preference has changed the action out from under them.
  const off = withPref('win32', false);
  assert.equal(off.canInstall, true, 'the build can install; the user asked it not to');
  assert.match(off.capabilityReason, /NSIS/);
  assert.match(off.reason, /turned off/, 'reason describes the current action');
});

test('leaving the preference unset behaves exactly as before', () => {
  // Every other caller and test omits it, so the default is load-bearing.
  const implicit = updates.policy({ platform: 'win32', packaged: true });
  assert.equal(implicit.action, updates.INSTALL);
  assert.equal(implicit.autoDownload, true);
  assert.equal(withPref('win32', true).action, updates.INSTALL);
});

test('capability() answers about the platform alone', () => {
  const cap = updates.capability({ platform: 'win32', packaged: true });
  assert.equal(cap.action, updates.INSTALL);
  assert.equal(cap.autoDownload, true);
  assert.equal(cap.canInstall, undefined, 'that field is policy()’s answer, not this one’s');
});

test('About says updates wait for you when the preference is off', () => {
  const p = withPref('win32', false);
  const line = updates.statusLine({ action: p.action, reason: p.reason, channel: 'dev' });
  assert.match(line, /installed when you ask/);
  assert.doesNotMatch(line, /automatically/);
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

/* --------------------------------------------------- how often it looks */

test('dev checks every five minutes, stable every six hours', () => {
  assert.equal(updates.checkIntervalMs('1.0.1-dev.51.e8de8f92c2'), 5 * 60 * 1000);
  assert.equal(updates.checkIntervalMs('1.0.1'), 6 * 60 * 60 * 1000);
});

test('the interval follows the same channel rule as allowPrerelease', () => {
  // One version cannot be on the dev channel for picking releases and on the
  // stable channel for deciding how often to look. Both read channelOf().
  for (const v of ['1.0.1', '2.3.4', '1.0.1-dev.51.abc', '1.0.1-beta.2', '9.9.9-rc.1']) {
    const fast = updates.checkIntervalMs(v) === updates.PRERELEASE_INTERVAL_MS;
    assert.equal(fast, updates.allowPrerelease(v), `disagreed about ${v}`);
  }
});

test('a version that cannot be parsed falls back to the slow interval', () => {
  // Defensive rather than expected: an unreadable version must not become a
  // reason to poll GitHub twelve times an hour.
  for (const v of [undefined, null, '', 'not-a-version']) {
    assert.equal(updates.checkIntervalMs(v), updates.STABLE_INTERVAL_MS);
  }
});
