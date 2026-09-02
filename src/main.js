'use strict';

const {
  app, BrowserWindow, WebContentsView, Tray, Menu, MenuItem, shell, dialog,
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
// Settings is a view layered over the main window's contents, not a window of
// its own. It stays a separate WebContents on purpose: the page holds the
// privileged IPC bridge, and the preload grants that bridge only to `file://`
// pages, so hosting it inside the gateway's document would mean handing remote
// content the ability to rewrite gateway settings and read pinned fingerprints.
// A child view keeps the modal *look* without giving up that boundary.
let settingsView = null;
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
  // The modal covers everything including the strip: the scrim is meant to dim
  // the whole window, and the settings page carries its own drag band.
  if (settingsView) settingsView.setBounds({ x: 0, y: 0, width, height });
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
    page()?.loadFile(path.join(UI_DIR, 'settings.html'), { search: settingsSearch({ firstRun: true }) });
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
  wc.on('page-title-updated', (_event, title) => {
    const session = title.replace(/\s*[—-]\s*OpenClaw\s*$/, '').trim();
    const full = session && session !== title ? `${session} — Claw Desktop` : 'Claw Desktop';
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(full);
    setStripLabel(session && session !== title ? session : null);
  });

  wc.on('did-finish-load', () => {
    wc.setZoomLevel(config.get().zoomLevel || 0);
    // Our own pages (first-run settings, the error page) want the Control UI's
    // design tokens. The gateway's page gets nothing injected at all.
    if (wc.getURL().startsWith('file://')) {
      applyThemeCss(wc);
      return;
    }
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
    settingsView = null;
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

/* ---------------------------------------------------------- settings window */


// `frameless` rides in the URL rather than being fetched over IPC because the
// page uses it for layout — how far down the card starts, to clear the drag
// band. Asked for asynchronously it arrives after first paint, and the card
// visibly jumps on every open.
function settingsSearch(opts = {}) {
  const params = new URLSearchParams();
  if (opts.firstRun) params.set('firstRun', '1');
  if (chrome.enabled()) params.set('frameless', '1');
  return `?${params}`;
}

function openSettings(opts = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  // On first run the main window is already showing this page full-size; a
  // modal of the same thing over the top of itself is not an improvement.
  if (settingsIsPage) {
    showMainWindow();
    return null;
  }
  if (settingsView) {
    settingsView.webContents.focus();
    return settingsView;
  }

  settingsView = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Transparent, so the translucent scrim the page paints actually reveals the
  // Control UI underneath instead of a black rectangle. A view added to a
  // window is opaque until told otherwise.
  settingsView.setBackgroundColor('#00000000');

  const wc = settingsView.webContents;
  attachContextMenu(wc);
  mainWindow.contentView.addChildView(settingsView);
  layoutViews();
  wc.loadFile(path.join(UI_DIR, 'settings.html'), { search: settingsSearch() });
  wc.once('did-finish-load', () => {
    applyThemeCss(wc);
    wc.focus();
  });
  return settingsView;
}

function closeSettings() {
  if (!settingsView) return;
  const view = settingsView;
  settingsView = null;
  themeCssKeys.delete(view.webContents.id);
  try {
    mainWindow?.contentView.removeChildView(view);
  } catch { /* window already gone; the view goes with it */ }
  view.webContents.close();
  page()?.focus();
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
  if (settingsView && !settingsView.webContents.isDestroyed()) applyThemeCss(settingsView.webContents);
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
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => (showingError ? loadActiveGateway() : page()?.reload()) },
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
        { label: 'Toggle Developer Tools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => page()?.toggleDevTools() },
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
    frameless: chrome.enabled(),
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
    closeSettings();
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
  ipcMain.handle('app:close-settings', () => { closeSettings(); });

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

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.azuretek.claw-desktop');

    // The default session only ever serves our own file:// pages; the gateway
    // itself loads in a per-gateway partition configured by createMainWindow.
    chrome.applyTheme(currentTheme);
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
