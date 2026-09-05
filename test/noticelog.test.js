'use strict';

// The on-disk failure log.
//
// The store in src/notices.js answers "what is wrong now" by replacing a notice
// in place, so it can never show that a gateway dropped five times overnight.
// This is the other half, with the opposite rule, and the properties worth
// pinning are the ones that only show up over time: that a month rolls into a
// new file, that an old file goes away, and that a failure and its recovery come
// back as one row rather than two events.
//
// The clock and the directory are injected, so a month passing is a number here
// rather than a wait.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const noticelog = require('../src/noticelog');

/** A log in a throwaway directory, with a clock the test drives. */
function withLog(startMs = Date.UTC(2026, 8, 5, 12), opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-noticelog-'));
  let clock = startMs;
  const log = noticelog.create({ dir, now: () => clock, ...opts });
  return {
    log,
    dir,
    at(ms) { clock = ms; },
    advanceDays(n) { clock += n * 24 * 60 * 60 * 1000; },
    files() { return fs.readdirSync(dir).sort(); },
  };
}

const failure = { id: 'connection', tone: 'error', message: 'Cannot connect to home', detail: 'Refused.' };

test('a failure is written, and an acknowledgement is not', () => {
  // "Connected" and "up to date" are the banner's job. In a log they are the
  // noise that makes the failures hard to find.
  const { log, files } = withLog();
  assert.equal(log.raised(failure), true);
  assert.equal(log.raised({ id: 'connected', tone: 'ok', message: 'Connected to home' }), false);
  assert.equal(log.raised({ id: 'update-available', tone: 'info', message: 'A new version' }), false);
  assert.equal(log.read().length, 1);
  assert.deepEqual(files(), ['2026-09.jsonl']);
});

test('clearing something that was never logged writes nothing', () => {
  // Otherwise an OK notice going away leaves a "cleared" line closing a raise
  // that is not in the file, and the reader has to guess what it referred to.
  const { log } = withLog();
  log.raised({ id: 'connected', tone: 'ok', message: 'Connected' });
  assert.equal(log.cleared('connected'), false);
  assert.equal(log.read().length, 0);
});

test('a failure and its recovery come back as one row', () => {
  // This is why successes need not be logged: the end of a failure is recorded
  // as the end of that failure, not as a separate piece of good news.
  const h = withLog();
  h.log.raised(failure);
  h.advanceDays(1);
  h.log.cleared('connection');

  const [row] = h.log.sessions();
  assert.equal(row.message, 'Cannot connect to home');
  assert.equal(row.from, '2026-09-05T12:00:00.000Z');
  assert.equal(row.to, '2026-09-06T12:00:00.000Z');
});

test('a failure that never resolved is still open', () => {
  const { log } = withLog();
  log.raised(failure);
  assert.equal(log.sessions()[0].to, null);
});

test('the same condition failing twice is two rows, not one', () => {
  // The exact opposite of the banner, and the whole reason this file exists.
  const h = withLog();
  h.log.raised(failure);
  h.log.cleared('connection');
  h.advanceDays(1);
  h.log.raised(failure);
  h.log.cleared('connection');
  assert.equal(h.log.sessions().length, 2);
});

test('newest first, because the question is always about the recent one', () => {
  const h = withLog();
  h.log.raised({ ...failure, message: 'older' });
  h.log.cleared('connection');
  h.advanceDays(1);
  h.log.raised({ ...failure, message: 'newer' });
  assert.deepEqual(h.log.sessions().map((r) => r.message), ['newer', 'older']);
});

test('a new month is a new file, and the old one is still readable', () => {
  const h = withLog(Date.UTC(2026, 8, 30, 12));
  h.log.raised(failure);
  h.at(Date.UTC(2026, 9, 1, 12));
  h.log.raised({ ...failure, id: 'secrets', message: 'Cannot store credentials' });

  assert.deepEqual(h.files(), ['2026-09.jsonl', '2026-10.jsonl']);
  assert.equal(h.log.read().length, 2, 'read spans every file that is still there');
});

test('a file outside the retention window is deleted', () => {
  const h = withLog(Date.UTC(2026, 5, 1, 12));
  h.log.raised(failure);
  assert.deepEqual(h.files(), ['2026-06.jsonl']);

  // Three months later, June is the fourth month back and goes.
  h.at(Date.UTC(2026, 8, 1, 12));
  h.log.raised(failure);
  assert.deepEqual(h.files(), ['2026-09.jsonl']);
});

test('the month either side of the window is kept, so the boundary is not off by one', () => {
  const h = withLog(Date.UTC(2026, 6, 1, 12));
  h.log.raised(failure);           // July, two months back
  h.at(Date.UTC(2026, 7, 1, 12));
  h.log.raised(failure);           // August, one month back
  h.at(Date.UTC(2026, 8, 1, 12));
  h.log.raised(failure);           // September, current
  assert.deepEqual(h.files(), ['2026-07.jsonl', '2026-08.jsonl', '2026-09.jsonl']);
});

test('pruning happens once a month, not once a line', () => {
  // It is a readdir, and nothing can age out between two lines in the same
  // month. Called per write it would be a syscall storm during exactly the
  // reconnect flapping that produces the most lines.
  const h = withLog();
  h.log.raised(failure);
  const before = fs.statSync(path.join(h.dir, '2026-09.jsonl')).mtimeMs;
  assert.ok(before > 0);
  assert.equal(h.log.prune(), 0, 'nothing to remove, and no throw on a live directory');
});

test('a file at its ceiling stops accepting lines instead of growing', () => {
  const h = withLog(Date.UTC(2026, 8, 5, 12), { maxBytes: 200 });
  let written = 0;
  for (let i = 0; i < 50; i += 1) {
    if (h.log.raised({ ...failure, id: `x${i}`, message: `failure ${i}` })) written += 1;
  }
  assert.ok(written > 0, 'the first lines land');
  assert.ok(written < 50, 'and it stops rather than growing without limit');
  assert.ok(fs.statSync(path.join(h.dir, '2026-09.jsonl')).size < 400);
});

test('a torn last line costs that line and nothing else', () => {
  // A crash mid-append leaves half a line. Throwing here would lose every
  // failure in the file to the one that was interrupted.
  const h = withLog();
  h.log.raised(failure);
  fs.appendFileSync(path.join(h.dir, '2026-09.jsonl'), '{"at":"2026-09-05T12:00:00.000Z","eve');

  assert.equal(h.log.read().length, 1);
  assert.equal(h.log.sessions().length, 1);
});

test('reading a log that was never written is empty, not an error', () => {
  const { log } = withLog();
  assert.deepEqual(log.read(), []);
  assert.deepEqual(log.sessions(), []);
});

test('an unwritable directory loses the line, never the app', () => {
  // The banner has already said the thing this line was about, so a log that
  // cannot write is not worth an exception on the path that reports failures.
  const log = noticelog.create({ dir: '/dev/null/nope', now: () => Date.UTC(2026, 8, 5) });
  assert.equal(log.raised(failure), false);
  assert.deepEqual(log.read(), []);
});

/* ------------------------------------------------- the seam main.js relies on */

test('the store and the log agree about what a notice is', () => {
  // main.js raises through the store and mirrors the *stored* notice into the
  // log. Neither module's own tests cover that hand-off, and it is the part with
  // a real trap in it: log the argument instead of the stored value and a notice
  // raised without an explicit tone arrives here as undefined, fails the tone
  // check, and the most common kind of failure is the one that never gets
  // written down.
  const store = require('../src/notices').create();
  const { log, dir } = withLog();
  assert.ok(dir);

  const setNotice = (id, n) => { if (store.set(id, n)) log.raised(store.get(id)); };
  const clearNotice = (id) => { if (store.clear(id)) log.cleared(id); };

  setNotice('connection', { message: 'Cannot connect to home', detail: 'Refused.' }); // no tone
  setNotice('connected', { tone: 'ok', message: 'Connected to home' });
  setNotice('connection', { message: 'Cannot connect to home', detail: 'Refused.' }); // identical
  clearNotice('connection');
  clearNotice('connected');

  const rows = log.sessions();
  assert.equal(rows.length, 1, 'one failure, and the acknowledgement is not in the log');
  assert.equal(rows[0].tone, 'error', 'the omitted tone became an error in the store, and is logged as one');
  assert.ok(rows[0].to, 'and its recovery closed it');
  assert.equal(log.read().length, 2, 'a re-raise of an unchanged condition is not a second failure');
});
