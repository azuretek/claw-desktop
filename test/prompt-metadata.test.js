'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const metadata = require('../src/prompt-metadata');

// The exact token OpenClaw owns. Pinned as a literal so any drift is a
// deliberate edit rather than a silent divergence from the gateway's stripper.
const MARKER = '\u27E6openclaw:ctx\u27E7';

function sampleBlock() {
  return metadata.formatBlock(metadata.collectMetadata({
    appVersion: '1.2.3',
    platform: 'win32',
    release: '11\nProfessional',
    arch: 'x64',
    hostname: 'azurepc1\rignored',
    userInfo: { username: 'Abi' },
    home: 'C:\\Users\\Abi',
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
  }));
}

function hookedSocket(config) {
  class FakeWebSocket {
    send(data) { this.sent = data; }
  }
  const context = { window: {}, WebSocket: FakeWebSocket };
  vm.runInNewContext(metadata.clientScript(config), context);
  return new FakeWebSocket();
}

/* ------------------------------------------------------- the gateway contract */

test('the header ends with the marker, which is what makes the gateway strip it', () => {
  const block = sampleBlock();
  const [header] = block.split('\n');
  assert.strictEqual(header, `Desktop client context: ${MARKER}`);
  assert.ok(header.endsWith(MARKER), 'stripper only matches a header ENDING in the marker');
  assert.ok(header.length > MARKER.length, 'a bare marker line is not a header');
});

test('the block is bounded, single-line per field, and cannot forge a header', () => {
  const block = sampleBlock();
  const lines = block.split('\n');
  // Only the first line carries the marker, so nothing in a value can extend the block.
  assert.strictEqual(lines.filter((line) => line.includes(MARKER)).length, 1);
  assert.deepStrictEqual(
    lines.slice(1).map((line) => line.split(':')[0]),
    ['host', 'os', 'user', 'home', 'locale', 'timezone', 'client'],
  );
  assert.match(block, /host: azurepc1 ignored/);
  assert.match(block, /os: Windows 11 Professional \(x64\)/);
  assert.match(block, /home: C:\\Users\\Abi/);
  assert.doesNotMatch(block, /[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  for (const line of lines.slice(1)) {
    assert.ok(line.length < metadata.MAX_VALUE_LENGTH + 32, `unbounded line: ${line}`);
  }
});

test('a value carrying the marker is neutralised instead of adding a second header', () => {
  const block = metadata.formatBlock({
    host: `evil ${MARKER}`, os: 'x', user: 'u', home: 'h', locale: 'l', timezone: 't', client: 'c',
  });
  assert.strictEqual(block.split('\n').filter((l) => l.includes(MARKER)).length, 1);
});

test('the prompt is separated from the block by the blank line the stripper needs', () => {
  const block = sampleBlock();
  const injected = metadata.inject('what time is it?', block);
  assert.strictEqual(injected, `${block}\n\nwhat time is it?`);
  // A prose block runs until a blank line, so the separator is load-bearing.
  assert.ok(injected.startsWith(`${block}\n\n`));
});

/* ------------------------------------------------------------ outbound frames */

test('enabled metadata reaches the actual outbound chat.send frame', () => {
  const block = sampleBlock();
  const socket = hookedSocket({ enabled: true, block });
  const original = 'Please inspect the logs.\nKeep this line verbatim.';

  socket.send(JSON.stringify({
    id: 'request-1',
    method: 'chat.send',
    params: { message: original, attachments: [] },
  }));

  const sent = JSON.parse(socket.sent);
  assert.strictEqual(sent.params.message, `${block}\n\n${original}`);
  assert.ok(sent.params.message.includes(MARKER));
  assert.deepStrictEqual(sent.params.attachments, []);
});

test('disabling metadata leaves the actual outbound prompt unchanged', () => {
  const frame = JSON.stringify({
    id: 'request-2',
    method: 'chat.send',
    params: { message: 'Do not decorate this prompt.' },
  });
  const socket = hookedSocket({ enabled: false, block: sampleBlock() });

  socket.send(frame);

  assert.strictEqual(socket.sent, frame);
});

test('the hook ignores commands, other methods, duplicate blocks, and bad frames', () => {
  const block = sampleBlock();
  const socket = hookedSocket({ enabled: true, block });
  const frames = [
    'not json',
    JSON.stringify({ method: 'chat.history', params: { message: 'hello' } }),
    JSON.stringify({ method: 'chat.send', params: { message: '/status' } }),
    JSON.stringify({ method: 'chat.send', params: { message: `${block}\n\nhello` } }),
  ];

  for (const frame of frames) {
    socket.send(frame);
    assert.strictEqual(socket.sent, frame);
  }
});

test('the pure frame transformer follows the same enabled and disabled contract', () => {
  const block = sampleBlock();
  const frame = JSON.stringify({ method: 'chat.send', params: { message: 'hello' } });
  assert.strictEqual(metadata.transformFrame(frame, { enabled: false, block }), frame);
  assert.strictEqual(
    JSON.parse(metadata.transformFrame(frame, { enabled: true, block })).params.message,
    `${block}\n\nhello`,
  );
});

/* ------------------------------------------- outbound only, by design */

test('the hook rewrites outbound frames only, because the gateway does the hiding', () => {
  const script = metadata.clientScript({ enabled: true, block: sampleBlock() });
  // A second owner for display suppression would hide the block for this
  // app's users alone and drift from the gateway's own stripper.
  assert.doesNotMatch(script, /addEventListener/);
  assert.doesNotMatch(script, /onmessage/);
  assert.doesNotMatch(script, /claw_desktop_context/);
  assert.match(script, /WebSocket\.prototype\.send/);
});

/* -------------------------------------------------------------- settings wiring */

test('the settings toggle is wired from the page through main to the gateway page', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src', 'ui', 'settings.html'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'src', 'ui', 'settings.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

  assert.match(html, /<input type="checkbox" id="promptMetadata">/);
  assert.match(settings, /\$\('promptMetadata'\)\.checked = s\.promptMetadata/);
  assert.match(settings, /promptMetadata: \$\('promptMetadata'\)\.checked/);
  assert.match(main, /promptMetadata\.clientScript\(promptMetadataConfig\(\)\)/);
  assert.match(main, /dom-ready[\s\S]*?installPromptMetadata\(wc\)/);
  assert.match(main, /app:save-settings[\s\S]*?installPromptMetadata\(page\(\)\)/);
});
