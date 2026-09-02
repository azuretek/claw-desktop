'use strict';

// Plain `node --test` — no Electron, so the Windows rules can be asserted from
// any machine. Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const chrome = require('../src/chrome');

// Collapse whitespace so assertions describe the rule, not the indentation.
const flat = (css) => css.replace(/\s+/g, ' ').trim();

test('hostClass marks only macOS, where the UI header IS the title bar', () => {
  assert.strictEqual(chrome.hostClass('darwin'), 'openclaw-native-macos');
  // Windows deliberately gets no marker class. The app draws a real strip above
  // the page there, so the page should lay itself out as an ordinary page;
  // setting the class would grow the UI's headers to titlebar height and inset
  // them for buttons that are no longer over the page — reserving twice.
  assert.strictEqual(chrome.hostClass('win32'), null);
  assert.strictEqual(chrome.hostClass('linux'), null);
});

test('the app owns the chrome on both desktop platforms', () => {
  // `enabled` is not `hostClass !== null` any more: Windows owns its chrome
  // through the reserved strip rather than through the marker class.
  assert.strictEqual(chrome.enabled('darwin'), true);
  assert.strictEqual(chrome.enabled('win32'), true);
  assert.strictEqual(chrome.enabled('linux'), false);
});

test('only Windows takes height away from the page', () => {
  assert.strictEqual(chrome.contentInset('win32').top, chrome.STRIP_HEIGHT);
  assert.ok(chrome.STRIP_HEIGHT > 0);
  // macOS hands the page the whole window; the UI's own header doubles as the
  // title bar and the traffic lights float over it.
  assert.strictEqual(chrome.contentInset('darwin').top, 0);
  assert.strictEqual(chrome.contentInset('linux').top, 0);
});

// The regression that forced this architecture. Windows draws its caption
// buttons over the top-right of the web contents, and that rectangle eats
// clicks. Three separate elements were found there and insetted in turn — the
// chat header, a docked side panel's header, the empty "Open a tab" header —
// before the custodian panel ("New agent") settled it: `.cp--right` is
// `position: fixed; right: 0`, so no ancestor's padding can move it. Neither can
// an image lightbox, nor any future popover anchored to that corner.
//
// So the page must not be insetted at all; it must be smaller. Any padding rule
// reappearing here means someone has gone back to guessing which element is at
// the edge today.
test('nothing is injected into the page to dodge the caption buttons', () => {
  const css = flat(chrome.dragCss('win32'));
  assert.strictEqual(css, '', 'Windows must inject no page CSS at all');

  for (const platform of ['darwin', 'win32', 'linux']) {
    const sheet = flat(chrome.dragCss(platform));
    assert.ok(!sheet.includes('padding-right'), `${platform} must not inset the right edge`);
    // `.sidebar-region` was the anchor for every one of the failed handoffs.
    // macOS still names `.side-panel__header` — as a drag region, which is a
    // different thing entirely — so the ban is on the layout-state selector.
    assert.ok(!sheet.includes('sidebar-region'), `${platform} must not key off sidebar layout state`);
  }
});

test('the strip clears the caption buttons, measured with a safe fallback', () => {
  // A constant cannot follow DPI changes, resize or maximise: a 150px guess was
  // wrong by 13px against a real 150%-scaled display, which measured 137px.
  assert.match(chrome.WIN_CONTROLS_WIDTH, /env\(titlebar-area-x, 0px\)/);
  assert.match(chrome.WIN_CONTROLS_WIDTH, /env\(titlebar-area-width, 100vw\)/);

  const css = flat(chrome.stripCss());
  assert.ok(css.includes(`--strip-height: ${chrome.STRIP_HEIGHT}px`), 'height has one owner');
  // Those env() vars are published to the window's main frame, and the strip is
  // a child view where they may be absent — in which case the calc resolves to
  // 0px and the label would slide under the close button. `max()` is what stops
  // that being a silent failure.
  assert.ok(css.includes('max('), 'clearance must have a floor');
  assert.ok(css.includes(`${chrome.WIN_CONTROLS_FALLBACK}px`));
  assert.ok(chrome.WIN_CONTROLS_FALLBACK >= 137, 'fallback must clear real buttons');
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
  // lights on a 20px pitch from MAC_LIGHTS_X, plus a deliberate gap.
  assert.strictEqual(
    chrome.MAC_CONTENT_INSET,
    chrome.MAC_LIGHTS_X + chrome.MAC_LIGHTS_SPAN + chrome.MAC_LIGHTS_GAP,
    'inset must stay the sum of its parts, not drift into a literal',
  );
  // Clearing the last light is necessary but not sufficient: at a 10px gap the
  // agent name read as crowded against the close button.
  assert.ok(
    chrome.MAC_LIGHTS_GAP >= 20,
    'the name needs breathing room, not just non-overlap',
  );
  // Windows has no lights on the left, so it must not pay this cost.
  assert.ok(!flat(chrome.dragCss('win32')).includes('sidebar-pad-x'));
});

test('header controls stay clickable inside the drag regions', () => {
  // -webkit-app-region: drag swallows mouse-down on every descendant until each
  // is carved back out, and a missed control fails silently.
  // macOS only: Windows injects nothing, because its title bar is the app's own
  // strip rather than the UI's header.
  for (const platform of ['darwin']) {
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

/* ------------------------------------------------------------ theme tokens */

// These values are injected as CSS into a file:// page that holds the
// privileged IPC bridge. A gateway that could smuggle text into one would have
// a stylesheet-injection primitive against the settings page.

test('every borrowed token declares a type, which is what makes it checkable', () => {
  const kinds = new Set(['color', 'length', 'font', 'shadow']);
  assert.ok(chrome.THEME_TOKENS.length > 0);
  for (const entry of chrome.THEME_TOKENS) {
    const [name, kind] = entry;
    assert.match(name, /^--[a-z0-9-]+$/, `${name} must be a custom property name`);
    assert.ok(kinds.has(kind), `${name} declares unknown type ${kind}`);
  }
  // The four the scrollbars need, or ours only resemble the Control UI's.
  const names = chrome.THEME_TOKENS.map(([n]) => n);
  for (const n of ['--scrollbar-size', '--scrollbar-thumb', '--scrollbar-thumb-hover', '--scrollbar-thumb-inset']) {
    assert.ok(names.includes(n), `${n} must be borrowed`);
  }
});

test('resolved values in the forms Chromium actually returns are kept', () => {
  assert.strictEqual(chrome.sanitizeTokenValue('color', 'rgb(250, 249, 245)'), 'rgb(250, 249, 245)');
  assert.strictEqual(chrome.sanitizeTokenValue('color', 'rgba(138, 138, 138, 0.32)'), 'rgba(138, 138, 138, 0.32)');
  // color-mix() resolves to one of these depending on the source colour space.
  assert.strictEqual(chrome.sanitizeTokenValue('color', 'color(srgb 0.98 0.976 0.961)'), 'color(srgb 0.98 0.976 0.961)');
  assert.strictEqual(chrome.sanitizeTokenValue('color', 'oklch(0.72 0.12 40)'), 'oklch(0.72 0.12 40)');
  assert.strictEqual(chrome.sanitizeTokenValue('length', '12px'), '12px');
  assert.strictEqual(chrome.sanitizeTokenValue('length', '9999px'), '9999px');
  assert.strictEqual(chrome.sanitizeTokenValue('font', '"Instrument Sans", -apple-system, sans-serif'),
    '"Instrument Sans", -apple-system, sans-serif');
  assert.strictEqual(chrome.sanitizeTokenValue('shadow', 'rgba(0, 0, 0, 0.55) 0px 24px 60px 0px'),
    'rgba(0, 0, 0, 0.55) 0px 24px 60px 0px');
});

test('nothing that could close a CSS rule survives', () => {
  const attacks = [
    'red} body{display:none} .x{color:red',   // escape the rule entirely
    'red; background: url(http://evil/)',      // smuggle a second declaration
    'url(http://evil/pixel.png)',              // exfiltrate by fetching
    'rgb(0,0,0) /* } */',                      // comment-splice out of the value
    'rgb(0,0,0))',                             // unbalanced parens
    'expression(alert(1))',
    '<script>',
  ];
  for (const kind of ['color', 'length', 'font', 'shadow']) {
    for (const value of attacks) {
      assert.strictEqual(chrome.sanitizeTokenValue(kind, value), null, `${kind} accepted: ${value}`);
    }
  }
  // A length is a length, not a colour, and vice versa — types are not advisory.
  assert.strictEqual(chrome.sanitizeTokenValue('length', 'rgb(1,2,3)'), null);
  assert.strictEqual(chrome.sanitizeTokenValue('color', '12px'), null);
  // Unbounded values are refused rather than truncated.
  assert.strictEqual(chrome.sanitizeTokenValue('font', 'a'.repeat(400)), null);
});

test('only whitelisted token names are carried, whatever the page sends', () => {
  const tokens = chrome.sanitizeTokens({
    '--bg': 'rgb(250, 249, 245)',
    '--radius': '10px',
    '--not-a-real-token': 'rgb(0, 0, 0)',
    '--bg-hover': 'red} body{display:none',
  });
  assert.strictEqual(tokens['--bg'], 'rgb(250, 249, 245)');
  assert.strictEqual(tokens['--radius'], '10px');
  assert.ok(!('--not-a-real-token' in tokens), 'unlisted names must be dropped');
  assert.ok(!('--bg-hover' in tokens), 'a listed name with a bad value must be dropped, not repaired');
  assert.deepStrictEqual(chrome.sanitizeTokens(null), {});
});

test('the injected sheet is a single :root rule and nothing else', () => {
  const theme = chrome.themeFromReport({
    mode: 'light',
    surface: 'rgb(250, 249, 245)',
    tokens: { '--bg': 'rgb(250, 249, 245)', '--scrollbar-size': '12px' },
  });
  const css = chrome.themeCss(theme);
  assert.match(css, /^:root \{/);
  assert.ok(css.includes('--bg: rgb(250, 249, 245) !important;'));
  assert.ok(css.includes('--scrollbar-size: 12px !important;'));
  // ui.css declares every one of these as a literal fallback, and those would
  // win on source order without the flag.
  assert.strictEqual((css.match(/!important/g) || []).length, 2);
  assert.strictEqual((css.match(/\{/g) || []).length, 1, 'exactly one rule may be emitted');

  // No tokens means no stylesheet at all, so a themeless page is left with its
  // own palette rather than an empty rule.
  assert.strictEqual(chrome.themeCss(chrome.fallbackTheme('dark')), '');
  assert.strictEqual(chrome.themeCss(null), '');
});
