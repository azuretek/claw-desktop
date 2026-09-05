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
// The app will fail to reach its first gateway and raise a notice about it.
// That is fine and deliberate: the banner and the overlays are what is being
// looked at, and they sit on top of whatever the window is showing. A second,
// deliberately slow gateway is started here so the loading bar can be caught
// while it is still moving.
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

// A real server that accepts the connection and then sits on it before
// answering. It is what makes the loading cover's progress bar observable at
// all: against a refused port the whole connect fails in milliseconds, so the
// bar only ever exists in its frozen, failed state and the part that moves is
// never seen. Holding the request produces a genuine, long CONNECTING phase —
// the same one a sleeping tailnet gateway produces — without faking any of it.
const HOLD_MS = 5000;
const slowGateway = require('node:http').createServer((_req, res) => {
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Slow gateway</title><body>connected');
  }, HOLD_MS);
});

// Seeded with a gateway that cannot answer, which is the state being aimed for
// rather than a shortcut. An empty profile is a *first run*, and on a first run
// Settings is the window's own content rather than a modal over it — so the
// overlay path, the one being checked, is the one that never runs.
fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [
    { id: 'harness', label: 'Harness', url: 'http://127.0.0.1:18789/' },
    { id: 'slow', label: 'Slow gateway', url: 'http://127.0.0.1:18790/' },
  ],
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
  slowGateway.listen(18790, '127.0.0.1');
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
    // The banner, reached through the real update path: a source build has no
    // updater, and a manual check is the one trigger that says so. It is a
    // notice now rather than a modal, so this also proves the banner can carry
    // an answer to something the user pressed and not only a standing fault —
    // the failed connection's own notice is up alongside it.
    {
      name: 'banner',
      click: 'Check for updates…',
      file: 'banner.html',
      // Case-insensitive on the reason: it is written to be appended to a
      // sentence, and the banner capitalises it to stand on its own.
      expect: [/Updates are not available in this build/, /running from source/i,
        /Cannot connect to Harness/, /Open Settings/],
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

  // Dismissing a notice. The banner's ✕ is the only way a standing condition
  // comes off the screen, and its failure mode is the quiet one: a button that
  // renders and does nothing leaves a strip permanently over the window, in a
  // view that eats every click inside its bounds.
  const banner = overlayContents('banner.html');
  if (!banner) {
    console.error('FAIL notice-dismiss: the banner is not up');
    failed = true;
  } else {
    const before = await banner.executeJavaScript('document.querySelectorAll(".banner").length');
    await banner.executeJavaScript('document.querySelector(".banner__close").click()');
    await delay(800);
    const after = await banner.executeJavaScript('document.querySelectorAll(".banner").length').catch(() => 0);
    if (after >= before) {
      console.error(`FAIL notice-dismiss: ${before} notices before, ${after} after`);
      failed = true;
    } else {
      console.log(`OK   notice-dismiss -> ${before} notices, ${after} after the ✕`);
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

  // The loading cover while something is genuinely in flight, and then the way
  // out of Settings once it lands. Both need a gateway that takes its time:
  // against the refused port the bar only ever exists frozen, and a connect
  // that completes before the capture proves nothing about what was on screen
  // during it.
  if (!settings) {
    console.error('FAIL loading: settings overlay is gone, cannot start a slow connect');
    failed = true;
  } else {
    // The Connect button of the gateway that is *not* active — the active one
    // reads "Reconnect", so an exact match picks the slow one without needing
    // to know the order the rows rendered in.
    const started = await settings.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Connect');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!started) {
      console.error('FAIL loading: no Connect button for the slow gateway');
      failed = true;
    } else {
      // Comfortably inside the hold, so the connect is still open.
      await delay(2000);
      try {
        const { image, text } = await capture('loading.html', 'loading');
        // A percentage, strictly between the ends: 0 would mean nothing was
        // reported and 100 would mean it claimed a load that has not finished.
        const shown = /(\d+)%/.exec(text);
        const percent = shown ? Number(shown[1]) : null;
        const missing = [/Connecting/, /Slow gateway/, /%/].filter((re) => !re.test(text));
        if (missing.length) {
          console.error(`FAIL loading: rendered without ${missing.join(', ')}`);
          failed = true;
        } else if (percent === null || percent <= 0 || percent >= 100) {
          console.error(`FAIL loading: bar reads ${shown ? shown[0] : 'nothing'} mid-connect`);
          failed = true;
        } else {
          console.log(`OK   loading -> ${image} (bar at ${percent}%)`);
        }
        console.log(`     ${text.slice(0, 400)}`);
      } catch (err) {
        console.error(`FAIL loading: ${err.message}`);
        failed = true;
      }

      // Now let it answer. The connect completes with Settings still open,
      // which is the one case that used to need a card on the Settings page
      // itself — it is a notice now, and only reachable because the banner
      // draws above the overlays.
      await delay(HOLD_MS + 2500);
      const done = overlayContents('banner.html');
      const text = done ? await done.executeJavaScript('document.body.innerText').catch(() => '') : '';
      if (done) await capture('banner.html', 'banner-connected').catch(() => {});
      // No composite screenshot of the notice sitting over Settings, and it is
      // not for want of trying: `BrowserWindow.capturePage()` captures the
      // window's *own* WebContents, and this window has none — it is child views
      // all the way down. It returns an empty image rather than failing, so a
      // shot taken that way is a zero-byte file next to a line reading OK.
      // Position is asserted instead, in scripts/test-connection-failure.js:
      // the banner's top edge is inside the first 40px while Settings is open.
      if (!/Open it/.test(text) || !/Slow gateway/.test(text)) {
        console.error(`FAIL connected-notice: banner reads ${JSON.stringify(text.slice(0, 200))}`);
        failed = true;
      } else {
        console.log('OK   connected-notice -> banner offers "Open it" over the Settings modal');
        // And the offer works: taking it closes Settings and clears the notice.
        await done.executeJavaScript('document.querySelector(".banner__action").click()');
        await delay(1000);
        if (overlayContents('settings.html')) {
          console.error('FAIL connected-notice: "Open it" left Settings open');
          failed = true;
        } else {
          console.log('OK   open-it -> Settings closed, the Control UI is in front');
        }
      }
    }
  }

  slowGateway.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
});
