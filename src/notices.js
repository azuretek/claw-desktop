'use strict';

// The banner that slides down from the top and stays until the thing it is
// about is fixed.
//
// It exists for a class of problem the app had no way to report: an ongoing
// condition that is nobody's immediate question. Credentials that cannot be
// stored on this machine, a global shortcut the OS refused, an update that
// failed to download. None of them can be answered with a button, so a dialog
// is the wrong shape — it interrupts, gets dismissed, and the condition is
// still true afterwards with nothing on screen to say so.
//
// So a notice is keyed and idempotent rather than a stream of events. Raising
// the same id twice replaces it instead of stacking, and the raiser clears it
// when the condition passes. That is what makes "stays until it resolves"
// literally true rather than a timeout dressed up as one.
//
// Pure and Electron-free: the store is a Map and the decisions are functions,
// so the ordering and the replace-don't-stack rule are testable without a
// window. src/main.js owns the one live instance and renders it in ui/banner.

/** Severities, worst first. The banner is sorted by these. */
const ERROR = 'error';
const WARN = 'warn';
const INFO = 'info';

const RANK = { [ERROR]: 0, [WARN]: 1, [INFO]: 2 };

/**
 * Whether two actions are the same offer.
 *
 * Part of the identity check rather than ignored, because the offer can change
 * while the message does not — and a banner whose button silently starts doing
 * something else is worse than one that re-renders.
 */
function sameAction(a, b) {
  if (!a || !b) return !a && !b;
  return a.label === b.label && a.command === b.command;
}

function create() {
  const notices = new Map();
  let seq = 0;

  /**
   * Raise a notice, or update the one already under this id.
   *
   * `action` is the one place a notice offers to do something, and it is a
   * *command name* rather than a callback: the banner is a sandboxed page on
   * the other side of IPC, so anything it can invoke has to be a string main
   * already knows how to run. It is deliberately singular — a notice that needs
   * two buttons is a question, and a question is a dialog.
   *
   * @param {string} id  stable per condition, not per occurrence
   * @param {{tone?: string, message: string, detail?: string, dismissible?: boolean,
   *          action?: {label: string, command: string}}} notice
   * @returns {boolean} whether anything actually changed
   */
  function set(id, { tone = ERROR, message, detail = null, dismissible = true, action = null }) {
    const previous = notices.get(id);
    if (previous && previous.tone === tone && previous.message === message && previous.detail === detail
      && sameAction(previous.action, action)) {
      // Identical to what is already on screen. Reporting no change matters:
      // the caller uses it to avoid re-rendering, and a banner that re-renders
      // replays its slide-in animation for no reason.
      return false;
    }
    notices.set(id, {
      id,
      tone,
      message,
      detail,
      dismissible,
      action: action ? { label: action.label, command: action.command } : null,
      // Insertion order within a severity, so a new warning appears below an
      // older one rather than shuffling what someone is reading.
      order: previous ? previous.order : seq++,
    });
    return true;
  }

  /** The condition passed. Returns whether there was anything to clear. */
  function clear(id) {
    return notices.delete(id);
  }

  /** Worst first, then oldest first. */
  function list() {
    return [...notices.values()].sort((a, b) => (RANK[a.tone] - RANK[b.tone]) || (a.order - b.order));
  }

  function size() {
    return notices.size;
  }

  return { set, clear, list, size };
}

/**
 * End a fragment with a full stop, unless it already ends with punctuation.
 *
 * Every detail line here is one of our sentences with a string from the OS or a
 * library dropped into it, and those end however they end. Without this the
 * banner reads "conversion failure from Frobnicate+Zz Change it in Settings."
 */
function sentence(text) {
  const trimmed = String(text == null ? '' : text).trim();
  if (!trimmed) return '';
  return /[.!?:;]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

module.exports = { create, sentence, ERROR, WARN, INFO };
