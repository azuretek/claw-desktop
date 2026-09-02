'use strict';

const { dialog } = require('electron');
const config = require('./config');

// Trust-on-first-use certificate pinning.
//
// Why not just `callback(true)` on every error: the gateway's own listener on
// :18789 is self-signed (gateway.tls.autoGenerate), so a blanket accept is the
// only thing that makes the LAN/IP addresses usable — but a blanket accept also
// silently trusts *any* bad cert on *any* host, which turns this app into an
// MITM-friendly browser. Instead we pin the exact fingerprint per host on an
// explicit prompt, and treat a later change to that fingerprint as hostile.

// One in-flight prompt per host, so a page whose HTML + CSS + websocket all fail
// at once produces a single dialog rather than three stacked ones.
const pending = new Map();

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

async function ask(parentWindow, { host, fingerprint, error, previous }) {
  const changed = Boolean(previous);
  const options = {
    type: changed ? 'error' : 'warning',
    buttons: changed
      ? ['Cancel', 'Trust the new certificate']
      : ['Cancel', 'Trust this certificate'],
    defaultId: 0,
    cancelId: 0,
    title: changed ? 'Certificate changed' : 'Untrusted certificate',
    message: changed
      ? `The certificate for ${host} has CHANGED.`
      : `${host} is using a certificate this app cannot verify.`,
    detail: changed
      ? [
          'This host was trusted before, but it is now presenting a different certificate.',
          '',
          `Previously trusted: ${previous}`,
          `Now presenting:     ${fingerprint}`,
          `Reason:             ${error}`,
          '',
          'This is expected if the gateway was reinstalled or regenerated its self-signed',
          'certificate. If nothing like that happened, something is intercepting the',
          'connection and you should cancel.',
        ].join('\n')
      : [
          'The OpenClaw gateway generates its own certificate, so this is normal when you',
          'connect straight to its listener (an address ending in :18789) instead of going',
          'through the Tailscale Serve address.',
          '',
          `Fingerprint: ${fingerprint}`,
          `Reason:      ${error}`,
          '',
          'Trusting pins this exact fingerprint for this host only. You will be warned',
          'again if it ever changes.',
        ].join('\n'),
    noLink: true,
  };

  const { response } = parentWindow && !parentWindow.isDestroyed()
    ? await dialog.showMessageBox(parentWindow, options)
    : await dialog.showMessageBox(options);

  return response === 1;
}

/**
 * Wire into `app.on('certificate-error')`.
 * Calls `callback(true)` only for a host+fingerprint pair the user has pinned.
 */
function install(app, getParentWindow) {
  app.on('certificate-error', (event, _webContents, url, error, certificate, callback) => {
    const host = hostOf(url);
    const fingerprint = certificate && certificate.fingerprint;
    if (!host || !fingerprint) return callback(false);

    // Always take the decision away from Chromium's default (reject) so we can
    // answer from the pin store instead.
    event.preventDefault();

    const pinned = config.get().trustedCerts[host];
    if (pinned && pinned === fingerprint) return callback(true);

    if (pending.has(host)) {
      // Fold this request into the prompt already on screen for the same host.
      pending.get(host).then((ok) => callback(ok && config.get().trustedCerts[host] === fingerprint));
      return;
    }

    const decision = ask(getParentWindow(), { host, fingerprint, error, previous: pinned })
      .then((accepted) => {
        if (accepted) config.trustCert(host, fingerprint);
        return accepted;
      })
      .catch(() => false)
      .finally(() => {
        // Leave the entry long enough for folded-in callbacks above to resolve.
        setImmediate(() => pending.delete(host));
      });

    pending.set(host, decision);
    decision.then((accepted) => callback(accepted));
  });
}

module.exports = { install };
