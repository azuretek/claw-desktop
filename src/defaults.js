'use strict';

// Gateways offered on first run. These are only *suggestions* — the setup screen
// lets you edit or replace them, and nothing here is contacted until you pick one.
//
// The tailnet name is the canonical address: Tailscale Serve terminates a real
// Let's Encrypt cert on :443 and proxies to the gateway's self-signed listener on
// localhost:18789, so this URL is bare (no port) and raises no cert warning.
// The :18789 entries talk to that inner listener directly and WILL present a
// self-signed cert — expect the trust prompt (see src/certs.js).
const suggestedGateways = [
  { label: 'your-host (tailnet)', url: 'https://your-host.your-tailnet.ts.net' },
  { label: 'your-host (tailnet IP)', url: 'https://100.64.0.1:18789' },
  { label: 'your-host (LAN)', url: 'https://192.168.1.10:18789' },
];

module.exports = {
  suggestedGateways,
  globalShortcut: 'CommandOrControl+Shift+O',
  windowDefaults: { width: 1440, height: 920 },
  minWindow: { width: 480, height: 400 },
};
