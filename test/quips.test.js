'use strict';

// The line under the loading bar.
//
// Two things here can actually break something: a list that runs out leaves the
// last line frozen, which is the appearance of the hang this exists to disprove;
// and a line that reads as a real status message is a lie told next to a real
// progress bar.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const quips = require('../src/quips');

test('there are enough lines that a wait does not repeat itself quickly', () => {
  assert.ok(quips.QUIPS.length >= 12, `only ${quips.QUIPS.length} lines`);
  assert.equal(new Set(quips.QUIPS).size, quips.QUIPS.length, 'the list repeats itself');
});

test('the rotation wraps rather than running out', () => {
  // There is no upper bound on how long a connect can take, and a list that ends
  // leaves the last line up forever -- which looks exactly like a hang.
  const first = quips.quipAt(0);
  assert.equal(quips.quipAt(quips.QUIPS.length), first);
  assert.equal(quips.quipAt(quips.QUIPS.length * 7), first);
  for (const step of [0, 1, 5, 99, 1e6]) {
    assert.ok(quips.QUIPS.includes(quips.quipAt(step)), `step ${step} produced nothing`);
  }
});

test('a fractional step is floored, so the wall clock can drive it', () => {
  // main rotates on Date.now() / ROTATE_MS rather than a counter, so the line
  // survives the cover being torn down and rebuilt on a retry.
  assert.equal(quips.quipAt(2.9), quips.quipAt(2));
});

test('the offset shifts the whole sequence without skipping a line', () => {
  const shifted = quips.QUIPS.map((_, i) => quips.quipAt(i, 3));
  assert.equal(new Set(shifted).size, quips.QUIPS.length, 'an offset run misses lines');
});

test('a negative or oversized step still lands on a real line', () => {
  for (const step of [-1, -50, Number.MAX_SAFE_INTEGER]) {
    assert.ok(quips.QUIPS.includes(quips.quipAt(step)), `step ${step} fell off the list`);
  }
});

test('startAt stays inside the list for any seed', () => {
  for (const seed of [0, 0.5, 0.999999, 1, -0.3]) {
    const at = quips.startAt(seed);
    assert.ok(Number.isInteger(at) && at >= 0 && at < quips.QUIPS.length, `seed ${seed} gave ${at}`);
  }
});

test('no line claims to describe a step the app is performing', () => {
  // The whole risk of putting jokes on a loading screen: one that reads as a
  // real diagnostic sends someone chasing a stage that does not exist. The real
  // state is the bar, the URL above it, and the banner when it fails.
  const forbidden = /\b(verif|authent|connect|download|load|handshak|resolv|retry|error|fail)/i;
  for (const line of quips.QUIPS) {
    assert.doesNotMatch(line, forbidden, `"${line}" reads as a status message`);
  }
});

test('the lines are short enough for one row at the narrowest window', () => {
  for (const line of quips.QUIPS) {
    assert.ok(line.length <= 48, `"${line}" is ${line.length} characters`);
  }
});

test('the rotation is slow enough to read and fast enough to move', () => {
  assert.ok(quips.ROTATE_MS >= 2000 && quips.ROTATE_MS <= 6000, `${quips.ROTATE_MS}ms`);
});
