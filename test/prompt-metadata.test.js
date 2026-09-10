'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const metadata = require('../src/prompt-metadata');

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
    send(data) {
      this.sent = data;
    }
  }
  const context = { window: {}, WebSocket: FakeWebSocket };
  vm.runInNewContext(metadata.clientScript(config), context);
  return { context, socket: new FakeWebSocket() };
}

test('the prompt block is bounded and contains the useful desktop facts', () => {
  const block = sampleBlock();
  assert.match(block, /^<claw_desktop_context>\n/);
  assert.match(block, /host: azurepc1 ignored/);
  assert.match(block, /os: Windows 11 Professional \(x64\)/);
  assert.match(block, /user: Abi/);
  assert.match(block, /home: C:\\Users\\Abi/);
  assert.match(block, /locale: en-US/);
  assert.match(block, /timezone: America\/Los_Angeles/);
  assert.match(block, /client: Claw Desktop 1\.2\.3/);
  assert.match(block, /\n<\/claw_desktop_context>$/);
  assert.doesNotMatch(block, /[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
});

test('enabled metadata reaches the actual outbound chat.send frame', () => {
  const block = sampleBlock();
  const { socket } = hookedSocket({ enabled: true, block });
  const original = 'Please inspect the logs.\nKeep this line verbatim.';

  socket.send(JSON.stringify({
    id: 'request-1',
    method: 'chat.send',
    params: { message: original, attachments: [] },
  }));

  const sent = JSON.parse(socket.sent);
  assert.strictEqual(sent.params.message, `${block}\n\n${original}`);
  assert.deepStrictEqual(sent.params.attachments, []);
});

test('disabling metadata leaves the actual outbound prompt unchanged', () => {
  const block = sampleBlock();
  const { context, socket } = hookedSocket({ enabled: true, block });
  vm.runInNewContext(metadata.clientScript({ enabled: false, block }), context);
  const frame = JSON.stringify({
    id: 'request-2',
    method: 'chat.send',
    params: { message: 'Do not decorate this prompt.' },
  });

  socket.send(frame);

  assert.strictEqual(socket.sent, frame);
});

test('the hook ignores commands, other methods, duplicate blocks, and bad frames', () => {
  const block = sampleBlock();
  const { socket } = hookedSocket({ enabled: true, block });
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
