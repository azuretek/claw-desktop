'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// This preload is attached to the same window that later loads the remote
// Control UI, so gate the bridge on the page being one of *our* local pages.
// Remote gateway content gets no API surface at all — it is a website, and it
// should not be able to rewrite gateway settings or read pinned fingerprints.
const isLocalPage = location.protocol === 'file:';

if (isLocalPage) {
  contextBridge.exposeInMainWorld('openclaw', {
    getState: () => ipcRenderer.invoke('app:state'),
    testGateway: (url) => ipcRenderer.invoke('app:test-gateway', url),
    addGateway: (entry) => ipcRenderer.invoke('app:add-gateway', entry),
    removeGateway: (id) => ipcRenderer.invoke('app:remove-gateway', id),
    forgetCert: (host) => ipcRenderer.invoke('app:forget-cert', host),
    connect: (id) => ipcRenderer.invoke('app:connect', id),
    saveSettings: (patch) => ipcRenderer.invoke('app:save-settings', patch),
    retry: () => ipcRenderer.invoke('app:retry'),
    openSettings: () => ipcRenderer.invoke('app:open-settings'),
  });
}
