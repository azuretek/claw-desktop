# OpenClaw Desktop

A standalone desktop window for the OpenClaw Control UI — its own icon, its own
Dock/taskbar entry, a tray icon and a global shortcut. Electron, one codebase,
builds for macOS, Windows and Linux.

## Do you actually need this?

Check these first — two of them cost nothing.

| Option | What you get | Cost |
|---|---|---|
| **Install the PWA** (Chrome/Edge → *Install app*) | Own icon and window, **plus Web Push that wakes it when closed** | Zero. The Control UI already ships `manifest.webmanifest` + a service worker |
| **[Windows Hub](https://github.com/openclaw/openclaw-windows-node/releases/latest)** / macOS menu-bar app | Native chat, tray, Command Center, **and node mode** (screen, camera, `system.run`) | Turns the machine into a paired node — a much larger security surface |
| **This app** | Own window, tray, close-to-tray, global hotkey, multiple gateway profiles, no browser dependency | A build step |

Pick the PWA if you mainly want push notifications. Pick Windows Hub if you want
the machine to *be* a node. Pick this if you want the Control UI as a plain app
that is always one keystroke away.

**This app is a viewer only.** It does not run a gateway, does not pair as a node,
and has no access to the host beyond the window it draws.

## Install

Grab the installer for your platform from the repo's
[Releases](https://github.com/azuretek/home_server/releases) page.

- **Windows** — run `OpenClaw-Setup-<version>-<arch>.exe`. Per-user, no admin.
- **macOS** — open the `.dmg` and drag to Applications. The build is **unsigned**,
  so Gatekeeper will refuse it on first launch. Clear the quarantine flag once:

  ```sh
  xattr -dr com.apple.quarantine /Applications/OpenClaw.app
  ```

## First run

1. The setup window lists the gateways from `src/defaults.js`. Pick one, or add
   your own and use **Test connection** to check reachability before committing.
2. Press **Edit** on that gateway and save its token. Get it on the gateway host
   with:

   ```sh
   openclaw gateway auth-token --show
   ```

   The app supplies it on every connect, so the Control UI never asks you to
   paste anything. See [Credentials](#credentials).

Use the tailnet address (`https://<host>.<tailnet>.ts.net`, no port) where you can:
Tailscale Serve terminates a real Let's Encrypt certificate, so it just works. The
`:18789` addresses talk to the gateway's own listener, which is self-signed — see
below.

## Certificates

The gateway generates its own certificate, so any `:18789` address trips a TLS
error. Rather than accepting every bad certificate everywhere — which would make
this app trivially MITM-able — it pins fingerprints:

- First failure for a host raises a prompt showing the fingerprint. Accepting pins
  **that exact fingerprint for that host only**.
- If a pinned host later presents a *different* certificate you get a distinct,
  louder warning that defaults to Cancel. Expected after a gateway reinstall;
  otherwise treat it as hostile.
- Review and revoke pins under **Settings → Trusted certificates**.

## Credentials

Each gateway carries its own saved credentials, set under **Settings → Gateways →
Edit**. The point is that you never hand-paste a token, and never keep one in a
password manager you have to open first.

| Field | How the app applies it |
|---|---|
| **Gateway token** | Handed to the Control UI on the URL fragment as `#token=…`, the [documented handoff](https://docs.openclaw.ai/web/urls). The UI consumes it, stores it for that gateway, and strips it from the address bar. Reapplied on every connect, so it also repairs a stale stored token. |
| **Gateway password** | For gateways in password mode. There is **no** URL handoff for passwords — the Control UI parses only `gatewayUrl`, `token` and `bootstrapToken`, and its docs are explicit that passwords stay in memory only. So the app fills the sign-in form instead. |
| **Extra headers** | Added to every request **to that gateway's origin only**, for Cloudflare Access, a shared-secret header, or an authenticating reverse proxy. |

Storage:

- Values live in `credentials.json` beside `config.json`, encrypted with Electron
  `safeStorage` — the macOS Keychain and Windows DPAPI. `config.json` stays free
  of secrets so it remains safe to open or paste.
- On Linux, `safeStorage` silently degrades to a `basic_text` backend that is
  obfuscation rather than encryption. The app treats that as unavailable and
  refuses to store, rather than pretending. Install `gnome-keyring` or `kwallet`.
- The settings page is **write-only**: it can set or clear a credential and ask
  whether one exists, but there is no IPC channel that returns a value. A bug in
  that page cannot become a disclosure.
- Removing a gateway deletes its credentials and clears its site data.

Two caveats worth knowing:

- **Password autofill is best-effort.** It depends on the Control UI's login-gate
  markup, which is not an API. It fills only empty fields, runs at most once per
  load, and if the gate never appears it does nothing. Token mode is the durable
  path; prefer it.
- **Each gateway gets its own Electron session partition** (`persist:gw-<id>`).
  Device pairing is per browser profile, so a shared partition would make two
  gateways overwrite each other's device identity. The cost is that switching
  gateways recreates the window, and each gateway pairs once on its own.

## Settings

Everything lives in one window (**Cmd/Ctrl+,**, or the tray menu):

- **Gateways** — add, remove, edit, test, switch. Each row shows what the app will
  sign in with. Switching is also in the tray menu.
- **Keep running when the window is closed** — closing hides to the tray. Quit
  from the tray or the app menu. On by default.
- **Open at login** / **Start hidden in the tray**.
- **Global shortcut** — `CommandOrControl+Shift+O` by default. Shows or hides the
  window from anywhere. Clear it to disable.

Config lives at:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/OpenClaw/config.json` |
| Windows | `%APPDATA%\OpenClaw\config.json` |
| Linux | `~/.config/OpenClaw/config.json` |

It is written atomically and holds gateway list, window bounds, preferences, and
pinned certificate fingerprints. **No secrets** — those live encrypted in
`credentials.json` in the same directory (see [Credentials](#credentials)).

## Development

```sh
npm install
npm start                # run from source
npm run pack             # unpacked build into dist/, no installer
npm run build:mac        # dmg + zip (arm64, x64)
npm run build:win        # nsis installer (x64, arm64)
npm run icons            # regenerate PNGs from src/assets/openclaw.svg
```

Icons are **committed** deliberately, so a clean clone builds without `sharp`.
Re-run `npm run icons` only when the artwork changes.

Building Windows installers on macOS needs Wine for resource editing, so build
Windows on Windows. Two ways:

- **On the Windows box directly** — fastest, and costs no CI minutes:

  ```
  gh repo clone azuretek/home_server
  cd home_server\desktop\openclaw-desktop
  npm ci
  npm run build:win
  dist\OpenClaw-Setup-1.0.0-x64.exe /S     :: /S installs silently, per-user
  ```

  It installs to `%LOCALAPPDATA%\Programs\OpenClaw`. Use `gh repo clone` rather
  than `git clone git@…`: Git for Windows ships its own `ssh` that cannot see keys
  held by the Windows OpenSSH agent, so an SSH clone fails with
  `Permission denied (publickey)` even when `ssh -T git@github.com` succeeds.

- **`desktop-release` GitHub Actions workflow** — builds each platform on its own
  runner. Push a `desktop-v*` tag to cut a release, or run it manually for
  artifacts. Note that private-repo minutes bill at 2× for Windows and 10× for
  macOS, so prefer a local build for routine work.

## Known limits

- **No Web Push.** Electron has no push service, so notifications only arrive while
  the app is running. If you need to be woken when it is closed, install the PWA
  alongside this.
- **Unsigned builds.** No Apple Developer ID or Windows code-signing certificate,
  hence the `xattr` step on macOS and a SmartScreen warning on Windows.
- **Not a node.** No screen, camera, or `system.run`. That is Windows Hub's job.

## Layout

```
src/main.js          app lifecycle, window, tray, menus, navigation guards
src/certs.js         trust-on-first-use certificate pinning
src/config.js        atomic JSON config store (no secrets)
src/secrets.js       per-gateway token/password/headers, safeStorage-encrypted
src/defaults.js      suggested gateways and defaults  ← edit for a new machine
src/preload.js       narrow IPC bridge, exposed to local pages only
src/ui/              settings and connection-error pages
scripts/make-icons.mjs
```
