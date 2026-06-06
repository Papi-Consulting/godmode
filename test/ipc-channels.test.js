// Guard the shared Electron IPC channel registry. These constants are the manual
// review anchor for CodeGraph when it cannot infer string-channel flow.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GODMODE_IPC } from '../dist/shared/ipcChannels.js';

test('GodMode IPC channels are unique and namespaced', () => {
  const channels = Object.values(GODMODE_IPC);
  assert.equal(new Set(channels).size, channels.length);
  for (const channel of channels) {
    assert.match(channel, /^godmode:/);
  }
});
