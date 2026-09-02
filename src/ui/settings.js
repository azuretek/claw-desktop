'use strict';

const api = window.openclaw;
const firstRun = new URLSearchParams(location.search).has('firstRun');
const $ = (id) => document.getElementById(id);

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

    const row = el('div', { className: 'row' }, [
      el('div', { className: 'stack grow' }, [
        el('span', { className: 'name', textContent: gw.label || gw.url }),
        el('span', { className: 'url', textContent: gw.url }),
        el('span', {
          className: 'muted-sm',
          textContent: supplies.length ? `Signs in with: ${supplies.join(', ')}` : 'No saved credentials — you will be asked to sign in.',
        }),
      ]),
      active ? el('span', { className: 'badge', textContent: 'Connected' }) : null,
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
  setResult($('test-result'), 'Added. Use Edit to save its token, password, or headers.', 'ok');
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
