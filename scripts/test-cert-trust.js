'use strict';

// Prove the certificate flow against a real refused certificate.
//
// This is the path with no dialog in it any more, and the failure it has to
// avoid is a dead end: connection refused, error page shown, and no way from
// there to a working app. So the whole loop is exercised rather than any one
// piece of it — a real self-signed HTTPS server, a real handshake failure, the
// real error page, the real Settings card, and then the connection actually
// succeeding afterwards.
//
//   npx electron scripts/test-cert-trust.js
//
//   npx electron scripts/test-cert-trust.js --shots /tmp/cert-flow   # and look at it
//
// Needs `openssl` on PATH to mint the throwaway certificate. Nothing is
// committed: the key is generated per run into a temp directory and deleted.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { app, Menu, webContents } = require('electron');

const PORT = 18790; // not 18789, so a real gateway on this machine is untouched
const HOST = `127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-cert-'));
const PROFILE = path.join(TMP, 'profile');
fs.mkdirSync(PROFILE, { recursive: true });

app.setPath('userData', PROFILE);
fs.writeFileSync(path.join(PROFILE, 'config.json'), `${JSON.stringify({
  gateways: [{ id: 'harness', label: 'Self-signed', url: `https://${HOST}/` }],
  activeGatewayId: 'harness',
}, null, 2)}\n`);

/* --------------------------------------------------- a server it must refuse */

const key = path.join(TMP, 'key.pem');
const cert = path.join(TMP, 'cert.pem');
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', key, '-out', cert, '-days', '1',
  '-subj', '/CN=127.0.0.1',
  '-addext', 'subjectAltName=IP:127.0.0.1',
], { stdio: 'ignore' });

const server = https.createServer(
  { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Gateway</title><body><h1>PRETEND GATEWAY REACHED</h1>');
  },
);

require('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function menuItem(label, items = Menu.getApplicationMenu()?.items || []) {
  for (const item of items) {
    if (item.label === label) return item;
    const found = item.submenu && menuItem(label, item.submenu.items);
    if (found) return found;
  }
  return null;
}

function contentsFor(match) {
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().includes(match));
}

const shotIndex = process.argv.indexOf('--shots');
const SHOTS = shotIndex === -1 ? null : process.argv[shotIndex + 1];
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

/**
 * What a page is showing, as text, and optionally as a picture.
 *
 * The text is the assertion; `--shots` is for looking at it afterwards. They
 * are not interchangeable — a card that renders empty because an element id was
 * mistyped looks fine in a thumbnail — and `capturePage` needs a display
 * surface, so it fails outright on a headless or locked machine. That must not
 * be able to fail the run.
 */
async function textOf(match, what) {
  const wc = contentsFor(match);
  if (!wc) throw new Error(`${what}: nothing is showing ${match}`);
  if (SHOTS) {
    try {
      const shot = await wc.capturePage();
      fs.writeFileSync(path.join(SHOTS, `${what.replace(/[^a-z0-9]+/gi, '-')}.png`), shot.toPNG());
    } catch (err) {
      console.log(`     no screenshot of ${what} (${err.message})`);
    }
  }
  const text = await wc.executeJavaScript('document.body.innerText');
  return text.replace(/\s*\n+\s*/g, ' | ').trim();
}

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

// A hard stop. Without it, anything that throws inside the run below becomes an
// unhandled rejection: app.exit() is never reached, and the harness sits there
// with a window open until someone kills it by hand.
const WATCHDOG_MS = 120000;
setTimeout(() => {
  console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`);
  app.exit(1);
}, WATCHDOG_MS).unref();

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  await delay(6000);

  /* 1. The connection is refused, and the app says so where it stands: a
        notice down from the top carrying the link to the page that can fix it.
        Nothing navigated on its own -- that is half the claim being made. */
  const bannerText = await textOf('banner.html', 'the notice after the refusal');
  check('a refused connection raises a notice rather than moving anyone',
    /Cannot connect/i.test(bannerText) && !contentsFor('settings.html'),
    `${bannerText.slice(0, 200)} | settings open: ${Boolean(contentsFor('settings.html'))}`);
  check('and the notice carries the way to fix it', /Open Settings/.test(bannerText), bannerText.slice(0, 200));

  /* 2. Following that link is what puts the certificate in front of you. */
  await contentsFor('banner.html').executeJavaScript('document.querySelector(".banner__action").click()');
  await delay(2500);

  const settingsText = await textOf('settings.html', 'settings after following the link');
  check('Settings carries the refused certificate and its fingerprint',
    settingsText.includes(HOST) && /Trust this certificate/.test(settingsText) && /sha256\//.test(settingsText),
    settingsText.slice(0, 400));
  check('it is worded as routine rather than as an attack',
    /cannot verify/i.test(settingsText) && !/has CHANGED/.test(settingsText),
    settingsText.slice(0, 400));
  // Case-insensitive: ui.css text-transforms the badge, and innerText reports
  // what is rendered rather than what is in the markup.
  check('the gateway row itself reports the problem',
    /certificate not trusted/i.test(settingsText), settingsText.slice(0, 600));

  /* 3. Trusting it there fixes the thing that was broken. */
  const settings = contentsFor('settings.html');
  await settings.executeJavaScript(
    '[...document.querySelectorAll("#cert-offers button")].find((b) => /Trust/.test(b.textContent)).click()',
  );
  await delay(3000);

  const pinned = JSON.parse(fs.readFileSync(path.join(PROFILE, 'config.json'), 'utf8')).trustedCerts || {};
  check('the fingerprint is pinned for that host alone',
    typeof pinned[HOST] === 'string' && pinned[HOST].startsWith('sha256/') && Object.keys(pinned).length === 1,
    JSON.stringify(pinned));

  // The point of the whole exercise: the app is now connected to the thing it
  // could not reach. Anything less is a prompt replaced by a dead end.
  const reached = contentsFor(`https://${HOST}`);
  const body = reached ? await reached.executeJavaScript('document.body.innerText') : '';
  check('the gateway loads after trusting it', /PRETEND GATEWAY REACHED/.test(body), `showing: ${body.slice(0, 120)}`);

  // Read from the store rather than from the page: by now the settings page has
  // been replaced by the gateway it just connected to, and a remote page gets
  // no bridge at all — deliberately, since it is a website.
  const offerNow = require('../src/certs').pendingOffers().length;
  check('the offer is gone once it has been decided', offerNow === 0, `${offerNow} still pending`);

  /* 4. The hostile case. Same host, same pin, different certificate — which is
        what interception looks like, and must not read like the routine one. */
  await new Promise((r) => server.close(r));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });

  const impostor = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body>SHOULD NOT BE REACHED'); },
  );
  await new Promise((r) => impostor.listen(PORT, '127.0.0.1', r));

  menuItem('Reconnect to gateway').click();
  await delay(5000);

  const changedText = await textOf('settings.html', 'settings after the certificate changed');
  check('a changed certificate is called out as changed',
    /has CHANGED/.test(changedText), changedText.slice(0, 400));
  check('both fingerprints are shown, so they can be compared',
    /previously trusted/.test(changedText) && /now presenting/.test(changedText),
    changedText.slice(0, 400));
  // Asserted on the *content* rather than on whether a view still holds that
  // URL. It used to be the URL, which worked only because a failure navigated
  // the page away to Settings; now that nothing navigates, the view keeps the
  // address it failed on and that proxy answers the wrong question. What has to
  // be true is that the impostor's bytes never rendered.
  const impostorView = contentsFor(`https://${HOST}`);
  const shown = impostorView ? await impostorView.executeJavaScript('document.body.innerText') : '';
  check('the impostor is not reached while the decision is pending',
    !/SHOULD NOT BE REACHED/.test(shown), `the page is showing: ${shown.slice(0, 200)}`);
  // And it is not on screen either way: the loading cover is over it until a
  // connection actually succeeds, so nothing stale is being read as current.
  check('and nothing stale is left on screen behind the decision',
    Boolean(contentsFor('loading.html')), 'no loading cover over the failed page');

  // Doing nothing has to be the safe outcome — the whole reason this is not a
  // modal whose easiest button is "yes".
  const stillPinned = JSON.parse(fs.readFileSync(path.join(PROFILE, 'config.json'), 'utf8')).trustedCerts || {};
  check('the original pin is untouched until someone decides',
    stillPinned[HOST] === pinned[HOST], `${stillPinned[HOST]} vs ${pinned[HOST]}`);

  impostor.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  try { server.close(); } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(1);
});
