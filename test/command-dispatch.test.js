// Renderer-level send-control path (issue #57). The AgentPane "Message <role>"
// control delegates its delivery + next-input-state decision to the pure
// `deliverRoleMessage` helper, so exercising it here proves the renderer behavior
// (clear only on confirmed write; preserve text + surface a reason otherwise)
// without a DOM or live Electron. Run via `npm test` (builds shared first).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composePtyMessage, deliverRoleMessage, PTY_SUBMIT_CHAR } from '../dist/shared/commandDispatch.js';

test('composePtyMessage appends exactly one submit character', () => {
  assert.equal(composePtyMessage('run tests'), `run tests${PTY_SUBMIT_CHAR}`);
  assert.equal(PTY_SUBMIT_CHAR, '\r');
});

test('successful delivery sends exact text + submit char and clears the field', async () => {
  const sent = [];
  const send = async (input) => {
    sent.push(input);
    return { ok: true, paneId: input.paneId, bytes: Buffer.byteLength(input.data) };
  };
  const outcome = await deliverRoleMessage('builder', 'npm test', send);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { paneId: 'builder', data: 'npm test\r' });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.nextValue, ''); // field cleared only on confirmed write
  assert.equal(outcome.error, null);
});

test('no-live-session failure preserves the text and surfaces the reason', async () => {
  // Regression guard: an enabled send must not look delivered when nothing wrote.
  const send = async (input) => ({
    ok: false,
    paneId: input.paneId,
    code: 'no_live_session',
    error: 'No live reviewer_a session to deliver to. Start (or restart) the session and retry.',
  });
  const outcome = await deliverRoleMessage('reviewer_a', 're-review latest commit', send);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.nextValue, 're-review latest commit'); // text retained for retry
  assert.match(outcome.error, /No live reviewer_a session/);
});

test('whitespace-only input is a no-op: no send, no error, text retained', async () => {
  let called = false;
  const send = async () => {
    called = true;
    return { ok: true, paneId: 'builder', bytes: 0 };
  };
  const outcome = await deliverRoleMessage('builder', '   ', send);
  assert.equal(called, false);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.nextValue, '   ');
  assert.equal(outcome.error, null);
});

test('a missing bridge (undefined result) reports unavailable and keeps the text', async () => {
  const outcome = await deliverRoleMessage('head', 'status?', async () => undefined);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.nextValue, 'status?');
  assert.match(outcome.error, /unavailable/i);
});

test('a thrown send is caught and surfaced without clearing the field', async () => {
  const outcome = await deliverRoleMessage('head', 'status?', async () => {
    throw new Error('ipc exploded');
  });
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.nextValue, 'status?');
  assert.match(outcome.error, /ipc exploded/);
});
