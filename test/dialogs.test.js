'use strict';

// The project's rule: every dialog is one of the app's own overlay pages, never
// a native one.
//
// This is a source scan rather than a behaviour test because the failure it
// guards against is silent and one line long. `dialog.showMessageBox` works,
// looks approximately right on the machine of whoever added it, and only
// afterwards turns out to be a different dialog on each platform, in the
// system's colours rather than the Control UI's, with no room for anything but
// a line of text — which is how the About box ended up native in the first
// place. Nothing at runtime objects to it, so nothing but this would notice.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const UI = path.join(SRC, 'ui');

// There are no exceptions. The last one was the certificate prompt, and it went
// because the failed handshake means there is often no page to lay a dialog
// over — and because a yes/no box in front of someone waiting for their app to
// open is the worst place to put a security decision. It is refused on the spot
// and settled in Settings instead; see src/certs.js.

const sourceFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));

/**
 * Source with its comments removed.
 *
 * Needed because saying why we do *not* call a thing is the point of half the
 * comments in this codebase, so scanning raw text flags the explanations along
 * with the offences. Block comments are stripped as blocks rather than by
 * matching the start of each line: a wrapped `/* ... *\/` has continuation
 * lines that begin with an ordinary word.
 */
function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('the app has source files to scan', () => {
  // A rename or a restructure that empties this list would turn every
  // assertion below into a test that cannot fail.
  assert.ok(sourceFiles.length >= 10, `only found ${sourceFiles.length} source files`);
});

test('nothing opens a native dialog', () => {
  for (const file of sourceFiles) {
    assert.doesNotMatch(code(path.join(SRC, file)), /dialog\.show(MessageBox|ErrorBox)/, `${file} opens a native dialog`);
  }
});

test('nothing imports Electron’s dialog module at all', () => {
  // Stronger than scanning for the call, and the reason it is worth having:
  // reaching for `dialog` is what someone does when the in-app path looks like
  // more work, and the import is the moment to notice rather than the call.
  for (const file of sourceFiles) {
    assert.doesNotMatch(code(path.join(SRC, file)), /\bdialog\b\s*[,}]/, `${file} imports dialog`);
  }
});

test('nothing uses the built-in About panel', () => {
  // Electron's `role: 'about'` cannot show the build commit, cannot say
  // anything about updating, and cannot carry a button — the two things people
  // open About to do. On Windows it did not exist before Electron 15.
  for (const file of sourceFiles) {
    assert.doesNotMatch(code(path.join(SRC, file)), /role:\s*['"]about['"]/, `${file} uses the native About panel`);
  }
});

test('every overlay page main.js can open exists on disk', () => {
  // main.js maps a name to a filename, and a typo there is a modal that opens
  // as a blank sheet over the whole window until the watchdog tears it down.
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const block = /const OVERLAY_PAGES = \{([^}]*)\}/.exec(main);
  assert.ok(block, 'OVERLAY_PAGES not found in main.js');

  const pages = [...block[1].matchAll(/(\w+):\s*'([^']+)'/g)].map(([, name, file]) => ({ name, file }));
  assert.ok(pages.length >= 3, `expected settings, about and message; found ${pages.length}`);

  for (const { name, file } of pages) {
    assert.ok(fs.existsSync(path.join(UI, file)), `${name} -> ui/${file} does not exist`);
    // Every page is loaded into a sandboxed view with contextIsolation on, so
    // its script is the only way it can do anything at all.
    const html = fs.readFileSync(path.join(UI, file), 'utf8');
    const script = /<script src="([^"]+)"/.exec(html);
    assert.ok(script, `ui/${file} loads no script`);
    assert.ok(fs.existsSync(path.join(UI, script[1])), `ui/${file} loads a missing ${script[1]}`);
    // Inline script and style are blocked by each page's own CSP, so a page
    // without one is a page whose failure mode is "the buttons do nothing".
    assert.match(html, /Content-Security-Policy/, `ui/${file} has no CSP`);
  }
});
