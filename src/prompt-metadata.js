'use strict';

const os = require('node:os');

// The marker OpenClaw already owns for inbound context.
//
// Adopting it is what lets the gateway strip this block for us. OpenClaw's
// stripInboundMetadata removes any block whose HEADER LINE ENDS WITH this token,
// from user-facing and display text and from replayed past turns, while the
// active turn keeps its metadata so the model still sees the block on the turn
// it was sent. That is the same contract the gateway's own "Conversation info"
// block rides on, so this app needs no upstream change and no code of its own
// to suppress the block once it has been displayed.
//
// Two shape rules come from that stripper and are load-bearing:
//   1. the header must END with the marker, and
//   2. a prose block runs until a blank line, so the prompt must be separated
//      from the block by one. `inject` owns that separator.
const CONTEXT_MARKER = '\u27E6openclaw:ctx\u27E7';
const CONTEXT_HEADER = `Desktop client context: ${CONTEXT_MARKER}`;
const MAX_VALUE_LENGTH = 256;

/** Keep machine-controlled values on one bounded line inside the prompt block. */
function clean(value, fallback = 'unknown') {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    // Angle brackets and the marker itself are neutralised so no value can
    // forge a header line or close the block early.
    .replace(/</g, '\u2039')
    .replace(/>/g, '\u203A')
    .split(CONTEXT_MARKER)
    .join(' ')
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
    CONTEXT_HEADER,
    `host: ${clean(metadata.host)}`,
    `os: ${clean(metadata.os)}`,
    `user: ${clean(metadata.user)}`,
    `home: ${clean(metadata.home)}`,
    `locale: ${clean(metadata.locale)}`,
    `timezone: ${clean(metadata.timezone)}`,
    `client: ${clean(metadata.client)}`,
  ].join('\n');
}

function shouldInject(message) {
  if (typeof message !== 'string' || !message.trim()) return false;
  // A prefix would stop OpenClaw recognising a slash command as a command.
  if (/^\/\S/.test(message.trimStart())) return false;
  return !message.includes(CONTEXT_HEADER);
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
    if (payload?.method !== 'chat.send' || typeof payload.params?.message !== 'string') {
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
 * Install the outbound frame transformer in the Control UI's main world.
 *
 * Electron's isolated preload cannot replace the page world's WebSocket, so
 * main executes this small hook after each gateway document becomes ready.
 * Re-executing updates the config in place instead of stacking another hook.
 *
 * Outbound only, deliberately. An earlier revision also rewrote INCOMING frames
 * to hide the block, which is now the gateway's job because the block carries
 * the marker above. Rewriting inbound frames here would put a second owner on
 * that behaviour and would hide the block from this app's users alone.
 */
function clientScript(config) {
  return `(function() {
    window.__clawDesktopPromptMetadata = ${JSON.stringify(config)};
    if (window.__clawDesktopPromptMetadataInstalled) return;
    window.__clawDesktopPromptMetadataInstalled = true;
    var header = ${JSON.stringify(CONTEXT_HEADER)};
    var originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      try {
        var cfg = window.__clawDesktopPromptMetadata;
        if (cfg && cfg.enabled && typeof cfg.block === 'string' && cfg.block && typeof data === 'string' && data.charAt(0) === '{') {
          var payload = JSON.parse(data);
          var message = payload && payload.method === 'chat.send' && payload.params && payload.params.message;
          if (typeof message === 'string' && message.trim() && !/^\\/\\S/.test(message.trimStart()) && message.indexOf(header) === -1) {
            payload.params.message = cfg.block + '\\n\\n' + message;
            data = JSON.stringify(payload);
          }
        }
      } catch (error) {}
      return originalSend.call(this, data);
    };
  })();`;
}

module.exports = {
  CONTEXT_MARKER,
  CONTEXT_HEADER,
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
