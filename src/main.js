'use strict';

const {
  app, BrowserWindow, WebContentsView, Tray, Menu, MenuItem, shell,
  globalShortcut, nativeImage, ipcMain, screen, session,
} = require('electron');
// No `dialog` here on purpose. Everything this app says to the user is one of
// its own overlay pages -- see the overlay section below. The one exception in
// the project is src/certs.js, which has to be able to ask about a certificate
// before any page has loaded, and where the question is a security decision
// rather than a piece of app chrome.
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const autostart = require('./autostart');
const config = require('./config');
const buildInfo = require('./build-info');
const cache = require('./cache');
const certs = require('./certs');
const chrome = require('./chrome');
const menus = require('./menus');
const overlay = require('./overlay');
const profile = require('./profile');
const updates = require('./updates');
const secrets = require('./secrets');
const defaults = require('./defaults');

const UI_DIR = path.join(__dirname, 'ui');
const ASSETS = path.join(__dirname, 'assets');
const PRELOAD = path.join(__dirname, 'preload.js');

// Read once: the stamp is baked into the bundle at pack time and cannot change
// while the app is running.
const buildStamp = buildInfo.read();

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
// The gateway page — and the app's own error and first-run pages — live in a
// child view rather than in the window's own WebContents, because a child view
// can be given bounds and a window's own contents cannot.
//
// That is the entire mechanism behind the reserved title strip: the view starts
// below the window buttons, so the page's viewport genuinely excludes them and
// nothing it draws can land underneath — not a header, not a docked panel, not a
// `position: fixed` overlay anchored to a corner. Linux keeps its OS frame, so
// there the view simply fills the window and this costs nothing.
let pageView = null;
// The strip above it, on macOS and Windows. See ui/titlebar.html.
let stripView = null;
// Settings, About and message dialogs are views layered over the main window's
// contents rather than windows or native dialogs of their own. See the overlay
// section below for why, and for the map that holds them.
//
// True while the main window is showing the settings page directly, which is
// the first run: there is no gateway to lay a modal over yet.
let settingsIsPage = false;
let tray = null;
let quitting = false;
let showingError = false;
let saveTimer = null;
// Inserted-stylesheet keys, per WebContents id, so a theme change can replace
// the sheet it wrote rather than stacking a second one on top.
const themeCssKeys = new Map();

// The colours the app paints for itself, tracking whichever theme the Control
// UI is in. Seeded from the last run so a cold start opens in the right ones
// rather than flashing the wrong palette for as long as the gateway takes to
// answer — which, over Tailscale to a sleeping box, is not a flash.
let currentTheme = chrome.fallbackTheme(config.get().themeMode);

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

/**
 * The WebContents showing the gateway — or, on a first run or a failed connect,
 * one of the app's own pages. Everything that used to address
 * `mainWindow.webContents` addresses this instead.
 */
function page() {
  return pageView && !pageView.webContents.isDestroyed() ? pageView.webContents : null;
}

/**
 * Position the child views. A child view does not track its parent's size, so
 * this has to run on every event that changes it; one missed event leaves the
 * page the wrong size or the modal floating in a corner.
 *
 * The strip's height is the only thing the page gives up, and it is zero on
 * Linux, which keeps its OS frame.
 */
function layoutViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [width, height] = mainWindow.getContentSize();
  const top = chrome.contentInset().top;
  if (stripView) stripView.setBounds({ x: 0, y: 0, width, height: top });
  if (pageView) pageView.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  // A modal covers everything including the strip: the scrim is meant to dim
  // the whole window, and each overlay page carries its own drag band.
  for (const view of overlayViews.values()) view.setBounds({ x: 0, y: 0, width, height });
}

function trayImage() {
  // Not a macOS template image. A template adapts to the menu bar automatically,
  // which is the more native behaviour — but legibility is the reason to want
  // one, and the mark was checked against both a light and a dark menu bar and
  // holds contrast in red on either. So it keeps the app's colour.
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
  settingsIsPage = false;
  const gw = config.activeGateway();
  const params = new URLSearchParams({
    code: String(detail.errorCode ?? ''),
    description: detail.errorDescription || 'The gateway could not be reached.',
    url: detail.url || (gw ? gw.url : ''),
    label: gw ? gw.label : '',
  });
  page()?.loadFile(path.join(UI_DIR, 'error.html'), { search: `?${params}` });
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
    // Nothing to lay a modal over, so settings *is* the window's content. Also
    // the only thing that makes the window paintable at all on a first run:
    // `ready-to-show` never fires for a window that was never asked to load
    // anything, so without this the app would sit in the tray, invisible.
    showingError = false;
    settingsIsPage = true;
    closeSettings();
    page()?.loadFile(path.join(UI_DIR, 'settings.html'), { search: overlaySearch({ firstRun: true }) });
    return null;
  }
  showingError = false;
  settingsIsPage = false;
  autofilled = false;
  const creds = secrets.load(gw.id);
  const supplied = [creds.token && 'token', creds.password && 'password', creds.headers.length && `${creds.headers.length} header(s)`]
    .filter(Boolean).join(', ');
  console.log(`[claw] connecting to ${gw.label || gw.url} <${gw.url}>${supplied ? ` (supplying ${supplied})` : ''}`);
  page()?.loadURL(withTokenHandoff(gw.url, creds.token));
}

/* --------------------------------------------------------------- stale cache */

// The Control UI is a PWA whose service worker serves /assets/ cache-first. A
// browser re-checks sw.js on navigation, which is normally often enough — but
// this app closes to tray rather than quitting, so its document can sit there
// for weeks without one, still controlled by the worker an old gateway
// installed. What that looks like is an app that keeps showing yesterday's
// Control UI after the gateway has been upgraded under it.
//
// Three ways out, in order of how little the user has to notice:
//   - the gateway's build id changed since the last load   -> clearAndReload
//   - this app was upgraded since the last run             -> clearOnAppUpgrade
//   - neither, but it still looks wrong                    -> the menu/tray item
//
// All three route through cache.clear(), which drops caches and *only* caches;
// see src/cache.js for why that boundary is load-bearing.

function gatewayOrigins() {
  return config.get().gateways.map((g) => originOf(g.url)).filter(Boolean);
}

function forgetBuildIds(origins) {
  const next = { ...config.get().swVersions };
  for (const origin of origins) delete next[origin];
  config.update({ swVersions: next });
}

// Set while a reload we triggered ourselves is in flight, so the probe on that
// load is skipped. Not a loop guard — the new build id is recorded *before* the
// reload, so a second pass would decide `unchanged` anyway — just a way to
// avoid re-probing a page we already know the answer for.
let selfReloading = false;

/**
 * Read the gateway's Control UI build id and, if it moved, drop the caches and
 * reload. Called after every successful load of a gateway page.
 */
async function maybeRefreshForNewBuild(wc) {
  if (selfReloading) { selfReloading = false; return; }
  const origin = activeOrigin();
  if (!origin || !wc.getURL().startsWith(origin)) return;

  let source = null;
  try {
    source = await wc.executeJavaScript(cache.SW_SOURCE_PROBE, true);
  } catch {
    // A page that refuses the probe (navigated away mid-flight, no service
    // worker, not a Control UI at all) is not an error worth surfacing: the
    // manual command still covers it.
    return;
  }

  const version = cache.parseServiceWorkerVersion(source);
  const seen = config.get().swVersions[origin] || null;
  const decision = cache.decideRefresh(seen, version);
  if (decision.action === 'none') return;

  // Record first, unconditionally. If clearing or reloading then fails, the
  // worst case is that this upgrade is not auto-cleared; recording afterwards
  // would instead retry the clear on every single load.
  config.update({ swVersions: { ...config.get().swVersions, [origin]: version } });
  if (decision.action === 'record') return;

  console.log(`[claw] control ui build changed at ${origin} (${seen} -> ${version}); clearing cache`);
  selfReloading = true;
  await cache.clear(session.defaultSession, [origin]);
  loadActiveGateway();
}

/**
 * Manual escape hatch, on the File menu and the tray. Clears the active
 * gateway's caches — or every gateway's, if none is active, which is the case
 * on the error page where this is most likely to be reached for.
 */
async function clearCacheAndReload() {
  const active = activeOrigin();
  const origins = active ? [active] : gatewayOrigins();
  console.log(`[claw] clearing cache for ${origins.join(', ') || '(no gateway)'}`);
  await cache.clear(session.defaultSession, origins);
  // Drop the recorded ids too, so the load that follows records what it finds
  // instead of comparing against a build whose cache no longer exists.
  forgetBuildIds(origins);
  loadActiveGateway();
}

/**
 * Identify the installed build.
 *
 * Prefers the commit stamped in at pack time, which is what a build actually
 * is. Failing that — a source run, or a build made from a dirty tree — it stats
 * the app bundle (`app.asar` when packaged, the project directory in
 * development), because the semver alone does not move between builds. See
 * cache.buildFingerprint. A stat that fails degrades to the version, which
 * simply means this particular upgrade is not detected; it must never throw and
 * take startup with it.
 */
function appBuildId() {
  const version = app.getVersion();
  const commit = buildInfo.buildId(buildStamp);
  if (commit) return cache.buildFingerprint({ version, commit });
  try {
    const stat = fs.statSync(app.getAppPath());
    return cache.buildFingerprint({ version, size: stat.size, mtimeMs: stat.mtimeMs });
  } catch {
    return version;
  }
}

/**
 * Clear once on the first run after an app upgrade, before anything loads.
 *
 * A new build brings a new Electron and a new preload; leaving a worker from
 * the previous one in place is the same staleness by a different route. A
 * profile with no recorded build is a fresh install, not an upgrade.
 */
async function clearOnAppUpgrade() {
  const previous = config.get().appBuild;
  const current = appBuildId();
  if (previous === current) return;
  config.update({ appBuild: current, swVersions: {} });
  if (!previous) return;
  console.log(`[claw] app build changed (${previous} -> ${current}); clearing web cache`);
  await cache.clear(session.defaultSession, gatewayOrigins());
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
          backgroundColor: currentTheme.surface,
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

  attachContextMenu(wc);
}

// Electron ships no default context menu; without this you cannot even
// right-click → Paste into the composer, or into the settings page's token and
// URL fields — which is the one place a paste is genuinely likely.
function attachContextMenu(wc) {
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

/* --------------------------------------------------------------- title strip */

/**
 * The strip the app draws above the page, carrying the window buttons.
 *
 * Deliberately inert: no preload, no IPC bridge, no script (its CSP forbids
 * one). It is a coloured, draggable band with a label, and the label is written
 * in from here — the one place that knows which session is loaded. Giving it a
 * bridge would mean a second privileged page for no gain.
 */
function createStrip() {
  if (chrome.contentInset().top === 0) return null;
  stripView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  stripView.setBackgroundColor(currentTheme.surface);
  mainWindow.contentView.addChildView(stripView);
  const wc = stripView.webContents;
  wc.loadFile(path.join(UI_DIR, 'titlebar.html'));
  wc.once('did-finish-load', () => {
    wc.insertCSS(chrome.stripCss()).catch(() => {});
    applyThemeCss(wc);
  });
  return stripView;
}

/**
 * Put the current session's name in the strip, or fall back to the app name.
 *
 * `executeJavaScript` rather than IPC because the strip has no preload to route
 * a message through, and it is not subject to the page's CSP. The value is
 * JSON-encoded, so a session named `</script>` or `'); …` is inert text.
 */
function setStripLabel(session) {
  const wc = stripView && !stripView.webContents.isDestroyed() ? stripView.webContents : null;
  if (!wc) return;
  const text = session || 'Claw Desktop';
  wc.executeJavaScript(
    `document.getElementById('label').textContent = ${JSON.stringify(text)};`,
    true,
  ).catch(() => {});
}

function createMainWindow() {
  const cfg = config.get();
  configureSession(session.defaultSession, config.activeGateway());

  mainWindow = new BrowserWindow({
    ...restoredBounds(),
    ...chrome.windowOptions(currentTheme),
    minWidth: defaults.minWindow.width,
    minHeight: defaults.minWindow.height,
    show: false,
    backgroundColor: currentTheme.surface,
    autoHideMenuBar: true,
    title: 'Claw Desktop',
    icon: process.platform === 'linux' ? path.join(ASSETS, 'icon.png') : undefined,
  });

  if (cfg.window.maximized) mainWindow.maximize();

  createStrip();

  pageView = new WebContentsView({
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
  pageView.setBackgroundColor(currentTheme.surface);
  mainWindow.contentView.addChildView(pageView);

  const wc = pageView.webContents;
  attachNavigationGuards(wc);
  layoutViews();

  // The Control UI sets document.title to "<session> — OpenClaw", and Electron
  // mirrors a page title onto the window by default. That put the upstream name
  // in our taskbar entry and window title even after the rename, which is the
  // one place a user actually reads it. Keep the page's session name — it is
  // genuinely useful when several windows are open — but under our own name.
  //
  // The event fires on the view now, not the window, so the title has to be set
  // rather than merely amended: a view's title does not reach the window at all.
  const refreshTitle = () => {
    const label = chrome.pageLabel(wc.getTitle(), wc.getURL());
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(chrome.windowTitle(label));
    setStripLabel(label);
  };
  wc.on('page-title-updated', refreshTitle);
  // Also on in-page navigation: the label depends on the route, not only on the
  // title, and the two do not always change together — nor in a fixed order, so
  // a title-only listener can read the previous URL.
  wc.on('did-navigate-in-page', refreshTitle);

  wc.on('did-finish-load', () => {
    wc.setZoomLevel(config.get().zoomLevel || 0);
    // Our own pages (first-run settings, the error page) want the Control UI's
    // design tokens. The gateway's page gets nothing injected at all.
    if (wc.getURL().startsWith('file://')) {
      applyThemeCss(wc);
      return;
    }
    maybeAutofill(wc);
    void maybeRefreshForNewBuild(wc);
  });

  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    // -3 is ERR_ABORTED, which fires on ordinary in-app navigation.
    if (!isMainFrame || errorCode === -3) return;
    showError({ errorCode, errorDescription, url: validatedURL });
  });

  wc.on('render-process-gone', (_e, details) => {
    showError({ errorCode: details.reason, errorDescription: `The window stopped responding (${details.reason}).` });
  });

  // Every event that changes the content size has to re-lay the views out — the
  // page's own size now depends on this, not just the modal's, so a missed one
  // is a page that does not fill the window rather than a cosmetic slip.
  mainWindow.on('resize', () => { layoutViews(); schedulePersist(); });
  mainWindow.on('move', schedulePersist);
  mainWindow.on('maximize', () => { layoutViews(); schedulePersist(); });
  mainWindow.on('unmaximize', () => { layoutViews(); schedulePersist(); });
  mainWindow.on('enter-full-screen', layoutViews);
  mainWindow.on('leave-full-screen', layoutViews);

  mainWindow.on('close', (event) => {
    persistBounds();
    if (quitting || !config.get().closeToTray) return;
    event.preventDefault();
    // Hide the window but deliberately keep the Dock icon: hiding the Dock icon
    // too suppresses the 'activate' event, and then only the tray or the global
    // shortcut can bring the app back — an easy way to lose it entirely.
    mainWindow.hide();
  });

  // Child views die with the window, but the module-level handles do not, and a
  // stale one would have `showMainWindow` hand work to a destroyed WebContents.
  mainWindow.on('closed', () => {
    pageView = null;
    stripView = null;
    overlayViews.clear();
    // Nothing left to answer with, so an in-flight message dialog cancels.
    settleMessage(null);
  });

  // `ready-to-show` is the window's own signal and it never fires now: the
  // window has no content of its own, only child views. So the first paint of
  // the *page* is what the window waits for. `dom-ready` rather than
  // `did-finish-load` because subresources should not hold the window back, and
  // `once` on both paths so a later navigation cannot re-show a window the user
  // has since sent to the tray.
  //
  // The window's backgroundColor is the theme surface, so the gap before that
  // fires shows the right colour rather than white.
  if (!config.get().startHidden) {
    const reveal = () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); };
    wc.once('dom-ready', reveal);
    // A gateway that never answers must not leave the app invisible with no way
    // in but the tray; showing the window is also what makes the error page,
    // which replaces the failed load, reachable.
    setTimeout(reveal, 4000);
  }

  loadActiveGateway();
  return mainWindow;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createMainWindow();
  // The tray icon and the global shortcut are what someone reaches for when the
  // window has stopped responding, so this is the right place to sweep up a dead
  // overlay: it makes the instinctive gesture the recovery gesture. Supervision
  // should have caught it already — this is the net under that.
  for (const name of [...overlayViews.keys()]) if (!overlayAlive(name)) closeOverlay(name);
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

/* --------------------------------------------------------------------- theme */

// Adopt a theme reported by the page and repaint everything the page's own
// stylesheet cannot reach. Persisting the mode is what makes the *next* cold
// start open in the right colours; only the mode is kept, because the exact
// surface belongs to whichever palette is live and re-arrives within a frame of
// the page loading.
function adoptTheme(theme) {
  if (!theme) return;
  // Tokens are part of the comparison, not just the caption colours: two
  // palettes can share a `--bg` and differ everywhere else, and if that
  // difference is dropped here the settings page keeps the old theme's borders
  // and accents until something unrelated forces a repaint.
  const changed = theme.surface !== currentTheme.surface
    || theme.symbol !== currentTheme.symbol
    || theme.mode !== currentTheme.mode
    || JSON.stringify(theme.tokens) !== JSON.stringify(currentTheme.tokens);
  if (!changed) return;

  const modeChanged = theme.mode !== currentTheme.mode;
  console.log(`[claw] theme: ${theme.mode} ${theme.surface} (${Object.keys(theme.tokens).length} tokens)`);
  currentTheme = theme;
  chrome.applyTheme(currentTheme, [mainWindow]);
  refreshThemedPages();
  if (modeChanged) config.update({ themeMode: theme.mode });
}

/* ----------------------------------------------------------------- overlays */

/**
 * Every dialog this app shows is one of these: a local page in a transparent
 * WebContentsView layered over the window's contents.
 *
 * None of them is a native dialog, and that is a deliberate rule for the whole
 * project rather than a preference about looks. A native message box is a
 * different dialog on each of the three platforms, takes its colours from the
 * OS rather than from the Control UI theme the rest of the app is tracking,
 * and — the reason the About box came here first — cannot carry anything but a
 * fixed line of text and a row of buttons. Electron's `role: 'about'` panel
 * cannot show which commit a build came from, and it does not exist at all on
 * Windows before Electron 15.
 *
 * They stay separate WebContents rather than being drawn into the gateway's own
 * document, because these pages hold the privileged IPC bridge: the preload
 * grants it only to `file://` pages, so hosting them inside remote content
 * would hand a gateway the ability to rewrite settings and read pinned
 * fingerprints. A child view keeps the modal *look* without giving that up.
 *
 * Views stack in the order they are added, so a message opened while Settings
 * is up lands on top of it and Settings is still there underneath when it goes.
 */
const OVERLAY_PAGES = { settings: 'settings.html', about: 'about.html', message: 'message.html' };

/** name -> WebContentsView, in the order they were opened, which is z-order. */
const overlayViews = new Map();

// `frameless` rides in the URL rather than being fetched over IPC because the
// page uses it for layout — how far down the card starts, to clear the drag
// band. Asked for asynchronously it arrives after first paint, and the card
// visibly jumps on every open.
function overlaySearch(opts = {}) {
  const params = new URLSearchParams();
  if (opts.firstRun) params.set('firstRun', '1');
  if (chrome.enabled()) params.set('frameless', '1');
  return `?${params}`;
}

/** True if this overlay is still a live thing that can be focused and closed. */
function overlayAlive(name) {
  const view = overlayViews.get(name);
  return Boolean(view) && !view.webContents.isDestroyed();
}

function openOverlay(name, opts = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  // A destroyed view still covers the window and still eats clicks, so focusing
  // it does nothing and reopening has to mean *replace*. Otherwise the one
  // action a wedged user would try — click the menu item again — is the one
  // action guaranteed not to help.
  if (overlayViews.has(name) && !overlayAlive(name)) closeOverlay(name);
  if (overlayViews.has(name)) {
    const existing = overlayViews.get(name);
    existing.webContents.focus();
    return existing;
  }

  const view = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Transparent, so the translucent scrim the page paints actually reveals the
  // Control UI underneath instead of a black rectangle. A view added to a
  // window is opaque until told otherwise.
  view.setBackgroundColor('#00000000');
  overlayViews.set(name, view);

  const wc = view.webContents;
  attachContextMenu(wc);
  // Armed before the view is attached, so a load that fails immediately is
  // already covered. `isCurrent` is a closure over the live handle rather than
  // a captured boolean: it has to answer for the overlay that is open *now*, or
  // a dying one closes its own replacement.
  overlay.supervise(wc, {
    isCurrent: () => overlayViews.get(name) === view,
    close: () => closeOverlay(name),
    log: (msg) => console.error(`[claw] ${name} overlay: ${msg}`),
  });
  mainWindow.contentView.addChildView(view);
  layoutViews();
  wc.loadFile(path.join(UI_DIR, OVERLAY_PAGES[name]), { search: opts.search || overlaySearch() });
  wc.once('did-finish-load', () => {
    applyThemeCss(wc);
    wc.focus();
  });
  return view;
}

function closeOverlay(name) {
  const view = overlayViews.get(name);
  if (!view) return;
  overlayViews.delete(name);
  themeCssKeys.delete(view.webContents.id);
  try {
    mainWindow?.contentView.removeChildView(view);
  } catch { /* window already gone; the view goes with it */ }
  // Detaching is the part that unblocks the window, so nothing after it may
  // throw: this runs on the crash path too, where the contents are already gone.
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch { /* already torn down */ }
  // A message shown over Settings must hand focus back to Settings, not to the
  // gateway page buried under both of them.
  const remaining = [...overlayViews.values()].filter((v) => !v.webContents.isDestroyed());
  if (remaining.length) remaining[remaining.length - 1].webContents.focus();
  else page()?.focus();
  // The renderer is the only thing that can answer a message dialog, so losing
  // it has to count as the cancel button. Otherwise a crashed overlay leaves
  // whoever awaited showMessage() waiting for a click that can never happen.
  if (name === 'message') settleMessage(null);
}

function openSettings() {
  // On first run the main window is already showing this page full-size; a
  // modal of the same thing over the top of itself is not an improvement.
  if (settingsIsPage) {
    showMainWindow();
    return null;
  }
  return openOverlay('settings');
}

function closeSettings() {
  closeOverlay('settings');
}

/* ------------------------------------------------------------ message modal */

// Anything that used to be dialog.showMessageBox(). Same shape in and out — a
// message, a detail, a list of buttons, a resolved `{ response }` index — so
// the call sites read the same and only the pixels changed.
let currentMessage = null;
const messageQueue = [];

/**
 * Show one of the app's own message dialogs and resolve with the button index.
 *
 * Queued rather than concurrent: two of these on screen at once would be two
 * scrims dimming each other, and the native dialogs this replaces serialised
 * too. The window is brought forward first, because an overlay inside a hidden
 * window is a dialog nobody can answer — and this app spends most of its life
 * closed to the tray.
 *
 * @param {{message: string, detail?: string, kind?: string, buttons?: string[],
 *          defaultId?: number, cancelId?: number}} spec
 * @returns {Promise<{response: number}>}
 */
function showMessage(spec) {
  return new Promise((resolve) => {
    messageQueue.push({ spec, resolve });
    pumpMessages();
  });
}

/** Resolve the open message. `null` means it was dismissed rather than answered. */
function settleMessage(response) {
  const pending = currentMessage;
  if (!pending) return;
  currentMessage = null;
  const cancel = Number.isInteger(pending.spec.cancelId) ? pending.spec.cancelId : 0;
  pending.resolve({ response: response === null ? cancel : response });
}

function pumpMessages() {
  if (currentMessage) return;
  // Settled already, so this closes an empty shell rather than cancelling
  // anything — and it guarantees the next message gets a page that reads its
  // own state fresh on load, with no need to push an update into a live one.
  closeOverlay('message');
  const next = messageQueue.shift();
  if (!next) return;
  currentMessage = next;
  showMainWindow();
  if (!openOverlay('message')) {
    // No window to lay it over, so there is nothing to answer with.
    settleMessage(null);
    pumpMessages();
  }
}

/**
 * Give one of the app's own pages the Control UI's live design tokens.
 *
 * This is what makes settings look like part of the UI rather than beside it:
 * surfaces, borders, radii and the scrollbar tokens all come from whichever
 * palette the UI is actually running. ui.css declares a full fallback set, so a
 * page that loads before any theme has been reported — the first run — is
 * styled, just not matched.
 */
async function applyThemeCss(wc) {
  if (!wc || wc.isDestroyed()) return;
  const css = chrome.themeCss(currentTheme);
  try {
    const previous = themeCssKeys.get(wc.id);
    if (previous) {
      themeCssKeys.delete(wc.id);
      await wc.removeInsertedCSS(previous);
    }
    if (css) themeCssKeys.set(wc.id, await wc.insertCSS(css));
  } catch { /* the page keeps ui.css's own palette */ }
}

/** Re-theme every page of ours that is currently on screen. */
function refreshThemedPages() {
  for (const view of overlayViews.values()) {
    if (!view.webContents.isDestroyed()) applyThemeCss(view.webContents);
  }
  // The strip is one of the app's own pages, and the one most visibly wrong if
  // it lags: it sits directly against the UI, so a stale surface colour reads as
  // a mismatched band across the top rather than as a slow repaint somewhere.
  if (stripView && !stripView.webContents.isDestroyed()) {
    applyThemeCss(stripView.webContents);
    stripView.setBackgroundColor(currentTheme.surface);
  }
  if ((settingsIsPage || showingError) && mainWindow && !mainWindow.isDestroyed()) {
    applyThemeCss(page());
  }
}

/* ---------------------------------------------------------------- zoom/menu */

function setZoom(delta, absolute) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = page();
  if (!wc) return;
  const level = absolute !== undefined ? absolute : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta));
  wc.setZoomLevel(level);
  config.update({ zoomLevel: level });
}

/* -------------------------------------------------------------------- updates */

// How often a running app looks for a new release. Long, because the app is
// meant to sit in the tray for weeks: the cost of noticing an update an hour
// late is nothing, and the cost of hammering GitHub from every machine is a
// rate limit on the one call that matters.
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Where a platform that cannot install for itself sends the user. Hard-coded
// rather than read from electron-builder.yml's `publish` block: that file is not
// packaged, so the app would be parsing something it does not ship.
const RELEASES_URL = 'https://github.com/azuretek/claw-desktop/releases';
// Long enough that a cold start is not competing with the gateway connection
// for the network, and short enough to be within one sitting.
const UPDATE_FIRST_CHECK_MS = 60 * 1000;

let updater = null; // the electron-updater AppUpdater, or null where we do not check
let updateReady = null; // version string once downloaded and installable
let updateTimer = null;
// The last check to actually finish, for About to report. Updating is otherwise
// invisible — see updates.statusLine() for why that is worth a line.
let lastCheck = { at: null, result: null };

function updatePolicy() {
  return updates.policy({
    platform: process.platform,
    packaged: app.isPackaged,
    autoUpdate: config.get().autoUpdate !== false,
  });
}

/**
 * Track the automatic-updates preference on an already-running updater.
 *
 * Only `autoDownload` moves. Whether to *check* is deliberately not re-read:
 * turning the preference off leaves the six-hourly check running, which is what
 * lets the app still say a release exists and offer to fetch it on the spot.
 * Restarting the app is not required for the toggle to take effect, and an
 * update already downloaded before it was switched off stays installable —
 * throwing away 130MB somebody already waited for would be a strange reading of
 * "stop downloading updates".
 */
function applyUpdatePreference() {
  if (!updater) return;
  const plan = updatePolicy();
  updater.autoDownload = plan.autoDownload;
  notifyAboutChanged();
}

/**
 * Wire up update checking, if this build can do anything useful about one.
 *
 * Required late rather than at the top of the file: it is the app's only runtime
 * dependency, and a source run has no use for it at all.
 */
function initUpdates() {
  const plan = updatePolicy();
  console.log(`[claw] updates: ${plan.action} (${plan.reason})`);
  if (!plan.check) return;

  const { autoUpdater } = require('electron-updater');
  updater = autoUpdater;
  updater.autoDownload = plan.autoDownload;
  // Same channel only: a dev build follows dev releases, a stable build follows
  // stable ones, and neither is ever offered the other. One flag does both
  // directions -- see allowPrerelease() in updates.js for why.
  updater.allowPrerelease = updates.allowPrerelease(app.getVersion());
  // Installing behind the user's back on quit is the wrong default for an app
  // they close to the tray dozens of times a day; the restart is offered.
  updater.autoInstallOnAppQuit = false;
  updater.logger = { info: () => {}, warn: () => {}, error: (m) => console.error(`[claw] updater: ${m}`), debug: () => {} };

  // The plan is re-read on every event rather than captured here: the
  // automatic-updates preference can change while the app runs, and a handler
  // holding the plan from startup would keep acting on the old answer.
  updater.on('update-available', (info) => onUpdateAvailable(info));
  updater.on('update-downloaded', (info) => onUpdateDownloaded(info));
  updater.on('error', (err) => {
    // Never unprompted. A machine that is offline, or behind a proxy, or hitting
    // a rate limit must not interrupt whatever the user was doing to say so.
    console.error(`[claw] update check failed: ${err && err.message}`);
    setLastCheck('check failed');
    if (pendingManualCheck) {
      pendingManualCheck = false;
      void showMessage({ kind: 'warning', message: 'Could not check for updates.', detail: String((err && err.message) || err), buttons: ['OK'] });
    }
  });
  updater.on('update-not-available', () => {
    setLastCheck('up to date');
    if (!pendingManualCheck) return;
    pendingManualCheck = false;
    void showMessage({ message: 'Claw Desktop is up to date.', detail: `You are on ${app.getVersion()}.`, buttons: ['OK'] });
  });

  setTimeout(() => void checkForUpdates('startup'), UPDATE_FIRST_CHECK_MS);
  updateTimer = setInterval(() => void checkForUpdates('scheduled'), UPDATE_INTERVAL_MS);
}

let pendingManualCheck = false;

/** Record how a check ended, and push it to an About box that is on screen. */
function setLastCheck(result) {
  lastCheck = { at: Date.now(), result };
  notifyAboutChanged();
}

async function checkForUpdates(trigger = 'manual') {
  if (!updater) {
    if (updates.shouldReportNoUpdate(trigger)) {
      const plan = updatePolicy();
      void showMessage({ message: 'Updates are not available in this build.', detail: plan.reason, buttons: ['OK'] });
    }
    return;
  }
  pendingManualCheck = updates.shouldReportNoUpdate(trigger);
  try {
    await updater.checkForUpdates();
  } catch {
    // Deliberately silent. electron-updater emits 'error' *and* rejects for the
    // same failure, so logging here too prints every update failure twice —
    // which is exactly what a first run against a repo with no releases did.
    // This catch exists only to stop the rejection going unhandled.
  }
}

async function onUpdateAvailable(info) {
  const plan = updatePolicy();
  pendingManualCheck = false;
  setLastCheck(`${info.version} available`);
  // Windows downloads in the background and speaks once it can actually offer
  // the restart, so there is nothing useful to say yet.
  if (plan.action === updates.INSTALL) return;

  const { message, detail } = updates.availableMessage({
    action: plan.action, version: info.version, current: app.getVersion(), reason: plan.reason,
  });

  // Two different offers, and saying the wrong one is worse than saying
  // nothing: MANUAL means this build can install it and is waiting to be told,
  // NOTIFY means it genuinely cannot and the release page is the only way on.
  const canInstallNow = plan.action === updates.MANUAL;
  const { response } = await showMessage({
    message,
    detail,
    buttons: [canInstallNow ? 'Download and install' : 'Open release page', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  if (!canInstallNow) {
    await shell.openExternal(`${RELEASES_URL}/tag/v${info.version}`);
    return;
  }
  // Straight to downloadUpdate rather than flipping autoDownload: this is a
  // one-off yes to this version, not a change to the preference.
  setLastCheck(`downloading ${info.version}`);
  try {
    await updater.downloadUpdate();
  } catch (err) {
    setLastCheck('download failed');
    void showMessage({ kind: 'warning', message: 'Could not download the update.', detail: String((err && err.message) || err), buttons: ['OK'] });
  }
}

async function onUpdateDownloaded(info) {
  updateReady = info.version;
  setLastCheck(`${info.version} downloaded, restart to apply`);
  buildTray(); // so "Restart to update" appears without waiting for the dialog
  const { response } = await showMessage({
    message: `Claw Desktop ${info.version} is ready.`,
    detail: 'Restart to finish updating. You can also keep working and restart later.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    quitting = true;
    // isSilent false so the installer's progress is visible; isForceRunAfter so
    // the app comes back rather than leaving the user staring at a closed window.
    updater.quitAndInstall(false, true);
  }
}

/**
 * What the About box shows, gathered in one place so the page and any future
 * caller cannot disagree about it.
 *
 * Every line is something someone gets asked for when reporting a problem and
 * cannot look up for themselves: which build this is, what it does about new
 * versions and when it last looked, and the runtime a rendering bug would be
 * blamed on.
 */
function aboutState() {
  const plan = updatePolicy();
  return {
    version: app.getVersion(),
    build: buildInfo.describe(app.getVersion(), buildStamp),
    channel: updates.channelOf(app.getVersion()) || 'stable',
    updateStatus: updates.statusLine({
      action: plan.action,
      reason: plan.reason,
      channel: updates.channelOf(app.getVersion()),
      checkedAt: lastCheck.at,
      result: lastCheck.result,
    }),
    // The About box is where someone goes to ask "is it even updating?", so it
    // has to be able to answer "no, and here is the switch" as well as "yes".
    autoUpdate: config.get().autoUpdate !== false,
    canInstall: plan.canInstall,
    capabilityReason: plan.capabilityReason,
    checking: pendingManualCheck,
    updateReady,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
    platform: process.platform,
    arch: process.arch,
    releasesUrl: RELEASES_URL,
  };
}

/**
 * Push a fresh About state into the box if it happens to be open.
 *
 * Without this, clicking "Check for updates" from inside About would leave the
 * status line it is sitting under saying "no check yet this run" — the one
 * question the box exists to answer, answered wrongly, immediately after the
 * user did the thing that changed it.
 */
function notifyAboutChanged() {
  const view = overlayViews.get('about');
  if (view && !view.webContents.isDestroyed()) view.webContents.send('app:about-changed');
}

/**
 * Tell the app's own pages that `currentState()` has moved under them.
 *
 * Settings renders from a snapshot it fetched when it opened, so without this a
 * certificate refused *while it is on screen* — which is exactly what happens
 * when you press Reconnect from inside it — would not appear until it was
 * closed and reopened.
 */
function notifyStateChanged() {
  for (const view of overlayViews.values()) {
    if (!view.webContents.isDestroyed()) view.webContents.send('app:state-changed');
  }
  if ((settingsIsPage || showingError) && page()) page().send('app:state-changed');
}

/**
 * The About box, as one of the app's own overlay pages.
 *
 * Reachable from the menu bar and from the tray. The tray matters more than it
 * looks: Windows runs with `autoHideMenuBar`, so the menu bar is behind an Alt
 * press that nobody discovers, which is exactly how a build with a working
 * "Check for updates…" can still read as having none.
 */
function showAbout() {
  showMainWindow();
  openOverlay('about');
}

/**
 * Every command the menu bar and the tray can run, defined once.
 *
 * One definition per command, so a label or a behaviour cannot differ between
 * the places it appears — which is half of what keeps the platforms identical.
 * src/menus.js arranges them; see the note at the top of that file for the
 * differences the operating systems impose and why nothing of ours hides behind
 * one.
 */
function menuCommands() {
  return {
    about: { label: 'About Claw Desktop', click: () => showAbout() },
    checkUpdates: { label: 'Check for updates…', click: () => { void checkForUpdates('manual'); } },
    releaseNotes: { label: 'Release notes', click: () => { void shell.openExternal(RELEASES_URL); } },
    settings: { label: 'Settings…', click: () => openSettings() },
    reload: { label: 'Reload', click: () => (showingError ? loadActiveGateway() : page()?.reload()) },
    reconnect: { label: 'Reconnect to gateway', click: () => loadActiveGateway() },
    clearCache: { label: 'Clear cache and reload', click: () => { void clearCacheAndReload(); } },
    quit: { label: 'Quit Claw Desktop', click: () => { quitting = true; app.quit(); } },
    zoomIn: { label: 'Zoom In', click: () => setZoom(0.5) },
    zoomOut: { label: 'Zoom Out', click: () => setZoom(-0.5) },
    actualSize: { label: 'Actual Size', click: () => setZoom(0, 0) },
    devTools: { label: 'Toggle Developer Tools', click: () => page()?.toggleDevTools() },
  };
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menus.template({
    platform: process.platform,
    appName: app.name,
    commands: menuCommands(),
  })));
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
  // The same command objects the menu bar uses, so a label or a behaviour cannot
  // differ between the two places someone might reach for it.
  const cmd = menuCommands();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Claw Desktop', click: showMainWindow },
    // Only once there is genuinely something to restart into. A permanently
    // present "Restart to update" that usually does nothing teaches people to
    // ignore it, which is the opposite of what it is for.
    ...(updateReady ? [{
      label: `Restart to update to ${updateReady}`,
      click: () => { quitting = true; updater.quitAndInstall(false, true); },
    }] : []),
    // The tray copies bring the window forward first. Reloading something
    // nobody can see is not what anyone means by clicking these from a tray.
    { ...cmd.reconnect, click: () => { showMainWindow(); loadActiveGateway(); } },
    { ...cmd.clearCache, click: () => { showMainWindow(); void clearCacheAndReload(); } },
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
    cmd.settings,
    // On the tray as well as the menu bar, because Windows hides the menu bar
    // behind an Alt press: a build that updates itself perfectly still looks
    // like one with no updater anywhere in it.
    cmd.checkUpdates,
    cmd.about,
    { type: 'separator' },
    cmd.quit,
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

  // Linux takes a different route to the same setting. app.setLoginItemSettings
  // is `@platform darwin,win32`; on Linux it neither works nor throws, so the
  // checkbox would stay ticked and nothing would ever launch. autostart.js
  // writes the XDG entry every desktop environment reads instead.
  if (process.platform === 'linux') {
    const r = autostart.apply({ enabled: launchAtLogin, hidden: startHidden });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

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
    frameless: chrome.enabled(),
    secretsError: secrets.unavailableReason(),
    settings: {
      globalShortcut: cfg.globalShortcut,
      closeToTray: cfg.closeToTray,
      launchAtLogin: cfg.launchAtLogin,
      startHidden: cfg.startHidden,
      autoUpdate: cfg.autoUpdate !== false,
    },
    // Why the automatic-updates toggle is unavailable, where it is. A build
    // that could never install one has nothing to switch on, and saying so
    // beats a checkbox that silently does nothing.
    updates: (() => {
      const plan = updatePolicy();
      return { canInstall: plan.canInstall, reason: plan.capabilityReason };
    })(),
    trustedCerts: cfg.trustedCerts,
    // Certificates refused this session and waiting for a decision. This is
    // where the prompt went: Settings shows them, the error page points here.
    certOffers: certs.pendingOffers(),
    platform: process.platform,
    // Pre-formatted rather than sent as parts: the settings page is sandboxed
    // and cannot require src/build-info.js, so formatting it there would mean a
    // second copy of the rules that would drift.
    build: buildInfo.describe(app.getVersion(), buildStamp),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
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
  ipcMain.handle('app:trust-cert', (_e, host) => {
    const offer = certs.trust(String(host));
    // Reconnecting is the whole point of having trusted it, and the failed load
    // that produced the offer left the window on the error page — so without
    // this the reward for making the decision is a page that still says the
    // connection failed.
    const gw = config.activeGateway();
    let activeHost = null;
    try { activeHost = gw ? new URL(gw.url).host : null; } catch { /* unparseable url, no reconnect */ }
    if (offer && offer.host === activeHost) loadActiveGateway();
    return { ...currentState(), trusted: Boolean(offer) };
  });
  ipcMain.handle('app:dismiss-cert-offer', (_e, host) => {
    certs.dismiss(String(host));
    return currentState();
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
    closeSettings();
    return currentState();
  });
  ipcMain.handle('app:save-settings', (_e, patch) => {
    config.update(patch);
    const shortcut = registerShortcut();
    const login = applyLaunchAtLogin();
    // Takes effect now rather than on the next launch: a preference that needs
    // a restart to mean anything is one the user cannot tell they have set.
    applyUpdatePreference();
    buildTray();
    return { ...currentState(), shortcut, login };
  });
  ipcMain.handle('app:retry', () => { loadActiveGateway(); });
  ipcMain.handle('app:open-settings', () => { openSettings(); });
  ipcMain.handle('app:close-settings', () => { closeSettings(); });

  // The app's own dialogs. `app:message` is what a freshly loaded message page
  // asks for; there is no push, so a page that reloads for any reason comes
  // back showing the same thing rather than an empty card.
  ipcMain.handle('app:close-overlay', (_e, name) => { closeOverlay(String(name)); });
  ipcMain.handle('app:about', () => aboutState());
  ipcMain.handle('app:check-updates', () => { void checkForUpdates('manual'); });
  ipcMain.handle('app:open-releases', () => shell.openExternal(RELEASES_URL));
  ipcMain.handle('app:message', () => (currentMessage ? currentMessage.spec : null));
  ipcMain.handle('app:message-respond', (_e, index) => {
    settleMessage(Number.isInteger(index) ? index : null);
    closeOverlay('message');
    pumpMessages();
  });

  // Synchronous, and only because the caller is a sandboxed preload that cannot
  // require src/chrome.js. Serving the list from its one owner beats keeping a
  // second copy in the preload that silently drifts the first time it changes.
  ipcMain.on('chrome:token-spec', (event) => { event.returnValue = chrome.THEME_TOKENS; });

  // Sent by the preload of every window, including remote gateway pages. Only
  // the main window drives the app's colours: a popup showing a different page
  // must not repaint the window the user is actually looking at.
  ipcMain.on('chrome:theme', (event, report) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (event.sender !== page()) return;
    // The app's theme comes from the Control UI, never from one of our own
    // pages. Without this the first run — where the settings page *is* the main
    // window's content — would have the app take its colours from the very
    // stylesheet it is supposed to be theming, and the settings page would end
    // up quoting itself back.
    if (!/^https?:/.test(event.sender.getURL())) return;
    adoptTheme(chrome.themeFromReport(report));
  });
}

/* ------------------------------------------------------------------ startup */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.azuretek.claw-desktop');

    // The default session only ever serves our own file:// pages; the gateway
    // itself loads in a per-gateway partition configured by createMainWindow.
    chrome.applyTheme(currentTheme);
    configureSession(session.defaultSession, null);
    // No prompt: a refused certificate becomes an offer waiting in Settings,
    // and the failed load becomes the app's own error page pointing at it.
    certs.install(app, {
      onOffer: (offer) => {
        console.warn(`[claw] refused ${offer.changed ? 'CHANGED' : 'untrusted'} certificate for ${offer.host} (${offer.fingerprint})`);
        notifyStateChanged();
      },
    });

    if (!secrets.available()) console.warn(`[claw] ${secrets.unavailableReason()}`);
    registerIpc();
    buildMenu();
    buildTray();
    applyLaunchAtLogin();

    const shortcut = registerShortcut();
    if (!shortcut.ok) console.warn(`[claw] global shortcut not registered: ${shortcut.error}`);

    initUpdates();

    if (process.argv.includes('--hidden')) config.update({ startHidden: true });

    // Before the first load, not after: clearing a service worker out from
    // under a page it is already controlling leaves that page on the old
    // bundle until something reloads it.
    await clearOnAppUpgrade().catch((err) => console.warn(`[claw] cache clear failed: ${err.message}`));

    createMainWindow();

    app.on('activate', showMainWindow);
  });

  app.on('before-quit', () => { quitting = true; persistBounds(); });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (updateTimer) clearInterval(updateTimer);
  });

  app.on('window-all-closed', () => {
    // With close-to-tray on, the window hides rather than closing, so reaching
    // here means the user genuinely closed everything.
    if (process.platform !== 'darwin' && !config.get().closeToTray) app.quit();
  });
}
