'use strict';

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const label = params.get('label') || '';
const code = params.get('code') || '';
const description = params.get('description') || '';

const $ = (id) => document.getElementById(id);

// Named for the failures that actually happen with a tailnet-only gateway,
// rather than echoing Chromium's error string and leaving the user to guess.
const hints = {
  '-105': 'The hostname did not resolve. Check that Tailscale is connected and MagicDNS is on.',
  '-106': 'This machine appears to be offline.',
  '-109': 'The host is unreachable — are you on the same tailnet or LAN?',
  '-102': 'The connection was refused. The gateway may not be running.',
  '-118': 'The connection timed out. The gateway may be asleep or unreachable from this network.',
  '-200': 'The certificate was rejected, so the connection was not made.',
  '-501': 'The connection is not secure and was blocked.',
};

function host() {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function renderGeneric() {
  $('headline').textContent = label ? `Cannot reach ${label}` : 'Cannot reach the gateway';
  $('detail').textContent = hints[code] || description || 'The gateway did not respond.';
  $('code').textContent = [url, code ? `error ${code}` : '', description].filter(Boolean).join('  ·  ');
}

/**
 * The certificate case, which is the one this page can actually get you out of.
 *
 * A refused certificate used to be a native yes/no box in front of someone
 * waiting for their app to open. Now the connection is simply refused and the
 * decision waits in Settings, so this page's job is to say plainly what
 * happened and point at the one button that resolves it. See src/certs.js.
 */
function renderCertOffer(offer) {
  $('headline').textContent = offer.changed
    ? `The certificate for ${offer.host} has changed`
    : `Cannot verify ${label || offer.host}`;

  $('detail').textContent = offer.changed
    ? 'This host was trusted before and is now presenting a different certificate. That is expected if '
      + 'the gateway was reinstalled or regenerated its own certificate — and it is what interception '
      + 'looks like if nothing like that happened. Compare the fingerprints in Settings before trusting it.'
    : 'The gateway generates its own certificate, so this is normal on an address ending in :18789 rather '
      + 'than a Tailscale Serve address. Review the fingerprint in Settings and trust it there.';

  $('code').textContent = [
    offer.previous ? `was ${offer.previous}` : null,
    `now ${offer.fingerprint}`,
    offer.error,
  ].filter(Boolean).join('  ·  ');

  // Settings becomes the primary action, because retrying cannot succeed until
  // the certificate is trusted — it would fail identically, forever.
  $('settings').textContent = 'Review certificate in Settings';
  $('settings').className = 'primary';
  $('retry').className = '';
}

async function render() {
  const state = await window.clawDesktop.getState();
  const offer = (state.certOffers || []).find((o) => o.host === host());
  if (offer) renderCertOffer(offer);
  else renderGeneric();
}

$('retry').addEventListener('click', () => window.clawDesktop.retry());
$('settings').addEventListener('click', () => window.clawDesktop.openSettings());

// Painted immediately from the URL, then corrected once the state arrives. The
// certificate details come over IPC, and a page that renders nothing until that
// resolves is a blank window on the one screen that exists to explain a failure.
renderGeneric();
void render();
window.clawDesktop.onStateChanged(() => { void render(); });
