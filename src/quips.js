'use strict';

// The line under the progress bar while the app connects.
//
// It is there because the wait is the honest problem: a tailnet gateway that is
// asleep, or a laptop that has not finished joining the network, can leave this
// screen up for the better part of a minute, and a spinner with a percentage is
// a countdown to nothing. A line that changes gives the wait a pulse, and says
// the app is still running rather than hung.
//
// They are jokes and they are labelled as such -- none of them claims to
// describe a step the app is performing. That is deliberate: a fake status
// message ("Verifying certificates...") next to a real progress bar is a lie
// told in the one place someone is looking for a reason their app will not open.
// The real state is the bar, the gateway URL above it, and the banner when it
// fails.
//
// Pure and Electron-free: the rotation is an index into a frozen list, so the
// order and the wrap are testable without a window.

/**
 * The lines. Short enough for one row at the narrowest window the app allows,
 * and free of anything that reads as a real diagnostic.
 */
const QUIPS = Object.freeze([
  'Reticulating splines.',
  'Waking the gateway.',
  'Untangling the tailnet.',
  'Rounding up stray packets.',
  'Asking the socket nicely.',
  'Warming up the claws.',
  'Teaching the electrons to queue.',
  'Checking under the couch for the token.',
  'Convincing DNS.',
  'Aligning the antennae.',
  'Polishing the pixels.',
  'Consulting a manual nobody wrote.',
  'Negotiating with a certificate.',
  'Counting to one in binary.',
  'It was here a second ago.',
  'Holding the ethernet cable at a better angle.',
]);

/** How long each line stays up. Long enough to read twice, short enough to move. */
const ROTATE_MS = 3200;

/**
 * The line at `step`, starting from `offset`.
 *
 * Wraps rather than stopping, because there is no upper bound on how long a
 * connect can take and a list that runs out leaves the last line frozen -- which
 * is the appearance of a hang, the one thing this is here to avoid.
 *
 * @param {number} step    how many rotations have elapsed
 * @param {number} offset  where this run started in the list
 */
function quipAt(step, offset = 0) {
  const n = QUIPS.length;
  const i = ((Math.floor(step) + Math.floor(offset)) % n + n) % n;
  return QUIPS[i];
}

/**
 * Where to start, so two launches in a row do not open on the same joke.
 *
 * Seeded rather than random when a seed is given, which is what lets a test
 * assert the sequence.
 */
function startAt(seed = Math.random()) {
  return Math.floor(Math.abs(seed) * QUIPS.length) % QUIPS.length;
}

module.exports = { QUIPS, ROTATE_MS, quipAt, startAt };
