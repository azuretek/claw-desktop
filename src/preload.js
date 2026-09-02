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
// conversion, and it always answers in `rgb()`.
function readTheme() {
  const root = document.documentElement;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;top:-9999px;left:-9999px;width:0;height:0;'
    + 'pointer-events:none;background-color:var(--bg);color:var(--text)';
  root.appendChild(probe);
  const computed = getComputedStyle(probe);
  const report = {
    mode: root.getAttribute('data-theme-mode'),
    surface: computed.backgroundColor,
    symbol: computed.color,
  };
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
