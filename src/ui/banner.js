'use strict';

// The banner that slides down from the top and stays.
//
// The one thing this page owes the main process is an accurate height. Its view
// is resized to whatever it reports, and a view eats every mouse event inside
// its bounds whatever the page draws there — so reporting too much makes an
// invisible strip that swallows clicks on the Control UI underneath, and
// reporting too little clips the banner.
//
// The height is measured from layout rather than after the animation, because
// the slide is a `transform` and a transform does not change layout height. So
// the number is correct on the first frame, and the view never resizes
// mid-animation.

const api = window.clawDesktop;
const stack = document.getElementById('stack');

// Deliberately no `frameless` class. The banner's view is already positioned
// below the title strip by main, so it has nothing to clear — and the rule that
// class used to carry was written for the error page, which no longer exists.

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function report() {
  // Synchronous on purpose. `getBoundingClientRect` forces layout, so the
  // number is right immediately -- and waiting for a frame would deadlock: the
  // view starts at a provisional height, requestAnimationFrame does not fire
  // for content that has not painted, and the height that would make it paint
  // is the one being reported.
  const height = stack.childElementCount ? stack.getBoundingClientRect().height : 0;
  void api.bannerHeight(height);
}

function card(notice) {
  const dismiss = notice.dismissible === false ? null : el('button', {
    className: 'banner__close',
    type: 'button',
    title: 'Dismiss',
    textContent: '✕',
    onclick: () => { void api.dismissNotice(notice.id); },
  });

  // A link rather than a button, and the only one: this is where a notice says
  // "the thing that fixes me is over there". It navigates; it does not act, so
  // the notice stays up until the condition it describes actually passes.
  const action = notice.action ? el('button', {
    className: 'banner__action',
    type: 'button',
    textContent: notice.action.label,
    onclick: () => { void api.noticeAction(notice.action.command); },
  }) : null;

  return el('div', { className: `banner banner--${notice.tone}`, id: `n-${notice.id}` }, [
    el('div', { className: 'stack grow' }, [
      el('span', { className: 'banner__message', textContent: notice.message }),
      notice.detail ? el('span', { className: 'banner__detail', textContent: notice.detail }) : null,
    ]),
    action,
    dismiss,
  ]);
}

async function render() {
  const notices = await api.notices();
  // Rebuild only what changed, keyed by id. Replacing the whole list every time
  // would replay the slide-in on a banner that has been sitting there for an
  // hour, every time an unrelated one appears.
  const wanted = new Map(notices.map((n) => [n.id, n]));

  for (const node of [...stack.children]) {
    if (!wanted.has(node.id.slice(2))) node.remove();
  }
  for (const notice of notices) {
    const existing = document.getElementById(`n-${notice.id}`);
    const next = card(notice);
    if (existing) existing.replaceWith(next);
    else stack.append(next);
  }

  report();
}

api.onNoticesChanged(() => { void render(); });
window.addEventListener('resize', report);

void render();
