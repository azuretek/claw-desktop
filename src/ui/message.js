'use strict';

// The app's own message dialog, in place of dialog.showMessageBox.
//
// It fetches its content on load rather than being pushed it, so a page that
// reloads for any reason comes back showing the same question instead of an
// empty card. Answering is a single IPC call carrying the button index, which
// is what the awaiting caller in main.js resolves with — the same `{ response }`
// the native dialog returned, so the call sites did not have to change shape.

const api = window.clawDesktop;
const $ = (id) => document.getElementById(id);

if (new URLSearchParams(location.search).has('frameless')) document.body.classList.add('frameless');

let cancelId = 0;
// A second click while the first is still crossing IPC would answer a dialog
// that is already closing, and the next one in the queue would inherit it.
let answered = false;

function answer(index) {
  if (answered) return;
  answered = true;
  void api.respondToMessage(index);
}

(async () => {
  const spec = await api.message();
  // Nothing to show. Reachable only if the dialog was settled between opening
  // this page and it loading, in which case main has already closed the view.
  if (!spec) return;

  if (spec.kind === 'warning') document.body.classList.add('warning');
  $('message').textContent = spec.message || '';
  $('detail').textContent = spec.detail || '';
  $('detail').hidden = !spec.detail;

  const buttons = Array.isArray(spec.buttons) && spec.buttons.length ? spec.buttons : ['OK'];
  cancelId = Number.isInteger(spec.cancelId) ? spec.cancelId : 0;
  const defaultId = Number.isInteger(spec.defaultId) ? spec.defaultId : 0;

  // Rendered right to left so the default action sits at the trailing edge,
  // which is where every one of the three platforms puts it, while the array
  // stays in the order the caller wrote it.
  $('buttons').replaceChildren(...buttons.map((label, index) => Object.assign(document.createElement('button'), {
    textContent: label,
    className: index === defaultId ? 'primary' : 'ghost',
    onclick: () => answer(index),
  })).reverse());

  const primary = $('buttons').querySelector('button.primary') || $('buttons').querySelector('button');
  if (primary) primary.focus();
})();

// Escape and click-outside both mean the cancel button, matching what dismissing
// a native dialog does. There is no close cross: a dialog with two real choices
// should not offer a third exit that looks like neither.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') answer(cancelId); });
$('scrim').addEventListener('mousedown', (e) => {
  if (e.target !== e.currentTarget) return;
  $('scrim').addEventListener('mouseup', (ev) => { if (ev.target === e.currentTarget) answer(cancelId); }, { once: true });
});
