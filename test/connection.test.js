'use strict';

// What each gateway row says about itself.
//
// The failure worth guarding here is a row that lies. The badge used to read
// "Connected" for whichever gateway was *selected*, which was wrong for the
// whole time a connection was failing — the exact state in which someone is
// reading it, since a failure is now what puts this page on screen.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const connection = require('../src/connection');

const active = (over = {}) => connection.status({ isActive: true, ...over });

test('a connected gateway says so, and only when it is connected', () => {
  const s = active({ phase: connection.CONNECTED });
  assert.equal(s.tone, 'ok');
  assert.equal(s.label, 'Connected');
});

test('the gateway this app is not pointed at never claims to be connected', () => {
  // Even if it was the one that connected a moment ago.
  const s = connection.status({ isActive: false, phase: connection.CONNECTED });
  assert.equal(s.tone, 'muted');
  assert.equal(s.label, 'Not connected');
});

test('a failure says what went wrong in words, and keeps the raw string', () => {
  const s = active({ phase: connection.FAILED, error: { code: -109, description: 'ERR_ADDRESS_UNREACHABLE' } });
  assert.equal(s.tone, 'err');
  assert.equal(s.label, 'Cannot connect');
  assert.match(s.detail, /same tailnet or LAN/, 'the hint someone can act on');
  assert.match(s.detail, /ERR_ADDRESS_UNREACHABLE/, 'and the string they would search for');
});

test('an unknown error code falls back to Chromium’s own description', () => {
  const s = active({ phase: connection.FAILED, error: { code: -99999, description: 'ERR_SOMETHING_NEW' } });
  assert.match(s.detail, /ERR_SOMETHING_NEW/);
});

test('a failure with no detail at all still says something', () => {
  // Reachable through render-process-gone, whose "code" is a word.
  const s = active({ phase: connection.FAILED, error: null });
  assert.ok(s.detail && s.detail.length > 10, s.detail);
});

test('a refused certificate outranks the connection phase', () => {
  // It is both the cause of the failure and the only half the reader can act
  // on. "Cannot connect" over the top of it would be true and useless.
  const s = active({ phase: connection.FAILED, error: { code: -200 }, certOffer: { changed: false } });
  assert.equal(s.label, 'Certificate not trusted');
  assert.match(s.detail, /Review the certificate/);
});

test('a changed certificate is louder than an unknown one', () => {
  const unknown = active({ certOffer: { changed: false } });
  const changed = active({ certOffer: { changed: true } });
  assert.equal(unknown.tone, 'warn');
  assert.equal(changed.tone, 'err');
  assert.notEqual(unknown.label, changed.label);
});

test('a certificate problem shows on an inactive gateway too', () => {
  // Its row is where someone would look to find out why switching to it did
  // not work, and the offer outlives the attempt that produced it.
  const s = connection.status({ isActive: false, certOffer: { changed: false } });
  assert.equal(s.label, 'Certificate not trusted');
});

/* ------------------------------------------------------- what counts as a failure */

test('a subframe failure is not a connection failure', () => {
  // Otherwise an ad, a font or a failed websocket in a working session throws
  // the user out to Settings — far worse than the thing that failed.
  assert.equal(connection.isRealFailure({ code: -105, isMainFrame: false }), false);
});

test('ERR_ABORTED is not a failure at all', () => {
  // It fires on ordinary in-app navigation.
  assert.equal(connection.isRealFailure({ code: connection.ERR_ABORTED, isMainFrame: true }), false);
  assert.equal(connection.ERR_ABORTED, -3);
});

test('a main-frame failure with a real code is one', () => {
  assert.equal(connection.isRealFailure({ code: -105, isMainFrame: true }), true);
});

/* ------------------------------------------- what counts as actually connected */

test('an error-page commit does not count as connecting successfully', () => {
  // Chromium commits an error document for the same URL after a main-frame
  // failure, and that fires did-finish-load. Taken at face value it turned
  // every failed connect green a few milliseconds after it went red.
  assert.equal(
    connection.shouldMarkConnected({ phase: connection.FAILED, url: 'https://gw.example/' }),
    false,
  );
});

test('a real load while connecting does count', () => {
  assert.equal(
    connection.shouldMarkConnected({ phase: connection.CONNECTING, url: 'https://gw.example/' }),
    true,
  );
});

test('one of the app’s own pages never means a gateway answered', () => {
  assert.equal(
    connection.shouldMarkConnected({ phase: connection.CONNECTING, url: 'file:///app/src/ui/settings.html' }),
    false,
  );
});

/* ------------------------------------------------------ the failure banner */

test('the banner names the gateway and offers exactly one way out', () => {
  const n = connection.failureNotice({ label: 'minizilla', error: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' } });
  assert.equal(n.tone, 'error');
  assert.match(n.message, /minizilla/);
  assert.match(n.detail, /Tailscale/);
  // Chromium's string survives beside the sentence: it is what someone pastes
  // into a search box when the friendly hint does not fit their case.
  assert.match(n.detail, /ERR_NAME_NOT_RESOLVED/);
  assert.equal(n.action.command, 'settings');
});

test('the banner and the gateway row describe one failure the same way', () => {
  // Two wordings of the same failure would drift the first time either moved.
  const error = { code: -102, description: 'ERR_CONNECTION_REFUSED' };
  const row = connection.status({ isActive: true, phase: connection.FAILED, error });
  assert.equal(connection.failureNotice({ label: 'gw', error }).detail, row.detail);
});

test('a failure with no gateway and no error still reads as a sentence', () => {
  // render-process-gone arrives with neither, and a banner saying
  // "Cannot connect to undefined" is worse than the failure it reports.
  const n = connection.failureNotice({});
  assert.equal(n.message, 'Cannot connect to the gateway');
  assert.equal(n.detail, 'The gateway did not respond.');
});
