'use strict';

// `electron` is required lazily, inside the one function that needs it, so the
// CSS this module generates can be unit-tested under plain `node --test`.

// Frameless window chrome, the way Discord, Slack and Spotify do it: no OS title
// bar, the app's colour running to the top edge.
//
// The window buttons sit on a strip the app draws for itself, above the page,
// rather than floating over the page. That is the whole design, and it was
// arrived at the hard way.
//
// The obvious alternative is to let them float and keep the page's own controls
// out from under them. The Control UI even seems to invite it: its stylesheet
// ships host-set marker classes -- `openclaw-native-macos`,
// `openclaw-native-web-chrome` -- under which its header rows grow to titlebar
// height and inset themselves for native buttons. But "which element is under
// the buttons" has no stable answer. On Windows it was the chat pane header,
// then a docked side panel's header, then the empty "Open a tab" header, then
// the custodian panel -- `position: fixed; right: 0`, so no ancestor's padding
// could ever move it. On macOS it was the sidebar brand row, then any routed
// page's own top-left content once the nav collapses, a case upstream computes
// `--shell-titlebar-inset: 90px` for and then applies to `.chat-pane__header`
// alone. Each fix was correct for one layout state and silently wrong in the
// others.
//
// The one inset a fixed-position overlay cannot escape is a smaller viewport.
// So the page loads into a WebContentsView that starts below the button band.
// Nothing it draws can be under the buttons, because it does not extend under
// them -- and the app needs no knowledge of upstream's markup at all.
//
// Note this is NOT the CSS attempt that also failed. Reserving space *inside*
// the page leaves its `height: 100vh` boxes at full window height -- `vh` is
// always the whole window -- so the layout lands exactly the strip's height
// below the fold (measured: 754px of content in a 720px window). Shrinking the
// view shrinks the viewport, so `100vh` is correct by definition.

// The strip reserved above the page, on both desktop platforms. Sized for the
// window buttons -- 32px is the Windows standard, and macOS traffic lights are
// 12px -- plus a little breathing room. Every pixel is taken away from the page,
// so it is kept as small as the buttons allow.
const STRIP_HEIGHT = 36;

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
// everything to the right of it is buttons. Measured on a 150% display: 137px.
//
// This is now used only by the title strip the app draws for itself — the page
// no longer needs it, because the page no longer reaches that corner. The strip
// does: it spans the full width and its right end lies beneath the buttons.
//
// Fallbacks make it resolve to 0px, which is why it is wrapped in `max()` at the
// point of use: the env vars are published to the window's main frame, and this
// stylesheet runs in a child view, where they may legitimately be absent.
const WIN_CONTROLS_WIDTH =
  'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))';

// Enough to clear the three buttons at any scale factor when `env()` says
// nothing. Overshooting costs a little unused strip; undershooting puts the
// window title under the close button.
const WIN_CONTROLS_FALLBACK = 160;

// Where the strip's label starts on macOS, clearing the traffic lights. There is
// no `env()` for these — the position is ours, set below — so it is derived, not
// guessed: three 12px buttons on a 20px pitch span 52px, from `MAC_LIGHTS_X`.
const MAC_LIGHTS_X = 16;
const MAC_LIGHTS_SPAN = 52;
// Breathing room between the last light and the label. Its own constant because
// it is the one number here that is a judgement rather than a measurement:
// everything else is fixed by the buttons, this is how close the text is allowed
// to sit to them. Started at 10px, which read as crowded.
const MAC_LIGHTS_GAP = 22;
const MAC_CONTENT_INSET = MAC_LIGHTS_X + MAC_LIGHTS_SPAN + MAC_LIGHTS_GAP;

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
      // Vertically centre the 16px lights in the strip the app draws.
      trafficLightPosition: { x: MAC_LIGHTS_X, y: (STRIP_HEIGHT - 16) / 2 },
    };
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      // Windows keeps drawing real minimise/maximise/close buttons, so snap
      // layouts and tooltips still work and the window can never become
      // unclosable — it just wears the app's colours. They now land on the
      // reserved strip rather than on the page.
      titleBarOverlay: { color: theme.surface, symbolColor: theme.symbol, height: STRIP_HEIGHT },
    };
  }
  // Linux window managers vary too much to reliably hand back a frameless
  // window the user can still move, resize and close. Leave the frame on.
  return {};
}

// `platform` is a parameter rather than a direct `process.platform` read so the
// strip geometry can be asserted for every platform from one test run.

/** True where the app owns the window chrome, by either mechanism. */
function enabled(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

/**
 * How much of the window the page does NOT get, because the app draws its title
 * strip there. Zero only on Linux, which keeps its OS frame.
 */
function contentInset(platform = process.platform) {
  return { top: platform === 'linux' ? 0 : STRIP_HEIGHT };
}

/**
 * Geometry for the app's own title strip, as custom properties.
 *
 * Inserted into `ui/titlebar.html` — which is ours, not the gateway's — so the
 * strip's height and its clearance for the caption buttons have exactly one
 * owner: the constants above. The stylesheet declares its own fallbacks, so the
 * strip is never unstyled if this never arrives.
 */
function stripCss(platform = process.platform) {
  // macOS puts its traffic lights at the strip's left end, Windows its caption
  // buttons at the right. Both are the OS's own buttons drawn over the strip, so
  // the label has to start after one and stop before the other.
  const start = platform === 'darwin' ? `${MAC_CONTENT_INSET}px` : '12px';
  const end = platform === 'win32'
    ? `max(${WIN_CONTROLS_FALLBACK}px, ${WIN_CONTROLS_WIDTH})`
    : '12px';
  return `:root {
  --strip-height: ${STRIP_HEIGHT}px;
  --strip-pad-start: ${start};
  --strip-pad-end: ${end};
}`;
}

// Nothing is injected into the gateway page. That is the point of the strip.
//
// Earlier versions set the Control UI's `openclaw-native-macos` /
// `openclaw-native-web-chrome` marker classes and layered CSS on top: drag
// regions on its header rows, and insets to keep its controls out from under the
// window buttons. Every one of those insets was a bet on which element happened
// to reach a corner, and the bets kept losing — the chat header, then a docked
// side panel's header, then the empty "Open a tab" header, then the custodian
// panel (`position: fixed`, so unreachable by any ancestor's padding), then the
// routed page's own top-left content once the nav is collapsed, where upstream
// computes `--shell-titlebar-inset: 90px` and applies it to `.chat-pane__header`
// alone.
//
// With the window buttons on a strip of our own, none of that is needed: the
// page never shares space with them. The app now has no dependency whatsoever on
// upstream's class names or markup, which is the durable win here — those were
// never an API, and every release could have moved them.

/* ------------------------------------------------------------------- title */

const APP_NAME = 'Claw Desktop';

/**
 * True for a chat route with an agent but no session — the "Home" entry in the
 * nav, `/chat/<agent>`.
 */
function isAgentHome(url) {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    return segments.length === 2 && segments[0] === 'chat';
  } catch {
    return false;
  }
}

/**
 * The label for the title strip and the window, or null for "just the app name".
 *
 * Derived from the page's own `document.title`, which is right nearly
 * everywhere: the Control UI titles its routes "Automations", "Plugins", or the
 * session's name. The exception is Home — `/chat/<agent>` — which it titles with
 * the **agent id** ("main"), so the strip read "main" where the nav said "Home".
 * That is answered from the route rather than by rewriting the string, because
 * "main" is a legitimate title for anything else and an agent can be called
 * whatever you like.
 *
 * A title without the Control UI's own suffix is not trusted at all: our
 * file:// pages set their own titles, and a gateway is free to set any it likes.
 */
function pageLabel(title, url) {
  const raw = typeof title === 'string' ? title : '';
  const stripped = raw.replace(/\s*[—–-]\s*OpenClaw\s*$/, '').trim();
  if (!stripped || stripped === raw.trim()) return null;
  return isAgentHome(url) ? 'Home' : stripped;
}

/** What the OS window title should be, given that label. */
function windowTitle(label) {
  return label ? `${label} — ${APP_NAME}` : APP_NAME;
}

/* ------------------------------------------------------------------- theme */

// Everything below is deliberately pure so it can be tested under plain
// `node --test`, and so nothing a remote page sends reaches an Electron API
// without being parsed into a known-good `#rrggbb` first.

/**
 * The Control UI design tokens the app's own pages borrow, so settings and the
 * error page are styled by the *same* values as the UI they sit in front of
 * rather than by a hand-matched approximation that drifts every release.
 *
 * Each token declares its type, and that is the security mechanism, not a
 * convenience. These values are injected as CSS into a `file://` page that
 * holds the privileged IPC bridge, so a gateway that could put arbitrary text
 * in one would have a stylesheet-injection primitive against it — `--bg: red}
 * body{display:none` and the settings page is a blank sheet with live buttons
 * underneath. Declaring the type lets the page resolve each token to a computed
 * value (colours to `rgb()`, lengths to `px`) and lets the main process then
 * hold it to a narrow grammar. Nothing with a brace, a semicolon or a `url()`
 * can survive that round trip.
 *
 * Names are upstream's, taken from `dist/control-ui/themes/*.css` and the core
 * bundle. Tokens the UI does not define simply resolve to nothing and are
 * dropped, so this list may safely name more than any one theme provides.
 */
const THEME_TOKENS = [
  // Surfaces
  ['--bg', 'color'], ['--bg-accent', 'color'], ['--bg-hover', 'color'],
  ['--bg-muted', 'color'], ['--bg-content', 'color'],
  ['--panel', 'color'], ['--panel-hover', 'color'], ['--panel-strong', 'color'],
  ['--input', 'color'], ['--chrome', 'color'],
  // Text
  ['--text', 'color'], ['--text-strong', 'color'],
  ['--muted', 'color'], ['--muted-strong', 'color'],
  // Lines
  ['--border', 'color'], ['--border-strong', 'color'], ['--border-hover', 'color'],
  // Accent
  ['--accent', 'color'], ['--accent-hover', 'color'], ['--accent-subtle', 'color'],
  ['--primary', 'color'], ['--primary-hover', 'color'], ['--primary-foreground', 'color'],
  ['--destructive', 'color'], ['--ring', 'color'],
  // Shape
  ['--radius', 'length'], ['--radius-sm', 'length'], ['--radius-md', 'length'],
  ['--radius-lg', 'length'], ['--radius-full', 'length'],
  // Scrollbars — the reason our scrollbars can match rather than resemble.
  ['--scrollbar-size', 'length'], ['--scrollbar-thumb-inset', 'length'],
  ['--scrollbar-thumb', 'color'], ['--scrollbar-thumb-hover', 'color'],
  // Type and depth
  ['--font-body', 'font'], ['--shadow-lg', 'shadow'],
];

// Grammars for a *computed* value. Deliberately narrow: no braces, no
// semicolons, no `url()`, no nested parentheses, nothing that can close a rule
// and open another. A token that does not match is dropped, never repaired.
const TOKEN_GRAMMAR = {
  // `#abc`, `rgb(…)`, `rgba(…)`, and the `color(srgb …)`/`oklab(…)`/`oklch(…)`
  // forms Chromium may resolve `color-mix()` into. Inner text is digits and
  // separators only.
  color: /^(#[0-9a-f]{3,8}|(?:rgba?|oklab|oklch|lab|lch|hwb)\([a-z0-9.,\s%/+-]*\)|color\(srgb[a-z0-9.,\s%/+-]*\))$/i,
  length: /^-?\d+(?:\.\d+)?(?:px|rem|em|%)?$/,
  // A resolved font stack: family names, quotes, commas, hyphens. No
  // parentheses at all, so no function call of any kind can hide in one.
  font: /^[\w\s"',.-]{1,300}$/,
};

// The colour forms above, for reuse. A resolved box-shadow is the one token
// whose value legitimately *contains* colours, so it cannot be a flat character
// class — spelling one loose enough to admit `rgba(…)` also admits
// `anything(…)`. Instead the colours are subtracted first and the remainder is
// held to lengths and keywords, which leaves nowhere for a call to hide.
const COLOR_FN = /(?:rgba?|oklab|oklch|lab|lch|hwb)\([^()]*\)|color\(srgb[^()]*\)|#[0-9a-f]{3,8}/gi;

function isShadow(value) {
  const remainder = value.replace(COLOR_FN, ' ');
  // `inset` and `none` are the only keywords Chromium resolves a shadow into.
  return /^[\s\d.,a-z%-]*$/i.test(remainder) && !/[()]/.test(remainder);
}

/**
 * Hold one reported token to its declared grammar, or reject it.
 *
 * Rejection is silent and total — the page keeps its own fallback value, which
 * is always defined in ui.css. A partly-applied theme is a worse outcome than
 * an unthemed one.
 */
function sanitizeTokenValue(kind, value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 300) return null;
  // Belt and braces against comment-splicing, which no grammar above admits but
  // which is the classic way out of a CSS value.
  if (trimmed.includes('/*') || trimmed.includes('*/')) return null;

  if (kind === 'shadow') {
    if (!isShadow(trimmed)) return null;
  } else {
    const grammar = TOKEN_GRAMMAR[kind];
    if (!grammar || !grammar.test(trimmed)) return null;
  }
  // Unbalanced parentheses would let a value swallow the rest of the rule.
  const open = (trimmed.match(/\(/g) || []).length;
  const close = (trimmed.match(/\)/g) || []).length;
  if (open !== close) return null;
  return trimmed;
}

/** Sanitize a whole reported token map, dropping anything that does not fit. */
function sanitizeTokens(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, kind] of THEME_TOKENS) {
    const value = sanitizeTokenValue(kind, raw[name]);
    if (value !== null) out[name] = value;
  }
  return out;
}

/**
 * The stylesheet handed to the app's own pages so they inherit the live theme.
 *
 * Emitted under `:root` with `!important` deliberately: ui.css declares every
 * one of these as a fallback so the page is never unstyled, and without the
 * flag those literals would win on source order once this is inserted.
 */
function themeCss(theme) {
  const tokens = (theme && theme.tokens) || {};
  const body = Object.entries(tokens)
    .map(([name, value]) => `  ${name}: ${value} !important;`)
    .join('\n');
  if (!body) return '';
  return `:root {\n${body}\n}\n`;
}

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
  return {
    mode: declared || (light ? 'light' : 'dark'),
    surface,
    symbol,
    tokens: sanitizeTokens(report.tokens),
  };
}

/** The theme to open windows with before any page has reported one. */
function fallbackTheme(mode) {
  const base = mode === 'light' ? FALLBACK_LIGHT : FALLBACK_DARK;
  // No tokens: ui.css carries a complete palette of its own for exactly this
  // case, which is what the first run — no gateway, no page, no theme — uses.
  return { ...base, tokens: {} };
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
        height: STRIP_HEIGHT,
      });
    } catch { /* window has no overlay; its frame is already the right colour */ }
  }
}

module.exports = {
  STRIP_HEIGHT,
  WIN_CONTROLS_WIDTH,
  WIN_CONTROLS_FALLBACK,
  contentInset,
  stripCss,
  MAC_LIGHTS_X,
  MAC_LIGHTS_SPAN,
  MAC_LIGHTS_GAP,
  MAC_CONTENT_INSET,
  windowOptions,
  APP_NAME,
  isAgentHome,
  pageLabel,
  windowTitle,
  applyTheme,
  themeFromReport,
  fallbackTheme,
  themeCss,
  sanitizeTokenValue,
  sanitizeTokens,
  THEME_TOKENS,
  normalizeColor,
  isLight,
  enabled,
};
