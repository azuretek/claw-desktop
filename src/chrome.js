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

// There are surfaces the Control UI's stylesheet can never reach: the Windows
// caption strip (drawn by the OS, above the web contents), the window's own
// background behind an unpainted page, and our settings/error pages. They used
// to be pinned to one dark palette, which is correct exactly as long as the UI
// is dark — and the UI ships twelve palettes, six of them light. In a light
// theme the caption strip stayed near-black: a 137x50 hole in the top-right
// corner of an otherwise cream window.
//
// So these are a starting point, not the answer. The real colours are read back
// off the loaded page (see `themeProbe`) and pushed onto the window; these only
// have to hold for the few hundred milliseconds before the first paint, and to
// give the settings window something sane when no page has ever loaded.
const FALLBACK_DARK = { mode: 'dark', surface: '#0a0a0a', symbol: '#c9c9c9' };
const FALLBACK_LIGHT = { mode: 'light', surface: '#faf9f5', symbol: '#3d3a33' };

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

// Left edge to keep clear on macOS for the traffic lights. There is no `env()`
// for these — the position is ours, set below — so it is derived, not guessed:
// three 12px buttons on a 20px pitch span 52px, from `MAC_LIGHTS_X`, plus a gap.
//
// This is needed because the Control UI's own left inset does NOT cover the
// nav sidebar. `--shell-titlebar-inset` is 12px while the nav is expanded and
// 90px only once it collapses, and it is applied solely to `.chat-pane__header`
// — upstream assumes that with the sidebar open the lights land on the sidebar
// and its host has dealt with them. Ours has to.
const MAC_LIGHTS_X = 16;
const MAC_CONTENT_INSET = MAC_LIGHTS_X + 52 + 10;

/**
 * BrowserWindow options for the main window.
 *
 * `theme` is the last known page theme, so a window opens in roughly the right
 * colours instead of flashing the wrong ones. It is only a seed: `applyTheme`
 * corrects it as soon as the page reports.
 */
function windowOptions(theme = FALLBACK_DARK) {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      // Vertically centre the 16px lights in the header row the UI now draws.
      trafficLightPosition: { x: MAC_LIGHTS_X, y: (TITLEBAR_HEIGHT - 16) / 2 },
    };
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      // Windows keeps drawing real minimise/maximise/close buttons, so snap
      // layouts and tooltips still work and the window can never become
      // unclosable — it just wears the app's colours.
      titleBarOverlay: { color: theme.surface, symbolColor: theme.symbol, height: TITLEBAR_HEIGHT },
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

  // The traffic lights float over the sidebar's top row, so shift that row's
  // content clear of them. Horizontal, not vertical: pushing the row down far
  // enough to clear a 12px light that starts 17px from the top would cost a
  // ~70px empty strip, because the row's own content is 34px tall and sits
  // inside the same band. `--sidebar-pad-x` is the padding `.sidebar-shell`
  // already contributes; subtracting it makes the total measured from the
  // window edge, which is where the lights are measured from too.
  const leftInset = platform === 'darwin'
    ? `
    ${scope} .sidebar-brand {
      padding-left: calc(${MAC_CONTENT_INSET}px - var(--sidebar-pad-x, 10px));
    }`
    : '';

  // Rows that become part of the title bar, and so drag the window.
  const bars = ['.chat-pane__header', '.side-panel__header', '.sidebar-brand'];
  const interactive =
    ':is(button, a, input, select, textarea, summary, [role="button"], [role="tab"],' +
    ' [role="menuitem"], [contenteditable], [class*="menu"], [class*="control"],' +
    ' wa-dropdown, wa-button, openclaw-tooltip)';
  return `
    ${scope} { --openclaw-native-titlebar-height: ${TITLEBAR_HEIGHT}px; }
    ${bars.map((b) => `${scope} ${b}`).join(',\n    ')} {
      -webkit-app-region: drag; app-region: drag;
    }
    /* Carve every interactive thing back out, or the header's own buttons stop
       responding — a drag region swallows the mouse-down before the page sees
       it. Deliberately broad: a missed control is a dead control. */
    ${bars.map((b) => `${scope} ${b} ${interactive}`).join(',\n    ')} {
      -webkit-app-region: no-drag; app-region: no-drag;
    }
    ${leftInset}
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

/* ------------------------------------------------------------------- theme */

// Everything below is deliberately pure so it can be tested under plain
// `node --test`, and so nothing a remote page sends reaches an Electron API
// without being parsed into a known-good `#rrggbb` first.

/**
 * Parse any colour the page can hand back into `#rrggbb`, or null.
 *
 * The probe reports *computed* values, which CSS resolves to `rgb()`/`rgba()`
 * whatever the stylesheet wrote — so a theme authored in `oklch()` or
 * `color-mix()` arrives already flattened and no colour-space maths is needed
 * here. Hex is still accepted because our own fallbacks are written that way.
 *
 * Fully transparent is a failure, not a colour: `background-color` computes to
 * `rgba(0, 0, 0, 0)` when the custom property does not exist, which is exactly
 * what the login gate and our own error page look like. Treating that as black
 * would repaint the caption strip black on precisely the pages that have no
 * theme to follow.
 */
function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();

  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(raw);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;

  // Trailing pair is 8-digit hex alpha; drop it, the strip cannot be translucent.
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(raw);
  if (long) return `#${long[1]}`;

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.%]+)\s*)?\)$/.exec(raw);
  if (!rgb) return null;
  if (rgb[4] !== undefined) {
    const alpha = rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    if (!(alpha > 0.5)) return null;
  }
  const channels = [rgb[1], rgb[2], rgb[3]].map((n) => {
    const v = Math.round(Number(n));
    return Math.max(0, Math.min(255, v));
  });
  if (channels.some((c) => !Number.isFinite(c))) return null;
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance, used only to answer "is this a light surface?". */
function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  const linear = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * linear((n >> 16) & 255)
    + 0.7152 * linear((n >> 8) & 255)
    + 0.0722 * linear(n & 255);
  return l > 0.4;
}

/**
 * Turn a raw probe report into a theme, or null if there is nothing usable.
 *
 * The surface is the one value that must survive: without it there is no strip
 * colour and the caller should keep whatever it already had. The symbol colour
 * and the light/dark mode are both *derived* from the surface when the page
 * does not supply them, because the page is free to be half-styled (our error
 * page sets a background and no `--text`) and a caption glyph the same colour
 * as the strip it sits on is an invisible close button.
 */
function themeFromReport(report) {
  if (!report || typeof report !== 'object') return null;
  const surface = normalizeColor(report.surface);
  if (!surface) return null;

  const light = isLight(surface);
  const symbol = normalizeColor(report.symbol)
    || (light ? FALLBACK_LIGHT.symbol : FALLBACK_DARK.symbol);

  // Prefer the page's own declaration of intent. `data-theme-mode` is what the
  // Control UI sets alongside `data-theme` ("absolutely" vs "absolutely-light"),
  // and it is authoritative in the one case luminance gets wrong: a mid-tone
  // palette that sits either side of the threshold.
  const declared = report.mode === 'light' || report.mode === 'dark' ? report.mode : null;
  return { mode: declared || (light ? 'light' : 'dark'), surface, symbol };
}

/** The theme to open windows with before any page has reported one. */
function fallbackTheme(mode) {
  return mode === 'light' ? { ...FALLBACK_LIGHT } : { ...FALLBACK_DARK };
}

/**
 * Repaint the surfaces the page's stylesheet cannot reach.
 *
 * `nativeTheme.themeSource` is set from the *page*, not the OS, on purpose: the
 * Control UI's theme is chosen in the Control UI, so following the OS would let
 * a light UI sit in a dark settings window and vice versa. Setting it here is
 * also what makes `prefers-color-scheme` in our own file:// pages resolve to the
 * same answer, so ui.css needs no IPC of its own.
 */
function applyTheme(theme, windows = []) {
  const { nativeTheme } = require('electron');
  nativeTheme.themeSource = theme.mode;

  for (const win of windows) {
    if (!win || win.isDestroyed()) continue;
    win.setBackgroundColor(theme.surface);
    // Only windows created with `titleBarOverlay` accept this, and it throws
    // rather than no-ops on the ones that were not — including every window on
    // macOS and Linux.
    if (process.platform !== 'win32') continue;
    try {
      win.setTitleBarOverlay({
        color: theme.surface,
        symbolColor: theme.symbol,
        height: TITLEBAR_HEIGHT,
      });
    } catch { /* window has no overlay; its frame is already the right colour */ }
  }
}

module.exports = {
  TITLEBAR_HEIGHT,
  WIN_CONTROLS_WIDTH,
  MAC_LIGHTS_X,
  MAC_CONTENT_INSET,
  windowOptions,
  dragCss,
  applyToPage,
  applyTheme,
  themeFromReport,
  fallbackTheme,
  normalizeColor,
  isLight,
  enabled,
  hostClass,
};
