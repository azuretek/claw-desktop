'use strict';

// Plain `node --test` — no Electron, so the Windows rules can be asserted from
// any machine. Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const chrome = require('../src/chrome');

// Collapse whitespace so assertions describe the rule, not the indentation.
const flat = (css) => css.replace(/\s+/g, ' ').trim();

test('hostClass maps each platform to the Control UI marker it understands', () => {
  assert.strictEqual(chrome.hostClass('darwin'), 'openclaw-native-macos');
  assert.strictEqual(chrome.hostClass('win32'), 'openclaw-native-web-chrome');
  assert.strictEqual(chrome.hostClass('linux'), null);
  assert.strictEqual(chrome.enabled('linux'), false);
});

test('the Windows caption-button inset is measured, never hardcoded', () => {
  // A constant cannot follow DPI changes, resize or maximise. A 150px guess was
  // wrong by 13px against a real 150%-scaled display, which measured 137px.
  assert.match(chrome.WIN_CONTROLS_WIDTH, /env\(titlebar-area-width/);
  assert.match(chrome.WIN_CONTROLS_WIDTH, /env\(titlebar-area-x/);
  // Both env() reads fall back, so a host without the overlay insets nothing.
  assert.match(chrome.WIN_CONTROLS_WIDTH, /env\(titlebar-area-x, 0px\)/);
  assert.match(chrome.WIN_CONTROLS_WIDTH, /env\(titlebar-area-width, 100vw\)/);

  const css = flat(chrome.dragCss('win32'));
  assert.ok(!/padding-right:\s*\d+px/.test(css), 'no pixel literal may survive');
});

// The regression this guards: Windows draws its caption buttons over the
// top-right of the web contents, and opening a side-docked panel moves that
// corner from the chat header to the PANEL header — whose close button sits at
// its right end. Inset the wrong header and the panel opens but cannot close.
test('the right-edge inset follows whichever header reaches the corner', () => {
  const css = flat(chrome.dragCss('win32'));
  const w = chrome.WIN_CONTROLS_WIDTH;

  // No panel: the chat header owns the corner.
  assert.ok(
    css.includes(`html.openclaw-native-web-chrome .chat-pane__header { padding-right: ${w}; }`),
    'chat header must be inset by default',
  );

  // Side-docked panel open: the panel header owns the corner instead...
  assert.ok(
    css.includes(
      'html.openclaw-native-web-chrome .sidebar-region:not(.sidebar-region--bottom) ' +
        `.side-panel__header { padding-right: ${w}; }`,
    ),
    'side panel header must be inset when the panel is docked beside the chat',
  );

  // ...and the chat header gives its inset back, or the gap lands mid-window.
  assert.ok(
    css.includes(
      'html.openclaw-native-web-chrome .sidebar-region:not(.sidebar-region--bottom)' +
        ':has(.side-panel) .chat-pane__header { padding-right: 0; }',
    ),
    'chat header must drop its inset once the panel owns the corner',
  );
});

// Regression: the first attempt gated the handoff on `.sidebar-region--expanded`,
// which is the maximise/restore toggle, not "a panel is open". An ordinary
// docked panel never carries it, so the inset never moved and the panel's close
// button stayed under the caption buttons.
test('the panel handoff does not depend on the expand/restore state class', () => {
  const css = flat(chrome.dragCss('win32'));
  assert.ok(
    !css.includes('sidebar-region--expanded'),
    'handoff must key off panel presence, not layout.expanded',
  );
});

test('a bottom-docked panel leaves the inset on the chat header', () => {
  // `--bottom` turns the region into a column, so the panel sits below the chat
  // pane and never reaches the caption buttons.
  const css = flat(chrome.dragCss('win32'));
  const handoffs = css.match(/\.sidebar-region[^{]*\{/g) || [];
  assert.ok(handoffs.length > 0, 'expected the panel handoff rules to exist');
  for (const selector of handoffs) {
    assert.match(selector, /:not\(\.sidebar-region--bottom\)/);
  }
});

test('macOS gets no right-edge inset at all', () => {
  // Traffic lights are top-left; nothing floats over the right edge.
  const css = flat(chrome.dragCss('darwin'));
  assert.ok(!css.includes('padding-right'), 'macOS must not inset the right edge');
  assert.ok(!css.includes('titlebar-area-width'), 'macOS has no window controls overlay');
});

// The Control UI's own `--shell-titlebar-inset` is 12px while the nav is
// expanded and lands only on `.chat-pane__header`, so with the sidebar open the
// traffic lights sit on top of `.sidebar-brand` — the workspace avatar and agent
// name. Upstream leaves that to the host; this is the host.
test('macOS clears the traffic lights off the sidebar top row', () => {
  const css = flat(chrome.dragCss('darwin'));
  assert.ok(
    css.includes(
      'html.openclaw-native-macos .sidebar-brand { padding-left: ' +
        `calc(${chrome.MAC_CONTENT_INSET}px - var(--sidebar-pad-x, 10px)); }`,
    ),
    'sidebar brand row must be inset past the traffic lights',
  );
  // Derived from the button geometry we set, not a magic number: three 12px
  // lights on a 20px pitch from MAC_LIGHTS_X, plus a gap.
  assert.ok(
    chrome.MAC_CONTENT_INSET > chrome.MAC_LIGHTS_X + 52,
    'inset must clear the far edge of the last light',
  );
  // Windows has no lights on the left, so it must not pay this cost.
  assert.ok(!flat(chrome.dragCss('win32')).includes('sidebar-pad-x'));
});

test('header controls stay clickable inside the drag regions', () => {
  // -webkit-app-region: drag swallows mouse-down on every descendant until each
  // is carved back out, and a missed control fails silently.
  for (const platform of ['darwin', 'win32']) {
    const css = flat(chrome.dragCss(platform));
    assert.match(css, /\.chat-pane__header[^}]*-webkit-app-region: drag/);
    assert.match(css, /no-drag/);
    for (const carved of ['button', 'a', 'openclaw-tooltip', 'wa-dropdown']) {
      assert.ok(css.includes(carved), `${platform}: ${carved} must be carved out of the drag region`);
    }
  }
});

/* ------------------------------------------------------------------- theme */

// The bug these guard: every self-painted surface was pinned to one dark
// palette, so in any of the Control UI's six light themes the Windows caption
// strip stayed near-black — a 137x50 hole in the corner of a cream window.

test('computed colours in any notation arrive as #rrggbb', () => {
  // What the probe actually sends: CSS resolves custom properties to rgb()
  // before we ever see them, whatever the stylesheet was authored in.
  assert.strictEqual(chrome.normalizeColor('rgb(250, 249, 245)'), '#faf9f5');
  assert.strictEqual(chrome.normalizeColor('rgba(10, 10, 10, 1)'), '#0a0a0a');
  assert.strictEqual(chrome.normalizeColor('rgb(250 249 245 / 100%)'), '#faf9f5');
  // Our own fallbacks are written as hex.
  assert.strictEqual(chrome.normalizeColor('#FAF9F5'), '#faf9f5');
  assert.strictEqual(chrome.normalizeColor('#abc'), '#aabbcc');
});

test('an unthemed page reports no colour rather than black', () => {
  // `background-color: var(--bg)` computes to transparent when --bg does not
  // exist, which is exactly what the login gate and our error page look like.
  // Reading that as black would repaint the strip black on precisely the pages
  // that have no theme to follow.
  assert.strictEqual(chrome.normalizeColor('rgba(0, 0, 0, 0)'), null);
  assert.strictEqual(chrome.normalizeColor('transparent'), null);
  assert.strictEqual(chrome.normalizeColor(''), null);
  assert.strictEqual(chrome.normalizeColor(undefined), null);
  // Nothing a hostile gateway can send reaches an Electron API unparsed.
  assert.strictEqual(chrome.normalizeColor('red; --evil: 1'), null);
  assert.strictEqual(chrome.normalizeColor('url(http://x/)'), null);
});

test('a report with no usable surface is discarded whole', () => {
  // The caller keeps the colours it already had; a half-applied theme is worse
  // than a stale one.
  assert.strictEqual(chrome.themeFromReport(null), null);
  assert.strictEqual(chrome.themeFromReport({}), null);
  assert.strictEqual(chrome.themeFromReport({ surface: 'rgba(0, 0, 0, 0)' }), null);
});

test('the page decides light or dark; luminance only breaks ties', () => {
  // data-theme-mode is what the Control UI sets beside data-theme
  // ("absolutely" vs "absolutely-light"), so it wins where it exists.
  const declared = chrome.themeFromReport({ mode: 'light', surface: 'rgb(250, 249, 245)' });
  assert.strictEqual(declared.mode, 'light');
  assert.strictEqual(declared.surface, '#faf9f5');

  // A page with no declaration still has to be classified.
  assert.strictEqual(chrome.themeFromReport({ surface: 'rgb(250, 249, 245)' }).mode, 'light');
  assert.strictEqual(chrome.themeFromReport({ surface: 'rgb(10, 10, 10)' }).mode, 'dark');
  // Junk in the mode field must not become the mode.
  assert.strictEqual(chrome.themeFromReport({ mode: 'neon', surface: 'rgb(10,10,10)' }).mode, 'dark');
});

test('caption glyphs never come out the same colour as the strip', () => {
  // The failure is silent and total: an invisible close button on a window
  // whose frame the OS has already given away.
  const halfStyled = chrome.themeFromReport({ surface: 'rgb(250, 249, 245)', symbol: 'rgba(0,0,0,0)' });
  assert.strictEqual(halfStyled.symbol, '#3d3a33', 'light surface must fall back to a dark glyph');
  assert.ok(chrome.isLight(halfStyled.surface) && !chrome.isLight(halfStyled.symbol));

  const dark = chrome.themeFromReport({ surface: 'rgb(10, 10, 10)', symbol: '' });
  assert.ok(!chrome.isLight(dark.surface) && chrome.isLight(dark.symbol));
});

test('windows opened before the page answers use the remembered mode', () => {
  // Cold start over a slow link is seconds, not a flash, so the seed matters.
  assert.strictEqual(chrome.fallbackTheme('light').mode, 'light');
  assert.ok(chrome.isLight(chrome.fallbackTheme('light').surface));
  assert.strictEqual(chrome.fallbackTheme('dark').mode, 'dark');
  assert.strictEqual(chrome.fallbackTheme(null).mode, 'dark', 'first ever run defaults dark');
});
