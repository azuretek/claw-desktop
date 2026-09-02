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
  // Traffic lights are top-left, and the Control UI already insets that side
  // itself via --shell-titlebar-inset.
  const css = flat(chrome.dragCss('darwin'));
  assert.ok(!css.includes('padding-right'), 'macOS must not inset the right edge');
  assert.ok(!css.includes('titlebar-area-width'), 'macOS has no window controls overlay');
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
