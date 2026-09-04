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
//   Linux     Notify only. AppImage updates work in principle, but the app is
//             not distributed that way and the path is untested here; claiming
//             an install we have never run is worse than telling the truth.
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
// This constant describes the builds people install, which come from CI. A
// Developer ID now exists on the signing machine, so a local `npm run build:mac`
// is signed and notarized -- but CI has no certificate yet, and this flag is
// compiled in. Setting it true before CI can sign would tell an unsigned release
// build to hand itself to Squirrel.Mac, which is the exact failure the flag
// exists to avoid. Flip it in the same commit that gives CI a certificate.
const MAC_SIGNED = false;

/** What to do when a newer version exists. */
const INSTALL = 'install'; // download it and offer to restart
const NOTIFY = 'notify'; // tell the user, link to the release, install by hand
const NONE = 'none'; // do not even check

/**
 * How this build should behave about updates.
 *
 * @param {object} opts
 * @param {string} opts.platform   process.platform
 * @param {boolean} opts.packaged  app.isPackaged
 * @param {boolean} [opts.macSigned]
 * @returns {{action: string, check: boolean, autoDownload: boolean, reason: string}}
 */
function policy({ platform, packaged, macSigned = MAC_SIGNED }) {
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

  return { action: NOTIFY, check: true, autoDownload: false, reason: 'no tested install path on this platform' };
}

/**
 * Message for the "a new version exists" dialog.
 *
 * Split from the dialog call so the wording is testable and so the two
 * platforms cannot drift into saying the same thing about different outcomes.
 */
function availableMessage({ action, version, current }) {
  const headline = `Claw Desktop ${version} is available.`;
  if (action === INSTALL) {
    return { message: headline, detail: `You are on ${current}. It will download in the background, and you can restart to apply it.` };
  }
  return {
    message: headline,
    detail: `You are on ${current}. This build cannot update itself, because it is not code signed — `
      + 'download the new version and replace the app to upgrade.',
  };
}

/** Whether a check should say anything when there is no update. */
function shouldReportNoUpdate(trigger) {
  // A scheduled check that announces "you are up to date" every six hours is
  // noise. Someone who just clicked "Check for updates" is owed an answer.
  return trigger === 'manual';
}

module.exports = { policy, availableMessage, shouldReportNoUpdate, INSTALL, NOTIFY, NONE, MAC_SIGNED };
