'use strict';

const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// Per-gateway credentials: the gateway token, the gateway password, and any
// extra HTTP headers the gateway sits behind (Cloudflare Access, an auth proxy,
// a shared-secret header on a reverse proxy).
//
// Two deliberate choices:
//
//   1. These live in their own file, NOT config.json. config.json is meant to be
//      readable and hand-editable; the moment it carries a token, it stops being
//      safe to open in a screen-share or paste into an issue.
//   2. Values are encrypted with Electron safeStorage — the macOS Keychain and
//      Windows DPAPI — so the file on disk is useless to another local account.
//
// The renderer can WRITE these and can ask whether one is set. It can never read
// one back. That mirrors OpenClaw's own secret store, where values are
// "structurally absent from the listing", and it means a bug in the settings
// page cannot turn into a credential disclosure.

let cache = null;
let storeFile = null;

function file() {
  if (!storeFile) storeFile = path.join(app.getPath('userData'), 'credentials.json');
  return storeFile;
}

// safeStorage reports "available" on Linux even when it has fallen back to the
// `basic_text` backend, which is obfuscation rather than encryption. Treat that
// as unavailable: refusing to store is honest, quietly pretending is not.
function available() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      return safeStorage.getSelectedStorageBackend() !== 'basic_text';
    }
    return true;
  } catch {
    return false;
  }
}

function unavailableReason() {
  if (available()) return null;
  return process.platform === 'linux'
    ? 'No OS keyring is available (install gnome-keyring or kwallet), so credentials cannot be stored encrypted.'
    : 'The OS credential store is unavailable, so credentials cannot be stored encrypted.';
}

function readStore() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.entries || typeof raw.entries !== 'object') throw new Error('shape');
    cache = { version: 1, entries: raw.entries };
  } catch {
    // Missing is the normal first-run case; malformed is left on disk as
    // evidence rather than overwritten, and simply reads as "no credentials".
    cache = { version: 1, entries: {} };
  }
  return cache;
}

// Atomic, 0600. A crash mid-write must not leave a truncated file that loses
// every stored credential at once.
function writeStore(next) {
  cache = next;
  const target = file();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return cache;
}

function blank() {
  return { token: '', password: '', headers: [] };
}

function normaliseHeaders(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((h) => h && typeof h.name === 'string' && typeof h.value === 'string' && h.name.trim())
    .map((h) => ({ name: h.name.trim(), value: h.value }));
}

/** Decrypted credentials for one gateway. Main process only — never sent to a renderer. */
function load(id) {
  const raw = readStore().entries[id];
  if (typeof raw !== 'string' || !raw) return blank();
  try {
    const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(raw, 'base64')));
    return {
      token: typeof parsed.token === 'string' ? parsed.token : '',
      password: typeof parsed.password === 'string' ? parsed.password : '',
      headers: normaliseHeaders(parsed.headers),
    };
  } catch {
    // A failed decrypt means the profile was copied from another machine or
    // another OS account, or the keychain entry was removed. Report "not set"
    // rather than throwing on every page load.
    return blank();
  }
}

function persist(id, creds) {
  const store = readStore();
  const entries = { ...store.entries };
  if (!creds.token && !creds.password && creds.headers.length === 0) delete entries[id];
  else entries[id] = safeStorage.encryptString(JSON.stringify(creds)).toString('base64');
  writeStore({ version: 1, entries });
}

/** What the settings page is allowed to know: whether something is set, never what. */
function summary(id) {
  const creds = load(id);
  return {
    hasToken: Boolean(creds.token),
    hasPassword: Boolean(creds.password),
    headers: creds.headers.map((h) => h.name),
  };
}

function guard() {
  const reason = unavailableReason();
  return reason ? { ok: false, error: reason } : null;
}

/** Write-only. An omitted field is left alone; an empty string clears it. */
function set(id, patch = {}) {
  const blocked = guard();
  if (blocked) return blocked;
  const next = load(id);
  if (typeof patch.token === 'string') next.token = patch.token;
  if (typeof patch.password === 'string') next.password = patch.password;
  persist(id, next);
  return { ok: true };
}

function addHeader(id, name, value) {
  const blocked = guard();
  if (blocked) return blocked;
  const clean = String(name || '').trim();
  // Reject anything that could smuggle a second header or break the request line.
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(clean)) {
    return { ok: false, error: 'That is not a valid HTTP header name.' };
  }
  if (/[\r\n]/.test(String(value ?? ''))) {
    return { ok: false, error: 'Header values cannot contain line breaks.' };
  }
  const next = load(id);
  next.headers = [...next.headers.filter((h) => h.name.toLowerCase() !== clean.toLowerCase()), { name: clean, value: String(value ?? '') }];
  persist(id, next);
  return { ok: true };
}

function removeHeader(id, name) {
  const blocked = guard();
  if (blocked) return blocked;
  const next = load(id);
  next.headers = next.headers.filter((h) => h.name.toLowerCase() !== String(name || '').toLowerCase());
  persist(id, next);
  return { ok: true };
}

function forget(id) {
  const store = readStore();
  if (!(id in store.entries)) return { ok: true };
  const entries = { ...store.entries };
  delete entries[id];
  writeStore({ version: 1, entries });
  return { ok: true };
}

module.exports = {
  path: file,
  available,
  unavailableReason,
  load,
  summary,
  set,
  addHeader,
  removeHeader,
  forget,
};
