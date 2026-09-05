'use strict';

// Prove what connecting looks like, and what a failure does now: it stays put.
//
// These are the claims a unit test cannot reach, because each is about where
// things ended up on screen rather than what a function returned. The run walks
// the three states in the order a person meets them:
//
//   connecting  the cover is up and visibly working, with nothing to press
//   failed      nothing navigated, the cover stops, the notice slides down
//               carrying the one link, and following it opens Settings as a
//               modal over the window rather than in place of it
//   recovered   the cover comes down on its own and takes the notice with it
//
// Every state is reached through a real socket rather than injected. The
// connecting state needs a server that accepts and then says nothing, which is
// the only way to hold it still long enough to look at — a refused port fails
// in under a millisecond and there is nothing to photograph.
//
//   npx electron scripts/test-connection-failure.js [--shots DIR]

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { app, webContents, nativeTheme } = require('electron');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-connfail-'));
app.setPath('userData', TMP);
fs.writeFileSync(path.join(TMP, 'config.json'), `${JSON.stringify({
  // Nothing listens here. Chosen over an unresolvable hostname because a
  // refused connection fails immediately and identically on all three
  // platforms, where DNS failure timing depends on the resolver.
  gateways: [{ id: 'harness', label: 'Nowhere', url: 'http://127.0.0.1:18791/' }],
  activeGatewayId: 'harness',
}, null, 2)}\n`);

const shotIndex = process.argv.indexOf('--shots');
const SHOTS = shotIndex === -1 ? null : process.argv[shotIndex + 1];
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// Accepts the connection and then never answers, so the app sits in its
// connecting state for as long as this is up. Sockets are held rather than left
// to the server, because closing a listener does not disturb a connection that
// is already open — and the one already open is the one being tested.
const held = new Set();
const blackhole = http.createServer(() => { /* deliberately no response */ });
blackhole.on('connection', (socket) => { held.add(socket); socket.on('close', () => held.delete(socket)); });
blackhole.listen(18791, '127.0.0.1');

require('../src/main.js');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const live = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
const pageNamed = (name) => live().find((wc) => wc.getURL().includes(name));

let failed = false;
function check(name, ok, detail) {
  if (ok) console.log(`OK   ${name}`);
  else { console.error(`FAIL ${name}: ${detail}`); failed = true; }
}

async function shoot(wc, name) {
  if (!SHOTS || !wc) return;
  try {
    fs.writeFileSync(path.join(SHOTS, name), (await wc.capturePage()).toPNG());
  } catch (err) {
    console.log(`     no screenshot ${name} (${err.message})`);
  }
}

const WATCHDOG_MS = 90000;
setTimeout(() => {
  console.error(`FAIL harness: still running after ${WATCHDOG_MS / 1000}s`);
  app.exit(1);
}, WATCHDOG_MS).unref();

app.whenReady().then(async () => {
  await delay(4000);

  /* ------------------------------------------------------- 0. connecting */

  const connecting = pageNamed('loading.html');
  check('the window shows a loading screen while it connects', Boolean(connecting), 'no loading view exists');
  if (connecting) {
    const state = await connecting.executeJavaScript(
      '(() => ({ failed: document.body.classList.contains("is-failed"),'
      + ' title: document.getElementById("title").textContent,'
      + ' retry: !document.getElementById("retry").hidden,'
      + ' spin: getComputedStyle(document.querySelector(".loading__ring")).animationName,'
      + ' halo: getComputedStyle(document.querySelector(".loading__mark"), "::before").animationName,'
      + ' text: document.body.innerText.replace(/\\s+/g, " ").trim() }))()',
    );
    check('it says it is connecting, and to what',
      !state.failed && state.title === 'Connecting…' && /Nowhere/.test(state.text), JSON.stringify(state));
    check('the ring is actually turning', state.spin === 'loading-spin', `animation-name: ${state.spin}`);
    check('and the halo is breathing behind it', state.halo === 'loading-pulse', `animation-name: ${state.halo}`);
    // Nothing to press while it is still trying: a retry button beside a live
    // spinner invites someone to restart the attempt that is already running.
    check('with nothing to press while it is still trying', !state.retry, 'the retry button is showing');
    await shoot(connecting, 'connecting.png');

    // The light palette is half of ui.css and nothing else here exercises it.
    // Forced through nativeTheme, which is what main drives from the Control
    // UI's own theme — safe to move while no gateway has reported one.
    nativeTheme.themeSource = 'light';
    await delay(600);
    const light = await connecting.executeJavaScript(
      'getComputedStyle(document.body).backgroundColor',
    );
    check('the loading screen follows the light palette too',
      light !== 'rgb(10, 10, 10)', `background stayed ${light}`);
    await shoot(connecting, 'connecting-light.png');
    nativeTheme.themeSource = 'system';
    await delay(400);
  }
  check('and no notice, because nothing has gone wrong yet',
    !pageNamed('banner.html'), 'a notice is up during an ordinary connect');

  /* ------------------------------------------------- 1. nothing navigated */

  // Drop the held sockets and stop listening, so the hung load fails and the
  // retry below is refused outright.
  for (const socket of held) socket.destroy();
  blackhole.close();
  await delay(2500);
  const stopped = pageNamed('loading.html');
  if (stopped) await stopped.executeJavaScript('document.getElementById("retry").click()');
  await delay(3000);

  check('the failure does not put Settings on screen by itself',
    !pageNamed('settings.html'), 'settings.html is loaded and nobody asked for it');

  /* ---------------------------------------------------- 2. the loading cover */

  const cover = pageNamed('loading.html');
  check('the window shows the loading cover instead', Boolean(cover), 'no loading view exists');

  if (cover) {
    const state = await cover.executeJavaScript(
      '(() => ({ failed: document.body.classList.contains("is-failed"),'
      + ' title: document.getElementById("title").textContent,'
      + ' label: document.getElementById("label").textContent,'
      + ' retry: !document.getElementById("retry").hidden,'
      + ' spin: getComputedStyle(document.querySelector(".loading__ring")).animationName,'
      + ' text: document.body.innerText.replace(/\\s+/g, " ").trim() }))()',
    );
    check('it stops claiming to be connecting once it has stopped',
      state.failed && state.title === 'Not connected', JSON.stringify(state));
    check('the ring stops spinning with it', state.spin === 'none', `animation-name: ${state.spin}`);
    check('it names the gateway it was reaching for', /Nowhere/.test(state.text), state.text);
    check('and offers to try again', state.retry, 'the retry button is still hidden');
    // The reason belongs to the notice alone. Two wordings of one failure would
    // drift, and this copy could not be dismissed.
    check('but does not restate the failure the notice owns',
      !/refused|ERR_/i.test(state.text), state.text);
    await shoot(cover, 'connection-failed-cover.png');
  }

  /* ------------------------------------------------------- 3. the notice */

  const banner = pageNamed('banner.html');
  check('the failure slides down from the top', Boolean(banner), 'no banner view exists');
  if (!banner) { fs.rmSync(TMP, { recursive: true, force: true }); app.exit(1); return; }

  const notice = await banner.executeJavaScript(
    '(() => { const b = document.querySelector(".banner");'
    + ' const a = b && b.querySelector(".banner__action");'
    + ' return { text: b ? b.innerText.replace(/\\s+/g, " ").trim() : null,'
    + ' action: a ? a.textContent : null,'
    + ' animation: b ? getComputedStyle(b).animationName : null,'
    + ' top: b ? b.getBoundingClientRect().top : null }; })()',
  );
  check('it names the gateway and the reason', /Nowhere/.test(notice.text) && /refused/i.test(notice.text), notice.text);
  check('it keeps Chromium\'s string beside the sentence', /ERR_CONNECTION_REFUSED/.test(notice.text), notice.text);
  check('it slides rather than appearing in place', notice.animation === 'banner-in', `animation-name: ${notice.animation}`);
  check('and lands on screen rather than above it', notice.top >= 0 && notice.top < 40, `top: ${notice.top}`);
  check('it carries the one way out', notice.action === 'Open Settings', `action: ${notice.action}`);
  await shoot(banner, 'connection-failed-banner.png');

  /* --------------------------------------- following the link, on purpose */

  await banner.executeJavaScript('document.querySelector(".banner__action").click()');
  await delay(2500);

  const settings = pageNamed('settings.html');
  check('following the link opens Settings', Boolean(settings), 'no settings view appeared');
  if (settings) {
    // As a modal over the window, not as the window. `page=1` is what makes
    // Settings the window's own content, and it must not be set here.
    const asPage = await settings.executeJavaScript('document.body.classList.contains("as-page")');
    check('as a modal over the window, not in place of it', !asPage, 'settings rendered as the whole page');
    await shoot(settings, 'connection-failed-settings.png');
  }
  // The cover is still behind it: going to Settings is not the failure
  // resolving, and the window has nothing else to show.
  check('and the loading cover is still underneath', Boolean(pageNamed('loading.html')), 'the cover went away');

  /* ------------------------------------------------------------- recovery */

  // The half that is unrecoverable if it is wrong: a cover that never comes
  // down leaves the app permanently showing a loading screen over a working
  // gateway, and nothing on screen would explain it. So the gateway starts
  // answering and the same window has to come back on its own.
  // Answers immediately by default. The delay is turned up later so the
  // connecting state can be observed rather than raced: a localhost server
  // replies in single-digit milliseconds, which is faster than any assertion
  // can be scheduled against it.
  let responseDelay = 0;
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Gateway</title><h1 id="served">served</h1>');
    }, responseDelay);
  });
  await new Promise((resolve) => server.listen(18791, '127.0.0.1', resolve));

  await cover.executeJavaScript('document.getElementById("retry").click()');
  await delay(3000);

  check('a successful reconnect takes the cover away', !pageNamed('loading.html'), 'the cover is still up');
  check('and clears the notice with it', !pageNamed('banner.html'), 'the failure notice is still on screen');
  const served = live().find((wc) => wc.getURL().startsWith('http://127.0.0.1:18791'));
  check('leaving the gateway on screen', Boolean(served), 'no view is showing the gateway');

  await shoot(pageNamed('settings.html') || served, 'connection-recovered.png');

  /* ------------------------------------------- pressing Connect in Settings */

  // Connect used to close Settings the instant it was pressed, so the page went
  // away before there was any answer to show in it and the next thing on screen
  // was either the Control UI or a failure. It runs behind the page now, and
  // leaving is a second, deliberate press.
  const open = pageNamed('settings.html');
  check('Settings is still open to press Connect in', Boolean(open), 'settings closed itself');
  if (open) {
    responseDelay = 2000;
    await open.executeJavaScript(
      '[...document.querySelectorAll("#gateways button")].find((b) => /^(Re)?[Cc]onnect$/.test(b.textContent)).click()',
    );
    // Mid-flight: the page is still here and the button says what is happening.
    await delay(700);
    const during = await open.executeJavaScript(
      '(() => { const b = [...document.querySelectorAll("#gateways button")]'
      + '.find((x) => /Connect/i.test(x.textContent));'
      + ' return { label: b ? b.textContent : null, disabled: b ? b.disabled : null }; })()',
    );
    check('pressing Connect does not close Settings', Boolean(pageNamed('settings.html')), 'settings went away on press');
    check('and the button reports it rather than going quiet',
      during.label === 'Connecting…' && during.disabled === true, JSON.stringify(during));

    await delay(4500);
    const ready = await open.executeJavaScript(
      '(() => { const c = document.querySelector("#ready .card, #ready > .ready");'
      + ' return c ? c.innerText.replace(/\\s+/g, " ").trim() : null; })()',
    );
    check('when it lands, Settings says the UI is ready', Boolean(ready) && /Connected to/.test(ready), String(ready));
    check('and offers the way through to it', /Open it/.test(ready || ''), String(ready));
    await shoot(open, 'connect-ready.png');

    await open.executeJavaScript('[...document.querySelectorAll("#ready button")].find((b) => /Open it/.test(b.textContent)).click()');
    await delay(1500);
    check('following that closes Settings', !pageNamed('settings.html'), 'settings is still open');
    check('leaving the Control UI on screen',
      Boolean(live().find((wc) => wc.getURL().startsWith('http://127.0.0.1:18791'))), 'the gateway is not showing');
  }

  server.close();

  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((err) => {
  console.error(`FAIL harness: ${err && err.stack ? err.stack : err}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  app.exit(1);
});
