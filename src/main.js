'use strict';

const {
  app, BrowserWindow, Tray, Menu, MenuItem, shell, dialog,
  globalShortcut, nativeImage, ipcMain, screen, session,
} = require('electron');
const path = require('node:path');
const https = require('node:https');
const config = require('./config');
const certs = require('./certs');
const chrome = require('./chrome');
const profile = require('./profile');
const secrets = require('./secrets');
const defaults = require('./defaults');

const UI_DIR = path.join(__dirname, 'ui');
const ASSETS = path.join(__dirname, 'assets');
const PRELOAD = path.join(__dirname, 'preload.js');

/* ------------------------------------------------------- profile after rename */

// Runs at load, before app.whenReady() and before anything opens the profile —
// `appData` is one of the few paths resolvable that early. The logic itself
// lives in src/profile.js so it can be tested without launching Electron.
{
  const migration = profile.migrate(app.getPath('appData'));
  if (migration.status === 'migrated') console.log(`[claw] migrated profile: ${migration.from} -> ${migration.to}`);
  if (migration.status === 'failed') console.warn(`[claw] could not migrate profile (${migration.error}); starting fresh`);
}

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let quitting = false;
let showingError = false;
let saveTimer = null;

/* ------------------------------------------------------------------ helpers */

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function activeOrigin() {
  const gw = config.activeGateway();
  return gw ? originOf(gw.url) : null;
}

function trayImage() {
  // Not a macOS template image: the mark is a red lobster and reads better in
  // colour than as a monochrome silhouette.
  const img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  img.setTemplateImage(false);
  return img;
}

/* ------------------------------------------------------------- window state */

// Persist size/position, but only reuse them if the saved rectangle still
// intersects a display that exists now — otherwise unplugging a monitor strands
// the window off-screen with no way to get it back.
function restoredBounds() {
  const saved = config.get().window;
  const { width, height, x, y } = saved;
  const base = {
    width: width || defaults.windowDefaults.width,
    height: height || defaults.windowDefaults.height,
  };
  if (x == null || y == null) return base;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x < a.x + a.width && x + base.width > a.x && y < a.y + a.height && y + base.height > a.y;
  });
  return visible ? { ...base, x, y } : base;
}

function persistBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  const maximized = mainWindow.isMaximized();
  const bounds = maximized ? config.get().window : mainWindow.getNormalBounds();
  config.update({
    window: {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x ?? null,
      y: bounds.y ?? null,
      maximized,
    },
  });
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistBounds, 400);
}

/* ------------------------------------------------------------------ session */

// All gateways share one session, exactly as they would share one browser
// profile.
//
// An earlier version gave each gateway entry its own `persist:` partition,
// reasoning that device pairing is per browser profile. That was wrong twice
// over. Chromium already keys site storage — localStorage, IndexedDB, cookies,
// cache — by origin, so two gateways at different origins are isolated inside
// one session anyway; the partition bought nothing. And because the partition
// name was derived from the entry's UUID, the app threw away its device
// identity the moment the entry changed, so the Gateway saw a brand-new device
// and reported a login from an unrecognised client. Editing a URL, removing and
// re-adding a gateway, or simply upgrading was enough to trigger it.
//
// Sharing the session keeps one stable device identity per gateway origin,
// which is what "pair once" is supposed to mean.
function configureSession(ses, gw) {
  const granted = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media', 'pointerLock']);

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = originOf(details?.requestingUrl || (wc && wc.getURL()) || '');
    callback(origin === activeOrigin() && granted.has(permission));
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    requestingOrigin === activeOrigin() && granted.has(permission));

  applyHeaders(ses);
}

// Extra request headers for gateways behind an authenticating proxy — Cloudflare
// Access, a shared-secret header, Basic auth on a reverse proxy.
//
// Matched per request against the origin of the gateway that owns them, which is
// the whole point: a header set here is a credential, and it must never ride
// along on a request to some third-party host the page happens to load. Keying
// the lookup on the request's own origin (rather than the active gateway's) also
// means one listener covers every gateway and never needs re-registering.
function headersByOrigin() {
  const map = new Map();
  for (const gw of config.get().gateways) {
    const origin = originOf(gw.url);
    const headers = secrets.load(gw.id).headers;
    if (origin && headers.length) map.set(origin, headers);
  }
  return map;
}

function applyHeaders(ses) {
  const map = headersByOrigin();
  // Electron keeps only one listener per session for this event, so re-running
  // this after a credential change replaces the old set rather than stacking.
  if (map.size === 0) {
    ses.webRequest.onBeforeSendHeaders(null);
    return;
  }
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers = map.get(originOf(details.url));
    if (!headers) return callback({ requestHeaders: details.requestHeaders });
    const next = { ...details.requestHeaders };
    for (const h of headers) next[h.name] = h.value;
    callback({ requestHeaders: next });
  });
}

/* ------------------------------------------------------------------- errors */

function showError(detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  showingError = true;
  const gw = config.activeGateway();
  const params = new URLSearchParams({
    code: String(detail.errorCode ?? ''),
    description: detail.errorDescription || 'The gateway could not be reached.',
    url: detail.url || (gw ? gw.url : ''),
    label: gw ? gw.label : '',
  });
  mainWindow.loadFile(path.join(UI_DIR, 'error.html'), { search: `?${params}` });
}

/* -------------------------------------------------------------- main window */

// The Control UI accepts a token handoff on the URL fragment — `#token=<token>`
// — reads it during boot, stores it for that gateway, and strips it from the
// address bar (docs/web/urls.md, "Remote Gateway handoff"). The fragment form is
// the documented preference over `?token=` because fragments never reach HTTP
// request logs or a Referer header. This is what lets the app supply the
// credential instead of asking you to paste one, and because it is reapplied on
// every connect it also self-heals a stale stored token.
function withTokenHandoff(rawUrl, token) {
  if (!token) return rawUrl;
  try {
    const url = new URL(rawUrl);
    const frag = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
    frag.set('token', token);
    url.hash = `#${frag.toString()}`;
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function loadActiveGateway() {
  const gw = config.activeGateway();
  if (!gw) {
    showingError = false;
    return openSettings({ firstRun: true });
  }
  showingError = false;
  autofilled = false;
  const creds = secrets.load(gw.id);
  const supplied = [creds.token && 'token', creds.password && 'password', creds.headers.length && `${creds.headers.length} header(s)`]
    .filter(Boolean).join(', ');
  console.log(`[claw] connecting to ${gw.label || gw.url} <${gw.url}>${supplied ? ` (supplying ${supplied})` : ''}`);
  mainWindow.loadURL(withTokenHandoff(gw.url, creds.token));
}

/* --------------------------------------------------------------- login gate */

// Password mode has no URL handoff — the Control UI parses only `gatewayUrl`,
// `token` and `bootstrapToken`, and its docs are explicit that "passwords stay
// in memory only". So the one way to avoid a manual paste is to fill the login
// gate ourselves.
//
// This is deliberately best-effort and must stay that way: it depends on the
// Control UI's markup, which is not an API. It fills only empty fields, runs at
// most once per load, and if the gate never appears it simply does nothing —
// the worst case is the login screen you would have seen anyway.
let autofilled = false;

function autofillScript(creds) {
  return `(() => {
    if (window.__clawDesktopAutofilled) return 'already';
    const creds = ${JSON.stringify({ token: creds.token, password: creds.password })};
    if (!creds.token && !creds.password) return 'nothing-to-fill';

    const setValue = (el, value) => {
      // Lit binds .value as a property, so assigning el.value alone leaves the
      // component's own state untouched. Go through the native setter and fire
      // the input event its @input handler is listening for.
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const attempt = () => {
      const form = document.querySelector('.login-gate__form');
      if (!form) return false;
      // Field order in the gate: [0] gateway token, [1] gateway password.
      const fields = form.querySelectorAll('.settings-secret input');
      if (!fields.length) return false;
      const filled = [];
      if (creds.token && fields[0] && !fields[0].value) { setValue(fields[0], creds.token); filled.push('token'); }
      if (creds.password && fields[1] && !fields[1].value) { setValue(fields[1], creds.password); filled.push('password'); }
      if (!filled.length) return false;
      window.__clawDesktopAutofilled = true;
      const last = filled.includes('password') ? fields[1] : fields[0];
      last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    };

    // The gate renders only after the WebSocket handshake is refused, which is
    // after did-finish-load — so poll briefly rather than checking once.
    if (attempt()) return 'filled';
    const deadline = Date.now() + 10000;
    const tick = () => { if (attempt() || Date.now() > deadline) return; setTimeout(tick, 250); };
    setTimeout(tick, 250);
    return 'watching';
  })()`;
}

function maybeAutofill(wc) {
  if (autofilled) return;
  const gw = config.activeGateway();
  if (!gw || originOf(wc.getURL()) !== originOf(gw.url)) return;
  const creds = secrets.load(gw.id);
  if (!creds.token && !creds.password) return;
  autofilled = true;
  wc.executeJavaScript(autofillScript(creds), true)
    .then((result) => console.log(`[claw] login gate autofill: ${result}`))
    .catch((err) => console.warn(`[claw] login gate autofill failed: ${err.message}`));
}

function attachNavigationGuards(wc) {
  // A link to anywhere other than the gateway belongs in the real browser. Without
  // this, one click on an external link replaces the app with a page that has no
  // back button and no address bar.
  wc.setWindowOpenHandler(({ url }) => {
    if (originOf(url) === activeOrigin()) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 800,
          minWidth: defaults.minWindow.width,
          minHeight: defaults.minWindow.height,
          backgroundColor: '#0a0a0a',
          autoHideMenuBar: true,
          webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
    return { action: 'deny' };
  });

  wc.on('will-navigate', (event, url) => {
    const target = originOf(url);
    if (target === activeOrigin() || url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });

  // Electron ships no default context menu; without this you cannot even
  // right-click → Paste into the composer.
  wc.on('context-menu', (_event, props) => {
    const menu = new Menu();
    const { editFlags, isEditable, selectionText } = props;
    if (isEditable || selectionText) {
      menu.append(new MenuItem({ role: 'cut', enabled: editFlags.canCut }));
      menu.append(new MenuItem({ role: 'copy', enabled: editFlags.canCopy }));
      menu.append(new MenuItem({ role: 'paste', enabled: editFlags.canPaste }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'selectAll' }));
    }
    if (props.linkURL && /^https?:/.test(props.linkURL)) {
      if (menu.items.length) menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Open link in browser', click: () => shell.openExternal(props.linkURL) }));
      menu.append(new MenuItem({ label: 'Copy link address', click: () => require('electron').clipboard.writeText(props.linkURL) }));
    }
    if (menu.items.length) menu.popup();
  });
}

function createMainWindow() {
  const cfg = config.get();
  configureSession(session.defaultSession, config.activeGateway());

  mainWindow = new BrowserWindow({
    ...restoredBounds(),
    ...chrome.windowOptions(),
    minWidth: defaults.minWindow.width,
    minHeight: defaults.minWindow.height,
    show: false,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    title: 'Claw Desktop',
    icon: process.platform === 'linux' ? path.join(ASSETS, 'icon.png') : undefined,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  if (cfg.window.maximized) mainWindow.maximize();

  const wc = mainWindow.webContents;
  attachNavigationGuards(wc);

  wc.on('did-finish-load', () => {
    wc.setZoomLevel(config.get().zoomLevel || 0);
    chrome.applyToPage(wc);
    maybeAutofill(wc);
  });

  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which fires on ordinary in-app navigation.
    if (!isMainFrame || errorCode === -3) return;
    showError({ errorCode, errorDescription, url: validatedURL });
  });

  wc.on('render-process-gone', (_e, details) => {
    showError({ errorCode: details.reason, errorDescription: `The window stopped responding (${details.reason}).` });
  });

  mainWindow.on('resize', schedulePersist);
  mainWindow.on('move', schedulePersist);
  mainWindow.on('maximize', schedulePersist);
  mainWindow.on('unmaximize', schedulePersist);

  mainWindow.on('close', (event) => {
    persistBounds();
    if (quitting || !config.get().closeToTray) return;
    event.preventDefault();
    // Hide the window but deliberately keep the Dock icon: hiding the Dock icon
    // too suppresses the 'activate' event, and then only the tray or the global
    // shortcut can bring the app back — an easy way to lose it entirely.
    mainWindow.hide();
  });

  mainWindow.once('ready-to-show', () => {
    if (!config.get().startHidden) mainWindow.show();
  });

  loadActiveGateway();
  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

function toggleMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
    return;
  }
  showMainWindow();
}

/* ---------------------------------------------------------- settings window */

function openSettings(opts = {}) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 660,
    minWidth: 560,
    minHeight: 480,
    title: opts.firstRun ? 'Connect to a gateway' : 'Claw Desktop Settings',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    parent: opts.firstRun ? undefined : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined),
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWindow.loadFile(path.join(UI_DIR, 'settings.html'), {
    search: opts.firstRun ? '?firstRun=1' : '',
  });
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => { settingsWindow = null; });
  return settingsWindow;
}

/* ---------------------------------------------------------------- zoom/menu */

function setZoom(delta, absolute) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  const level = absolute !== undefined ? absolute : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta));
  wc.setZoomLevel(level);
  config.update({ zoomLevel: level });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => openSettings() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { label: 'Quit Claw Desktop', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: () => openSettings() }]),
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => (showingError ? loadActiveGateway() : mainWindow?.webContents.reload()) },
        { label: 'Reconnect to gateway', accelerator: 'CmdOrCtrl+Shift+R', click: () => loadActiveGateway() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { label: 'Quit', accelerator: 'Ctrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => setZoom(0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => setZoom(-0.5) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => setZoom(0, 0) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Toggle Developer Tools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ tray */

function buildTray() {
  if (!tray) {
    tray = new Tray(trayImage());
    tray.setToolTip('Claw Desktop');
    tray.on('click', () => (process.platform === 'darwin' ? tray.popUpContextMenu() : toggleMainWindow()));
    tray.on('double-click', showMainWindow);
  }
  const cfg = config.get();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Claw Desktop', click: showMainWindow },
    { label: 'Reconnect', click: () => { showMainWindow(); loadActiveGateway(); } },
    { type: 'separator' },
    {
      label: 'Gateway',
      submenu: cfg.gateways.map((g) => ({
        label: g.label || g.url,
        type: 'radio',
        checked: g.id === cfg.activeGatewayId,
        click: () => switchGateway(g.id),
      })),
    },
    { label: 'Settings…', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function switchGateway(id) {
  config.update({ activeGatewayId: id });
  buildTray();
  showMainWindow();
  loadActiveGateway();
}

/* ------------------------------------------------------- shortcut / startup */

function registerShortcut() {
  globalShortcut.unregisterAll();
  const accel = config.get().globalShortcut;
  if (!accel) return { ok: true };
  try {
    const ok = globalShortcut.register(accel, toggleMainWindow);
    return { ok, error: ok ? null : 'Another application already owns that shortcut.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function applyLaunchAtLogin() {
  const { launchAtLogin, startHidden } = config.get();
  // Only touch the login item when something needs to change. An unpackaged dev
  // run has no registerable app bundle, so calling this unconditionally makes
  // macOS log "Unable to set login item: Operation not permitted" on every start.
  let current = false;
  try {
    current = app.getLoginItemSettings().openAtLogin;
  } catch { /* unsupported on this platform */ }
  if (current === launchAtLogin) return { ok: true };
  try {
    app.setLoginItemSettings({ openAtLogin: launchAtLogin, openAsHidden: startHidden, args: startHidden ? ['--hidden'] : [] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------- gateway test */

// Reachability probe for the settings screen. Deliberately does NOT grant trust:
// when the TLS chain is rejected we retry with verification off purely to read
// back the fingerprint, and report it so the user can compare it to the prompt.
function testGateway(rawUrl) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(rawUrl);
    } catch {
      return resolve({ ok: false, status: null, message: 'That is not a valid URL.' });
    }
    if (!/^https?:$/.test(target.protocol)) {
      return resolve({ ok: false, status: null, message: 'Use an http:// or https:// URL.' });
    }

    const attempt = (rejectUnauthorized) => {
      const mod = target.protocol === 'https:' ? https : require('node:http');
      const req = mod.request(
        { method: 'GET', hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname || '/', rejectUnauthorized, timeout: 8000, servername: target.hostname },
        (res) => {
          let fingerprint = null;
          if (!rejectUnauthorized && res.socket.getPeerCertificate) {
            const cert = res.socket.getPeerCertificate();
            if (cert && cert.fingerprint256) fingerprint = `sha256/${Buffer.from(cert.fingerprint256.replace(/:/g, ''), 'hex').toString('base64')}`;
          }
          res.resume();
          resolve({
            ok: res.statusCode > 0 && res.statusCode < 500,
            status: res.statusCode,
            message: rejectUnauthorized
              ? `Reachable — HTTP ${res.statusCode}.`
              : `Reachable — HTTP ${res.statusCode}, but the certificate is self-signed. You will be asked to trust it once on connect.`,
            fingerprint,
          });
        },
      );
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: null, message: 'Timed out after 8s. Is the gateway running, and are you on the tailnet?' }); });
      req.on('error', (err) => {
        const tls = ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED'];
        if (rejectUnauthorized && tls.includes(err.code)) return attempt(false);
        resolve({ ok: false, status: null, message: `${err.code || 'Error'}: ${err.message}` });
      });
      req.end();
    };

    attempt(true);
  });
}

/* -------------------------------------------------------------------- IPC */

function currentState() {
  const cfg = config.get();
  return {
    // Each gateway carries only whether a credential is set, never its value.
    gateways: cfg.gateways.map((g) => ({ ...g, credentials: secrets.summary(g.id) })),
    activeGatewayId: cfg.activeGatewayId,
    secretsAvailable: secrets.available(),
    secretsError: secrets.unavailableReason(),
    settings: {
      globalShortcut: cfg.globalShortcut,
      closeToTray: cfg.closeToTray,
      launchAtLogin: cfg.launchAtLogin,
      startHidden: cfg.startHidden,
    },
    trustedCerts: cfg.trustedCerts,
    platform: process.platform,
    versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome },
    configPath: config.path(),
  };
}

function registerIpc() {
  ipcMain.handle('app:state', () => currentState());
  ipcMain.handle('app:test-gateway', (_e, url) => testGateway(url));
  ipcMain.handle('app:add-gateway', (_e, entry) => { config.addGateway(entry); buildTray(); return currentState(); });
  ipcMain.handle('app:update-gateway', (_e, id, patch) => {
    config.updateGateway(id, patch || {});
    buildTray();
    // Headers are matched by origin, so a changed URL changes which requests
    // they belong to.
    applyHeaders(session.defaultSession);
    return currentState();
  });
  ipcMain.handle('app:remove-gateway', (_e, id) => {
    // Drop the credentials, but deliberately leave the origin's site data alone:
    // it holds the paired device identity, and wiping it would make a re-added
    // gateway look like a brand-new device and raise a fresh login alert. Use
    // the gateway's own `openclaw devices revoke` to actually sever a device.
    secrets.forget(id);
    config.removeGateway(id);
    buildTray();
    applyHeaders(session.defaultSession);
    return currentState();
  });
  // Token and password are applied at connect time, so no session work here.
  // Save before reading state back: currentState() reports the stored summary.
  ipcMain.handle('app:set-credentials', (_e, id, patch) => {
    const saved = secrets.set(id, patch || {});
    return { ...currentState(), saved };
  });
  ipcMain.handle('app:add-header', (_e, id, name, value) => {
    const res = secrets.addHeader(id, name, value);
    if (res.ok) applyHeaders(session.defaultSession);
    return { ...currentState(), saved: res };
  });
  ipcMain.handle('app:remove-header', (_e, id, name) => {
    const res = secrets.removeHeader(id, name);
    if (res.ok) applyHeaders(session.defaultSession);
    return { ...currentState(), saved: res };
  });
  ipcMain.handle('app:forget-cert', (_e, host) => {
    const cfg = config.get();
    const trustedCerts = { ...cfg.trustedCerts };
    delete trustedCerts[host];
    config.update({ trustedCerts });
    return currentState();
  });
  ipcMain.handle('app:connect', (_e, id) => {
    switchGateway(id);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    return currentState();
  });
  ipcMain.handle('app:save-settings', (_e, patch) => {
    config.update(patch);
    const shortcut = registerShortcut();
    const login = applyLaunchAtLogin();
    buildTray();
    return { ...currentState(), shortcut, login };
  });
  ipcMain.handle('app:retry', () => { loadActiveGateway(); });
  ipcMain.handle('app:open-settings', () => { openSettings(); });
}

/* ------------------------------------------------------------------ startup */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.azuretek.claw-desktop');

    // The default session only ever serves our own file:// pages; the gateway
    // itself loads in a per-gateway partition configured by createMainWindow.
    chrome.applyTheme();
    configureSession(session.defaultSession, null);
    certs.install(app, () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null));

    if (!secrets.available()) console.warn(`[claw] ${secrets.unavailableReason()}`);
    registerIpc();
    buildMenu();
    buildTray();
    applyLaunchAtLogin();

    const shortcut = registerShortcut();
    if (!shortcut.ok) console.warn(`[claw] global shortcut not registered: ${shortcut.error}`);

    if (process.argv.includes('--hidden')) config.update({ startHidden: true });
    createMainWindow();

    app.on('activate', showMainWindow);
  });

  app.on('before-quit', () => { quitting = true; persistBounds(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.on('window-all-closed', () => {
    // With close-to-tray on, the window hides rather than closing, so reaching
    // here means the user genuinely closed everything.
    if (process.platform !== 'darwin' && !config.get().closeToTray) app.quit();
  });
}
