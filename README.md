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

---

# Setup

## 1. Get the app

**From a release** — take the installer for your platform from
[Releases](https://github.com/azuretek/claw-desktop/releases):

- **Windows** — `ClawDesktop-Setup-<version>-<arch>.exe`. Per-user, no admin.
- **macOS** — open the `.dmg` and drag to Applications.

**Or build it** — needed if no release covers your platform, and how the app is
kept current on a machine you already develop on:

```sh
git clone https://github.com/azuretek/claw-desktop.git
cd claw-desktop
npm ci
npm run build:mac        # or build:win / build:linux
```

The installer lands in `dist/`. Build on the platform you are targeting —
Windows installers cannot be cross-built without Wine.

### After installing

- **macOS** — builds are **unsigned**, so clear the quarantine flag once,
  otherwise Gatekeeper refuses to open it:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Claw Desktop.app"
  ```

- **Windows** — SmartScreen will warn for the same reason. *More info → Run
  anyway.* Installs to `%LOCALAPPDATA%\Programs\Claw Desktop`.

- **Upgrading from the old *OpenClaw*-named build** — quit it first, then
  uninstall it: the `appId` changed, so the installer will not replace it. Your
  profile, credentials and paired device identity move across automatically on
  first launch ([src/profile.js](src/profile.js)).

## 2. Connect to a gateway

The setup window opens on first launch.

1. Pick a suggested gateway, or **Add** your own. **Test connection** checks
   reachability before you commit to it.
2. Press **Edit** on that gateway and save its token. Get one on the gateway
   host with:

   ```sh
   openclaw gateway auth-token --show
   ```

   The app supplies it on every connect, so the Control UI never asks you to
   paste anything.

3. Press **Connect**.

**Which address to use.** Prefer the tailnet name
(`https://<host>.<tailnet>.ts.net`, no port) — Tailscale Serve terminates a real
certificate and it simply works. A `:18789` address talks to the gateway's own
listener, which is self-signed, so the first connection raises a prompt showing
the certificate fingerprint. Accepting pins **that exact fingerprint for that
host alone**; a pinned host later presenting a different certificate raises a
louder warning that defaults to Cancel. Review and revoke under **Settings →
Trusted certificates**.

## 3. Set your preferences

**Settings** is one window — **Cmd/Ctrl+,**, or the tray menu.

- **Gateways** — add, remove, edit, test, switch. Switching is also on the tray.
- **Keep running when the window is closed** — on by default; closing hides to
  the tray and you quit from there.
- **Open at login** / **Start hidden in the tray** — together, the app is
  waiting in the tray from boot.
- **Global shortcut** — `CommandOrControl+Shift+O` by default, shows or hides
  the window from anywhere. Clear the field to disable.

## 4. Know where your data lives

| Platform | Directory |
|---|---|
| macOS | `~/Library/Application Support/Claw Desktop/` |
| Windows | `%APPDATA%\Claw Desktop\` |
| Linux | `~/.config/Claw Desktop/` |

- `config.json` — gateway list, window bounds, preferences, pinned certificate
  fingerprints. Written atomically, and **holds no secrets**, so it is safe to
  open, copy or paste.
- `credentials.json` — tokens, passwords and headers, encrypted with Electron
  `safeStorage` (macOS Keychain, Windows DPAPI).

On Linux `safeStorage` degrades to plain obfuscation rather than encryption; the
app treats that as unavailable and refuses to store, rather than pretending.
Install `gnome-keyring` or `kwallet` first.

---

# Features

## Saved credentials

Set per gateway under **Settings → Gateways → Edit**, so you never hand-paste a
token or keep one in a password manager you have to open first.

| Field | How it is applied |
|---|---|
| **Gateway token** | Handed to the Control UI on the URL fragment as `#token=…`, the [documented handoff](https://docs.openclaw.ai/web/urls). Reapplied on every connect, so it also repairs a stale stored token. |
| **Gateway password** | No URL handoff exists for passwords, so the app fills the sign-in form. Best-effort: it reads the login gate's markup, which is not an API, and fails soft. Prefer token mode. |
| **Extra headers** | Sent to that gateway's origin only — for Cloudflare Access, a shared secret, or an authenticating proxy. |

The settings page is **write-only**: it can set or clear a credential and ask
whether one exists, but no IPC channel returns a value, so a bug there cannot
become a disclosure.

## Window chrome

Frameless on macOS and Windows: the app's colour runs to the top edge, and the
window buttons sit on a 36px strip the app draws for itself, carrying the
current session's name. They are the OS's real buttons — traffic lights, Windows
caption buttons — so snap layouts and tooltips keep working and the window can
never become unclosable.

The page loads into a view that *starts below* the strip, so nothing it draws
can land under the buttons, and **the app injects nothing into the gateway page
at all** — no marker classes, no drag regions, no insets, and so no dependency
on upstream markup. Linux keeps its normal frame.

Colours are read back off the page rather than assumed, so the caption strip,
window background and the app's own pages follow whichever Control UI theme is
active, light or dark. The mode is remembered, so a cold start opens in the
right palette instead of flashing the wrong one. Both mechanisms are documented
at length in [src/chrome.js](src/chrome.js).

## Recovering a stale UI

The Control UI is a PWA whose service worker serves `/assets/` cache-first. This
app closes to the tray rather than quitting, so a document can sit for weeks
without the navigation that would re-check `sw.js` — leaving the app showing an
older Control UI than the gateway is serving. Three ways out:

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

## Which build am I running?

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

## Known limits

- **No Web Push.** Electron has no push service, so notifications arrive only
  while the app runs. Install the PWA alongside if you need waking when closed.
- **Unsigned builds.** No Apple Developer ID or Windows signing certificate —
  hence the `xattr` step and the SmartScreen warning.
- **Auto-update is Windows-only.** See below — it is a signing limit, not a
  configuration gap.
- **Not a node.** No screen, camera, or `system.run`. That is Windows Hub's job.

## Updates

The app checks for a new release a minute after launch and every six hours
after, and on demand from **Check for updates…** on the File (or app) menu.
What it does with one depends on the platform, because installing an update
requires a signed build on macOS and does not on Windows:

| Platform | Behaviour | Why |
|---|---|---|
| **Windows** | Downloads in the background, then offers **Restart to update** — in a dialog and on the tray menu | `NsisUpdater` skips signature verification when the build has no `publisherName`, so an unsigned build updates normally |
| **macOS** | Tells you a release exists and links to it; you replace the app by hand | `MacUpdater` hands off to native Squirrel.Mac, which requires a valid signature on the running bundle and fails with `Could not get code signature for running application` |
| **Linux** | Same as macOS | AppImage updates work in principle, but the app is not distributed that way and the path is untested |

Automatic checks are silent unless there is something to act on; a manual check
always answers, including "you are up to date". A failed check — offline, proxy,
rate limit — is logged and never interrupts you.

macOS becomes the same as Windows the moment builds are signed: set
`MAC_SIGNED = true` in [src/updates.js](src/updates.js). That is the only code
change; the rest is credentials.

### Enabling signed builds

Nothing in the repo forces an unsigned build — there is no `identity: null`. The
standard electron-builder behaviour applies: sign if an identity is
discoverable, warn and continue if not.

- **macOS** — an [Apple Developer Program](https://developer.apple.com/programs/)
  membership ($99/year) is required for a *Developer ID Application*
  certificate; without one, notarization is rejected too. Install the
  certificate in the keychain (or set `CSC_LINK` + `CSC_KEY_PASSWORD` in CI),
  set `notarize: true` in `electron-builder.yml`, and provide `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Notarization also needs
  `hardenedRuntime`. CI currently sets `CSC_IDENTITY_AUTO_DISCOVERY: false` so a
  runner cannot pick up a stray identity — remove that when signing.
- **Windows** — only removes the SmartScreen warning; it is **not** needed for
  auto-update. [Azure Artifact Signing](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/)
  (formerly Trusted Signing) is $9.99/month and open to individual developers,
  though identity validation is currently US/Canada only. A traditional OV
  certificate costs more and requires a hardware token.

---

# Contributing

```sh
npm install
npm test                 # unit tests, no Electron needed
npm start                # run from source
npm run pack             # unpacked build into dist/, no installer
npm run build:mac        # dmg + zip (arm64, x64)
npm run build:win        # nsis installer (x64, arm64)
npm run icons            # regenerate PNGs from src/assets/claw*.svg
npm run release          # bump, tag, push; CI publishes — see .release-it.cjs
```

Icons are committed so a clean clone builds without `sharp`; re-run `npm run
icons` only when the artwork changes. The artwork is original — neither file is
derived from OpenClaw's mascot or any other upstream brand asset.

**Building for Windows** takes roughly half an hour on a recent laptop, and must
happen on Windows (cross-building needs Wine for resource editing). `--x64` does
not shorten it: the per-target `arch` list in `electron-builder.yml` wins over
the CLI flag. Use `gh repo clone`, not `git clone git@…` — Git for Windows ships
its own `ssh` that cannot see keys held by the Windows OpenSSH agent. Install a
built installer silently with `/S`.

## Builds and releases

CI builds on three triggers, and they mean different things:

| Trigger | Produces | Where it goes |
|---|---|---|
| **Push to `main`** | Dev build, `1.0.0-dev.<sha>` | Actions artifacts, 7 days |
| **Tag `v*`** | Release, `1.0.0` | Published to [Releases](https://github.com/azuretek/claw-desktop/releases), permanent |
| **Manual dispatch** | Dev build of any ref | Actions artifacts, 7 days |

Docs-only pushes are skipped (`paths-ignore`), and pushing several commits in a
row cancels the superseded runs — except tag builds, which are never cancelled.

**Cutting a release** is `npm run release [patch|minor|major]`. It bumps
`package.json` and the lockfile, commits, tags, and pushes; CI does the rest. It
refuses, with nothing written, off `main`, on a dirty tree, without an upstream,
or on failing tests.

**Never bump the version by hand** — `artifactName` interpolates it, so a
hand-pushed tag can publish a release named `v1.1.0` full of
`…-1.0.0-x64.exe`. CI's `version` job refuses that before either build starts.

That same job also decides *whether* to build. `git push --follow-tags` sends
the release commit and its tag together, and GitHub raises a separate event for
each — so the branch run stands down and lets the tag run publish, rather than
building identical code twice and uploading a misleadingly named dev copy
beside the release. A manual dispatch is always honoured.

## Layout

```
src/main.js          app lifecycle, window, tray, menus, navigation guards
src/chrome.js        title strip geometry + theme adopted from the page
src/cache.js         drops the Control UI's cached copy of itself, never its storage
src/certs.js         trust-on-first-use certificate pinning
src/secrets.js       per-gateway token/password/headers, safeStorage-encrypted
src/config.js        atomic JSON config store (no secrets)
src/overlay.js       supervises the settings overlay so it cannot wedge the window
src/updates.js       per-platform update policy (install, notify, or neither)
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
