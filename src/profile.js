'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Profile directory migration for the OpenClaw -> Claw Desktop rename.
//
// `productName` is what Electron derives `app.getPath('userData')` from, so
// renaming the app silently repoints the profile at an empty directory. That
// would abandon three things at once: config.json, the encrypted
// credentials.json, and the site storage holding the paired device identity —
// so the Gateway would see an unrecognised client and report a login from a new
// device. Which is precisely the failure this app just stopped causing.
//
// Deliberately a plain function over an explicit base directory rather than
// something that reaches for `app.getPath()` itself. It is the only code here
// that renames a directory full of credentials, so it has to be testable
// without launching Electron and without any chance of touching a real profile.
// (Learned the hard way: `HOME` does not redirect `app.getPath('appData')` on
// macOS, so an "isolated" Electron run moved the live profile instead.)

const PREVIOUS_NAME = 'OpenClaw';
const CURRENT_NAME = 'Claw Desktop';

/**
 * Move an old-name profile into place, once.
 *
 * @param {string} appDataDir  Parent of the profile directories.
 * @returns {{status: string, from?: string, to?: string, error?: string}}
 *   `migrated` | `already-current` (target exists — never overwrite) |
 *   `nothing-to-migrate` | `failed`
 */
function migrate(appDataDir, { previousName = PREVIOUS_NAME, currentName = CURRENT_NAME } = {}) {
  const from = path.join(appDataDir, previousName);
  const to = path.join(appDataDir, currentName);

  // Target first: if a current-name profile exists it is authoritative, and
  // merging two profiles is never the right answer.
  if (fs.existsSync(to)) return { status: 'already-current', to };
  if (!fs.existsSync(from)) return { status: 'nothing-to-migrate' };

  try {
    fs.renameSync(from, to);
    return { status: 'migrated', from, to };
  } catch (err) {
    // Not fatal: a fresh profile still works, it just has to sign in again.
    return { status: 'failed', from, to, error: err.message };
  }
}

module.exports = { migrate, PREVIOUS_NAME, CURRENT_NAME };
