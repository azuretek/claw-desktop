'use strict';

const params = new URLSearchParams(location.search);
const url = params.get('url') || '';
const label = params.get('label') || '';
const code = params.get('code') || '';
const description = params.get('description') || '';

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

document.getElementById('headline').textContent =
  label ? `Cannot reach ${label}` : 'Cannot reach the gateway';

document.getElementById('detail').textContent =
  hints[code] || description || 'The gateway did not respond.';

document.getElementById('code').textContent = [url, code ? `error ${code}` : '', description]
  .filter(Boolean)
  .join('  ·  ');

document.getElementById('retry').addEventListener('click', () => window.clawDesktop.retry());
document.getElementById('settings').addEventListener('click', () => window.clawDesktop.openSettings());
