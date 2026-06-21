// Guard the shared Electron IPC channel registry. These constants are the manual
// review anchor for CodeGraph when it cannot infer string-channel flow.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GODMODE_IPC, GODMODE_IPC_CHANNELS } from '../dist/shared/ipcChannels.js';

test('GodMode IPC channels are unique and namespaced', () => {
  const channels = GODMODE_IPC_CHANNELS;
  assert.equal(channels.length, 49);
  assert.equal(new Set(channels).size, channels.length);
  for (const channel of channels) {
    assert.match(channel, /^godmode:/);
  }
});

test('GodMode IPC channel registry keeps the expected public surface', () => {
  assert.deepEqual(Object.keys(GODMODE_IPC).sort(), [
    'appGet',
    'configGet',
    'githubChanged',
    'githubGet',
    'githubIssueGet',
    'projectBrowse',
    'projectChanged',
    'projectGet',
    'projectSelect',
    'ptyData',
    'ptyExit',
    'ptyResize',
    'ptySend',
    'ptyStart',
    'ptyStarted',
    'ptyStop',
    'ptyWrite',
    'registryGet',
    'runAdoptHead',
    'runBuilderRecoveryChanged',
    'runBuilderRecoveryGet',
    'runBuilderRelaunch',
    'runChanged',
    'runClear',
    'runDiscard',
    'runDispatch',
    'runGet',
    'runHandoffGet',
    'runHandoffSend',
    'runLoopChanged',
    'runLoopGet',
    'runLoopSetMode',
    'runPrConfirm',
    'runPrDiscover',
    'runPrDiscovered',
    'runResume',
    'runResumeChanged',
    'runResumeGet',
    'runReviewerComment',
    'runSelectIssue',
    'runSelectManual',
    'runSendFix',
    'runSetIsolation',
    'runStartReviewers',
    'runSynthesizeReviews',
    'runVerificationChanged',
    'runVerify',
    'worktreeCleanup',
    'worktreeList',
  ]);
});
