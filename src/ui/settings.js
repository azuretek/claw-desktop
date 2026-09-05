'use strict';

const api = window.clawDesktop;
const params = new URLSearchParams(location.search);
const firstRun = params.has('firstRun');
// This page is the window's own content rather than a dialog over it: a first
// run, or a connection that failed and left nothing behind to go back to.
// Separate from firstRun, which used to imply it — a failed connection shows
// the preferences, a first run hides them.
const asPage = params.has('page');
const $ = (id) => document.getElementById(id);

// Applied before first paint, from the URL rather than from getState(), because
// these decide where the card sits and whether it is a dialog or the window
// itself. Fetched over IPC they land after the first frame and the card jumps.
// (This script is the last element in <body>, so document.body exists.)
if (params.has('frameless')) document.body.classList.add('frameless');
if (asPage) document.body.classList.add('as-page');
if (firstRun) document.body.classList.add('first-run');

let state = null;
// Which gateway's credential editor is open. Kept across re-renders so saving a
// field does not collapse the panel you are working in.
let editing = null;

/* Build DOM nodes rather than assigning innerHTML: labels and URLs are
   user-supplied strings, and this page has no business parsing them as HTML. */
function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function field(labelText, control, hint) {
  return el('div', { className: 'field' }, [
    el('span', { textContent: labelText }),
    control,
    // No inline style attributes anywhere on this page: settings.html sets
    // `style-src 'self'`, which CSP applies to style attributes too.
    hint ? el('div', { className: 'muted-sm hint', textContent: hint }) : null,
  ]);
}

/* ---------------------------------------------------------------- gateways */

// The renderer never receives a stored secret — only whether one exists. So the
// input is always empty, and its placeholder carries the state instead.
function secretRow(gw, { key, title, has, hint }, out) {
  const input = el('input', {
    type: 'password',
    autocomplete: 'off',
    spellcheck: false,
    placeholder: has ? 'Stored — type a new value to replace it' : 'Not set',
  });

  const save = el('button', {
    className: 'primary',
    textContent: 'Save',
    onclick: async () => {
      if (!input.value) return setResult(out, 'Enter a value first.', 'err');
      const res = await api.setCredentials(gw.id, { [key]: input.value });
      state = res;
      input.value = '';
      setResult(out, res.saved.ok ? `${title} saved.` : res.saved.error, res.saved.ok ? 'ok' : 'err');
      render();
    },
  });

  const clear = el('button', {
    className: 'ghost danger',
    textContent: 'Clear',
    disabled: !has,
    onclick: async () => {
      const res = await api.setCredentials(gw.id, { [key]: '' });
      state = res;
      setResult(out, res.saved.ok ? `${title} cleared.` : res.saved.error, res.saved.ok ? 'ok' : 'err');
      render();
    },
  });

  return el('div', {}, [
    field(`${title}${has ? ' · stored' : ''}`, input, hint),
    el('div', { className: 'row' }, [el('span', { className: 'grow' }), save, clear]),
  ]);
}

function headerSection(gw, out) {
  const names = (gw.credentials && gw.credentials.headers) || [];
  const list = el('div', {}, names.length
    ? names.map((name) => el('div', { className: 'row' }, [
      el('span', { className: 'url grow', textContent: `${name}: ••••••••` }),
      el('button', {
        className: 'ghost danger',
        textContent: 'Remove',
        onclick: async () => {
          const res = await api.removeHeader(gw.id, name);
          state = res;
          setResult(out, res.saved.ok ? `Removed ${name}.` : res.saved.error, res.saved.ok ? 'ok' : 'err');
          render();
        },
      }),
    ]))
    : el('div', { className: 'muted-sm', textContent: 'No extra headers.' }));

  const name = el('input', { type: 'text', placeholder: 'CF-Access-Client-Id', autocomplete: 'off', spellcheck: false });
  const value = el('input', { type: 'password', placeholder: 'value', autocomplete: 'off', spellcheck: false });

  const add = el('button', {
    textContent: 'Add header',
    onclick: async () => {
      if (!name.value.trim()) return setResult(out, 'Enter a header name.', 'err');
      const res = await api.addHeader(gw.id, name.value, value.value);
      state = res;
      if (res.saved.ok) { name.value = ''; value.value = ''; }
      setResult(out, res.saved.ok ? 'Header saved.' : res.saved.error, res.saved.ok ? 'ok' : 'err');
      render();
    },
  });

  return el('div', {}, [
    el('div', { className: 'field' }, [
      el('span', { textContent: 'Extra request headers' }),
      list,
      el('div', {
        className: 'muted-sm hint',
        textContent: 'Sent only to this gateway’s own origin. Use for Cloudflare Access or an authenticating reverse proxy.',
      }),
    ]),
    el('div', { className: 'row' }, [name, value, add]),
  ]);
}

function gatewayEditor(gw) {
  const out = el('div', { className: 'result' });
  const creds = gw.credentials || { hasToken: false, hasPassword: false, headers: [] };

  const label = el('input', { type: 'text', value: gw.label || '', placeholder: 'Name', autocomplete: 'off' });
  const url = el('input', { type: 'url', value: gw.url, autocomplete: 'off', spellcheck: false });

  const saveAddress = el('button', {
    className: 'primary',
    textContent: 'Save address',
    onclick: async () => {
      if (!url.value.trim()) return setResult(out, 'Enter a URL first.', 'err');
      state = await api.updateGateway(gw.id, { label: label.value.trim(), url: url.value.trim() });
      setResult(out, 'Saved. Reconnect to use the new address.', 'ok');
      render();
    },
  });

  return el('div', { className: 'editor' }, [
    field('Name', label),
    field('URL', url),
    el('div', { className: 'row' }, [el('span', { className: 'grow' }), saveAddress]),
    el('hr'),
    secretRow(gw, {
      key: 'token',
      title: 'Gateway token',
      has: creds.hasToken,
      hint: 'Handed to the Control UI on connect, so you are never asked to paste it. From `openclaw gateway auth-token --show` on that gateway.',
    }, out),
    secretRow(gw, {
      key: 'password',
      title: 'Gateway password',
      has: creds.hasPassword,
      hint: 'Only for gateways in password mode. There is no URL handoff for passwords, so the app fills the sign-in form instead — best effort.',
    }, out),
    el('hr'),
    headerSection(gw, out),
    out,
  ]);
}

function renderGateways() {
  const host = $('gateways');
  host.replaceChildren();

  if (state.secretsError) {
    host.append(el('div', { className: 'card' }, el('div', { className: 'result err', textContent: state.secretsError })));
  }

  if (!state.gateways.length) {
    host.append(el('div', { className: 'card empty', textContent: 'No gateways yet — add one below.' }));
    return;
  }

  for (const gw of state.gateways) {
    const active = gw.id === state.activeGatewayId;
    const open = editing === gw.id;
    const creds = gw.credentials || { hasToken: false, hasPassword: false, headers: [] };

    // A one-line summary of what the app will supply, so the list answers
    // "why is this one still asking me to sign in?" without opening the editor.
    const supplies = [
      creds.hasToken ? 'token' : null,
      creds.hasPassword ? 'password' : null,
      creds.headers.length ? `${creds.headers.length} header${creds.headers.length > 1 ? 's' : ''}` : null,
    ].filter(Boolean);

    // What this gateway is doing, and why it is not doing it. The badge used to
    // say "Connected" for whichever gateway was *selected*, which was a lie for
    // the entire time a connection was failing — the state in which someone is
    // most likely to be reading it.
    const status = gw.status || { tone: 'muted', label: 'Not connected', detail: null };

    const row = el('div', { className: 'row' }, [
      el('div', { className: 'stack grow' }, [
        el('span', { className: 'name', textContent: gw.label || gw.url }),
        el('span', { className: 'url', textContent: gw.url }),
        el('span', {
          className: 'muted-sm',
          textContent: supplies.length ? `Signs in with: ${supplies.join(', ')}` : 'No saved credentials — you will be asked to sign in.',
        }),
        status.detail ? el('span', { className: `result ${status.tone}`, textContent: status.detail }) : null,
      ]),
      el('span', { className: `badge badge--${status.tone}`, textContent: status.label }),
      el('button', {
        className: active ? 'ghost' : 'primary',
        textContent: active ? 'Reconnect' : 'Connect',
        onclick: () => api.connect(gw.id),
      }),
      el('button', {
        className: 'ghost',
        textContent: open ? 'Done' : 'Edit',
        onclick: () => { editing = open ? null : gw.id; render(); },
      }),
      el('button', {
        className: 'ghost danger',
        textContent: 'Remove',
        onclick: async () => {
          if (editing === gw.id) editing = null;
          state = await api.removeGateway(gw.id);
          render();
        },
      }),
    ]);

    host.append(el('div', { className: 'card' }, [row, open ? gatewayEditor(gw) : null]));
  }
}

/* ------------------------------------------------------------------- other */

/**
 * Certificates refused this session, waiting for a decision.
 *
 * This is the whole reason there is no certificate prompt any more. The
 * fingerprints are here to be compared rather than dismissed, nothing is
 * blocked on the answer, and doing nothing leaves the connection refused —
 * which is the safe outcome, unlike a modal whose easiest button is "yes".
 */
function renderCertOffers() {
  const host = $('cert-offers');
  host.replaceChildren();
  const offers = state.certOffers || [];
  if (!offers.length) return;

  // Its own heading rather than the static one below, because this block sits
  // above Gateways and only exists while something is waiting.
  host.append(el('h2', { textContent: offers.length > 1 ? 'Certificates to review' : 'Certificate to review' }));

  for (const offer of offers) {
    const out = el('div', { className: 'result' });

    // A first sighting is routine on a :18789 address. A *changed* fingerprint
    // on a host that was trusted before is the case worth alarming about, and
    // the two must not look alike.
    const heading = offer.changed
      ? el('div', { className: 'result err', textContent: `The certificate for ${offer.host} has CHANGED since it was trusted.` })
      : el('div', { className: 'result warn', textContent: `${offer.host} is using a certificate this app cannot verify.` });

    const explain = el('div', {
      className: 'muted-sm hint',
      textContent: offer.changed
        ? 'Expected if the gateway was reinstalled or regenerated its certificate. If nothing like that happened, '
          + 'something is intercepting the connection — leave it refused.'
        : 'The OpenClaw gateway generates its own certificate, so this is normal when you connect straight to its '
          + 'listener (an address ending in :18789) instead of going through the Tailscale Serve address.',
    });

    const fingerprints = el('div', { className: 'stack' }, [
      offer.previous ? el('span', { className: 'url', textContent: `previously trusted  ${offer.previous}` }) : null,
      el('span', { className: 'url', textContent: `${offer.previous ? 'now presenting     ' : 'fingerprint  '}${offer.fingerprint}` }),
      offer.error ? el('span', { className: 'muted-sm', textContent: `Reason: ${offer.error}` }) : null,
    ]);

    const trust = el('button', {
      className: 'primary',
      textContent: offer.changed ? 'Trust the new certificate' : 'Trust this certificate',
      onclick: async () => {
        const res = await api.trustCert(offer.host);
        state = res;
        setResult(out, res.trusted ? `Pinned. Reconnecting to ${offer.host}…` : 'That certificate is no longer being offered.', res.trusted ? 'ok' : 'warn');
        render();
      },
    });

    const dismiss = el('button', {
      className: 'ghost',
      textContent: 'Not now',
      onclick: async () => { state = await api.dismissCertOffer(offer.host); render(); },
    });

    host.append(el('div', { className: 'card' }, [
      heading,
      explain,
      fingerprints,
      el('div', { className: 'row' }, [el('span', { className: 'grow' }), dismiss, trust]),
      out,
    ]));
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

  // A build that could never install an update has nothing to switch on, so the
  // checkbox says why instead of sitting there doing nothing when clicked —
  // which is what an unsigned macOS build or a non-AppImage Linux run gets.
  const canInstall = !state.updates || state.updates.canInstall;
  $('autoUpdate').checked = s.autoUpdate && canInstall;
  $('autoUpdate').disabled = !canInstall;
  if (!canInstall) {
    $('autoUpdate-hint').textContent =
      `This build cannot install its own updates — ${state.updates.reason}. It will still tell you when a new version exists.`;
  }
}

// `state.build` already reads as "1.0.0 (a1b2c3d4e5, built …)" — the main
// process formats it, because this page is sandboxed and cannot require the
// module that knows the rules.
function renderAbout() {
  $('about').textContent =
    `Claw Desktop ${state.build} · Electron ${state.versions.electron} · Chromium ${state.versions.chrome} · ${state.configPath}`;
}

/** The subtitle carries the reason this page is on screen, when there is one. */
function renderHeading() {
  if (firstRun) return;
  // The phase, not the badge: a refused certificate shows as a *warning* on the
  // row, because it is routine on a self-signed listener — but the connection
  // failed all the same, and that is why this page is in front of you.
  const failed = state.connection && state.connection.phase === 'failed';
  if (asPage && failed) {
    $('title').textContent = 'Cannot reach the gateway';
    $('subtitle').textContent = 'Claw Desktop came back here so you can fix it. The gateway that failed is marked below.';
  } else {
    $('title').textContent = 'Settings';
    $('subtitle').textContent = 'Choose which gateway this app connects to.';
  }
}

function render() {
  renderHeading();
  renderGateways();
  renderAbout();
  if (!firstRun) { renderCertOffers(); renderCerts(); renderPrefs(); }
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
  setResult($('test-result'), 'Added. Use Edit to save its token, password, or headers.', 'ok');
  render();
});

$('save').addEventListener('click', async () => {
  const patch = {
    closeToTray: $('closeToTray').checked,
    launchAtLogin: $('launchAtLogin').checked,
    startHidden: $('startHidden').checked,
    // Never write false just because the checkbox is disabled: a Linux user who
    // once ran the unpacked binary would come back to their AppImage with the
    // preference silently turned off.
    ...($('autoUpdate').disabled ? {} : { autoUpdate: $('autoUpdate').checked }),
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

/* ----------------------------------------------------------------- dismiss */

// Only dismissable as a modal. When this page IS the window — a first run, or a
// connection that failed — there is nothing behind it to go back to, and an
// Escape key that emptied the window would leave the app running with a blank
// frame and no way to pick a gateway.
if (!asPage) {
  const dismiss = () => api.closeSettings();
  $('close').addEventListener('click', dismiss);
  // Only a click that both starts and ends on the scrim counts. Without the
  // target check, releasing the mouse outside the card after selecting text
  // inside it closes the dialog and throws away what you were doing.
  $('scrim').addEventListener('mousedown', (e) => {
    if (e.target !== e.currentTarget) return;
    const up = (ev) => { if (ev.target === e.currentTarget) dismiss(); };
    $('scrim').addEventListener('mouseup', up, { once: true });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismiss();
  });
}

/* -------------------------------------------------------------------- boot */

// A certificate refused while this page is open — which is exactly what
// pressing Reconnect from in here does — has to appear without the page being
// closed and reopened. The snapshot this renders from is otherwise as old as
// the dialog.
api.onStateChanged(async () => {
  state = await api.getState();
  render();
});

(async () => {
  state = await api.getState();
  if (firstRun) {
    $('title').textContent = 'Connect to a gateway';
    $('subtitle').textContent = 'Pick the OpenClaw gateway this app should open, or add your own.';
  }
  // Preferences are hidden only on a first run, where there is nothing to
  // prefer yet. A failed connection shows the whole page: the setting that
  // needs changing to fix it could be any of them.
  $('prefs').hidden = firstRun;
  $('close').hidden = asPage;
  render();
})();
