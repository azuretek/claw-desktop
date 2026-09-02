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
