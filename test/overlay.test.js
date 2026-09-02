'use strict';

// Plain `node --test` — no Electron. src/overlay.js takes its collaborators as
// arguments for exactly this reason, so the watchdog can be driven against a
// stub WebContents.
//
// What is being protected here is not a nicety. The settings overlay is a
// transparent view covering the whole window; if it stops responding it eats
// every click in the app while remaining invisible, and the only exits live
// inside the renderer that just died. Each of these tests is one way that used
// to end with a window that could be dragged by its title strip and not clicked
// anywhere else.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const overlay = require('../src/overlay');

/** Minimal stand-in for a WebContents: the four members `supervise` touches. */
function stubContents({ loading = true, destroyed = false } = {}) {
  const handlers = new Map();
  return {
    loading,
    destroyed,
    isLoading() { return this.loading; },
    isDestroyed() { return this.destroyed; },
    on(event, fn) { handlers.set(event, [...(handlers.get(event) || []), fn]); },
    once(event, fn) { this.on(event, fn); },
    emit(event, ...args) { for (const fn of handlers.get(event) || []) fn({}, ...args); },
    listenerCount(event) { return (handlers.get(event) || []).length; },
  };
}

/** Wires a supervisor to a fresh stub and records every teardown reason. */
function supervised(opts = {}) {
  const wc = stubContents(opts.contents);
  const closed = [];
  const logs = [];
  let current = true;
  const stop = overlay.supervise(wc, {
    isCurrent: () => current,
    close: (why) => closed.push(why),
    log: (msg) => logs.push(msg),
    timeoutMs: opts.timeoutMs ?? 20,
  });
  return { wc, closed, logs, stop, retire: () => { current = false; } };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ crash teardown */

test('a gone renderer closes the overlay instead of leaving an invisible sheet', () => {
  const s = supervised();
  s.wc.emit('render-process-gone', { reason: 'crashed' });
  assert.equal(s.closed.length, 1);
  assert.match(s.closed[0], /renderer gone \(crashed\)/);
});

test('the reason reaches the log, so a wedged overlay is not a silent one', () => {
  const s = supervised();
  s.wc.emit('render-process-gone', { reason: 'oom' });
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0], /oom/);
  assert.match(s.logs[0], /window stays usable/);
});

test('malformed crash details still tear down', () => {
  // The teardown matters far more than the reason string; a details object that
  // is not the shape we expect must not throw on the recovery path.
  const s = supervised();
  assert.doesNotThrow(() => s.wc.emit('render-process-gone', undefined));
  assert.equal(s.closed.length, 1);
});

/* ------------------------------------------------------- load-failure teardown */

test('a main-frame load failure closes the overlay', () => {
  const s = supervised();
  s.wc.emit('did-fail-load', -6, 'ERR_FILE_NOT_FOUND', 'file:///settings.html', true);
  assert.equal(s.closed.length, 1);
  assert.match(s.closed[0], /-6 ERR_FILE_NOT_FOUND/);
});

test('ERR_ABORTED is ordinary navigation and is not a failure', () => {
  const s = supervised();
  s.wc.emit('did-fail-load', overlay.ERR_ABORTED, 'ERR_ABORTED', 'file:///settings.html', true);
  assert.deepEqual(s.closed, []);
});

test('a failing subframe leaves a perfectly clickable overlay alone', () => {
  const s = supervised();
  s.wc.emit('did-fail-load', -6, 'ERR_FILE_NOT_FOUND', 'file:///nested', false);
  assert.deepEqual(s.closed, []);
});

/* ------------------------------------------------------------------ watchdog */

test('an overlay that never finishes loading is closed by the clock', async () => {
  const s = supervised({ contents: { loading: true } });
  await settle();
  assert.equal(s.closed.length, 1);
  assert.match(s.closed[0], /did not load in time/);
});

test('a page that loaded in time is never touched by the watchdog', async () => {
  const s = supervised();
  s.wc.emit('did-finish-load');
  s.wc.loading = false;
  await settle();
  assert.deepEqual(s.closed, []);
});

test('a destroyed contents is not probed after the fact', async () => {
  // isLoading() on destroyed contents throws in Electron, so the destroyed
  // check has to come first — the watchdog must not itself become the crash.
  const s = supervised({ contents: { loading: true } });
  s.wc.destroyed = true;
  s.wc.isLoading = () => { throw new Error('called on destroyed contents'); };
  await settle();
  assert.deepEqual(s.closed, []);
});

test('an idle-but-unfinished page is left alone', async () => {
  // Only "still loading" is evidence of a wedge. A page that stopped loading
  // without emitting did-finish-load is on screen and usable.
  const s = supervised({ contents: { loading: false } });
  await settle();
  assert.deepEqual(s.closed, []);
});

/* ------------------------------------------------------- close exactly once */

test('a crash that also reports a load failure closes only once', () => {
  // Chromium emits both. Closing twice would tear down whatever overlay had
  // since replaced this one — the bug the fix would have introduced.
  const s = supervised();
  s.wc.emit('render-process-gone', { reason: 'crashed' });
  s.wc.emit('did-fail-load', -6, 'ERR_FAILED', 'file:///settings.html', true);
  assert.equal(s.closed.length, 1);
});

test('a superseded overlay cannot close its replacement', () => {
  const s = supervised();
  s.retire();
  s.wc.emit('render-process-gone', { reason: 'crashed' });
  assert.deepEqual(s.closed, []);
});

test('cancelling stops the watchdog and every later event', async () => {
  const s = supervised({ contents: { loading: true } });
  s.stop();
  s.wc.emit('render-process-gone', { reason: 'crashed' });
  await settle();
  assert.deepEqual(s.closed, []);
});

test('cancelling twice is harmless', () => {
  const s = supervised();
  assert.doesNotThrow(() => { s.stop(); s.stop(); });
});

/* ----------------------------------------------------------------- wiring */

test('every teardown signal is actually subscribed', () => {
  // A watchdog that silently stopped listening would leave no trace until the
  // day it was needed.
  const s = supervised();
  for (const event of ['render-process-gone', 'did-fail-load', 'did-finish-load', 'destroyed']) {
    assert.ok(s.wc.listenerCount(event) > 0, `no listener for ${event}`);
  }
});

test('the default deadline is short enough to be a recovery, not a wait', () => {
  assert.ok(overlay.LOAD_TIMEOUT_MS > 0 && overlay.LOAD_TIMEOUT_MS <= 10000);
});
