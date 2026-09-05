'use strict';

// Prove the banner: that it appears for a real condition, that it is exactly as
// tall as it claims, and that it goes away when the condition does.
//
// The height is the part worth testing rather than eyeballing. The banner lives
// in a view sized to whatever the page reports, and a view swallows every mouse
// event inside its bounds no matter what is drawn there — so a wrong number is
// not a cosmetic slip, it is an invisible strip across the top of the Control UI
// that eats clicks. Nothing on screen would explain it.
//
//   npx electron scripts/test-banner.js [--shots DIR]
//
// The condition is real rather than injected: the profile is written with a
// global shortcut the OS cannot possibly register, which is one of the four
// things that genuinely raise a notice.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, webContents } = require('electron');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-banner-'));
app.setPath('userData', TMP);
fs.writeFileSync(path.join(TMP, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Nowhere', url: 'http://127.0.0.1:18791/' }],
  activeGatewayId: 'harness',
  // Not an accelerator. globalShortcut.register throws on it, which is exactly
  // the path that raises the 'shortcut' notice.
  globalShortcut: 'Frobnicate+Zz',
}, null, 2)}\n`);

const shotIndex = process.argv.indexOf('--shots');
const SHOTS = shotIndex === -1 ? null : process.argv[shotIndex + 1];
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

require('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function bannerContents() {
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes('banner.html'));
}

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

const WATCHDOG_MS = 90000;
setTimeout(() => {
  console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`);
  app.exit(1);
}, WATCHDOG_MS).unref();

app.whenReady().then(async () => {
  await delay(6000);

  const banner = bannerContents();
  check('a real condition raises the banner', Boolean(banner), 'no banner view exists');
  if (!banner) { app.exit(1); return; }

  const text = (await banner.executeJavaScript('document.body.innerText')).replace(/\s*\n+\s*/g, ' | ').trim();
  check('it says what is wrong and what to do', /global shortcut is not active/i.test(text) && /Settings/.test(text), text);
  check('it names the accelerator that failed', /Frobnicate/.test(text), text);

  // The two numbers that must agree. `getBounds` is what the compositor uses
  // and `scrollHeight` is what the page laid out; a gap either way is the
  // invisible click-eating strip.
  const [view] = await banner.executeJavaScript(
    '[[document.getElementById("stack").getBoundingClientRect().height, window.innerHeight]]',
  );
  const [stackHeight, viewHeight] = view;
  check('the view is exactly as tall as the banner it holds',
    Math.abs(stackHeight - viewHeight) <= 1, `stack ${stackHeight} vs view ${viewHeight}`);
  check('and that is a real height, not zero', stackHeight > 20, `${stackHeight}px`);

  // It slid, and — more importantly — it is where it should be. The animation
  // fills `both`, so a banner whose animation never ran still sits at its
  // ordinary position rather than parked above the viewport, invisible.
  const [animation, offset] = await banner.executeJavaScript(
    '(() => { const b = document.querySelector(".banner");'
    + ' return [getComputedStyle(b).animationName, b.getBoundingClientRect().top]; })()',
  );
  check('it slides in rather than appearing in place', animation === 'banner-in', `animation-name: ${animation}`);
  check('and it ends up on screen, not parked above it', offset >= 0 && offset < 40, `top: ${offset}`);
  console.log(`     geometry: stack ${stackHeight}, view ${viewHeight}, card top ${offset}, count ${await banner.executeJavaScript('document.querySelectorAll(".banner").length')}`);

  if (SHOTS) {
    try {
      fs.writeFileSync(path.join(SHOTS, 'banner.png'), (await banner.capturePage()).toPNG());
    } catch (err) {
      console.log(`     no screenshot (${err.message})`);
    }
  }

  // Dismissing is the user saying "I have read it", and it must take the view
  // with it — a zero-height view left behind is the same invisible strip.
  await banner.executeJavaScript('document.querySelector(".banner__close").click()');
  await delay(1200);
  check('dismissing takes the whole view away, not just the drawing',
    !bannerContents(), 'the banner view is still there after dismissal');

  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(1);
});
