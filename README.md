# Claw Desktop

A standalone desktop window for the OpenClaw Control UI — its own icon, its own
Dock/taskbar entry, a tray icon and a global shortcut. Electron, one codebase,
builds for macOS, Windows and Linux.

**Viewer only.** It does not run a gateway, does not pair as a node, and has no
access to the host beyond the window it draws.

## Do you actually need this?

| Option | What you get | Cost |
|---|---|---|
| **Install the PWA** (Chrome/Edge → *Install app*) | Own icon and window, **plus Web Push that wakes it when closed** | Zero — the Control UI already ships a manifest and service worker |
| **[Windows Hub](https://github.com/openclaw/openclaw-windows-node/releases/latest)** / macOS menu-bar app | Native chat, tray, Command Center, **and node mode** (screen, camera, `system.run`) | Turns the machine into a paired node — a much larger security surface |
| **This app** | Own window, tray, close-to-tray, global hotkey, multiple gateway profiles, no browser dependency | A build step |

Pick the PWA for push notifications. Pick Windows Hub to make the machine a
node. Pick this for the Control UI as a plain app that is always one keystroke
away.

## Install

From the [Releases](https://github.com/azuretek/claw-desktop/releases) page:

- **Windows** — run `ClawDesktop-Setup-<version>-<arch>.exe`. Per-user, no admin.
- **macOS** — open the `.dmg` and drag to Applications. Builds are **unsigned**,
  so clear the quarantine flag once:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Claw Desktop.app"
  ```

Upgrading from the old *OpenClaw*-named build: quit it first, then uninstall it
— the `appId` changed, so the installer will not replace it. Your profile,
credentials and paired device identity move across automatically on first launch
([src/profile.js](src/profile.js)).

## First run

1. Pick a gateway from the list, or add your own and use **Test connection**.
2. Press **Edit** and save its token, from `openclaw gateway auth-token --show`
   on the gateway host.

Prefer the tailnet address (`https://<host>.<tailnet>.ts.net`, no port) —
Tailscale Serve terminates a real certificate. The `:18789` addresses are
self-signed and go through certificate pinning below.

## Features

### Credentials

Each gateway carries its own, set under **Settings → Gateways → Edit**, so you
never hand-paste a token.

| Field | How it is applied |
|---|---|
| **Gateway token** | Handed to the Control UI on the URL fragment as `#token=…`, the [documented handoff](https://docs.openclaw.ai/web/urls). Reapplied on every connect, so it also repairs a stale stored token. |
| **Gateway password** | No URL handoff exists for passwords, so the app fills the sign-in form. Best-effort: it reads the login gate's markup, which is not an API, and fails soft. Prefer token mode. |
| **Extra headers** | Sent to that gateway's origin only — for Cloudflare Access, a shared secret, or an authenticating proxy. |

Stored in `credentials.json`, encrypted with Electron `safeStorage` (macOS
Keychain, Windows DPAPI). `config.json` holds no secrets. The settings page is
**write-only** — it can set or clear a credential and ask whether one exists,
but no IPC channel returns a value.

On Linux `safeStorage` degrades to plain obfuscation; the app treats that as
unavailable and refuses to store rather than pretending. Install
`gnome-keyring` or `kwallet`.

### Certificate pinning

Trust-on-first-use for self-signed gateways. The first failure for a host shows
its fingerprint and pins that exact fingerprint for that host alone. A pinned
host later presenting a different certificate raises a louder warning that
defaults to Cancel. Review and revoke under **Settings → Trusted certificates**.

### Window chrome

Frameless on macOS and Windows: the app's colour runs to the top edge, and the
window buttons sit on a 36px strip the app draws for itself, carrying the
current session's name. They are the OS's real buttons — traffic lights,
Windows caption buttons — so snap layouts and tooltips keep working and the
window can never become unclosable.

The page loads into a view that *starts below* the strip, so nothing it draws
can land under the buttons, and **the app injects nothing into the gateway page
at all** — no marker classes, no drag regions, no insets, and so no dependency
on upstream markup. Linux keeps its normal frame.

Colours are read back off the page rather than assumed, so the caption strip,
window background and the app's own pages follow whichever of the Control UI's
themes is active, light or dark. The mode is remembered, so a cold start opens
in the right palette instead of flashing the wrong one.

Both mechanisms are documented at length in [src/chrome.js](src/chrome.js).

### Stale UI after an upgrade

The Control UI is a PWA whose service worker serves `/assets/` cache-first. This
app closes to the tray rather than quitting, so a document can sit for weeks
without the navigation that would re-check `sw.js` — leaving the app showing an
older Control UI than the gateway is serving.

Three ways out:

- **Gateway upgraded** — the app compares the build id in `sw.js` against the
  one recorded for that gateway and, if it moved, drops the caches and reloads
  once, automatically.
- **App upgraded** — the first run after a new build clears them before
  anything loads.
- **Neither** — **File → Clear cache and reload**, also on the tray menu
  (Windows auto-hides the menu bar behind Alt, exactly when you want this).

All three drop the service worker, its Cache Storage, and the HTTP and
compiled-code caches — and **never** cookies, localStorage or IndexedDB. That
boundary is load-bearing: the paired device identity lives in origin storage, so
clearing it would make the Gateway report a login from an unrecognised device.
[src/cache.js](src/cache.js) keeps the two apart and `test/cache.test.js`
asserts it.

### Settings

One window, **Cmd/Ctrl+,** or the tray menu.

- **Gateways** — add, remove, edit, test, switch. Switching is also on the tray.
- **Keep running when the window is closed** — on by default; quit from the tray.
- **Open at login** / **Start hidden in the tray**.
- **Global shortcut** — `CommandOrControl+Shift+O` by default. Clear to disable.

Config lives beside the credentials, written atomically:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Claw Desktop/config.json` |
| Windows | `%APPDATA%\Claw Desktop\config.json` |
| Linux | `~/.config/Claw Desktop/config.json` |

### Which build am I running?

The line at the bottom of Settings names the commit the app was packaged from,
during first-run setup as well as afterwards:

```
Claw Desktop 1.0.0 (a1b2c3d4e5, built 2026-09-02 08:41Z) · Electron 44.1.1 · …
```

| Shown | Means |
|---|---|
| `1.0.0 (a1b2c3d4e5, …)` | packaged from that commit on `main` |
| `1.0.0 (fix-clicks a1b2c3d4e5, …)` | built from a branch — named, because that is the surprising case |
| `1.0.0 (a1b2c3d4e5-dirty, …)` | uncommitted changes; the hash does **not** describe what shipped |
| `1.0.0-dev.a1b2c3d4e5 (…)` | a CI dev build, versioned for its commit |
| `1.0.0 (source build)` | `npm start`, which has no single commit to claim |

## Development

```sh
npm install
npm test                 # unit tests, no Electron needed
npm start                # run from source
npm run pack             # unpacked build into dist/, no installer
npm run build:mac        # dmg + zip (arm64, x64)
npm run build:win        # nsis installer (x64, arm64)
npm run icons            # regenerate PNGs from src/assets/claw*.svg
```

Icons are committed so a clean clone builds without `sharp`; re-run `npm run
icons` only when the artwork changes. The artwork is original — neither file is
derived from OpenClaw's mascot or any other upstream brand asset.

Windows installers need Wine to cross-build, so build them on Windows:

```
gh repo clone azuretek/claw-desktop     :: not git clone git@… — Git for Windows
cd claw-desktop                         :: ships an ssh that cannot see the
npm ci                                  :: Windows OpenSSH agent's keys
npm run build:win
dist\ClawDesktop-Setup-<version>-x64.exe /S     :: silent, per-user
```

Roughly half an hour on a recent laptop. `--x64` does not shorten it — the
per-target `arch` list in `electron-builder.yml` wins over the CLI flag. Or run
the `release` workflow, which builds each platform on its own runner.

## Releasing

```sh
npm run release                 # asks for the bump
npm run release -- patch        # 1.0.0 -> 1.0.1
npm run release -- minor
npm run release -- patch --dry-run
```

[release-it](https://github.com/release-it/release-it) bumps `package.json` and
the lockfile, commits, tags `vX.Y.Z`, and pushes; CI then builds both platforms
and publishes a GitHub Release with the installers attached. It refuses, with
nothing written, if you are not on `main`, the tree is dirty, the branch has no
upstream, or the tests fail. See [.release-it.cjs](.release-it.cjs).

**Do not bump the version by hand.** `artifactName` interpolates `${version}`
from `package.json`, so a hand-pushed tag can publish a release named `v1.1.0`
containing `ClawDesktop-Setup-1.0.0-x64.exe`. CI's `version` job refuses that
before either build starts.

Running the workflow manually produces a **dev build**, versioned for its commit
(`ClawDesktop-Setup-1.0.0-dev.758853d656-x64.exe`) so two of them are never
named the same. Dev builds are never published.

## Known limits

- **No Web Push.** Electron has no push service, so notifications arrive only
  while the app runs. Install the PWA alongside if you need waking when closed.
- **Unsigned builds.** No Apple Developer ID or Windows signing certificate —
  hence the `xattr` step and a SmartScreen warning.
- **No auto-update yet.** Releases already carry the metadata for it
  (`latest.yml`, `latest-mac.yml`, `.blockmap`s). Adding
  [electron-updater](https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater)
  would work on **Windows only**: `NsisUpdater` skips signature verification
  when the build has no `publisherName`, but macOS hands off to Squirrel.Mac,
  which requires a signed bundle and fails with `Could not get code signature
  for running application`. macOS could only be told a release exists.
- **Not a node.** No screen, camera, or `system.run`. That is Windows Hub's job.

## Layout

```
src/main.js          app lifecycle, window, tray, menus, navigation guards
src/chrome.js        title strip geometry + theme adopted from the page
src/cache.js         drops the Control UI's cached copy of itself, never its storage
src/certs.js         trust-on-first-use certificate pinning
src/secrets.js       per-gateway token/password/headers, safeStorage-encrypted
src/config.js        atomic JSON config store (no secrets)
src/overlay.js       supervises the settings overlay so it cannot wedge the window
src/build-info.js    reads the packed-in commit; formats the Settings build line
src/profile.js       one-time profile move for the OpenClaw -> Claw Desktop rename
src/defaults.js      suggested gateways and defaults  ← edit for a new machine
src/preload.js       narrow IPC bridge, exposed to local pages only
src/ui/              settings and connection-error pages
scripts/build-info.js    stamps the commit in at pack time (beforePack hook)
scripts/version.js       CI build versioning + tag/package.json agreement
scripts/build-version.js decides the version a CI build carries
scripts/make-icons.mjs   regenerates the icon PNGs from the SVG artwork
```

## Status and licence

A personal project, shared because it might be useful — not a product. No
support commitment, no release schedule, unsigned builds. Issues and pull
requests are welcome; slow replies are likely.

**Not affiliated with the OpenClaw project.** This is an independent client for
its Control UI.

MIT — see [LICENSE](LICENSE).
