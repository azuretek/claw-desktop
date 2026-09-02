'use strict';

const api = window.openclaw;
const firstRun = new URLSearchParams(location.search).has('firstRun');
const $ = (id) => document.getElementById(id);

let state = null;

/* Build DOM nodes rather than assigning innerHTML: labels and URLs are
   user-supplied strings, and this page has no business parsing them as HTML. */
function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function renderGateways() {
  const host = $('gateways');
  host.replaceChildren();

  if (!state.gateways.length) {
    host.append(el('div', { className: 'card empty', textContent: 'No gateways yet — add one below.' }));
    return;
  }

  for (const gw of state.gateways) {
    const active = gw.id === state.activeGatewayId;
    const row = el('div', { className: 'row' }, [
      el('div', { className: 'stack grow' }, [
        el('span', { className: 'name', textContent: gw.label || gw.url }),
        el('span', { className: 'url', textContent: gw.url }),
      ]),
      active ? el('span', { className: 'badge', textContent: 'Connected' }) : null,
      el('button', {
        className: active ? 'ghost' : 'primary',
        textContent: active ? 'Reconnect' : 'Connect',
        onclick: () => api.connect(gw.id),
      }),
      el('button', {
        className: 'ghost danger',
        textContent: 'Remove',
        onclick: async () => { state = await api.removeGateway(gw.id); render(); },
      }),
    ]);
    host.append(el('div', { className: 'card' }, row));
  }
}

function renderCerts() {
  const host = $('certs');
  host.replaceChildren();
  const hosts = Object.keys(state.trustedCerts || {});

  if (!hosts.length) {
    host.append(el('div', { className: 'card empty', textContent: 'No certificates have been pinned.' }));
    return;
  }

  for (const name of hosts) {
    host.append(el('div', { className: 'card' }, el('div', { className: 'row' }, [
      el('div', { className: 'stack grow' }, [
        el('span', { className: 'name', textContent: name }),
        el('span', { className: 'url', textContent: state.trustedCerts[name] }),
      ]),
      el('button', {
        className: 'ghost danger',
        textContent: 'Forget',
        onclick: async () => { state = await api.forgetCert(name); render(); },
      }),
    ])));
  }
}

function renderPrefs() {
  const s = state.settings;
  $('closeToTray').checked = s.closeToTray;
  $('launchAtLogin').checked = s.launchAtLogin;
  $('startHidden').checked = s.startHidden;
  $('globalShortcut').value = s.globalShortcut || '';
  $('about').textContent =
    `OpenClaw ${state.versions.app} · Electron ${state.versions.electron} · Chromium ${state.versions.chrome} · ${state.configPath}`;
}

function render() {
  renderGateways();
  if (!firstRun) { renderCerts(); renderPrefs(); }
}

function setResult(node, text, kind) {
  node.textContent = text;
  node.className = `result${kind ? ` ${kind}` : ''}`;
}

/* --------------------------------------------------------------- listeners */

$('test').addEventListener('click', async () => {
  const url = $('new-url').value.trim();
  const out = $('test-result');
  if (!url) return setResult(out, 'Enter a URL first.', 'err');

  $('test').disabled = true;
  setResult(out, 'Testing…');
  const res = await api.testGateway(url);
  $('test').disabled = false;
  setResult(out, res.message, res.ok ? (res.fingerprint ? 'warn' : 'ok') : 'err');
});

$('add').addEventListener('click', async () => {
  const url = $('new-url').value.trim();
  const label = $('new-label').value.trim();
  if (!url) return setResult($('test-result'), 'Enter a URL first.', 'err');

  state = await api.addGateway({ label, url });
  $('new-url').value = '';
  $('new-label').value = '';
  setResult($('test-result'), 'Added.', 'ok');
  render();
});

$('save').addEventListener('click', async () => {
  const patch = {
    closeToTray: $('closeToTray').checked,
    launchAtLogin: $('launchAtLogin').checked,
    startHidden: $('startHidden').checked,
    globalShortcut: $('globalShortcut').value.trim(),
  };
  const res = await api.saveSettings(patch);
  state = res;

  const problems = [
    res.shortcut.ok ? null : `the shortcut was rejected (${res.shortcut.error})`,
    res.login.ok ? null : `"open at login" could not be set (${res.login.error})`,
  ].filter(Boolean);

  setResult(
    $('shortcut-result'),
    problems.length ? `Saved, but ${problems.join(', and ')}.` : 'Saved.',
    problems.length ? 'warn' : 'ok',
  );
  render();
});

/* -------------------------------------------------------------------- boot */

(async () => {
  state = await api.getState();
  if (firstRun) {
    $('title').textContent = 'Connect to a gateway';
    $('subtitle').textContent = 'Pick the OpenClaw gateway this app should open, or add your own.';
    $('prefs').hidden = true;
  } else {
    $('prefs').hidden = false;
  }
  render();
})();
