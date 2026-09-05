'use strict';

const config = require('./config');

// Trust-on-first-use certificate pinning, decided in Settings.
//
// Why not just `callback(true)` on every error: the gateway's own listener on
// :18789 is self-signed (gateway.tls.autoGenerate), so a blanket accept is the
// only thing that makes the LAN/IP addresses usable -- but a blanket accept also
// silently trusts *any* bad cert on *any* host, which turns this app into an
// MITM-friendly browser. So the exact fingerprint is pinned per host, and a
// later change to that fingerprint is treated as hostile.
//
// Why not a prompt either, which is what this used to be:
//
//   - It was the last native dialog in the app, and native dialogs are a
//     different dialog on each platform in the OS's colours. See the overlay
//     section in src/main.js.
//   - A modal cannot be shown reliably at the moment this fires. The handshake
//     failed, so the window may have no page in it at all, and on a connect at
//     launch there may be no window yet.
//   - A yes/no box in front of someone waiting for their app to open is the
//     worst possible place to put a security decision. It is answered by
//     whichever button makes it go away, which is the same button an attacker
//     would want pressed.
//
// So the connection is refused, the app shows its own error page saying which
// host and why, and the offer is left in Settings beside the certificates
// already trusted -- with the fingerprint in front of you and nothing waiting
// on the answer. Refusing first also means the default outcome of ignoring it
// entirely is the safe one.

// host -> the certificate that was refused, waiting for a decision. Not
// persisted: an offer is about a connection attempt in this session, and one
// surviving a restart would be a security decision presented without the
// context that produced it.
const offers = new Map();

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * What to do about a certificate, given what is pinned for its host.
 *
 * Pure, and separated from the event handler so the three outcomes can be
 * tested without Electron -- the distinction between `unknown` and `changed` is
 * the whole security value here, and it is one `===` away from being lost.
 *
 * @returns {'accept'|'unknown'|'changed'|'reject'}
 */
function decide({ pinned, fingerprint }) {
  if (!fingerprint) return 'reject';
  if (pinned === fingerprint) return 'accept';
  return pinned ? 'changed' : 'unknown';
}

/** Everything currently waiting for a decision, newest first. */
function pendingOffers() {
  return [...offers.values()].sort((a, b) => b.at - a.at);
}

function offerFor(host) {
  return offers.get(host) || null;
}

/** Pin the offered fingerprint. Returns the offer, or null if there was none. */
function trust(host) {
  const offer = offers.get(host);
  if (!offer) return null;
  config.trustCert(host, offer.fingerprint);
  offers.delete(host);
  return offer;
}

/** Refuse it and stop showing it. The pin store is untouched. */
function dismiss(host) {
  return offers.delete(host);
}

/** Test seam. Offers are session state, so a fresh run starts with none. */
function reset() {
  offers.clear();
}

/**
 * Wire into `app.on('certificate-error')`.
 *
 * Calls `callback(true)` only for a host+fingerprint pair already pinned.
 * Anything else is refused on the spot and recorded as an offer.
 *
 * @param {object} app
 * @param {{onOffer?: (offer: object) => void}} [hooks]
 */
function install(app, { onOffer = () => {} } = {}) {
  app.on('certificate-error', (event, _webContents, url, error, certificate, callback) => {
    const host = hostOf(url);
    const fingerprint = certificate && certificate.fingerprint;
    if (!host || !fingerprint) return callback(false);

    // Always take the decision away from Chromium's default (reject) so it can
    // be answered from the pin store instead.
    event.preventDefault();

    const pinned = config.get().trustedCerts[host];
    const verdict = decide({ pinned, fingerprint });
    if (verdict === 'accept') return callback(true);

    // Refused immediately. Nothing is kept waiting on a human, which is what
    // makes it safe for this to happen before there is a window to ask in.
    callback(false);

    const previous = offers.get(host);
    const offer = {
      host,
      fingerprint,
      error: String(error || ''),
      changed: verdict === 'changed',
      previous: verdict === 'changed' ? pinned : null,
      at: Date.now(),
    };
    offers.set(host, offer);
    // A page whose HTML, CSS and websocket all fail at once fires this three
    // times over. Only a fingerprint nobody has been told about yet is news.
    if (!previous || previous.fingerprint !== fingerprint) onOffer(offer);
  });
}

module.exports = { install, decide, pendingOffers, offerFor, trust, dismiss, reset };
