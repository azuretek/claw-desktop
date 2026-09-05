'use strict';

// The banner's store.
//
// The property that makes "stays until it resolves" true rather than decorative
// is that a notice is keyed by *condition* and not by occurrence: raising the
// same one twice replaces it, and the raiser clears it when the condition
// passes. Without that it is a log with a slide animation — three copies of the
// same warning stacking up while the thing they describe is still broken.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const notices = require('../src/notices');

test('the same condition raised twice is one banner, not two', () => {
  const n = notices.create();
  n.set('shortcut', { message: 'The global shortcut is not active.' });
  n.set('shortcut', { message: 'The global shortcut is not active.' });
  assert.equal(n.size(), 1);
});

test('an identical re-raise reports no change, so the slide is not replayed', () => {
  const n = notices.create();
  assert.equal(n.set('a', { message: 'x' }), true, 'first raise is a change');
  assert.equal(n.set('a', { message: 'x' }), false, 'the same thing again is not');
  assert.equal(n.set('a', { message: 'y' }), true, 'different text is');
});

test('clearing reports whether there was anything to clear', () => {
  const n = notices.create();
  n.set('a', { message: 'x' });
  assert.equal(n.clear('a'), true);
  assert.equal(n.clear('a'), false, 'clearing a condition that already passed is a no-op');
  assert.equal(n.size(), 0);
});

test('errors sort above warnings, and older above newer within a severity', () => {
  const n = notices.create();
  n.set('w1', { tone: notices.WARN, message: 'first warning' });
  n.set('e1', { tone: notices.ERROR, message: 'the error' });
  n.set('w2', { tone: notices.WARN, message: 'second warning' });
  assert.deepEqual(n.list().map((x) => x.id), ['e1', 'w1', 'w2']);
});

test('updating a notice does not move it to the bottom', () => {
  // Otherwise a banner someone is mid-sentence through jumps under a newer one
  // because its detail text was refreshed.
  const n = notices.create();
  n.set('a', { tone: notices.WARN, message: 'a' });
  n.set('b', { tone: notices.WARN, message: 'b' });
  n.set('a', { tone: notices.WARN, message: 'a, revised' });
  assert.deepEqual(n.list().map((x) => x.id), ['a', 'b']);
});

test('a notice defaults to an error and to being dismissible', () => {
  const n = notices.create();
  n.set('a', { message: 'x' });
  const [notice] = n.list();
  assert.equal(notice.tone, notices.ERROR);
  assert.equal(notice.dismissible, true);
  assert.equal(notice.detail, null);
});

test('two stores do not share state', () => {
  // The module exports a factory rather than a singleton so a test cannot leak
  // into the next one, and so main owns exactly one instance on purpose.
  const a = notices.create();
  const b = notices.create();
  a.set('x', { message: 'x' });
  assert.equal(b.size(), 0);
});

test('a detail line reads as a sentence even when the OS string does not', () => {
  // Every detail is one of our sentences with a string from the OS dropped in,
  // and those start and end however they start and end.
  assert.equal(notices.sentence('conversion failure from Frobnicate+Zz'), 'Conversion failure from Frobnicate+Zz.');
  assert.equal(notices.sentence('Already ends.'), 'Already ends.');
  assert.equal(notices.sentence('So does this!'), 'So does this!');
  assert.equal(notices.sentence('  padded  '), 'Padded.');
  assert.equal(notices.sentence(''), '', 'nothing in, nothing out — not a lone full stop');
  assert.equal(notices.sentence(null), '');
});

test('a reason written to be appended still reads standing alone', () => {
  // update.policy() phrases its reason for the middle of a sentence ("...because
  // it is running from source"). In the banner it is the whole line, and an
  // uncapitalised one looks like the start of it went missing.
  assert.equal(notices.sentence('running from source'), 'Running from source.');
});

test('an error code keeps its own capitals', () => {
  // Only the first character is touched, so a Chromium code arrives unharmed.
  assert.equal(notices.sentence('ERR_EMPTY_RESPONSE'), 'ERR_EMPTY_RESPONSE.');
});

test('good news sorts below a failure, so an alarm is never pushed down', () => {
  const store = notices.create();
  store.set('good', { tone: notices.OK, message: 'Connected' });
  store.set('bad', { tone: notices.ERROR, message: 'Cannot connect' });
  assert.deepEqual(store.list().map((n) => n.id), ['bad', 'good']);
});

/* ----------------------------------------------------------------- actions */

test('an action survives the round trip and is offered to the banner', () => {
  const n = notices.create();
  n.set('connection', { message: 'Cannot connect', action: { label: 'Open Settings', command: 'settings' } });
  assert.deepEqual(n.list()[0].action, { label: 'Open Settings', command: 'settings' });
});

test('a notice with no action says so explicitly rather than omitting the key', () => {
  // The banner reads `notice.action` directly; undefined and null behave the
  // same there, but the shape crossing IPC should not depend on that.
  const n = notices.create();
  n.set('shortcut', { message: 'The shortcut was refused' });
  assert.equal(n.list()[0].action, null);
});

test('a changed action counts as a change, even when the words do not move', () => {
  const n = notices.create();
  const base = { message: 'Cannot connect', detail: 'The gateway did not respond.' };
  assert.equal(n.set('connection', { ...base, action: { label: 'Open Settings', command: 'settings' } }), true);
  // Identical in every field: no re-render, so a banner that has been sitting
  // there does not replay its slide.
  assert.equal(n.set('connection', { ...base, action: { label: 'Open Settings', command: 'settings' } }), false);
  // Same words, different offer. A button that silently starts doing something
  // else is worse than a re-render.
  assert.equal(n.set('connection', { ...base, action: { label: 'Open Settings', command: 'reconnect' } }), true);
  // And dropping the offer entirely.
  assert.equal(n.set('connection', base), true);
});
