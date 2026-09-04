'use strict';

// The menu bar's shape, for every platform, with no Electron in it.
//
// It lives in its own module for the same reason updates.js does: so one
// `node --test` run can assert something about all three platforms at once. What
// it asserts is the rule this file exists to hold — every command this app has
// is on every platform it runs on, in the same menu, under the same label.
//
// That rule is easy to break by accident and impossible to notice, because the
// person adding a menu item is looking at one platform. "Check for updates…"
// spent its whole life in File on Windows and in the application menu on macOS,
// which is how a build with a working updater came to look like one with no
// updater in it.
//
// The differences that remain are the operating system's, not ours:
//
//   application menu  macOS turns the FIRST menu into the application menu and
//                     titles it with the app name, so one has to exist and has
//                     to be first. It repeats About, Settings and Quit, because
//                     that is where a Mac user looks for them. All three are
//                     also in File and Help, which is where everyone else looks.
//   roles             services, hide, hideOthers, unhide and front are macOS
//                     features with no Windows or Linux counterpart. None of our
//                     commands is behind one, and none of them carries a label,
//                     which is why labelsOf() below can ignore them.
//   accelerators      a command that appears in two menus on macOS may carry its
//                     key in only one of them, or which copy fires is anyone's
//                     guess. The application menu wins, being the copy the
//                     platform convention points at.

/** Every command the menu bar offers. The caller supplies label and click. */
const COMMANDS = [
  'about',
  'checkUpdates',
  'releaseNotes',
  'settings',
  'reload',
  'reconnect',
  'clearCache',
  'quit',
  'zoomIn',
  'zoomOut',
  'actualSize',
  'devTools',
];

/**
 * The menus every platform has, in order.
 *
 * macOS adds one in front of these — see the application menu note above — and
 * that is the only menu any platform does not share.
 */
const SHARED_MENUS = ['File', 'Edit', 'View', 'Window', 'Help'];

/**
 * The menu template, ready for Menu.buildFromTemplate.
 *
 * @param {object} opts
 * @param {string} opts.platform  process.platform
 * @param {string} opts.appName   app.name, which macOS shows as the first menu
 * @param {Record<string, {label: string, click: Function}>} opts.commands
 */
function template({ platform, appName, commands }) {
  const isMac = platform === 'darwin';

  // A command, optionally carrying its accelerator. `key` is passed only to the
  // copy that owns it; the other copy is the same item without a shortcut.
  const cmd = (id, accelerator) => {
    const item = commands[id];
    if (!item) throw new Error(`no command "${id}"`);
    return accelerator ? { ...item, accelerator } : { ...item };
  };
  const sep = { type: 'separator' };

  return [
    // macOS only, and first: the OS builds this one whatever we do.
    ...(isMac ? [{
      label: appName,
      submenu: [
        cmd('about'),
        cmd('checkUpdates'),
        sep,
        cmd('settings', 'Cmd+,'),
        sep,
        { role: 'services' },
        sep,
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        sep,
        cmd('quit', 'Cmd+Q'),
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        // On macOS the application menu above owns both shortcuts.
        cmd('settings', isMac ? null : 'Ctrl+,'),
        sep,
        cmd('reload', 'CmdOrCtrl+R'),
        cmd('reconnect', 'CmdOrCtrl+Shift+R'),
        cmd('clearCache'),
        sep,
        { role: 'close' },
        cmd('quit', isMac ? null : 'Ctrl+Q'),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, sep,
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        cmd('zoomIn', 'CmdOrCtrl+Plus'),
        cmd('zoomOut', 'CmdOrCtrl+-'),
        cmd('actualSize', 'CmdOrCtrl+0'),
        sep,
        { role: 'togglefullscreen' },
        // The same command, under each platform's own binding for it.
        cmd('devTools', isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I'),
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [sep, { role: 'front' }] : [])],
    },
    {
      label: 'Help',
      submenu: [cmd('about'), cmd('checkUpdates'), sep, cmd('releaseNotes')],
    },
  ];
}

/**
 * Every label in a template, as `Menu > Item`.
 *
 * Only our own items have labels — an Electron role renders the OS's own string
 * — so this is exactly the set of commands we put on a platform, which is the
 * thing that must not differ between them. The menu name is included because a
 * command moving between menus is the drift that actually happened.
 */
function labelsOf(menuTemplate) {
  const out = [];
  for (const menu of menuTemplate) {
    for (const item of menu.submenu || []) {
      if (item.label) out.push(`${menu.label} > ${item.label}`);
    }
  }
  return out;
}

module.exports = { COMMANDS, SHARED_MENUS, template, labelsOf };
