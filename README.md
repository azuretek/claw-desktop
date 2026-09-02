# Claw Desktop

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
[Releases](https://github.com/azuretek/claw-desktop/releases) page.

- **Windows** — run `ClawDesktop-Setup-<version>-<arch>.exe`. Per-user, no admin.
- **macOS** — open the `.dmg` and drag to Applications. The build is **unsigned**,
  so Gatekeeper will refuse it on first launch. Clear the quarantine flag once:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Claw Desktop.app"
  ```

### Upgrading from the "OpenClaw"-named build

This app was called *OpenClaw* until it was renamed to **Claw Desktop**. Two
consequences:

- **The profile moves with you.** `productName` is what Electron derives the
  profile directory from, so a rename repoints it at an empty one. On first
  launch the app moves the old directory across (`OpenClaw` → `Claw Desktop`),
  keeping the gateway list, the encrypted credentials, and — the one that bites
  — the paired device identity, so the Gateway does not see an unrecognised
  client and report a login from a new device. **Quit the old app first.** The
  move is skipped if a `Claw Desktop` profile already exists.
- **The old install is a separate app.** The Windows `appId` changed, so the
  installer will not replace an existing *OpenClaw* entry. Uninstall that one,
  and on macOS delete `/Applications/OpenClaw.app`.

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
- Removing a gateway deletes its credentials but keeps its site data — see the
  session note below for why.

Two caveats worth knowing:

- **Password autofill is best-effort.** It depends on the Control UI's login-gate
  markup, which is not an API. It fills only empty fields, runs at most once per
  load, and if the gate never appears it does nothing. Token mode is the durable
  path; prefer it.
- **All gateways share one session**, exactly as they would share one browser
  profile. Chromium already keys site storage by origin, so gateways on
  different origins are isolated without help. An earlier build gave each
  gateway entry its own `persist:` partition; because the partition name came
  from the entry's UUID, editing a URL — or upgrading — threw away the device
  identity, and the Gateway reported a login from an unrecognised client.
  Removing a gateway now deletes its credentials but deliberately leaves its
  site data, so re-adding it does not look like a new device. Use
  `openclaw devices revoke` to actually sever one.

## Window chrome

The main window is frameless on macOS and Windows: no OS title bar, and the
app's colour runs to the top edge. The window buttons sit on a 36px strip the
app draws for itself, above the page, carrying the current session's name.

They are the OS's real buttons — macOS traffic lights, Windows caption buttons
via `titleBarOverlay` — so snap layouts, tooltips and the taskbar preview keep
working, and the window can never be made unclosable by a CSS mistake. The strip
just gives them somewhere to live that is not on top of the page.

**Why a strip rather than letting them float over the content.** The Control UI
invites the floating approach: its stylesheet reads marker classes on `<html>`
it never sets itself (`openclaw-native-macos`, `openclaw-native-web-chrome`) and
under them grows its header rows to titlebar height and insets them for native
window buttons. The app used to set those classes and add insets on top.

It does not work, because "which element is under the window buttons" has no
stable answer. In order, each fixed and each then wrong in some other layout
state: the chat pane header; a docked side panel's header; the empty "Open a
tab" header; the custodian panel, which is `position: fixed; right: 0` and so
cannot be moved by any ancestor's padding; the sidebar brand row on macOS; and
finally any routed page's own top-left content once the nav is collapsed —
upstream computes `--shell-titlebar-inset: 90px` for that case and applies it to
`.chat-pane__header` alone.

A smaller viewport is the one inset a fixed-position overlay cannot escape, so
the page loads into a `WebContentsView` that starts below the strip. Nothing it
draws can share space with the buttons because it does not extend into that
band — and **the app now injects nothing into the gateway page at all**: no
marker classes, no drag regions, no insets, and so no dependency on upstream
markup.

Note this is not the same as reserving space *inside* the page, which was tried
and failed: `vh` is always the **whole** window, so a page sized `height: 100vh`
stays window-height and lands exactly the strip's height below the fold —
measured on a probe page, 754px of content in a 720px window. Shrinking the view
shrinks the viewport, so `100vh` is correct by definition.

Linux keeps its normal frame; window managers vary too much to be confident the
user can still move and close a frameless window.

### Following the UI's theme

Some surfaces belong to the app, not the page: the Windows caption strip (drawn
by the OS *above* the web contents), each window's background behind an
unpainted page, and the settings and error pages. The Control UI's stylesheet
cannot reach any of them, and it ships twelve palettes — six of them light.
Pinned to one dark palette, a light theme left a 137×50 near-black hole in the
top-right corner of an otherwise cream window.

So the app reads the colours back off the page rather than assuming them. A
sandboxed preload resolves `var(--bg)` / `var(--text)` against a throwaway
element — asking the engine to flatten whatever the theme was authored in down
to `rgb()` — and reports the result. The main process parses that to `#rrggbb`,
discards anything transparent or unparseable, and repaints the caption overlay
and window background. A `MutationObserver` on `data-theme` catches theme
changes, which the picker makes in place with no navigation to hang a load
event off.

`nativeTheme.themeSource` is then set from the **page**, not the OS: the theme
is chosen in the Control UI, so following the OS would leave a light UI sitting
in a dark settings window. That is also what makes `prefers-color-scheme` inside
the app's own `file://` pages resolve to the UI's answer, so `ui.css` needs no
IPC of its own.

The reporting preload runs for remote pages too, and exposes nothing to them —
it reads colours out, never in. A hostile gateway could report any colour it
liked; the blast radius is an ugly title bar, because nothing reaches an
Electron API without being parsed into a hex triple first.

The mode alone is remembered in `config.json` (`themeMode`), so a cold start
opens in the right colours instead of flashing the wrong palette for as long as
the gateway takes to answer — over Tailscale to a sleeping box, that is not a
flash.

## Stale UI after an upgrade

The Control UI is a PWA. Its service worker keys a cache on a build id embedded
in `sw.js` and serves everything under `/assets/` cache-first, without
revalidating. That is fine in a browser, where you close the tab and the next
navigation re-checks `sw.js`. It is not fine here: this app closes to the tray
rather than quitting, so a document can sit for weeks without a single
navigation, still controlled by the worker an older gateway installed. What you
see is an app still showing yesterday's Control UI after the gateway under it
was upgraded.

Three ways out, in order of how little you have to notice:

- **The gateway was upgraded.** After every successful load the app reads the
  build id out of `sw.js` and compares it to the one recorded for that gateway
  in `config.json` (`swVersions`). If it moved, the caches are dropped and the
  page reloads — once, automatically.
- **This app was upgraded.** A new build brings a new Electron and a new
  preload, so the first run after a version change clears the caches before
  anything loads. A profile with no recorded `appVersion` is a fresh install,
  not an upgrade, and clears nothing.
- **Neither, but it still looks wrong.** **File → Clear cache and reload**, also
  on the tray menu. It is on the tray deliberately: Windows runs with
  `autoHideMenuBar`, so the menu is behind an Alt press exactly when the window
  is in the state that makes you want this.

All three drop the same three things and nothing else: the service-worker
registration, its Cache Storage, and the HTTP + compiled-code caches.

**Cookies, localStorage and IndexedDB are never touched, and that boundary is
load-bearing.** The gateway's paired device identity lives in origin storage, so
a blunt `clearStorageData()` with no `storages` list would make the Gateway see
a brand-new client and report a login from an unrecognised device — the same
failure the per-gateway partition scheme used to cause (see the comment above
`configureSession` in `src/main.js`). `src/cache.js` keeps caches and storage
apart so that stays true even when someone is in a hurry, and
`test/cache.test.js` asserts it.

## Settings

Everything lives in one window (**Cmd/Ctrl+,**, or the tray menu). It keeps a
normal OS title bar, and follows the Control UI's light or dark theme:

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
| macOS | `~/Library/Application Support/Claw Desktop/config.json` |
| Windows | `%APPDATA%\Claw Desktop\config.json` |
| Linux | `~/.config/Claw Desktop/config.json` |

It is written atomically and holds gateway list, window bounds, preferences, and
pinned certificate fingerprints. **No secrets** — those live encrypted in
`credentials.json` in the same directory (see [Credentials](#credentials)).

## Development

```sh
npm install
npm test                 # profile-migration unit tests, no Electron needed
npm start                # run from source
npm run pack             # unpacked build into dist/, no installer
npm run build:mac        # dmg + zip (arm64, x64)
npm run build:win        # nsis installer (x64, arm64)
npm run icons            # regenerate PNGs from src/assets/claw*.svg
```

Icons are **committed** deliberately, so a clean clone builds without `sharp`.
Re-run `npm run icons` only when the artwork changes.

The artwork is original and lives in two files: `src/assets/claw.svg` is the
application icon, and `src/assets/claw-tray.svg` is the same mark stripped of its
tile and window for the 16px tray. Neither is derived from OpenClaw's mascot or
any other upstream brand asset.

Building Windows installers on macOS needs Wine for resource editing, so build
Windows on Windows. Two ways:

- **On the Windows box directly** — fastest, and costs no CI minutes:

  ```
  gh repo clone azuretek/claw-desktop
  cd claw-desktop
  npm ci
  npm run build:win
  dist\ClawDesktop-Setup-1.0.0-x64.exe /S     :: /S installs silently, per-user
  ```

  It installs to `%LOCALAPPDATA%\Programs\Claw Desktop`. A full `build:win` takes
  roughly half an hour on a recent laptop. **Passing `--x64` does not shorten it** —
  the per-target `arch` list in `electron-builder.yml` wins over the CLI flag,
  so you still get x64, arm64, and the combined installer. Edit the config if
  you genuinely want one arch. Use `gh repo clone` rather
  than `git clone git@…`: Git for Windows ships its own `ssh` that cannot see keys
  held by the Windows OpenSSH agent, so an SSH clone fails with
  `Permission denied (publickey)` even when `ssh -T git@github.com` succeeds.

- **`release` GitHub Actions workflow** — builds each platform on its own
  runner. Push a `v*` tag to cut a release, or run it manually for
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
src/cache.js         drops the Control UI's cached copy of itself, never its storage
src/certs.js         trust-on-first-use certificate pinning
src/profile.js       one-time profile move for the OpenClaw -> Claw Desktop rename
src/chrome.js        title strip geometry + theme adopted from the page
src/config.js        atomic JSON config store (no secrets)
src/secrets.js       per-gateway token/password/headers, safeStorage-encrypted
src/defaults.js      suggested gateways and defaults  ← edit for a new machine
src/preload.js       narrow IPC bridge, exposed to local pages only
src/ui/              settings and connection-error pages
scripts/make-icons.mjs
```

## Status and licence

A personal project, shared because it might be useful — not a product. There is
no support commitment and no release schedule, and builds are unsigned. The app
deliberately does not depend on the Control UI's markup, so an upstream restyle
should not break the window chrome; the login-gate password autofill is the one
remaining place that reads the UI's DOM, and it fails soft by design.

Issues and pull requests are welcome; slow replies are likely.

**Not affiliated with the OpenClaw project.** This is an independent client for
its Control UI. "Claw Desktop" is deliberately not "OpenClaw" — see
[src/profile.js](src/profile.js) for the rename's one lasting consequence.

MIT — see [LICENSE](LICENSE).
