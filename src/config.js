'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const defaults = require('./defaults');

let cache = null;
let configFile = null;

function file() {
  if (!configFile) configFile = path.join(app.getPath('userData'), 'config.json');
  return configFile;
}

function blank() {
  return {
    gateways: defaults.suggestedGateways.map((g) => ({ id: crypto.randomUUID(), ...g })),
    activeGatewayId: null,
    window: { width: defaults.windowDefaults.width, height: defaults.windowDefaults.height, x: null, y: null, maximized: false },
    zoomLevel: 0,
    globalShortcut: defaults.globalShortcut,
    closeToTray: true,
    launchAtLogin: false,
    startHidden: false,
    // "light" | "dark" | null — the Control UI's theme as of the last run, so a
    // cold start opens its windows in the right colours before the gateway has
    // answered. Learned, never configured; see adoptTheme in src/main.js.
    themeMode: null,
    // host -> "sha256/BASE64", pinned on first accept. See src/certs.js.
    trustedCerts: {},
  };
}

function read() {
  if (cache) return cache;
  const base = blank();
  if (!fs.existsSync(file())) {
    // Materialise the defaults on first boot so the file is there to inspect and
    // hand-edit, rather than appearing only after the first settings change.
    return write(base);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    // Shallow-merge so a config written by an older build never loses new keys,
    // and a hand-edited file missing a key still boots.
    cache = { ...base, ...raw, window: { ...base.window, ...(raw.window || {}) }, trustedCerts: { ...(raw.trustedCerts || {}) } };
    if (!Array.isArray(cache.gateways) || cache.gateways.length === 0) cache.gateways = base.gateways;
  } catch {
    // Keep the unreadable file in place as evidence; run from defaults this boot.
    cache = base;
  }
  return cache;
}

// Atomic: a crash mid-write must never leave a truncated config that wipes
// pinned certs and gateway list on next boot.
function write(next) {
  cache = next;
  const target = file();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return cache;
}

function update(patch) {
  return write({ ...read(), ...patch });
}

function activeGateway() {
  const cfg = read();
  return cfg.gateways.find((g) => g.id === cfg.activeGatewayId) || null;
}

function addGateway({ label, url }) {
  const cfg = read();
  const entry = { id: crypto.randomUUID(), label: label || url, url };
  write({ ...cfg, gateways: [...cfg.gateways, entry] });
  return entry;
}

function updateGateway(id, patch) {
  const cfg = read();
  const gateways = cfg.gateways.map((g) => (g.id === id
    ? { ...g, label: patch.label ?? g.label, url: patch.url ?? g.url }
    : g));
  return write({ ...cfg, gateways });
}

function removeGateway(id) {
  const cfg = read();
  const gateways = cfg.gateways.filter((g) => g.id !== id);
  const activeGatewayId = cfg.activeGatewayId === id ? null : cfg.activeGatewayId;
  return write({ ...cfg, gateways, activeGatewayId });
}

function trustCert(host, fingerprint) {
  const cfg = read();
  return write({ ...cfg, trustedCerts: { ...cfg.trustedCerts, [host]: fingerprint } });
}

module.exports = {
  path: file,
  get: read,
  update,
  activeGateway,
  addGateway,
  updateGateway,
  removeGateway,
  trustCert,
};
