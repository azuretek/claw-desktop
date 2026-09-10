'use strict';

const os = require('node:os');

const BLOCK_START = '<claw_desktop_context>';
const BLOCK_END = '</claw_desktop_context>';
const MAX_VALUE_LENGTH = 256;

/** Keep machine-controlled values on one bounded line inside the prompt block. */
function clean(value, fallback = 'unknown') {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_VALUE_LENGTH);
  return text || fallback;
}

function formatOs({ platform = process.platform, release = os.release(), arch = os.arch() } = {}) {
  const names = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  return `${names[platform] || clean(platform)} ${clean(release)} (${clean(arch)})`;
}

/** Gather only local facts that are useful when an agent reasons about this desktop. */
function collectMetadata({
  appVersion,
  platform = process.platform,
  release = os.release(),
  arch = os.arch(),
  hostname = os.hostname(),
  userInfo = (() => {
    try { return os.userInfo(); } catch { return {}; }
  })(),
  home = (() => {
    try { return os.homedir(); } catch { return ''; }
  })(),
  locale = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return ''; }
  })(),
  timezone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; }
  })(),
} = {}) {
  return {
    host: clean(hostname),
    os: clean(formatOs({ platform, release, arch })),
    user: clean(userInfo.username || process.env.USER || process.env.USERNAME),
    home: clean(home),
    locale: clean(locale),
    timezone: clean(timezone),
    client: clean(appVersion ? `Claw Desktop ${appVersion}` : 'Claw Desktop'),
  };
}

function formatBlock(metadata) {
  return [
    BLOCK_START,
    `host: ${clean(metadata.host)}`,
    `os: ${clean(metadata.os)}`,
    `user: ${clean(metadata.user)}`,
    `home: ${clean(metadata.home)}`,
    `locale: ${clean(metadata.locale)}`,
    `timezone: ${clean(metadata.timezone)}`,
    `client: ${clean(metadata.client)}`,
    BLOCK_END,
  ].join('\n');
}

function shouldInject(message) {
  if (typeof message !== 'string' || !message.trim()) return false;
  // A prefix would stop OpenClaw recognising a slash command as a command.
  if (/^\/\S/.test(message.trimStart())) return false;
  return !message.includes(BLOCK_START);
}

function inject(message, block) {
  return shouldInject(message) && typeof block === 'string' && block
    ? `${block}\n\n${message}`
    : message;
}

/** Transform one WebSocket frame without touching any method except chat.send. */
function transformFrame(data, { enabled, block } = {}) {
  if (!enabled || typeof data !== 'string' || !data.startsWith('{')) return data;
  try {
    const payload = JSON.parse(data);
    if (payload?.method !== 'chat.send' || typeof payload?.params?.message !== 'string') {
      return data;
    }
    const message = inject(payload.params.message, block);
    if (message === payload.params.message) return data;
    payload.params.message = message;
    return JSON.stringify(payload);
  } catch {
    return data;
  }
}

/**
 * Install the frame transformer in the Control UI's main world.
 *
 * Electron's isolated preload cannot replace the page world's WebSocket, so
 * main executes this small hook after each gateway document becomes ready.
 * Re-executing updates the config in place instead of stacking another hook.
 */
function clientScript(config) {
  return `(function() {
    window.__clawDesktopPromptMetadata = ${JSON.stringify(config)};
    if (window.__clawDesktopPromptMetadataInstalled) return;
    window.__clawDesktopPromptMetadataInstalled = true;
    var originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      try {
        var cfg = window.__clawDesktopPromptMetadata;
        if (cfg && cfg.enabled && typeof cfg.block === 'string' && cfg.block && typeof data === 'string' && data.charAt(0) === '{') {
          var payload = JSON.parse(data);
          var message = payload && payload.method === 'chat.send' && payload.params && payload.params.message;
          if (typeof message === 'string' && message.trim() && !/^\\/\\S/.test(message.trimStart()) && message.indexOf('${BLOCK_START}') === -1) {
            payload.params.message = cfg.block + '\\n\\n' + message;
            data = JSON.stringify(payload);
          }
        }
      } catch (error) {}
      return originalSend.call(this, data);
    };

    var originalAddEventListener = WebSocket.prototype.addEventListener;
    WebSocket.prototype.addEventListener = function(type, listener, options) {
      if (type === 'message' && typeof listener === 'function') {
        var originalListener = listener;
        listener = function(event) {
          try {
            if (typeof event.data === 'string' && event.data.indexOf('<claw_desktop_context>') !== -1) {
              var cleanData = event.data.replace(/<claw_desktop_context>[\\s\\S]*?<\\/claw_desktop_context>(?:\\\\n|\\\\r|\\n|\\r)*/g, '');
              Object.defineProperty(event, 'data', { value: cleanData });
            }
          } catch (e) {}
          return originalListener.call(this, event);
        };
      }
      return originalAddEventListener.call(this, type, listener, options);
    };

    var originalMessageSetter = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    if (originalMessageSetter) {
      Object.defineProperty(WebSocket.prototype, 'onmessage', {
        set: function(listener) {
          if (typeof listener === 'function') {
            this.addEventListener('message', listener);
          } else {
            originalMessageSetter.set.call(this, listener);
          }
        },
        get: originalMessageSetter.get
      });
    }
  })();`;
}

module.exports = {
  BLOCK_START,
  BLOCK_END,
  MAX_VALUE_LENGTH,
  clean,
  formatOs,
  collectMetadata,
  formatBlock,
  shouldInject,
  inject,
  transformFrame,
  clientScript,
};
