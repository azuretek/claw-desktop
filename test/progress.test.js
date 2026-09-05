'use strict';

// The loading bar's number. Worth testing rather than eyeballing, because the
// failure that matters is not "the bar looks wrong" — it is the bar claiming a
// stage the load never reached, at the one moment someone is staring at it
// trying to work out why their app will not open.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const progress = require('../src/progress');

test('the bar starts near zero and never opens on a lie', () => {
  assert.equal(progress.percent({ milestone: progress.START, sinceMs: 0 }), 2);
});

test('only a finished load reaches 100', () => {
  assert.equal(progress.percent({ milestone: progress.DONE }), 100);
  // Every other stage, given as long as you like.
  for (const milestone of [progress.START, progress.NAVIGATED, progress.DOM]) {
    const forever = progress.percent({ milestone, sinceMs: 10 * 60 * 1000 });
    assert.ok(forever < 100, `${milestone} reached ${forever} by waiting`);
  }
});

test('waiting inside a stage never carries the bar into the next one', () => {
  // The point of the creep: it fills time, it does not fake an event. A bar that
  // eased all the way to 42 would show DOM's arrival as no change at all.
  const crept = progress.percent({ milestone: progress.START, sinceMs: 60 * 1000 });
  assert.ok(crept < progress.FLOOR[progress.NAVIGATED],
    `crept to ${crept}, at or past NAVIGATED's floor of ${progress.FLOOR[progress.NAVIGATED]}`);
});

test('the number only ever grows while a load is in flight', () => {
  let last = -1;
  for (const milestone of [progress.START, progress.NAVIGATED, progress.DOM, progress.DONE]) {
    for (const sinceMs of [0, 250, 1000, 4000, 30000]) {
      const value = progress.percent({ milestone, sinceMs });
      if (milestone !== progress.DONE) assert.ok(value >= last, `${milestone}@${sinceMs} went backwards`);
      last = Math.max(last, value);
    }
  }
});

test('reaching a milestone is a visible step, not a rounding difference', () => {
  // If the creep swallowed the step, the real event would look like nothing
  // happened -- which is the appearance of a hang.
  const crept = progress.percent({ milestone: progress.START, sinceMs: 30000 });
  const landed = progress.percent({ milestone: progress.NAVIGATED, sinceMs: 0 });
  assert.ok(landed - crept >= 5, `only ${landed - crept} points of visible step`);
});

test('a failure freezes the bar at the stage it actually reached', () => {
  for (const milestone of [progress.START, progress.NAVIGATED, progress.DOM]) {
    const frozen = progress.percent({ milestone, sinceMs: 30000, failed: true });
    assert.equal(frozen, progress.FLOOR[milestone]);
  }
});

test('a failure keeps its distance, so how far it got is still readable', () => {
  // "The host never answered" and "the page loaded and then died" are different
  // problems, and the bar is the only thing on screen that distinguishes them.
  const early = progress.percent({ milestone: progress.START, failed: true });
  const late = progress.percent({ milestone: progress.DOM, failed: true });
  assert.ok(late > early, 'a late failure looks the same as an early one');
});

test('the value is always a whole percentage in range', () => {
  for (const milestone of [...progress.ORDER, 'nonsense']) {
    for (const sinceMs of [-1, 0, 3, 900, 5000, 1e7]) {
      const value = progress.percent({ milestone, sinceMs });
      assert.ok(Number.isInteger(value), `${milestone}@${sinceMs} is not an integer`);
      assert.ok(value >= 0 && value <= 100, `${milestone}@${sinceMs} is ${value}`);
    }
  }
});

test('an unknown milestone is treated as the start rather than throwing', () => {
  // It arrives from an event handler, and a loading screen that crashes on an
  // unexpected string is a worse outcome than one that reads low.
  assert.equal(progress.percent({ milestone: undefined, sinceMs: 0 }), 2);
  assert.equal(progress.percent({ milestone: 'reticulating', sinceMs: 0 }), 2);
  assert.equal(progress.percent({}), 2);
});

test('milestones only move forward', () => {
  // The Control UI routes on load, so its in-page navigation fires
  // `did-start-navigation` *after* `dom-ready`. Taken at face value that walks a
  // bar at 78 back to 42.
  assert.ok(progress.isAhead(progress.DOM, progress.NAVIGATED));
  assert.ok(!progress.isAhead(progress.NAVIGATED, progress.DOM));
  assert.ok(!progress.isAhead(progress.START, progress.START));
  assert.ok(progress.isAhead(progress.DONE, progress.START));
});

test('the milestones are ordered by where they put the bar', () => {
  // The list and the floors are two declarations of one sequence, and a floor
  // out of order would make an event move the bar backwards.
  const floors = progress.ORDER.map((m) => progress.FLOOR[m]);
  assert.deepEqual(floors, [...floors].sort((a, b) => a - b));
  assert.equal(floors.at(-1), 100);
});
