'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// This preload is attached to the same window that later loads the remote
// Control UI, so gate the bridge on the page being one of *our* local pages.
// Remote gateway content gets no API surface at all — it is a website, and it
// should not be able to rewrite gateway settings or read pinned fingerprints.
const isLocalPage = location.protocol === 'file:';

if (isLocalPage) {
  contextBridge.exposeInMainWorld('clawDesktop', {
    getState: () => ipcRenderer.invoke('app:state'),
    testGateway: (url) => ipcRenderer.invoke('app:test-gateway', url),
    addGateway: (entry) => ipcRenderer.invoke('app:add-gateway', entry),
    updateGateway: (id, patch) => ipcRenderer.invoke('app:update-gateway', id, patch),
    removeGateway: (id) => ipcRenderer.invoke('app:remove-gateway', id),
    // Write-only by design: there is no getCredentials. The settings page can
    // set or clear a credential and learn whether one exists, never read it.
    setCredentials: (id, patch) => ipcRenderer.invoke('app:set-credentials', id, patch),
    addHeader: (id, name, value) => ipcRenderer.invoke('app:add-header', id, name, value),
    removeHeader: (id, name) => ipcRenderer.invoke('app:remove-header', id, name),
    forgetCert: (host) => ipcRenderer.invoke('app:forget-cert', host),
    connect: (id) => ipcRenderer.invoke('app:connect', id),
    saveSettings: (patch) => ipcRenderer.invoke('app:save-settings', patch),
    retry: () => ipcRenderer.invoke('app:retry'),
    openSettings: () => ipcRenderer.invoke('app:open-settings'),
    closeSettings: () => ipcRenderer.invoke('app:close-settings'),

    /* The app's own dialogs, in place of native ones. See the overlay section
       in src/main.js for why none of these is a dialog.showMessageBox. */
    closeOverlay: (name) => ipcRenderer.invoke('app:close-overlay', name),
    about: () => ipcRenderer.invoke('app:about'),
    checkUpdates: () => ipcRenderer.invoke('app:check-updates'),
    openReleases: () => ipcRenderer.invoke('app:open-releases'),
    // The listener is wrapped rather than handed the raw event: a renderer
    // given `event` gets `event.sender`, and with it a way back into IPC that
    // the bridge is supposed to be the only door to.
    onAboutChanged: (fn) => ipcRenderer.on('app:about-changed', () => fn()),
    message: () => ipcRenderer.invoke('app:message'),
    respondToMessage: (index) => ipcRenderer.invoke('app:message-respond', index),
  });
}

/* --------------------------------------------------------- theme reporting */

// Runs for remote pages too, and deliberately so: this reads colours OUT of the
// page and sends them to the main process. It adds nothing to `window`, so the
// gate above still holds — the page cannot call this, only be measured by it.
//
// Worth stating the trust boundary plainly: a hostile gateway could report any
// colour it liked and repaint our caption strip. That is the whole blast radius
// — main parses every value into `#rrggbb` before it reaches an Electron API
// (see chrome.js `normalizeColor`), so the worst case is an ugly title bar.

// Ask the page to resolve `var(--bg)` for us rather than reading the custom
// property directly. `getComputedStyle().getPropertyValue('--bg')` hands back
// the raw token exactly as authored, so a theme written in `oklch()` would
// arrive as a string nothing in the main process can parse. Assigning it to a
// real property and reading the *computed* value makes the engine do the
// conversion, and it always answers in a resolved form.

// Which CSS property each token type is resolved through, and the fallback that
// proves absence. A token the theme does not define makes `var()` fall back —
// and without a sentinel the property would quietly land on its inherited or
// initial value, which for a colour is a perfectly plausible-looking answer
// that is not the token. Anything coming back equal to the sentinel is dropped.
const RESOLVE = {
  color: { prop: 'color', read: 'color', absent: 'rgb(1, 2, 3)' },
  length: { prop: 'width', read: 'width', absent: '31337px' },
  font: { prop: 'fontFamily', read: 'fontFamily', absent: '__claw_absent__' },
  shadow: { prop: 'boxShadow', read: 'boxShadow', absent: '0px 0px 0px rgb(1, 2, 3)' },
};

// The token list lives in src/chrome.js, which a sandboxed preload cannot
// require. Asking for it once per page keeps a single owner rather than a copy
// here that drifts the first time the list changes.
let tokenSpec = null;
function tokenSpecOnce() {
  if (tokenSpec) return tokenSpec;
  try {
    tokenSpec = ipcRenderer.sendSync('chrome:token-spec') || [];
  } catch {
    tokenSpec = [];
  }
  return tokenSpec;
}

function readTheme() {
  const root = document.documentElement;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;top:-9999px;left:-9999px;height:0;pointer-events:none;'
    + 'background-color:var(--bg);color:var(--text)';
  root.appendChild(probe);
  const computed = getComputedStyle(probe);

  const report = {
    mode: root.getAttribute('data-theme-mode'),
    surface: computed.backgroundColor,
    symbol: computed.color,
    tokens: {},
  };

  for (const [name, kind] of tokenSpecOnce()) {
    const spec = RESOLVE[kind];
    if (!spec) continue;
    probe.style[spec.prop] = `var(${name}, ${spec.absent})`;
    const value = computed[spec.read];
    probe.style[spec.prop] = '';
    if (value && value !== spec.absent) report.tokens[name] = value;
  }

  probe.remove();
  return report;
}

let lastReport = '';
function reportTheme() {
  try {
    const report = readTheme();
    // The observer fires on our own marker class as well as on real theme
    // changes; skip the repeats so the main process is not repainting a window
    // it already painted.
    const key = JSON.stringify(report);
    if (key === lastReport) return;
    lastReport = key;
    ipcRenderer.send('chrome:theme', report);
  } catch { /* a page we cannot measure keeps whatever colours are current */ }
}

window.addEventListener('DOMContentLoaded', () => {
  reportTheme();
  // The theme picker rewrites `data-theme` in place with no navigation, so
  // there is no load event to hang this off — the attribute IS the event.
  new MutationObserver(reportTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-theme-mode', 'style', 'class'],
  });
});
