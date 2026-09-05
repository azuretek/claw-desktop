'use strict';

// The loading cover. Same shape as the other pages here: nodes are addressed by
// id and every value comes from the main process, because this page is
// sandboxed and cannot require src/connection.js, src/progress.js or
// src/quips.js.
//
// It renders two states off one field, `state.connection.phase`. There is no
// third: a cover that is on screen at all is either waiting for the gateway or
// has stopped waiting, and "connected" is the view being gone.
//
// The failure *reason* is deliberately absent. It is in the banner, once, with
// the link to Settings — saying it in both places means two wordings of the
// same failure that drift apart, and the one on this page could not be
// dismissed.

const api = window.clawDesktop;
const $ = (id) => document.getElementById(id);

if (new URLSearchParams(location.search).has('frameless')) document.body.classList.add('frameless');

async function render() {
  const state = await api.getState();
  const gw = (state.gateways || []).find((g) => g.id === state.activeGatewayId) || null;
  const failed = Boolean(state.connection && state.connection.phase === 'failed');

  document.body.classList.toggle('is-failed', failed);
  $('title').textContent = failed ? 'Not connected' : 'Connecting…';
  $('label').textContent = gw ? (gw.label || '') : '';
  $('url').textContent = gw ? gw.url : '';
  // Only offered once waiting has stopped. A retry button beside a live spinner
  // invites someone to restart the attempt that is already running.
  $('retry').hidden = !failed;
}

/**
 * Draw the bar and the line under it.
 *
 * Both numbers come from main; nothing here decides how far along the load is.
 * The width is set as a percentage and eased by a CSS transition, so a value
 * four times a second reads as a bar moving rather than as four steps.
 */
function paintProgress(value) {
  if (!value) return;
  const percent = Math.max(0, Math.min(100, Math.round(value.percent)));
  $('fill').style.width = `${percent}%`;
  $('bar').setAttribute('aria-valuenow', String(percent));
  $('percent').textContent = `${percent}%`;
  if (value.quip) $('quip').textContent = value.quip;
}

$('retry').addEventListener('click', () => { void api.reconnect(); });
api.onProgress(paintProgress);
api.onStateChanged(() => { void render(); });

void render();
void api.progress().then(paintProgress);
