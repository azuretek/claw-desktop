'use strict';

// Supervision for a view layered over the main window.
//
// The settings overlay is a transparent WebContentsView covering the whole
// window. That means it swallows every mouse event that lands on it, and both
// of its ordinary exits -- the Escape key and the close button -- run *inside*
// its own renderer. A renderer that crashes, fails to load, or simply never
// finishes therefore leaves an invisible sheet over the entire app: the window
// still drags by the title strip, which is a separate view and stays alive, and
// nothing else in it responds to a click. There is no way out but killing the
// app, and nothing on screen says why.
//
// So the overlay is allowed to fail. It is not allowed to fail silently and
// permanently. This module is the watchdog that guarantees the difference.
//
// It lives outside main.js, and takes its collaborators as arguments, so the
// decision can be tested against a stub emitter with no Electron in the room --
// the same shape as `cache.clear`.

// How long the overlay may be a blank sheet over the window before it is
// assumed wedged. It is a local `file://` page with one stylesheet, so it loads
// in single-digit milliseconds; anything approaching this is already broken,
// and every second past it is a second the app cannot be used.
const LOAD_TIMEOUT_MS = 5000;

// ERR_ABORTED. Fires on ordinary navigation away from a page and means nothing
// went wrong, so it must not trigger a teardown.
const ERR_ABORTED = -3;

/**
 * Watch an overlay's WebContents and tear the overlay down when its renderer
 * can no longer do it itself.
 *
 * @param {object} wc            WebContents-like: `on`, `once`, `isDestroyed`, `isLoading`.
 * @param {object} opts
 * @param {() => boolean} opts.isCurrent  Whether this overlay is still the live one.
 *   Checked at fire time rather than captured, so a dying overlay can never close
 *   the one that replaced it.
 * @param {(reason: string) => void} opts.close  Teardown. Called at most once.
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.log]
 * @returns {() => void} Cancels the watchdog. Idempotent.
 */
function supervise(wc, { isCurrent, close, timeoutMs = LOAD_TIMEOUT_MS, log = () => {} }) {
  let done = false;

  const bail = (why) => {
    // `done` guards against a second reason arriving after teardown -- a crash
    // typically emits `did-fail-load` as well -- which would otherwise close a
    // *later* overlay that had already taken this one's place.
    if (done || !isCurrent()) return;
    done = true;
    clearTimeout(timer);
    log(`settings overlay ${why}; closing it so the window stays usable`);
    close(why);
  };

  const timer = setTimeout(() => {
    // Still loading after the deadline is the only signal available: a page that
    // never finishes emits no event at all. A page that finished and is merely
    // idle must be left alone, which is what `isLoading` distinguishes.
    if (!wc.isDestroyed() && wc.isLoading()) bail('did not load in time');
  }, timeoutMs);
  // A watchdog that keeps the process alive would turn a fixed bug into a
  // "quit does nothing" bug on the way out.
  if (typeof timer.unref === 'function') timer.unref();

  const stop = () => { done = true; clearTimeout(timer); };

  wc.on('render-process-gone', (_event, details) => bail(`renderer gone (${details && details.reason})`));
  wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    // A subframe that fails leaves the overlay perfectly usable; only the main
    // frame failing means there is nothing to click.
    if (isMainFrame && code !== ERR_ABORTED) bail(`failed to load (${code} ${description || 'no detail'})`);
  });

  // Success and destruction both end supervision, but neither is a failure.
  wc.once('did-finish-load', stop);
  wc.once('destroyed', stop);

  return stop;
}

module.exports = { supervise, LOAD_TIMEOUT_MS, ERR_ABORTED };
