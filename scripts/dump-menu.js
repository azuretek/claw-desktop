/**
 * Print the menu bar and tray menu as Electron actually resolves them, as JSON.
 *
 * The parity test in test/menus.test.js compares the *template* across
 * platforms. That cannot see a role that a given OS declines to render: roles
 * carry no label of ours, so `labelsOf` skips them by design, and several roles
 * (`zoom`, `front`, `window`) are documented as macOS-only. A menu can
 * therefore pass the template test and still come out shorter on Linux.
 *
 * This runs the real Electron, builds the real Menu, and prints what the OS
 * resolved — including the labels Electron supplies for roles. Run it on each
 * platform and diff the output; that difference is the user-visible one.
 *
 * Usage:  electron scripts/dump-menu.js            (needs a display; Xvfb is fine)
 */
'use strict';

const { app, Menu } = require('electron');
const menus = require('../src/menus');

/** Every command the template asks for, stubbed with its id as the label. */
function stubCommands() {
  const out = {};
  for (const id of menus.COMMANDS) out[id] = { label: id, click() {} };
  return out;
}

/** A resolved Electron MenuItem, reduced to what a user can perceive. */
function describe(item) {
  const out = {
    label: item.label,
    type: item.type,
    role: item.role || null,
    accelerator: item.accelerator || item.userAccelerator || null,
    enabled: item.enabled,
    visible: item.visible,
  };
  if (item.submenu) out.submenu = item.submenu.items.map(describe);
  return out;
}

app.whenReady().then(() => {
  const menu = Menu.buildFromTemplate(
    menus.template({ platform: process.platform, appName: app.name, commands: stubCommands() }),
  );

  console.log(JSON.stringify({
    platform: process.platform,
    electron: process.versions.electron,
    menu: menu.items.map(describe),
  }, null, 2));

  app.exit(0);
});
