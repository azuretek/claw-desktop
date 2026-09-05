'use strict';

// What the app says about a connection: each gateway's row in Settings, and the
// banner when the active one fails.
//
// A failure changes nothing about where you are. It used to replace the window
// with a dead-end error page, and then with Settings — both of which take the
// screen away from someone who did not ask to leave it. Now it slides a notice
// down from the top with a link to Settings, and the window shows the loading
// screen it was already showing while it tried. Going to Settings is a click,
// and it is the reader's click.
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
 * Both halves of a failure: the sentence for the reader, the code for the
 * search box. Shared by the gateway row and the banner so the two cannot end up
 * describing the same failure differently.
 *
 * The code is appended only when there is a *hint* to append it to. Chromium
 * has far more error strings than the list above, and for one that is not in it
 * `hint()` already falls back to the description — so appending it as well
 * produced "ERR_EMPTY_RESPONSE (ERR_EMPTY_RESPONSE)", which reads as a bug in
 * the app at the moment the reader is trying to diagnose their network.
 */
function reason(error) {
  if (!error) return hint();
  const sentence = hint(error);
  if (!error.description || sentence === error.description) return sentence;
  return `${sentence} (${error.description})`;
}

/**
 * What the banner says when a connection fails.
 *
 * A failure is a condition rather than an event — it stays true until the
 * gateway comes back or someone changes something — which is the banner's whole
 * shape, so it belongs there rather than in a dialog or a replaced screen.
 *
 * The action is a command name rather than a handler because this crosses IPC
 * to a sandboxed page and back. Naming a command main already knows how to run
 * keeps the renderer unable to ask for anything that was not offered.
 */
function failureNotice({ label, error = null } = {}) {
  return {
    tone: 'error',
    message: `Cannot connect to ${label || 'the gateway'}`,
    detail: reason(error),
    action: { label: 'Open Settings', command: 'settings' },
  };
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
      detail: reason(error),
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
  hint, reason, failureNotice, status, isRealFailure, shouldMarkConnected, HINTS, ERR_ABORTED,
  IDLE, CONNECTING, CONNECTED, FAILED,
};
