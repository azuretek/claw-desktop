'use strict';

// Plain `node --test` — no Electron. src/menus.js takes `platform` as a
// parameter for exactly this reason, so all three menu bars are built and
// compared in one run on one machine.
//
// The rule under test: every command this app has is on every platform, in the
// same menu, under the same label. Nobody can check that by looking, because
// checking means running three builds side by side, and the person adding a menu
// item has one of them open.
//
// Run with: npm test

const test = require('node:test');
const assert = require('node:assert');

const menus = require('../src/menus');

const PLATFORMS = ['darwin', 'win32', 'linux'];

const noop = () => {};

/** Stand-in commands: real labels, since labels are what is being compared. */
const commands = () => Object.fromEntries(
  menus.COMMANDS.map((id) => [id, { label: `label:${id}`, click: noop }]),
);

const build = (platform) => menus.template({ platform, appName: 'Claw Desktop', commands: commands() });

/** The shared menus, i.e. everything but the macOS application menu. */
const shared = (platform) => build(platform).filter((m) => menus.SHARED_MENUS.includes(m.label));

/* ------------------------------------------------------------- the same everywhere */

test('File, Edit, View, Window and Help are identical on every platform', () => {
  const [first, ...rest] = PLATFORMS.map((p) => menus.labelsOf(shared(p)));
  for (const [i, labels] of rest.entries()) {
    assert.deepEqual(labels, first, `${PLATFORMS[i + 1]} differs from ${PLATFORMS[0]}`);
  }
});

test('every platform offers every command', () => {
  for (const platform of PLATFORMS) {
    const labels = menus.labelsOf(build(platform)).join('\n');
    for (const id of menus.COMMANDS) {
      assert.match(labels, new RegExp(`label:${id}$`, 'm'), `${platform} is missing "${id}"`);
    }
  }
});

test('the menus themselves are in the same order everywhere', () => {
  const [first, ...rest] = PLATFORMS.map((p) => shared(p).map((m) => m.label));
  assert.deepEqual(first, menus.SHARED_MENUS);
  for (const order of rest) assert.deepEqual(order, first);
});

/* ------------------------------------------------- what About and updates need */

test('About and Check for updates are both in Help, on every platform', () => {
  // The whole reason this file exists. They used to be in the macOS application
  // menu and in the Windows File menu, so neither platform's user could be told
  // where they were, and on Windows the menu bar is hidden behind Alt anyway.
  for (const platform of PLATFORMS) {
    const labels = menus.labelsOf(build(platform));
    assert.ok(labels.includes('Help > label:about'), `${platform}`);
    assert.ok(labels.includes('Help > label:checkUpdates'), `${platform}`);
  }
});

/* ------------------------------------------------- what the OS makes different */

test('only macOS has an application menu, and it comes first', () => {
  const mac = build('darwin');
  assert.equal(mac[0].label, 'Claw Desktop', 'macOS turns the first menu into the application menu');
  for (const platform of ['win32', 'linux']) {
    assert.equal(build(platform)[0].label, 'File');
  }
});

test('the application menu repeats commands rather than owning them', () => {
  // A Mac user looks for About and Quit under the app name; everyone else looks
  // in Help and File. Both are true at once, which is why the copies exist.
  const appMenu = build('darwin')[0].submenu.filter((i) => i.label).map((i) => i.label);
  const elsewhere = menus.labelsOf(shared('darwin')).map((l) => l.split(' > ')[1]);
  for (const label of appMenu) {
    assert.ok(elsewhere.includes(label), `"${label}" is only in the application menu`);
  }
});

test('a command in two menus carries its accelerator in exactly one', () => {
  // Two menu items sharing an accelerator is not an error in Electron, it is
  // just undefined which one fires — worth catching rather than shipping.
  for (const platform of PLATFORMS) {
    const seen = new Map();
    for (const menu of build(platform)) {
      for (const item of menu.submenu || []) {
        if (!item.accelerator) continue;
        const before = seen.get(item.accelerator);
        assert.equal(before, undefined, `${platform}: ${item.accelerator} is on both "${before}" and "${item.label}"`);
        seen.set(item.accelerator, item.label);
      }
    }
  }
});

test('macOS keeps the platform shortcuts for Settings and Quit', () => {
  const appMenu = build('darwin')[0].submenu;
  const accel = (id) => appMenu.find((i) => i.label === `label:${id}`)?.accelerator;
  assert.equal(accel('settings'), 'Cmd+,');
  assert.equal(accel('quit'), 'Cmd+Q');
});

test('a missing command is a build error, not a silently absent menu item', () => {
  const short = commands();
  delete short.about;
  assert.throws(
    () => menus.template({ platform: 'win32', appName: 'Claw Desktop', commands: short }),
    /no command "about"/,
  );
});
