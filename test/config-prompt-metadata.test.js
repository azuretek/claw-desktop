'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function loadConfig(userData) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => userData } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../src/config')];
    return require('../src/config');
  } finally {
    Module._load = originalLoad;
  }
}

test('prompt metadata defaults off and an explicit choice persists', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-prompt-metadata-'));
  const config = loadConfig(userData);

  assert.strictEqual(config.get().promptMetadata, false);
  config.update({ promptMetadata: true });
  assert.strictEqual(config.get().promptMetadata, true);

  const written = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  assert.strictEqual(written.promptMetadata, true);
});
