'use strict';

// Plain `node --test` — no Electron, so the Windows rules can be asserted from
// any machine. Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const chrome = require('../src/chrome');

// Collapse whitespace so assertions describe the rule, not the indentation.
const flat = (css) => css.replace(/\s+/g, ' ').trim();

test('the app owns the chrome on both desktop platforms', () => {
  assert.strictEqual(chrome.enabled('darwin'), true);
  assert.strictEqual(chrome.enabled('win32'), true);
  // Linux window managers vary too much to hand back a frameless window the
  // user can reliably move, resize and close, so the OS frame stays.
  assert.strictEqual(chrome.enabled('linux'), false);
});

test('both desktop platforms reserve the strip; Linux reserves nothing', () => {
  assert.strictEqual(chrome.contentInset('darwin').top, chrome.STRIP_HEIGHT);
  assert.strictEqual(chrome.contentInset('win32').top, chrome.STRIP_HEIGHT);
  assert.strictEqual(chrome.contentInset('linux').top, 0);
  assert.ok(chrome.STRIP_HEIGHT > 0);
});

// The regression that forced this architecture, and the reason there is nothing
// left to assert about injected CSS.
//
// Window buttons drawn over the page take the click, and "which element is under
// them" has no stable answer. On Windows: the chat pane header, then a docked
// side panel's header, then the empty "Open a tab" header, then the custodian
// panel -- `position: fixed; right: 0`, so no ancestor's padding could move it.
// On macOS: the sidebar brand row, then any routed page's own top-left content
// once the nav collapses. Five insets, five layout states, five silent misses.
//
// A padding rule reappearing here means someone has gone back to guessing.
test('the app injects nothing into the gateway page', () => {
  for (const name of ['dragCss', 'applyToPage', 'hostClass']) {
    assert.strictEqual(
      chrome[name], undefined,
      `${name} is gone: the page must not be styled or marked by the app`,
    );
  }
});

test('the strip clears the window buttons at whichever end they are', () => {
  const mac = flat(chrome.stripCss('darwin'));
  const win = flat(chrome.stripCss('win32'));

  for (const css of [mac, win]) {
    assert.ok(css.includes(`--strip-height: ${chrome.STRIP_HEIGHT}px`), 'height has one owner');
  }

  // macOS: traffic lights at the left, so the label starts after them.
  assert.ok(mac.includes(`--strip-pad-start: ${chrome.MAC_CONTENT_INSET}px`));
  assert.ok(!mac.includes('titlebar-area'), 'macOS has no window controls overlay');

  // Windows: caption buttons at the right.
  assert.ok(win.includes('--strip-pad-start: 12px'), 'nothing to clear on the left');
  assert.match(win, /--strip-pad-end: max\(/, 'clearance must have a floor');
  assert.ok(win.includes(`${chrome.WIN_CONTROLS_FALLBACK}px`));
});

test('the Windows caption width is measured, with a floor when it cannot be', () => {
  // A constant cannot follow DPI changes, resize or maximise: a 150px guess was
  // wrong by 13px against a real 150%-scaled display, which measured 137px.
  assert.match(chrome.WIN_CONTROLS_WIDTH, /env\(titlebar-area-x, 0px\)/);
  assert.match(chrome.WIN_CONTROLS_WIDTH, /env\(titlebar-area-width, 100vw\)/);
  // Those env vars are published to the window's main frame, and the strip is a
  // child view where they may be absent -- the calc would then resolve to 0px
  // and put the label under the close button. Hence the floor.
  assert.ok(chrome.WIN_CONTROLS_FALLBACK >= 137, 'floor must clear real buttons');
});

test('the macOS label inset stays the sum of its parts', () => {
  assert.strictEqual(
    chrome.MAC_CONTENT_INSET,
    chrome.MAC_LIGHTS_X + chrome.MAC_LIGHTS_SPAN + chrome.MAC_LIGHTS_GAP,
    'inset must not drift into a literal',
  );
  // Clearing the last light is necessary but not sufficient: at a 10px gap the
  // label read as crowded against the close button.
  assert.ok(chrome.MAC_LIGHTS_GAP >= 20, 'the label needs breathing room');
});

/* ------------------------------------------------------------------- title */

test('every route label comes from the page, except Home', () => {
  const at = (path) => `https://gw.example/${path}`;
  // The Control UI titles most routes usefully...
  assert.strictEqual(chrome.pageLabel('Automations — OpenClaw', at('automations')), 'Automations');
  assert.strictEqual(chrome.pageLabel('Plugins — OpenClaw', at('settings/plugins')), 'Plugins');
  assert.strictEqual(
    chrome.pageLabel('Media curator status check — OpenClaw', at('chat/main/media-curator-abc')),
    'Media curator status check',
  );
  // ...but titles Home with the AGENT ID, so the strip read "main" where the nav
  // said "Home". Answered from the route, not by rewriting the string: "main" is
  // a legitimate title elsewhere, and an agent can be named anything.
  assert.strictEqual(chrome.pageLabel('main — OpenClaw', at('chat/main')), 'Home');
  assert.strictEqual(chrome.pageLabel('zilla — OpenClaw', at('chat/zilla')), 'Home');
  assert.strictEqual(chrome.pageLabel('main — OpenClaw', at('chat/main?nav=collapsed')), 'Home');
  assert.strictEqual(chrome.pageLabel('main — OpenClaw', at('chat/main/')), 'Home');
});

test('a session called "Home" is still its own session, not the Home route', () => {
  // The rule is the route, so this must not collapse into the nav entry.
  assert.strictEqual(
    chrome.pageLabel('Home — OpenClaw', 'https://gw.example/chat/main/home-a1b2'),
    'Home',
  );
  assert.strictEqual(chrome.isAgentHome('https://gw.example/chat/main/home-a1b2'), false);
  assert.strictEqual(chrome.isAgentHome('https://gw.example/chat/main'), true);
  assert.strictEqual(chrome.isAgentHome('https://gw.example/automations'), false);
  assert.strictEqual(chrome.isAgentHome('not a url'), false);
});

test('a title the Control UI did not write is not trusted', () => {
  // Our own file:// pages set their own titles, and a gateway may set any it
  // likes; neither should end up in the window title.
  assert.strictEqual(chrome.pageLabel('Claw Desktop Settings', 'file:///x/settings.html'), null);
  assert.strictEqual(chrome.pageLabel('', 'https://gw.example/chat/main'), null);
  assert.strictEqual(chrome.pageLabel(undefined, 'https://gw.example/chat/main'), null);
  // Suffix only, nothing before it.
  assert.strictEqual(chrome.pageLabel('OpenClaw', 'https://gw.example/chat/main'), null);
});

test('the window title always ends in the app name', () => {
  assert.strictEqual(chrome.windowTitle('Home'), `Home — ${chrome.APP_NAME}`);
  assert.strictEqual(chrome.windowTitle(null), chrome.APP_NAME);
  assert.strictEqual(chrome.APP_NAME, 'Claw Desktop');
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
