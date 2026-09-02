'use strict';

// `electron` is required lazily, inside the one function that needs it, so the
// CSS this module generates can be unit-tested under plain `node --test`.

// Frameless window chrome, the way Discord, Slack and Spotify do it: no OS title
// bar, the app's colour running to the top edge, window controls floating over
// the content.
//
// The Control UI turns out to support this directly. Its stylesheet ships
// host-set marker classes on <html> — `openclaw-native-macos`,
// `openclaw-native-web-chrome`, `openclaw-native-nav` — which the UI never sets
// itself; it only reads them (they gate a `Nm()` check in the bundle that asks
// "am I inside a native host?"). Under them the UI grows its own header rows to
// `--openclaw-native-titlebar-height` and insets its controls to clear the
// native window buttons. So the header BECOMES the title bar.
//
// That matters, because the obvious approach does not work. Reserving a strip at
// the top and pushing the page down leaves the page's own `height: 100vh` boxes
// at full window height — `vh` is always the whole window — so the layout ends
// up exactly the strip's height below the fold. Measured on a probe page: 754px
// of content in a 720px window. Clamping it back is possible but it is a
// heuristic fighting the page. Using the UI's native mode reserves nothing and
// fights nothing.

const TITLEBAR_HEIGHT = 50;
const SURFACE = '#0a0a0a';
const SYMBOL = '#c9c9c9';

// Width to keep clear on the right for the Windows caption buttons, asked of the
// platform rather than guessed. `titleBarOverlay` turns on the Window Controls
// Overlay API, which publishes the draggable strip's geometry as CSS env vars;
// everything to the right of it is buttons. Measured on a 150% display: 137px,
// where the constant this replaced guessed 150. It also re-resolves on resize
// and maximise, which a constant cannot.
//
// Fallbacks make it degrade to zero: with no overlay there are no buttons
// floating over the page, so nothing needs keeping clear.
const WIN_CONTROLS_WIDTH =
  'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))';

/** BrowserWindow options for the main window. */
function windowOptions() {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      // Vertically centre the 16px lights in the header row the UI now draws.
      trafficLightPosition: { x: 16, y: (TITLEBAR_HEIGHT - 16) / 2 },
    };
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      // Windows keeps drawing real minimise/maximise/close buttons, so snap
      // layouts and tooltips still work and the window can never become
      // unclosable — it just wears the app's colours.
      titleBarOverlay: { color: SURFACE, symbolColor: SYMBOL, height: TITLEBAR_HEIGHT },
    };
  }
  // Linux window managers vary too much to reliably hand back a frameless
  // window the user can still move, resize and close. Leave the frame on.
  return {};
}

// `platform` is a parameter rather than a direct `process.platform` read so the
// generated CSS can be asserted for every platform from one test run.
function hostClass(platform = process.platform) {
  if (platform === 'darwin') return 'openclaw-native-macos';
  if (platform === 'win32') return 'openclaw-native-web-chrome';
  return null;
}

function enabled(platform = process.platform) {
  return hostClass(platform) !== null;
}

// The UI reserves the space; we only add what it has no way to know about —
// which regions drag the window. It sets no `-webkit-app-region` anywhere.
function dragCss(platform = process.platform) {
  const scope = `html.${hostClass(platform)}`;
  // The Control UI's own native-host mode only insets the LEFT edge
  // (`--shell-titlebar-inset`, applied as padding-left) because upstream's
  // native hosts put their window controls there. Windows puts them on the
  // right, over the page, so the right edge is ours to handle.
  //
  // Which element reaches that edge is not fixed: `.sidebar-region` lays out
  // `.sidebar-region__primary` (the chat pane) and then
  // `.sidebar-region__right-runtime` holding `.side-panel`, so opening a
  // side-docked panel hands the top-right corner to the PANEL's header — and
  // its close/dock/expand buttons live at that header's right end, directly
  // under the OS buttons, which are drawn above the web contents and eat the
  // click. That is a panel you can open and then cannot close.
  //
  // Detect that structurally with `:has()`, NOT with a state class. The obvious
  // candidate, `.sidebar-region--expanded`, is wrong: `expanded` is the
  // maximise/restore toggle (`layout.expanded` in the bundle), so an ordinary
  // docked panel never carries it. Presence of `.side-panel` is the real
  // condition, and it also covers the empty "Open a tab" state, which renders
  // `.side-panel__header--empty` — same class, same corner, same dead buttons.
  //
  // Bottom-docked panels (`--bottom` switches the region to a column) sit below
  // the chat pane and never reach the corner, so the chat header keeps the inset.
  const sideDocked = `${scope} .sidebar-region:not(.sidebar-region--bottom)`;
  const rightInset = platform === 'win32'
    ? `
    ${scope} .chat-pane__header { padding-right: ${WIN_CONTROLS_WIDTH}; }
    ${sideDocked}:has(.side-panel) .chat-pane__header {
      padding-right: 0;
    }
    ${sideDocked} .side-panel__header {
      padding-right: ${WIN_CONTROLS_WIDTH};
    }`
    : '';
  return `
    ${scope} { --openclaw-native-titlebar-height: ${TITLEBAR_HEIGHT}px; }
    ${scope} .chat-pane__header,
    ${scope} .side-panel__header {
      -webkit-app-region: drag; app-region: drag;
    }
    /* Carve every interactive thing back out, or the header's own buttons stop
       responding — a drag region swallows the mouse-down before the page sees
       it. Deliberately broad: a missed control is a dead control. */
    ${scope} .chat-pane__header :is(button, a, input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [contenteditable], [class*="menu"], [class*="control"], wa-dropdown, wa-button, openclaw-tooltip),
    ${scope} .side-panel__header :is(button, a, input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [contenteditable], [class*="menu"], [class*="control"], wa-dropdown, wa-button, openclaw-tooltip) {
      -webkit-app-region: no-drag; app-region: no-drag;
    }
    ${rightInset}
  `;
}

const markScript = (cls) => `(() => {
  document.documentElement.classList.add(${JSON.stringify(cls)});
  return document.documentElement.className;
})()`;

/**
 * Put the page into the Control UI's native-host mode and mark the drag regions.
 * Re-applied on every load: a full navigation drops both the class and the CSS.
 * Best-effort — if it fails the window keeps native controls and is merely
 * awkward to drag, never stuck.
 */
function applyToPage(wc) {
  if (!enabled() || !wc || wc.isDestroyed()) return;
  wc.executeJavaScript(markScript(hostClass()), true).catch(() => {});
  wc.insertCSS(dragCss()).catch(() => {});
}

/** Ask the OS to draw our remaining native surfaces (the settings window) dark. */
function applyTheme() {
  require('electron').nativeTheme.themeSource = 'dark';
}

module.exports = {
  TITLEBAR_HEIGHT,
  WIN_CONTROLS_WIDTH,
  windowOptions,
  dragCss,
  applyToPage,
  applyTheme,
  enabled,
  hostClass,
};
