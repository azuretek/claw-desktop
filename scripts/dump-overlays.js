'use strict';

// Boot the real app, open each of its own dialogs through the real menu item,
// and capture what rendered.
//
// The companion to scripts/dump-menu.js, and it exists for the same reason: the
// unit suite tests pure functions, and every defect these pages can have lives
// outside one. A typo in an element id, a CSP that blocks the page's own
// script, a selector that no longer matches — all of them pass `npm test` and
// leave a modal that is blank, or worse, an invisible sheet over the whole
// window. Only running it finds those.
//
// It requires src/main.js rather than reimplementing any of it, so what gets
// captured is the same code path a menu click takes. It needs a display.
//
//   npx electron scripts/dump-overlays.js [--out DIR]
//
// The app will fail to reach a gateway and show its error page. That is fine
// and deliberate: the overlays are what is being looked at, and they sit on top
// of whatever the window is showing.
//
// One number in the output is this harness's own and not the app's: Electron
// takes the app path from the entry file's directory, so `app.getVersion()`
// here answers with Electron's version rather than the one in package.json.
// Every other value is the app's. Read the version from `npm start` instead.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, Menu, webContents } = require('electron');

// A throwaway profile, so a run cannot disturb the gateways, pinned
// certificates or preferences of the app someone actually uses on this machine.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-overlays-'));
app.setPath('userData', PROFILE);

// Seeded with a gateway that cannot answer, which is the state being aimed for
// rather than a shortcut. An empty profile is a *first run*, and on a first run
// Settings is the window's own content rather than a modal over it — so the
// overlay path, the one being checked, is the one that never runs.
fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Harness', url: 'http://127.0.0.1:18789/' }],
  activeGatewayId: 'harness',
}, null, 2)}\n`);

const outIndex = process.argv.indexOf('--out');
const OUT = outIndex === -1 ? path.join(os.tmpdir(), 'claw-overlays') : process.argv[outIndex + 1];

// The real thing. Loading it registers the IPC handlers, builds the menu, and
// creates the window, all before our own whenReady handler below runs, because
// it was required first.
require('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Find a menu item by its label, anywhere in the application menu. */
function menuItem(label, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (item.label === label) return item;
    const found = item.submenu && menuItem(label, item.submenu.items);
    if (found) return found;
  }
  return null;
}

/** The overlay's own WebContents, which is what has anything in it to capture. */
function overlayContents(file) {
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes(`/${file}`));
}

/**
 * What the overlay put on screen, as text, plus a screenshot where one is
 * possible.
 *
 * The text is the assertion and the image is the bonus, rather than the other
 * way round. It is the stronger signal for what breaks here — a mistyped
 * element id or a CSP that blocked the page's own script both produce a card
 * with nothing in it, which reads as "rendered" in a thumbnail. It is also the
 * only signal available on a machine with no display: `capturePage` needs a
 * display surface and fails outright without one, and a harness that could only
 * run where someone is sitting is a harness that does not get run.
 */
async function capture(file, name) {
  const wc = overlayContents(file);
  if (!wc) throw new Error(`${name}: ${file} never opened`);
  const text = await wc.executeJavaScript('document.body.innerText');

  let image = null;
  try {
    // Transparent outside the card, because the overlay is a sheet over the
    // window rather than a page of its own. Alpha is kept.
    const shot = await wc.capturePage();
    image = path.join(OUT, `${name}.png`);
    fs.writeFileSync(image, shot.toPNG());
  } catch (err) {
    image = `no screenshot (${err.message})`;
  }
  return { image, text: text.replace(/\s*\n+\s*/g, ' | ').trim() };
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // Long enough for the window, its child views and the first (failing) gateway
  // load to settle, so a capture is never racing a page that is still painting.
  await delay(6000);

  // `expect` is what turns this from a screenshot tool into a check: a page
  // that loads but renders nothing still produces a file, and a blank card is
  // exactly what every failure mode here looks like.
  const steps = [
    {
      name: 'about',
      click: 'About Claw Desktop',
      file: 'about.html',
      expect: [/Claw Desktop/, /Updates:/, /Check for updates/, /Electron/],
    },
    // Reaches the message dialog through the real update path: a source build
    // has no updater, and a manual check is the one trigger that says so.
    {
      name: 'message',
      click: 'Check for updates…',
      file: 'message.html',
      expect: [/Updates are not available in this build/, /running from source/, /OK/],
    },
    {
      name: 'settings',
      click: 'Settings…',
      file: 'settings.html',
      // Uppercase because ui.css text-transforms the section headings, and
      // innerText reports what is rendered rather than what is in the markup.
      expect: [/GATEWAYS/i, /Install updates automatically/],
    },
  ];

  let failed = false;
  for (const step of steps) {
    const item = menuItem(step.click);
    if (!item) {
      console.error(`FAIL ${step.name}: no menu item "${step.click}"`);
      failed = true;
      continue;
    }
    item.click();
    await delay(1500);
    try {
      const { image, text } = await capture(step.file, step.name);
      const missing = step.expect.filter((re) => !re.test(text));
      if (missing.length) {
        console.error(`FAIL ${step.name}: rendered without ${missing.join(', ')}`);
        failed = true;
      } else {
        console.log(`OK   ${step.name} -> ${image}`);
      }
      console.log(`     ${text.slice(0, 700)}`);
    } catch (err) {
      console.error(`FAIL ${step.name}: ${err.message}`);
      failed = true;
    }
  }

  // Answering a message dialog. This is the half that replaced the native
  // dialog's return value, and its failure mode is the quiet one: a button
  // that renders and does nothing leaves the caller in main.js awaiting a
  // promise forever, with a sheet still over the window.
  const message = overlayContents('message.html');
  if (!message) {
    console.error('FAIL message-answer: the dialog closed on its own');
    failed = true;
  } else {
    await message.executeJavaScript('document.querySelector("#buttons button").click()');
    await delay(800);
    if (overlayContents('message.html')) {
      console.error('FAIL message-answer: still open after its button was clicked');
      failed = true;
    } else {
      console.log('OK   message-answer -> dialog answered and torn down');
    }
  }

  // The automatic-updates toggle, end to end: click the real checkbox in the
  // real page, press its real Save button, and read what landed on disk. A
  // preference that renders but never persists looks identical until the next
  // launch, which is a session away from whoever changed it.
  const settings = overlayContents('settings.html');
  if (!settings) {
    console.error('FAIL autoUpdate: settings overlay is gone');
    failed = true;
  } else {
    const before = JSON.parse(fs.readFileSync(path.join(PROFILE, 'config.json'), 'utf8'));
    // The checkbox is legitimately disabled on a build that could never install
    // an update — a source run is one — and settings.js deliberately leaves the
    // key out of the patch when it is, so that a Linux user who once ran the
    // unpacked binary does not come back to their AppImage with the preference
    // silently off. Where that is the case, drive the same bridge call the
    // checkbox would have made, so the main-process half is still exercised.
    const disabled = await settings.executeJavaScript('document.getElementById("autoUpdate").disabled');
    console.log(`     checkbox ${disabled ? 'disabled (this build cannot install updates)' : 'enabled'}`);
    await settings.executeJavaScript(disabled
      ? 'window.clawDesktop.saveSettings({ autoUpdate: false })'
      : 'document.getElementById("autoUpdate").checked = false;'
        + 'document.getElementById("save").click();');
    await delay(1000);
    const after = JSON.parse(fs.readFileSync(path.join(PROFILE, 'config.json'), 'utf8'));
    if (before.autoUpdate === false || after.autoUpdate !== false) {
      console.error(`FAIL autoUpdate: ${JSON.stringify(before.autoUpdate)} -> ${JSON.stringify(after.autoUpdate)}`);
      failed = true;
    } else {
      console.log(`OK   autoUpdate -> ${JSON.stringify(before.autoUpdate)} -> ${JSON.stringify(after.autoUpdate)} in config.json`);
    }
  }

  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
});
