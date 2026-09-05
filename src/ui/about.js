'use strict';

// The About box. Same shape as settings.js: nodes are built rather than
// assigned as innerHTML, and every value comes from the main process already
// formatted, because this page is sandboxed and cannot require src/updates.js
// or src/build-info.js. Formatting here would mean a second copy of those rules
// that drifts the first time either changes.

const api = window.clawDesktop;
const $ = (id) => document.getElementById(id);

if (new URLSearchParams(location.search).has('frameless')) document.body.classList.add('frameless');

const PLATFORM_NAMES = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function fact(label, value) {
  return el('div', { className: 'fact' }, [
    el('span', { className: 'fact__label', textContent: label }),
    el('span', { className: 'fact__value mono', textContent: value }),
  ]);
}

function render(state) {
  $('build').textContent = state.build;
  $('update-status').textContent = state.updateStatus;
  // The status line says what is happening. This says what to do about it,
  // which is the part someone opening About while suspicious is looking for.
  const hint = state.updateReady
    ? `Version ${state.updateReady} is downloaded — restart from the tray or the menu bar to apply it.`
    : (state.canInstall && !state.autoUpdate
      ? 'Automatic updates are off. Turn on “Install updates automatically” in Settings to have new versions applied without asking.'
      : '');
  $('update-hint').textContent = hint;
  $('update-hint').hidden = !hint;

  $('facts').replaceChildren(
    fact('Version', state.version),
    fact('Channel', state.channel),
    fact('Electron', `${state.versions.electron} · Chromium ${state.versions.chrome}`),
    fact('Platform', `${PLATFORM_NAMES[state.platform] || state.platform} ${state.arch}`),
  );
}

async function refresh() {
  render(await api.about());
}

/* --------------------------------------------------------------- listeners */

$('check').addEventListener('click', async () => {
  const out = $('check-result');
  out.textContent = 'Checking…';
  out.className = 'result';
  await api.checkUpdates();
  // The result arrives as its own message dialog, and the status line above
  // refreshes itself through onAboutChanged — so all this has to do is stop
  // saying "Checking…" if the check never comes back at all.
  setTimeout(() => { if (out.textContent === 'Checking…') out.textContent = ''; }, 15000);
});

$('releases').addEventListener('click', () => api.openReleases());

const dismiss = () => api.closeOverlay('about');
$('close').addEventListener('click', dismiss);
// Only a click that both starts and ends on the scrim counts, so releasing the
// mouse outside the card after selecting text inside it does not close it.
$('scrim').addEventListener('mousedown', (e) => {
  if (e.target !== e.currentTarget) return;
  $('scrim').addEventListener('mouseup', (ev) => { if (ev.target === e.currentTarget) dismiss(); }, { once: true });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismiss(); });

// Pushed by the main process whenever a check finishes. Without it, clicking
// "Check for updates" would leave the line above the button still saying "no
// check yet this run" — the question this box exists to answer, answered
// wrongly, immediately after the user did the thing that changed it.
api.onAboutChanged(() => {
  const out = $('check-result');
  if (out.textContent === 'Checking…') out.textContent = '';
  void refresh();
});

void refresh();
