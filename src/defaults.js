'use strict';

// Gateways offered on first run. These are only *suggestions* — the setup screen
// lets you edit or replace them, and nothing here is contacted until you pick one.
// Edit this list for your own machines, or just add gateways in Settings.
//
// On addressing, because the difference decides whether you get a certificate
// warning:
//
//   - A Tailscale Serve address (`https://<host>.<tailnet>.ts.net`, no port)
//     terminates a real Let's Encrypt certificate and proxies to the gateway's
//     own listener. Prefer it: no port, no warning.
//   - A direct `:18789` address reaches that inner listener, which generates its
//     own certificate, so expect the trust prompt on first connect — see
//     src/certs.js for how the fingerprint is pinned.
//   - Loopback needs no TLS at all.
const suggestedGateways = [
  { label: 'Local gateway', url: 'http://127.0.0.1:18789' },
  { label: 'Tailscale Serve (edit me)', url: 'https://your-host.your-tailnet.ts.net' },
];

module.exports = {
  suggestedGateways,
  globalShortcut: 'CommandOrControl+Shift+O',
  windowDefaults: { width: 1440, height: 920 },
  minWindow: { width: 480, height: 400 },
};
