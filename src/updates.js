'use strict';

// What this app is allowed to do about a new version, per platform.
//
// The answer is not the same everywhere, and the reason is code signing rather
// than anything we chose:
//
//   Windows   Full auto-update, even unsigned. electron-updater's
//             `NsisUpdater.verifySignature()` reads `publisherName` from
//             app-update.yml and returns null when there is none, so an
//             unsigned build skips verification and installs normally.
//
//   macOS     Download and notify only. `MacUpdater` hands the update to native
//             Squirrel.Mac, which requires a valid signature on the *running*
//             bundle; an unsigned app fails with "Could not get code signature
//             for running application". No configuration avoids that -- it
//             needs an Apple Developer ID.
//
//   Linux     Full auto-update, but only while running as an AppImage.
//             `AppImageUpdater` replaces the .AppImage file the process was
//             started from, so it needs no signature, no package manager and no
//             root -- but it does need that file, which it finds through the
//             `APPIMAGE` environment variable the AppImage runtime sets. Started
//             any other way, `isUpdaterActive()` returns false and every check
//             resolves to null without emitting anything, so the honest answer
//             there is to not check and to say why.
//
//             That asymmetry is why AppImage is the only Linux target built. The
//             .deb and .rpm updaters exist, but they run dpkg or rpm through
//             pkexec, so every update raises a password prompt.
//
// Kept free of Electron so the policy can be tested for every platform from one
// run, the same shape as chrome.js taking `platform` as a parameter.

// Flip to true when macOS builds are signed with a Developer ID and notarized.
// It is a constant rather than a runtime probe on purpose: asking the OS whether
// the running bundle is signed means shelling out to `codesign` on every check,
// and the answer only changes when the build pipeline changes -- which is a
// commit, not a runtime event.
//
// Signing is credential-driven rather than configured: electron-builder.yml
// carries no `identity` key on purpose, and notarization is switched on per-run
// by scripts/build.js when the App Store Connect variables are present.
//
// This constant describes the builds people install, which come from CI, and
// the release workflow now signs and notarizes the mac leg with a Developer ID.
// It stays a compiled-in constant rather than a runtime `codesign` probe: the
// answer only changes when the build pipeline changes, which is a commit.
//
// The hazard to remember if signing is ever removed: this must go back to false
// in the same commit. A true value on an unsigned build hands the update to
// Squirrel.Mac, which refuses to install over an unsigned running bundle -- the
// exact failure this flag exists to avoid.
const MAC_SIGNED = true;

/** What to do when a newer version exists. */
const INSTALL = 'install'; // download it and offer to restart
const MANUAL = 'manual'; // could install, but only when the user asks for it
const NOTIFY = 'notify'; // tell the user, link to the release, install by hand
const NONE = 'none'; // do not even check

/**
 * What the *platform* allows, ignoring what the user has asked for.
 *
 * Split from policy() because the two answers are needed separately: Settings
 * has to say why the automatic-updates toggle is unavailable on a build that
 * could never install anyway, and that reason is a fact about the build rather
 * than about the preference.
 */
function capability({ platform, packaged, macSigned = MAC_SIGNED, appImage = Boolean(process.env.APPIMAGE) }) {
  // A source run has no app-update.yml and no version worth comparing.
  // electron-updater guards this itself (`app.isPackaged || forceDevUpdateConfig`)
  // but it does so by logging an error, which reads like a fault every `npm start`.
  if (!packaged) {
    return { action: NONE, check: false, autoDownload: false, reason: 'running from source' };
  }

  if (platform === 'win32') {
    return { action: INSTALL, check: true, autoDownload: true, reason: 'NSIS updates do not require a signed build' };
  }

  if (platform === 'darwin') {
    return macSigned
      ? { action: INSTALL, check: true, autoDownload: true, reason: 'signed with a Developer ID' }
      : {
        action: NOTIFY,
        check: true,
        // Downloading something that cannot be installed wastes ~130MB of
        // someone's bandwidth to reach the same dialog.
        autoDownload: false,
        reason: 'unsigned: Squirrel.Mac cannot install an update over an unsigned bundle',
      };
  }

  if (platform === 'linux') {
    return appImage
      ? { action: INSTALL, check: true, autoDownload: true, reason: 'an AppImage replaces itself in place' }
      : {
        action: NOTIFY,
        // Not merely useless but actively misleading: AppImageUpdater's
        // isUpdaterActive() is false without APPIMAGE, so checkForUpdates()
        // returns null having emitted no event at all -- no 'error', no
        // 'update-not-available'. A check that can only ever answer nothing is
        // worse than one that explains itself, and main.js turns check:false
        // into exactly that explanation.
        check: false,
        autoDownload: false,
        reason: 'not running as an AppImage, so there is no file an update could replace',
      };
  }

  return { action: NOTIFY, check: true, autoDownload: false, reason: 'no tested install path on this platform' };
}

/**
 * How this build should behave about updates, given what the platform allows
 * and what the user has asked for.
 *
 * The preference only ever *narrows* the platform's answer. Turning automatic
 * updates off cannot make a build that could not install start installing, and
 * it does not stop the app looking: knowing a release exists is the thing the
 * user gave up nothing to keep, and it is what makes the manual install offer
 * possible at all.
 *
 * MANUAL rather than NOTIFY when it is off, because the two are different
 * offers and saying the wrong one is worse than saying nothing. NOTIFY means
 * "go and replace the app yourself"; MANUAL means "press the button and I will
 * do it" — which is true here, and which NOTIFY's wording would deny.
 *
 * @param {object} opts
 * @param {string} opts.platform   process.platform
 * @param {boolean} opts.packaged  app.isPackaged
 * @param {boolean} [opts.macSigned]
 * @param {boolean} [opts.appImage]  running from an AppImage (Linux only)
 * @param {boolean} [opts.autoUpdate]  the user's preference; config.autoUpdate
 * @returns {{action: string, check: boolean, autoDownload: boolean, reason: string,
 *           canInstall: boolean, capabilityReason: string}}
 */
function policy({ autoUpdate = true, ...opts }) {
  const base = capability(opts);
  const canInstall = base.action === INSTALL;
  const common = { canInstall, capabilityReason: base.reason };

  if (!canInstall || autoUpdate) return { ...base, ...common };

  return {
    ...common,
    action: MANUAL,
    check: true,
    autoDownload: false,
    reason: 'automatic updates are turned off in Settings',
  };
}

/**
 * Message for the "a new version exists" dialog.
 *
 * Split from the dialog call so the wording is testable and so the two
 * platforms cannot drift into saying the same thing about different outcomes.
 *
 * The "why not" half is the caller's `reason` rather than a sentence written in
 * here. It used to say "because it is not code signed", which was true of the
 * only platform that could reach it at the time and became false the moment
 * Linux could reach it too — a dialog confidently naming the wrong cause.
 */
function availableMessage({ action, version, current, reason = null }) {
  const headline = `Claw Desktop ${version} is available.`;
  if (action === INSTALL) {
    return { message: headline, detail: `You are on ${current}. It will download in the background, and you can restart to apply it.` };
  }
  if (action === MANUAL) {
    return {
      message: headline,
      detail: `You are on ${current}. Automatic updates are off, so nothing has been downloaded yet — `
        + 'install it now, or turn them back on in Settings.',
    };
  }
  const because = reason ? `, because ${reason}` : '';
  return {
    message: headline,
    detail: `You are on ${current}. This build cannot update itself${because} — `
      + 'download the new version and replace the app to upgrade.',
  };
}

/** Whether a check should say anything when there is no update. */
function shouldReportNoUpdate(trigger) {
  // A scheduled check that announces "you are up to date" every six hours is
  // noise. Someone who just clicked "Check for updates" is owed an answer.
  return trigger === 'manual';
}

/**
 * The release channel a build belongs to, read from its own version.
 *
 * `1.0.1-dev.38.a1b2c3d4e5` is on `dev`; `1.0.1` is on stable, which returns
 * null. The version is the only honest source: it is stamped at build time and
 * travels with the installed app, so a build cannot be wrong about which
 * channel it came from.
 */
function channelOf(version) {
  const m = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(String(version || '').trim());
  return m ? m[1] : null;
}

/**
 * Whether this build may consider prereleases — which is what keeps the two
 * channels apart, in both directions.
 *
 * A stable build leaves it false, so electron-updater asks GitHub for
 * `/releases/latest`, and GitHub excludes prereleases from that by definition.
 * Stable can therefore never be offered a dev build, without us filtering
 * anything.
 *
 * A dev build sets it true, which switches GitHubProvider to walking the
 * releases feed. There it compares each release's channel against its own
 * (taken from `semver.prerelease(currentVersion)[0]`, i.e. `dev`) and takes the
 * first match. A stable release has no prerelease component, so it matches
 * neither branch of that check and is skipped — a dev build is never offered
 * stable either.
 *
 * The pairing to keep in step: the build must also publish to the matching
 * channel, or the update metadata it looks for will not exist. scripts/build.js
 * passes `--config.publish.channel` for exactly that reason.
 */
function allowPrerelease(version) {
  return channelOf(version) !== null;
}

/**
 * Roughly how long ago, in words.
 *
 * Deliberately coarse. The question this answers is "is it checking at all",
 * and a precise timestamp invites the reader to work out the interval instead
 * of reading the answer.
 */
function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The single line About shows about updating.
 *
 * It exists because updating is otherwise entirely invisible: it succeeds
 * silently, and the only proof it ever ran is a file in a cache directory. An
 * app that quietly keeps itself current and an app whose update check has been
 * failing for a month look exactly alike from the outside, which is a fair
 * reason to doubt the first one.
 *
 * Three facts, in the order someone doubting it would ask for them: which
 * releases this build follows, what it does when it finds one, and when it last
 * looked. Nothing is persisted, so "no check yet" means this run — which is the
 * truth, and a stored timestamp claiming otherwise would not be.
 *
 * @param {object} opts
 * @param {string} opts.action        from policy()
 * @param {string} opts.reason        from policy()
 * @param {string|null} [opts.channel] from channelOf()
 * @param {number|null} [opts.checkedAt]  Date.now() of the last completed check
 * @param {string|null} [opts.result]     how that check ended
 * @param {number} [opts.now]
 */
function statusLine({ action, reason, channel = null, checkedAt = null, result = null, now = Date.now() }) {
  const follows = `${channel || 'stable'} channel`;
  if (action === NONE) return `Updates: not checked — ${reason}`;

  const behaviour = {
    [INSTALL]: 'installed automatically',
    [MANUAL]: 'installed when you ask',
  }[action] || 'announced, installed by hand';
  const when = checkedAt === null ? null : ago(now - checkedAt);
  const last = when ? `last checked ${when}${result ? `, ${result}` : ''}` : 'no check yet this run';
  return `Updates: ${follows}, ${behaviour}; ${last}`;
}

module.exports = {
  capability, policy, availableMessage, shouldReportNoUpdate, channelOf, allowPrerelease, ago, statusLine,
  INSTALL, MANUAL, NOTIFY, NONE, MAC_SIGNED,
};
