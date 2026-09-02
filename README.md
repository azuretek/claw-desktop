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
2. The Control UI then asks for the gateway token — the same prompt you would get
   in a fresh browser. Get it on the gateway host with:

   ```sh
   openclaw gateway auth-token --show
   ```

   It is stored in this app's own profile, so you only do this once per machine.

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

## Settings

Everything lives in one window (**Cmd/Ctrl+,**, or the tray menu):

- **Gateways** — add, remove, test, switch. Switching is also in the tray menu.
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
pinned certificate fingerprints. No secrets: the gateway token is held by the
Control UI in the Electron profile, exactly as a browser would.

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

Building Windows installers on macOS needs Wine for resource editing. The
supported path is the `desktop-release` GitHub Actions workflow, which builds each
platform on its own runner — push a `desktop-v*` tag and collect the artifacts.

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
src/config.js        atomic JSON config store
src/defaults.js      suggested gateways and defaults  ← edit for a new machine
src/preload.js       narrow IPC bridge, exposed to local pages only
src/ui/              settings and connection-error pages
scripts/make-icons.mjs
```
