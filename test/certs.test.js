'use strict';

// Certificate pinning, minus Electron.
//
// The interesting part is not that a bad certificate is refused — everything
// refuses it, including doing nothing. It is that "a host we have never seen"
// and "a host that was trusted and has changed its certificate" stay *different
// answers*, because one is routine on a self-signed gateway listener and the
// other is what interception looks like. They are one `===` apart, and the app
// words them very differently.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const certs = require('../src/certs');

/* ------------------------------------------------------------------ decide */

test('a pinned fingerprint is accepted', () => {
  assert.equal(certs.decide({ pinned: 'sha256/AAA', fingerprint: 'sha256/AAA' }), 'accept');
});

test('a host that has never been seen is unknown, not hostile', () => {
  // Routine: the gateway's own listener on :18789 generates its own
  // certificate, so this is what a first connect to a LAN address looks like.
  assert.equal(certs.decide({ pinned: undefined, fingerprint: 'sha256/AAA' }), 'unknown');
});

test('a fingerprint that changed under a pinned host is its own answer', () => {
  // The one case worth alarming about, and the one a blanket "untrusted
  // certificate" message would hide.
  assert.equal(certs.decide({ pinned: 'sha256/AAA', fingerprint: 'sha256/BBB' }), 'changed');
});

test('no fingerprint at all is refused outright', () => {
  assert.equal(certs.decide({ pinned: 'sha256/AAA', fingerprint: null }), 'reject');
});

test('the accept case is an exact match, never a prefix or a substring', () => {
  assert.equal(certs.decide({ pinned: 'sha256/AAA', fingerprint: 'sha256/AAAB' }), 'changed');
  assert.equal(certs.decide({ pinned: 'sha256/AAAB', fingerprint: 'sha256/AAA' }), 'changed');
});

/* ------------------------------------------------------------------ offers */

test('offers start empty and are session state, not config', () => {
  certs.reset();
  assert.deepEqual(certs.pendingOffers(), []);
  assert.equal(certs.offerFor('example.com'), null);
});

test('trusting a host with no offer pins nothing', () => {
  // The failure this guards is a stale Settings page: the offer was dismissed
  // or already trusted in another window, and the button must not reach into
  // the pin store on the strength of a hostname alone.
  certs.reset();
  assert.equal(certs.trust('example.com'), null);
});

test('dismissing an offer that does not exist is not an error', () => {
  certs.reset();
  assert.equal(certs.dismiss('example.com'), false);
});
