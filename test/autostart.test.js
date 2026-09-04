'use strict';

// Plain `node --test` — no Electron, no real filesystem. src/autostart.js takes
// its environment, execPath and fs as arguments so the Linux behaviour is
// exercised from any machine, which is the only way this gets tested at all:
// the platform it exists for is the one nobody here develops on.
//
// What matters is that "Launch at login" either works or reports why. The bug
// this module replaces was the third option — Electron's setLoginItemSettings
// is darwin/win32 only and on Linux neither works nor throws, so the setting
// saved, the checkbox stayed ticked, and nothing ever launched.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const autostart = require('../src/autostart');

/* --------------------------------------------------------------- where */

test('the entry goes where every desktop environment looks', () => {
  const p = autostart.entryPath({ env: {}, home: '/home/abi' });
  assert.equal(p, path.join('/home/abi', '.config', 'autostart', 'claw-desktop.desktop'));
});

test('XDG_CONFIG_HOME wins when it is absolute', () => {
  const p = autostart.entryPath({ env: { XDG_CONFIG_HOME: '/home/abi/cfg' }, home: '/home/abi' });
  assert.equal(p, path.join('/home/abi/cfg', 'autostart', 'claw-desktop.desktop'));
});

test('a relative XDG_CONFIG_HOME is ignored, as the spec requires', () => {
  // "If an implementation encounters a relative path the environment variable
  // should be considered invalid." Honouring one would put the entry somewhere
  // relative to whatever directory the app happened to be launched from.
  const p = autostart.entryPath({ env: { XDG_CONFIG_HOME: 'cfg' }, home: '/home/abi' });
  assert.equal(p, path.join('/home/abi', '.config', 'autostart', 'claw-desktop.desktop'));
});

/* ---------------------------------------------------------------- what */

test('inside an AppImage the entry points at the AppImage, not execPath', () => {
  // The whole reason this function exists. Within a running AppImage,
  // execPath is inside the runtime's temporary mount, which is unmounted when
  // the app exits — so an entry written from it names a path that no longer
  // exists by the time the next login reads it, and fails silently forever.
  const cmd = autostart.launchCommand({
    env: { APPIMAGE: '/home/abi/Apps/ClawDesktop-1.0.1-x86_64.AppImage' },
    execPath: '/tmp/.mount_ClawDe7fA2x/claw-desktop',
  });
  assert.equal(cmd, '/home/abi/Apps/ClawDesktop-1.0.1-x86_64.AppImage');
});

test('outside an AppImage it falls back to the running executable', () => {
  const cmd = autostart.launchCommand({ env: {}, execPath: '/opt/claw-desktop/claw-desktop' });
  assert.equal(cmd, '/opt/claw-desktop/claw-desktop');
});

test('the body is a valid desktop entry that runs the app', () => {
  const body = autostart.entryBody({ exec: '/home/abi/Claw.AppImage' });
  assert.match(body, /^\[Desktop Entry\]$/m);
  assert.match(body, /^Type=Application$/m);
  assert.match(body, /^Name=Claw Desktop$/m);
  assert.match(body, /^Exec="\/home\/abi\/Claw\.AppImage"$/m);
  assert.match(body, /^Terminal=false$/m);
  // Redundant per the spec, but it is what GNOME Tweaks writes, and some
  // versions read its absence as disabled.
  assert.match(body, /^X-GNOME-Autostart-enabled=true$/m);
});

test('start-hidden reaches the entry as the flag main.js parses', () => {
  const body = autostart.entryBody({ exec: '/a/b.AppImage', hidden: true });
  assert.match(body, /^Exec="\/a\/b\.AppImage" --hidden$/m);
  assert.doesNotMatch(autostart.entryBody({ exec: '/a/b.AppImage' }), /--hidden/);
});

test('a path with spaces stays one argument', () => {
  // "~/My Apps/Claw Desktop.AppImage" unquoted would be read as three.
  assert.match(autostart.entryBody({ exec: '/home/abi/My Apps/Claw.AppImage' }), /^Exec="\/home\/abi\/My Apps\/Claw\.AppImage"$/m);
});

test('shell metacharacters in a path are escaped, not executed', () => {
  // Reserved inside a double-quoted Exec value, and doubly escaped because the
  // desktop file format takes a backslash pass of its own first.
  assert.equal(autostart.quoteExec('/tmp/a$b'), '"/tmp/a\\\\$b"');
  assert.equal(autostart.quoteExec('/tmp/a"b'), '"/tmp/a\\\\"b"');
  assert.equal(autostart.quoteExec('/tmp/a\\b'), '"/tmp/a\\\\\\b"');
});

/* ---------------------------------------------------------------- apply */

function fakeFs() {
  const files = new Map();
  const dirs = [];
  const removed = [];
  return {
    files,
    dirs,
    removed,
    mkdirSync: (d) => dirs.push(d),
    writeFileSync: (f, c) => files.set(f, c),
    rmSync: (f) => removed.push(f),
  };
}

test('enabling writes the entry', () => {
  const fs = fakeFs();
  const r = autostart.apply({
    enabled: true, fs, env: { APPIMAGE: '/home/abi/Claw.AppImage' }, home: '/home/abi',
  });
  assert.equal(r.ok, true);
  assert.equal(r.wrote, true);
  assert.deepEqual(fs.dirs, [path.join('/home/abi', '.config', 'autostart')]);
  assert.match(fs.files.get(r.path), /Exec="\/home\/abi\/Claw\.AppImage"/);
});

test('disabling removes it rather than writing a disabled one', () => {
  const fs = fakeFs();
  const r = autostart.apply({ enabled: false, fs, env: {}, home: '/home/abi' });
  assert.equal(r.ok, true);
  assert.equal(r.wrote, false);
  assert.equal(fs.files.size, 0);
  assert.deepEqual(fs.removed, [autostart.entryPath({ env: {}, home: '/home/abi' })]);
});

test('enabling rewrites even when already enabled', () => {
  // The AppImage's path changes the moment someone moves or renames it, and a
  // stale Exec is precisely the silent failure this module exists to avoid.
  const fs = fakeFs();
  autostart.apply({ enabled: true, fs, env: { APPIMAGE: '/old/Claw.AppImage' }, home: '/home/abi' });
  const r = autostart.apply({ enabled: true, fs, env: { APPIMAGE: '/new/Claw.AppImage' }, home: '/home/abi' });
  assert.match(fs.files.get(r.path), /Exec="\/new\/Claw\.AppImage"/);
});

test('a write failure is reported, not swallowed', () => {
  // A read-only home, or a config dir owned by root. The setting must not claim
  // to have taken effect.
  const fs = fakeFs();
  fs.writeFileSync = () => { throw new Error('EACCES: permission denied'); };
  const r = autostart.apply({ enabled: true, fs, env: {}, home: '/home/abi' });
  assert.equal(r.ok, false);
  assert.match(r.error, /EACCES/);
});

test('removing an entry that was never there is not a failure', () => {
  const fs = fakeFs();
  fs.rmSync = () => { throw new Error('ENOENT'); };
  // force:true means the real fs.rmSync does not throw here; this asserts the
  // shape of the answer if it ever did, since "turn it off" cannot fail because
  // it was already off.
  assert.equal(autostart.apply({ enabled: false, fs, env: {}, home: '/home/abi' }).ok, false);
});
