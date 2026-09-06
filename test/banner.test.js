'use strict';

// The banner page.
//
// src/ui/banner.js is a browser script, so it is loaded here against a minimal
// DOM rather than required. That is worth the shim for one reason: the stack is
// rebuilt key by key so a banner that has been sitting there for an hour does
// not replay its slide every time an unrelated one appears, and the Mark all
// read row is the one node in it that is not a notice. A rebuild that treats it
// like a card either duplicates it or prunes it as a condition that passed, and
// neither shows up in a screenshot of a working banner.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = path.join(__dirname, '..', 'src', 'ui', 'banner.js');

function makeNode(tag) {
  return {
    tag,
    id: '',
    className: '',
    textContent: '',
    parent: null,
    kids: [],
    get children() { return this.kids; },
    get childElementCount() { return this.kids.length; },
    append(...items) {
      for (const item of items) {
        if (!item) continue;
        item.parent = this;
        this.kids.push(item);
      }
    },
    remove() {
      if (!this.parent) return;
      this.parent.kids = this.parent.kids.filter((n) => n !== this);
      this.parent = null;
    },
    replaceWith(next) {
      if (!this.parent) return;
      const i = this.parent.kids.indexOf(this);
      next.parent = this.parent;
      this.parent.kids[i] = next;
      this.parent = null;
    },
    // The page reports this to main, which sizes the view to it. Any number will
    // do here; what matters is that an empty stack reports zero.
    getBoundingClientRect() { return { height: this.kids.length * 40 }; },
  };
}

function find(node, id) {
  if (node.id === id) return node;
  for (const kid of node.kids) {
    const hit = find(kid, id);
    if (hit) return hit;
  }
  return null;
}

/** The real banner script, wired to a fake page. */
function mount() {
  const stack = makeNode('div');
  stack.id = 'stack';
  const calls = { markAll: 0, dismissed: [], actions: [], heights: [] };
  let unread = [];

  global.document = {
    createElement: makeNode,
    getElementById: (id) => (id === 'stack' ? stack : find(stack, id)),
  };
  global.window = {
    clawDesktop: {
      notices: async () => unread,
      bannerHeight: (h) => { calls.heights.push(h); },
      markNoticesRead: async () => { calls.markAll += 1; },
      dismissNotice: async (id) => { calls.dismissed.push(id); },
      noticeAction: async (c) => { calls.actions.push(c); },
      onNoticesChanged: () => {},
    },
    addEventListener: () => {},
  };

  // Minus its own boot lines, which would subscribe and render on load.
  const src = fs.readFileSync(SOURCE, 'utf8')
    .replace(/^api\.onNoticesChanged.*$/m, '')
    .replace(/^window\.addEventListener.*$/m, '')
    .replace(/^void render\(\);$/m, '');
  // The script is strict, so eval gives it its own scope: hand the function back
  // explicitly rather than hoping it leaks.
  // eslint-disable-next-line no-eval
  const { render } = eval(`${src}\n;({ render })`);

  return {
    calls,
    render,
    set(next) { unread = next; },
    rows: () => stack.kids.map((n) => n.id || n.className),
    node: (id) => find(stack, id),
  };
}

const failure = { id: 'connection', tone: 'error', message: 'Cannot connect', detail: 'Refused.', dismissible: true };
// The finished update download, the one notice that refuses to be dismissed.
const pinned = { id: 'update-available', tone: 'ok', message: 'Ready to restart', dismissible: false };

test('a dismissible notice gets a way to close the whole bar', () => {
  const b = mount();
  b.set([failure]);
  return b.render().then(() => {
    assert.deepEqual(b.rows(), ['n-connection', 'banner-actions']);
  });
});

test('nothing offers to mark all read when nothing can be', async () => {
  // Otherwise the bar carries a control whose only effect is to do nothing.
  const b = mount();
  b.set([pinned]);
  await b.render();
  assert.deepEqual(b.rows(), ['n-update-available']);
});

test('the close-the-bar row stays at the bottom as cards come and go', async () => {
  const b = mount();
  b.set([pinned]);
  await b.render();
  b.set([pinned, failure]);
  await b.render();
  assert.equal(b.rows()[b.rows().length - 1], 'banner-actions');
});

test('a re-render leaves exactly one close-the-bar row', async () => {
  // The stack is rebuilt by id and this row has no notice behind it, so it is
  // the one node that could stack up unnoticed: three renders, three rows, and
  // a banner that grows every time anything else changes.
  const b = mount();
  b.set([failure]);
  await b.render();
  await b.render();
  await b.render();
  assert.equal(b.rows().filter((r) => r === 'banner-actions').length, 1);
  assert.ok(b.node('n-connection'), 'and the card it sits under survives too');
});

test('pressing it marks everything read, and the card X marks only its own', async () => {
  const b = mount();
  b.set([failure]);
  await b.render();

  await b.node('banner-actions').kids[0].onclick();
  assert.equal(b.calls.markAll, 1);

  const card = b.node('n-connection');
  await card.kids.find((k) => k.className === 'banner__close').onclick();
  assert.deepEqual(b.calls.dismissed, ['connection']);
});

test('a notice that cannot be dismissed is drawn without an X', async () => {
  const b = mount();
  b.set([pinned]);
  await b.render();
  const card = b.node('n-update-available');
  assert.ok(!card.kids.some((k) => k.className === 'banner__close'));
});

test('an empty bar reports zero height, so the view stops eating clicks', async () => {
  // A view swallows every mouse event inside its bounds whatever is drawn there,
  // so a bar that empties without saying so leaves an invisible strip over the
  // Control UI.
  const b = mount();
  b.set([failure]);
  await b.render();
  b.set([]);
  await b.render();
  assert.deepEqual(b.rows(), []);
  assert.equal(b.calls.heights[b.calls.heights.length - 1], 0);
});
