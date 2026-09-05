'use strict';

// What each gateway's row in Settings says about itself.
//
// This exists because the app no longer has a separate error page. A failed
// connection used to replace the window with a dead end whose only real content
// was one sentence; now it puts Settings back on screen, and the gateway that
// failed says so in its own row — beside the address, the credentials and the
// certificate that are usually the reason. The thing you would go to Settings
// to fix is already in front of you.
//
// Pure, and Electron-free, so every phase and every error code can be exercised
// from one `node --test` run. Settings is sandboxed and cannot require this, so
// main.js formats with it and sends the result — the same split as build-info
// and updates.

const IDLE = 'idle'; // never attempted this run
const CONNECTING = 'connecting';
const CONNECTED = 'connected';
const FAILED = 'failed';

// -3 is ERR_ABORTED, which fires on ordinary in-app navigation and means
// nothing went wrong.
const ERR_ABORTED = -3;

// Named for the failures that actually happen with a tailnet-only gateway,
// rather than echoing Chromium's error string and leaving the reader to guess.
// The string from Chromium is kept alongside, never instead: it is what someone
// searches for when the hint does not fit their case.
const HINTS = {
  '-105': 'The hostname did not resolve. Check that Tailscale is connected and MagicDNS is on.',
  '-106': 'This machine appears to be offline.',
  '-109': 'The host is unreachable — are you on the same tailnet or LAN?',
  '-102': 'The connection was refused. The gateway may not be running.',
  '-118': 'The connection timed out. The gateway may be asleep or unreachable from this network.',
  '-200': 'The certificate was rejected, so the connection was not made.',
  '-201': 'The certificate has expired.',
  '-501': 'The connection is not secure and was blocked.',
};

/** The sentence to show for a failure, in the reader's terms where possible. */
function hint({ code, description } = {}) {
  return HINTS[String(code)] || description || 'The gateway did not respond.';
}

/**
 * The status line for one gateway row.
 *
 * A certificate waiting for a decision outranks the connection phase, because
 * it is both the cause of the failure and the only one of the two the reader
 * can act on. Saying "cannot connect" over the top of it would be true and
 * useless.
 *
 * @param {object} opts
 * @param {boolean} opts.isActive        the gateway this app is pointed at
 * @param {string} [opts.phase]          IDLE | CONNECTING | CONNECTED | FAILED
 * @param {{code: (number|string), description: string}} [opts.error]
 * @param {{changed: boolean}} [opts.certOffer]  refused certificate for this host
 * @returns {{tone: string, label: string, detail: string|null}}
 */
function status({ isActive, phase = IDLE, error = null, certOffer = null }) {
  if (certOffer) {
    return {
      tone: certOffer.changed ? 'err' : 'warn',
      label: certOffer.changed ? 'Certificate changed' : 'Certificate not trusted',
      detail: certOffer.changed
        ? 'This host is presenting a different certificate than the one that was trusted. Review it above.'
        : 'Review the certificate above to connect to this gateway.',
    };
  }

  if (!isActive) return { tone: 'muted', label: 'Not connected', detail: null };

  if (phase === CONNECTED) return { tone: 'ok', label: 'Connected', detail: null };
  if (phase === CONNECTING) return { tone: 'muted', label: 'Connecting…', detail: null };
  if (phase === FAILED) {
    return {
      tone: 'err',
      label: 'Cannot connect',
      // Both halves: the sentence for the reader, the code for the search box.
      detail: error ? `${hint(error)}${error.description ? ` (${error.description})` : ''}` : hint(),
    };
  }
  return { tone: 'muted', label: 'Not connected', detail: null };
}

/**
 * Whether a finished load means the gateway actually answered.
 *
 * It is not enough that a load finished, and the reason is nasty: after a main
 * frame fails, Chromium commits an error document *for the same URL* and that
 * commit fires `did-finish-load` too. Taken at face value, every failed connect
 * marked itself connected a few milliseconds after it failed — the row went
 * green, the heading went back to "Settings", and the only trace of the failure
 * was the certificate warning that happened to survive on its own.
 *
 * So the phase is the guard. `loadActiveGateway` sets CONNECTING before every
 * attempt and `did-fail-load` sets FAILED, so an error-page commit arrives with
 * the phase already off CONNECTING and is ignored. A `file:` URL is one of the
 * app's own pages and never means a gateway answered.
 */
function shouldMarkConnected({ phase, url }) {
  if (typeof url === 'string' && url.startsWith('file:')) return false;
  return phase === CONNECTING;
}

/**
 * Whether a `did-fail-load` is worth reacting to at all.
 *
 * A subframe that fails leaves the app perfectly usable, and ERR_ABORTED fires
 * on ordinary navigation — reacting to either would throw the user back to
 * Settings from a working session, which is far worse than the failure.
 */
function isRealFailure({ code, isMainFrame }) {
  return Boolean(isMainFrame) && code !== ERR_ABORTED;
}

module.exports = {
  hint, status, isRealFailure, shouldMarkConnected, HINTS, ERR_ABORTED,
  IDLE, CONNECTING, CONNECTED, FAILED,
};
