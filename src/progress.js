'use strict';

// The number under the loading cover's progress bar.
//
// A gateway load reports no percentage. Chromium will tell you a navigation
// started, that the document parsed, and that the load finished, and nothing at
// all about the distance between them — so a bar driven only by those events
// would sit still for four seconds and then jump, which reads as frozen.
//
// So the milestones set the floor and the ceiling, and time fills the gap. Each
// milestone has a share of the bar; within one, the number eases toward the next
// milestone's floor and never arrives, because arriving would promise something
// that has not happened yet. The event moves it on; the clock only stops it
// looking dead.
//
// That makes the number honest in the way that matters: it can be behind, it can
// crawl, but it cannot claim a stage the app has not reached. 100 is reserved
// for a load that finished, which is also the moment the cover is removed.
//
// Pure and Electron-free, so the curve can be exercised at any instant from one
// `node --test` run rather than by watching a bar.

/** Milestones, in the order a load reaches them. */
const START = 'start'; // loadURL issued, nothing has answered
const NAVIGATED = 'navigated'; // the host answered with headers
const DOM = 'dom'; // the document parsed
const DONE = 'done'; // the load finished; the gateway is up

const ORDER = [START, NAVIGATED, DOM, DONE];

// Where each milestone puts the bar the instant it lands, and where easing
// inside it is allowed to creep toward. Weighted by how long each stage
// typically takes rather than evenly: the wait for a host to answer is the long
// one, so it gets the widest band and the most room to move.
const FLOOR = { [START]: 2, [NAVIGATED]: 42, [DOM]: 78, [DONE]: 100 };

// How fast the creep inside a stage decays, in ms. One time constant covers
// ~63% of the remaining band, two covers ~86%. At 2.2s a stage still looks
// alive after ten seconds while leaving visible headroom for its own event.
const TAU_MS = 2200;

// How much of the band to the next milestone the creep may take. Short of 1 so
// there is always a visible step when the real event lands -- a bar that has
// already crept to 42 makes reaching NAVIGATED look like nothing happened.
const CREEP = 0.75;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * The percentage to show, as an integer.
 *
 * @param {object} opts
 * @param {string} [opts.milestone]  the furthest stage reached
 * @param {number} [opts.sinceMs]    ms since that stage was reached
 * @param {boolean} [opts.failed]    the load stopped; the bar freezes where it is
 * @returns {number} 0-100
 */
function percent({ milestone = START, sinceMs = 0, failed = false } = {}) {
  const index = ORDER.indexOf(milestone);
  const stage = index === -1 ? START : ORDER[index];
  const floor = FLOOR[stage];
  if (stage === DONE) return 100;

  // A failure holds the bar at the last stage it genuinely reached. Creeping on
  // afterwards would keep promising progress toward a load that has stopped.
  if (failed) return floor;

  const ceiling = FLOOR[ORDER[ORDER.indexOf(stage) + 1]];
  const band = (ceiling - floor) * CREEP;
  const eased = 1 - Math.exp(-Math.max(0, sinceMs) / TAU_MS);
  return clamp(Math.round(floor + (band * eased)), 0, 99);
}

/**
 * Whether `next` is further along than `current`.
 *
 * Milestones are only ever allowed to move forward. Chromium fires
 * `did-start-navigation` for in-page navigations too, which on a Control UI that
 * routes on load arrives *after* the document is ready -- taken at face value
 * that would send a bar at 78 back to 42.
 */
function isAhead(next, current) {
  return ORDER.indexOf(next) > ORDER.indexOf(current);
}

module.exports = { percent, isAhead, ORDER, FLOOR, START, NAVIGATED, DOM, DONE };
