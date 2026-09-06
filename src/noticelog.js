'use strict';

// The on-disk record of things that went wrong, and when they stopped.
//
// The banner answers "what is wrong now" and dedupes hard to do it: one notice
// per condition, replaced in place. That is the right shape for a banner and
// exactly the wrong shape for the question you ask afterwards, which is "did it
// drop overnight, and how often". Five disconnects in an hour is the finding,
// and the banner is built so you can never see it.
//
// So this is a separate structure with the opposite rule. Nothing is replaced,
// every transition is a line, and it survives a restart, because a restart is
// the most common way the moment you wanted to ask about passes.
//
// Only ERROR and WARN are written. An acknowledgement ("Connected", "up to
// date") is noise here, and recovery is recorded anyway: a raised line is
// answered by a cleared line under the same id, so "when did it come back" is
// answered without logging successes at all.
//
// Electron-free and pure, like src/notices.js: the directory and the clock are
// injected, so the rotation and the retention window are testable without a
// window, an app object or waiting a month. src/main.js owns the live instance.

const fs = require('node:fs');
const path = require('node:path');

/** Kept per month, and only these. */
const LOGGED_TONES = new Set(['error', 'warn']);

// Three files, so "what happened last month" is answerable and the month before
// that is still there when someone gets round to asking.
const KEEP_MONTHS = 3;

// A flapping condition writes a line per transition, which is bounded by real
// state changes rather than by time, so this should never be reached. It is here
// because "should never" is how a tray app that runs for weeks fills a disk.
const MAX_BYTES = 2 * 1024 * 1024;

const MONTH_FILE = /^(\d{4}-\d{2})\.jsonl$/;

/** The month a timestamp belongs to, as it appears in the filename. */
function monthOf(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * @param {object} opts
 * @param {string} opts.dir             directory to keep the monthly files in
 * @param {() => number} [opts.now]     injectable clock
 * @param {number} [opts.keepMonths]
 * @param {number} [opts.maxBytes]      per-file ceiling
 */
function create({ dir, now = Date.now, keepMonths = KEEP_MONTHS, maxBytes = MAX_BYTES }) {
  // Which ids have a raised line with no cleared line yet. Without this, an OK
  // notice being cleared would write an orphan "cleared" for something that was
  // never logged as raised, and the reader would have to guess what it closed.
  const open = new Set();
  let prunedFor = null;

  function fileFor(ms) {
    return path.join(dir, `${monthOf(ms)}.jsonl`);
  }

  /**
   * Delete anything outside the retention window.
   *
   * Called on the first write of each month rather than on every write: it is a
   * readdir, and nothing can age out between two lines in the same month.
   * Failure is swallowed, because a log that cannot tidy up is not a reason to
   * lose the line that prompted it.
   */
  function prune(ms = now()) {
    const keep = new Set();
    const d = new Date(ms);
    for (let i = 0; i < keepMonths; i += 1) {
      keep.add(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    }
    let removed = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        const m = MONTH_FILE.exec(name);
        if (m && !keep.has(m[1])) {
          fs.rmSync(path.join(dir, name), { force: true });
          removed += 1;
        }
      }
    } catch { /* nothing written yet, or the directory is gone */ }
    return removed;
  }

  /**
   * Append one line, and report whether it landed.
   *
   * JSON Lines and append-only, so a crash costs the last line rather than the
   * file. A whole-document rewrite, which is how config.json is written, would
   * put every past failure at risk every time a new one is recorded.
   */
  function write(entry) {
    const file = fileFor(entry.at);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const month = monthOf(entry.at);
      if (prunedFor !== month) {
        prune(entry.at);
        prunedFor = month;
      }
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* first line of the month */ }
      if (size >= maxBytes) return false;
      fs.appendFileSync(file, `${JSON.stringify({ ...entry, at: new Date(entry.at).toISOString() })}\n`, { mode: 0o600 });
      return true;
    } catch {
      // Logging is never worth taking the app down for, and the banner has
      // already said the thing this line was about.
      return false;
    }
  }

  /** Record a notice going up. Ignored unless it is a failure. */
  function raised({ id, tone, message, detail = null }) {
    if (!LOGGED_TONES.has(tone)) return false;
    open.add(id);
    return write({ at: now(), event: 'raised', id, tone, message, detail });
  }

  /** Record the condition passing, if its raise was one we logged. */
  function cleared(id) {
    if (!open.delete(id)) return false;
    return write({ at: now(), event: 'cleared', id });
  }

  /**
   * Every line still on disk, oldest first.
   *
   * A line that will not parse is skipped rather than throwing: a half-written
   * last line from a crash should cost that line and nothing else.
   */
  function read() {
    const entries = [];
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => MONTH_FILE.test(n)).sort(); } catch { return entries; }
    for (const name of names) {
      let raw = '';
      try { raw = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* torn line */ }
      }
    }
    return entries;
  }

  /**
   * The log as the Settings page wants it: one row per failure, newest first,
   * with the clear folded in as an end time.
   *
   * Pairing happens here rather than in the page because it is the only part
   * with a rule worth testing: an unmatched raise is still open, and a raise
   * whose clear landed in an older file that has since aged out is not.
   */
  function sessions() {
    const rows = [];
    const openRows = new Map();
    for (const e of read()) {
      if (e.event === 'raised') {
        const row = { id: e.id, tone: e.tone, message: e.message, detail: e.detail, from: e.at, to: null };
        openRows.set(e.id, row);
        rows.push(row);
      } else if (e.event === 'cleared') {
        const row = openRows.get(e.id);
        if (row) {
          row.to = e.at;
          openRows.delete(e.id);
        }
      }
    }
    return rows.reverse();
  }

  // `dir` is exposed because opening the folder is a supported way to read this:
  // the files are plain JSON Lines precisely so that a person, or grep, can get
  // at a failure the Settings page has since aged out of its own view.
  return { raised, cleared, read, sessions, prune, fileFor, dir };
}

module.exports = { create, monthOf, LOGGED_TONES, KEEP_MONTHS, MAX_BYTES };
