// Tests for the automatic review/fix loop controller (issue #39). The pure
// decision core is exercised exhaustively; the stateful controller is driven with
// injected fakes so chaining, actor attribution, halting (no retry loop), the
// single transient retry, and the fix-commit watcher are all verified without
// Electron, PTYs, or live `gh`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  captureLoopStageGeneration,
  configureLoopController,
  decideLoopAction,
  detectFixLanded,
  getLoopState,
  isFixWatcherActive,
  isLoopStageGenerationStale,
  isLoopStopStatus,
  notifyFixDelivered,
  preemptLoopStages,
  resetLoopController,
  reviewersTerminal,
  setLoopMode,
  tickLoop,
} from '../dist/main/loop.js';

/** Build a minimal run snapshot carrying just the fields the loop reads. */
function makeRun(overrides = {}) {
  return {
    id: 'run-1',
    status: 'pr_opened',
    cycle: 1,
    maxCycles: 3,
    branch: 'feat/x',
    expectedCommit: 'abc1234',
    reviewers: undefined,
    ...overrides,
  };
}

function reviewer(status) {
  return { reviewerId: 'reviewer-a', paneId: 'reviewer_a', status, sessionToken: 't', displayName: 'A' };
}

const CTX_MANUAL = { autoSendFix: false, fixDelivered: false };

// --- Pure decision core ------------------------------------------------------

test('manual mode is always idle/inactive regardless of status', () => {
  for (const status of ['pr_opened', 'reviewers_running', 'builder_fixing', 'fix_pushed']) {
    const decision = decideLoopAction(makeRun({ status }), 'manual', CTX_MANUAL);
    assert.equal(decision.kind, 'idle');
    assert.equal(decision.waitingOn, 'inactive');
  }
});

test('auto mode with no run is idle', () => {
  const decision = decideLoopAction(null, 'auto', CTX_MANUAL);
  assert.equal(decision.kind, 'idle');
  assert.equal(decision.waitingOn, 'inactive');
});

test('auto: pr_opened launches reviewers', () => {
  const decision = decideLoopAction(makeRun({ status: 'pr_opened' }), 'auto', CTX_MANUAL);
  assert.equal(decision.kind, 'act');
  assert.equal(decision.action, 'start_reviewers');
});

test('auto: pre-PR statuses wait for a verified PR', () => {
  for (const status of ['idle', 'issue_selected', 'needs_spec', 'ready_to_build', 'builder_running']) {
    const decision = decideLoopAction(makeRun({ status }), 'auto', CTX_MANUAL);
    assert.equal(decision.kind, 'wait');
    assert.equal(decision.waitingOn, 'waiting_pr');
  }
});

test('auto: synthesize only once both reviewers are terminal', () => {
  const running = makeRun({ status: 'reviewers_running', reviewers: [reviewer('running'), reviewer('completed')] });
  assert.equal(decideLoopAction(running, 'auto', CTX_MANUAL).waitingOn, 'waiting_reviewers');

  const done = makeRun({ status: 'reviewers_running', reviewers: [reviewer('completed'), reviewer('comment_posted')] });
  const decision = decideLoopAction(done, 'auto', CTX_MANUAL);
  assert.equal(decision.kind, 'act');
  assert.equal(decision.action, 'synthesize');
});

test('auto: a failed reviewer still counts as terminal (does not block synthesis)', () => {
  const run = makeRun({ status: 'reviewers_rerunning', reviewers: [reviewer('failed'), reviewer('completed')] });
  assert.equal(decideLoopAction(run, 'auto', CTX_MANUAL).action, 'synthesize');
});

test('auto: review_synthesis holds (controller never forces a held gate forward)', () => {
  const decision = decideLoopAction(makeRun({ status: 'review_synthesis' }), 'auto', CTX_MANUAL);
  assert.equal(decision.kind, 'wait');
  assert.equal(decision.waitingOn, 'synthesis_hold');
});

test('auto: builder_fixing waits for operator approval when autoSendFix is off', () => {
  const decision = decideLoopAction(makeRun({ status: 'builder_fixing' }), 'auto', {
    autoSendFix: false,
    fixDelivered: false,
  });
  assert.equal(decision.kind, 'wait');
  assert.equal(decision.waitingOn, 'waiting_fix_approval');
});

test('auto: builder_fixing auto-sends only when autoSendFix is on', () => {
  const decision = decideLoopAction(makeRun({ status: 'builder_fixing' }), 'auto', {
    autoSendFix: true,
    fixDelivered: false,
  });
  assert.equal(decision.kind, 'act');
  assert.equal(decision.action, 'send_fix');
});

test('auto: once a fix is delivered the loop watches the PR for the commit', () => {
  const decision = decideLoopAction(makeRun({ status: 'builder_fixing' }), 'auto', {
    autoSendFix: true,
    fixDelivered: true,
  });
  assert.equal(decision.kind, 'wait');
  assert.equal(decision.waitingOn, 'watching_fix_commit');
});

test('auto: fix_pushed relaunches reviewers', () => {
  const decision = decideLoopAction(makeRun({ status: 'fix_pushed' }), 'auto', CTX_MANUAL);
  assert.equal(decision.kind, 'act');
  assert.equal(decision.action, 'start_reviewers');
});

test('auto: stops at merge_ready / needs_human / max_cycles_exceeded / paused / terminal', () => {
  for (const status of ['merge_ready', 'needs_human', 'max_cycles_exceeded', 'paused', 'cancelled', 'closed', 'karan_merged', 'agent_failed']) {
    const decision = decideLoopAction(makeRun({ status }), 'auto', CTX_MANUAL);
    assert.equal(decision.kind, 'stop', `expected stop for ${status}`);
    assert.equal(decision.waitingOn, 'stopped');
    assert.ok(isLoopStopStatus(status));
  }
});

// --- reviewersTerminal -------------------------------------------------------

test('reviewersTerminal: empty/absent reviewers are not terminal', () => {
  assert.equal(reviewersTerminal(makeRun({ reviewers: [] })), false);
  assert.equal(reviewersTerminal(makeRun({ reviewers: undefined })), false);
});

test('reviewersTerminal: a still-launching/running reviewer keeps it non-terminal', () => {
  assert.equal(reviewersTerminal(makeRun({ reviewers: [reviewer('launching'), reviewer('completed')] })), false);
  assert.equal(reviewersTerminal(makeRun({ reviewers: [reviewer('completed'), reviewer('comment_posted')] })), true);
});

// --- detectFixLanded ---------------------------------------------------------

function verification(overrides = {}) {
  return {
    status: 'verified',
    partial: false,
    pr: { number: 7, headSha: 'def5678abcdef', headRefName: 'feat/x' },
    ...overrides,
  };
}

test('detectFixLanded: a partial query never looks like a landed fix', () => {
  assert.deepEqual(detectFixLanded(makeRun(), verification({ partial: true })), { landed: false });
});

test('detectFixLanded: no PR / no baseline commit / matching head all mean not-landed', () => {
  assert.deepEqual(detectFixLanded(makeRun(), verification({ pr: null })), { landed: false });
  assert.deepEqual(detectFixLanded(makeRun({ expectedCommit: undefined }), verification()), { landed: false });
  // Head matches the recorded baseline => no new commit yet.
  const same = verification({ pr: { number: 7, headSha: 'abc1234', headRefName: 'feat/x' } });
  assert.deepEqual(detectFixLanded(makeRun({ expectedCommit: 'abc1234' }), same), { landed: false });
});

test('detectFixLanded: a new head SHA beyond the baseline is a landed fix', () => {
  const result = detectFixLanded(makeRun({ expectedCommit: 'abc1234' }), verification());
  assert.equal(result.landed, true);
  assert.equal(result.headSha, 'def5678abcdef');
});

// --- Stateful controller -----------------------------------------------------

/** A controllable fake harness for the controller. */
function makeHarness(opts = {}) {
  const calls = { startReviewers: [], synthesize: [], sendFix: 0, dispatch: [] };
  // Note: `opts.run` may be explicitly null (no run) — don't coalesce it away.
  const state = { run: opts.run !== undefined ? opts.run : makeRun() };
  let watchFn = null;
  const deps = {
    getRun: () => state.run,
    defaultAuto: () => opts.defaultAuto ?? true,
    autoSendFix: () => opts.autoSendFix ?? false,
    startReviewers: async (actor) => {
      calls.startReviewers.push(actor);
      if (opts.onStartReviewers) return opts.onStartReviewers(state, actor);
      state.run = { ...state.run, status: 'reviewers_running', reviewers: [reviewer('running')] };
      return { ok: true };
    },
    synthesize: async (actor) => {
      calls.synthesize.push(actor);
      if (opts.onSynthesize) return opts.onSynthesize(state, actor);
      state.run = { ...state.run, status: 'merge_ready' };
      return { ok: true };
    },
    sendFix: async () => {
      calls.sendFix += 1;
      return { ok: true };
    },
    dispatch: (action, options) => {
      calls.dispatch.push({ action, options });
      if (action === 'push_fix') state.run = { ...state.run, status: 'fix_pushed', expectedCommit: options.expectedCommit };
      return { ok: true };
    },
    verifyForFix: opts.verifyForFix ?? (async () => opts.verification ?? verification()),
    emitLoopChanged: () => {},
    emitRunChanged: () => {},
    now: () => '2026-06-14T00:00:00.000Z',
    setWatchTimer: (fn) => {
      watchFn = fn;
      return { id: 1 };
    },
    clearWatchTimer: () => {
      watchFn = null;
    },
    log: () => {},
  };
  return { deps, calls, state, runWatch: () => watchFn && watchFn() };
}

test('manual default: controller is a no-op (regression-safe)', async () => {
  const h = makeHarness({ defaultAuto: false, run: makeRun({ status: 'pr_opened' }) });
  configureLoopController(h.deps);
  await tickLoop();
  assert.equal(h.calls.startReviewers.length, 0);
  assert.equal(getLoopState().mode, 'manual');
  resetLoopController();
});

test('auto: chains pr_opened -> reviewers -> (reviewers exit) -> synthesis -> merge_ready', async () => {
  const h = makeHarness({ defaultAuto: true, run: makeRun({ status: 'pr_opened' }) });
  configureLoopController(h.deps);
  await tickLoop();
  // pr_opened -> start_reviewers, then waits for reviewer exits.
  assert.deepEqual(h.calls.startReviewers, ['loop']);
  assert.equal(h.state.run.status, 'reviewers_running');
  assert.equal(getLoopState().waitingOn, 'waiting_reviewers');

  // Simulate both reviewers exiting, then a reviewer-exit-driven tick.
  h.state.run = { ...h.state.run, reviewers: [reviewer('completed')] };
  await tickLoop();
  assert.deepEqual(h.calls.synthesize, ['loop']);
  assert.equal(h.state.run.status, 'merge_ready');
  assert.equal(getLoopState().waitingOn, 'stopped');
  resetLoopController();
});

test('auto: every controller-driven stage is attributed to the loop actor', async () => {
  const h = makeHarness({
    defaultAuto: true,
    run: makeRun({ status: 'reviewers_running', reviewers: [reviewer('completed')] }),
  });
  configureLoopController(h.deps);
  await tickLoop();
  assert.deepEqual(h.calls.synthesize, ['loop']);
  resetLoopController();
});

test('auto: a non-transient stage failure halts without a retry loop', async () => {
  const h = makeHarness({
    defaultAuto: true,
    run: makeRun({ status: 'pr_opened' }),
    onStartReviewers: () => ({ ok: false, error: 'not verified' }),
  });
  configureLoopController(h.deps);
  await tickLoop();
  assert.equal(h.calls.startReviewers.length, 1);
  assert.equal(getLoopState().waitingOn, 'halted');
  assert.match(getLoopState().lastError, /not verified/);

  // A second tick at the same status must NOT retry (no silent retry loop).
  await tickLoop();
  assert.equal(h.calls.startReviewers.length, 1);
  resetLoopController();
});

test('auto: a transient gh failure is retried exactly once', async () => {
  let n = 0;
  const h = makeHarness({
    defaultAuto: true,
    run: makeRun({ status: 'pr_opened' }),
    onStartReviewers: (state) => {
      n += 1;
      if (n === 1) return { ok: false, error: 'gh timeout', transient: true };
      state.run = { ...state.run, status: 'reviewers_running', reviewers: [reviewer('running')] };
      return { ok: true };
    },
  });
  configureLoopController(h.deps);
  await tickLoop();
  assert.equal(h.calls.startReviewers.length, 2);
  assert.equal(h.state.run.status, 'reviewers_running');
  resetLoopController();
});

test('setLoopMode rejects when there is no run, and toggles when there is', async () => {
  const h = makeHarness({ defaultAuto: false, run: null });
  configureLoopController(h.deps);
  const rejected = await setLoopMode('auto');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'no_run');

  h.state.run = makeRun({ status: 'pr_opened' });
  const accepted = await setLoopMode('auto');
  assert.equal(accepted.ok, true);
  assert.equal(accepted.loop.mode, 'auto');
  // Toggling to auto immediately drives the loop.
  assert.deepEqual(h.calls.startReviewers, ['loop']);
  resetLoopController();
});

test('auto: the fix-commit watcher dispatches push_fix when a new commit lands', async () => {
  const h = makeHarness({
    defaultAuto: true,
    autoSendFix: true,
    run: makeRun({ status: 'builder_fixing', expectedCommit: 'abc1234' }),
    verification: verification({ pr: { number: 7, headSha: 'newsha9999', headRefName: 'feat/x' } }),
  });
  configureLoopController(h.deps);
  await tickLoop();
  // autoSendFix -> send_fix -> fix delivered -> watching.
  assert.equal(h.calls.sendFix, 1);
  assert.equal(getLoopState().waitingOn, 'watching_fix_commit');
  assert.ok(isFixWatcherActive());

  // Fire one watcher poll: the new head SHA is detected and push_fix dispatched.
  await h.runWatch();
  const pushFix = h.calls.dispatch.find((d) => d.action === 'push_fix');
  assert.ok(pushFix, 'expected a push_fix dispatch');
  assert.equal(pushFix.options.actor, 'loop');
  assert.equal(pushFix.options.expectedCommit, 'newsha9999');
  // It then chains to relaunch reviewers for the next cycle.
  assert.equal(h.state.run.status, 'reviewers_running');
  resetLoopController();
});

test('blocker A-1: a partial fix-commit verification halts visibly after one retry (no infinite silent retry)', async () => {
  // Every poll returns a partial (gh/network/auth broken). The watcher must log
  // one retry, then halt and disarm — not keep polling forever with no error.
  const h = makeHarness({
    defaultAuto: true,
    autoSendFix: true,
    run: makeRun({ status: 'builder_fixing', expectedCommit: 'abc1234' }),
    verifyForFix: async () => verification({ status: 'needs_refresh', partial: true, pr: null }),
  });
  configureLoopController(h.deps);
  await tickLoop();
  assert.equal(getLoopState().waitingOn, 'watching_fix_commit');
  assert.ok(isFixWatcherActive());

  // First failing poll: budget allows one retry, watcher stays armed, no halt.
  await h.runWatch();
  assert.ok(isFixWatcherActive(), 'watcher stays armed for the single retry');
  assert.notEqual(getLoopState().waitingOn, 'halted');

  // Second consecutive failure: halt visibly and stop the watcher.
  await h.runWatch();
  assert.equal(getLoopState().waitingOn, 'halted');
  assert.match(getLoopState().lastError, /fix-commit verification failed/i);
  assert.equal(isFixWatcherActive(), false, 'watcher disarms on halt — no infinite retry');
  // No push_fix could have been dispatched off a partial result.
  assert.equal(h.calls.dispatch.find((d) => d.action === 'push_fix'), undefined);
  resetLoopController();
});

test('blocker A-1: a thrown fix-commit watcher error halts visibly after one retry', async () => {
  const h = makeHarness({
    defaultAuto: true,
    autoSendFix: true,
    run: makeRun({ status: 'builder_fixing', expectedCommit: 'abc1234' }),
    verifyForFix: async () => {
      throw new Error('gh exploded');
    },
  });
  configureLoopController(h.deps);
  await tickLoop();
  assert.ok(isFixWatcherActive());

  await h.runWatch();
  assert.ok(isFixWatcherActive(), 'watcher stays armed for the single retry');
  await h.runWatch();
  assert.equal(getLoopState().waitingOn, 'halted');
  assert.match(getLoopState().lastError, /gh exploded/);
  assert.equal(isFixWatcherActive(), false);
  resetLoopController();
});

test('blocker A-1: a transient partial that recovers does not halt (budget resets on a complete poll)', async () => {
  let n = 0;
  const h = makeHarness({
    defaultAuto: true,
    autoSendFix: true,
    run: makeRun({ status: 'builder_fixing', expectedCommit: 'abc1234' }),
    verifyForFix: async () => {
      n += 1;
      // First poll partial (one logged retry), then a complete poll with no new
      // commit yet, then a complete poll with the landed fix.
      if (n === 1) return verification({ status: 'needs_refresh', partial: true, pr: null });
      if (n === 2) return verification({ pr: { number: 7, headSha: 'abc1234', headRefName: 'feat/x' } });
      return verification({ pr: { number: 7, headSha: 'newsha9999', headRefName: 'feat/x' } });
    },
  });
  configureLoopController(h.deps);
  await tickLoop();

  await h.runWatch(); // partial -> retry
  assert.notEqual(getLoopState().waitingOn, 'halted');
  await h.runWatch(); // complete, head still matches baseline -> keep watching, budget reset
  assert.notEqual(getLoopState().waitingOn, 'halted');
  assert.ok(isFixWatcherActive());
  await h.runWatch(); // complete, new head -> push_fix
  const pushFix = h.calls.dispatch.find((d) => d.action === 'push_fix');
  assert.ok(pushFix, 'a recovered watch still detects the landed fix');
  assert.equal(pushFix.options.expectedCommit, 'newsha9999');
  resetLoopController();
});

test('blocker B-1: a stage aborted by an operator pause surfaces as stopped, not a halt error', async () => {
  // Model the race: the loop drives start_reviewers, but the operator pauses while
  // the live #9 verification is in flight, so the stage's preemption guard refuses
  // its side effects and returns ok:false. The controller must treat the now-paused
  // run as a stop (operator authority), not as a stage failure to halt+retry on.
  const h = makeHarness({
    defaultAuto: true,
    run: makeRun({ status: 'pr_opened' }),
    onStartReviewers: (state) => {
      // The operator paused during the await; the handler's preemption guard
      // aborted before any reviewer PTY/artifact/transition side effect.
      state.run = { ...state.run, status: 'paused' };
      return { ok: false, code: 'invalid_state', error: 'The run was preempted (now paused) during verification; reviewers were not launched.' };
    },
  });
  configureLoopController(h.deps);
  await tickLoop();
  assert.equal(h.calls.startReviewers.length, 1, 'the stage ran exactly once');
  assert.equal(getLoopState().waitingOn, 'stopped', 'preemption surfaces as stopped, not halted');
  assert.equal(getLoopState().lastError, null, 'a preemption is not recorded as a stage failure');

  // A follow-up tick at the paused (stop) status must not re-run the stage.
  await tickLoop();
  assert.equal(h.calls.startReviewers.length, 1, 'no retry after operator preemption');
  resetLoopController();
});

test('loop-stage generation: capture is stable until a preemption bumps it', () => {
  const captured = captureLoopStageGeneration();
  assert.equal(isLoopStageGenerationStale(captured), false, 'a fresh capture is not stale');
  // An operator/manual dispatch (or mode toggle/reset) bumps the generation.
  preemptLoopStages();
  assert.equal(isLoopStageGenerationStale(captured), true, 'the prior capture is now stale');
  // A re-capture tracks the new generation.
  const recaptured = captureLoopStageGeneration();
  assert.equal(isLoopStageGenerationStale(recaptured), false);
});

test('blocker B-1: a loop stage preempted by a manual dispatch into a launch-legal status stops without halt/retry', async () => {
  // Model the exact remaining race Reviewer B flagged: the loop drives
  // start_reviewers from pr_opened and awaits verification; during the await the
  // OPERATOR manually starts reviewers, advancing the run to `reviewers_running`
  // (a still-launch-legal status a status-only guard would wave through) and
  // bumping the loop-stage generation. The real handler then detects the stale
  // generation and returns `preempted` WITHOUT a second reviewer-record install,
  // artifact prep, PTY spawn, prompt write, or loop transition. The controller
  // must treat this as a clean stop — never a halt or a retry.
  let started = 0;
  const h = makeHarness({
    defaultAuto: true,
    run: makeRun({ status: 'pr_opened' }),
    onStartReviewers: (state) => {
      started += 1;
      // The manual operator dispatch happened during the await: it advanced the
      // run into a launch-legal status AND preempted the loop-stage generation.
      state.run = { ...state.run, status: 'reviewers_running', reviewers: [reviewer('running')] };
      preemptLoopStages();
      // The handler's generation guard fired, so no side effects were performed.
      return {
        ok: false,
        preempted: true,
        error: 'An operator action preempted the loop during verification (run now reviewers_running); reviewers were not launched.',
      };
    },
  });
  configureLoopController(h.deps);
  await tickLoop();

  // The loop stage ran exactly once and did NOT re-run or halt.
  assert.equal(started, 1, 'the loop stage ran exactly once');
  assert.equal(h.calls.startReviewers.length, 1, 'no re-install after manual preemption');
  assert.equal(getLoopState().waitingOn !== 'halted', true, 'a manual preemption is not a halt');
  assert.equal(getLoopState().lastError, null, 'a preemption is not recorded as a stage failure');
  // It did not advance the run itself (no synthesize / push_fix dispatch).
  assert.equal(h.calls.synthesize.length, 0, 'no synthesis after preemption');
  assert.equal(h.calls.dispatch.length, 0, 'no loop-driven transition after preemption');

  // A follow-up tick (the kind the manual dispatch queues) re-syncs from the live
  // reviewers_running run and simply waits for the reviewer sessions — it does not
  // re-run the preempted stage.
  await tickLoop();
  assert.equal(h.calls.startReviewers.length, 1, 'still no re-run on the next tick');
  assert.equal(getLoopState().waitingOn, 'waiting_reviewers', 're-syncs to waiting on reviewers');
  resetLoopController();
});

test('notifyFixDelivered arms the watcher even when autoSendFix is off (manual send)', async () => {
  const h = makeHarness({
    defaultAuto: true,
    autoSendFix: false,
    run: makeRun({ status: 'builder_fixing', expectedCommit: 'abc1234' }),
  });
  configureLoopController(h.deps);
  await tickLoop();
  // Without a delivered fix, the loop waits for operator approval.
  assert.equal(getLoopState().waitingOn, 'waiting_fix_approval');
  assert.equal(h.calls.sendFix, 0);

  // Operator sends the fix manually -> main notifies the controller.
  notifyFixDelivered();
  await tickLoop();
  assert.equal(getLoopState().waitingOn, 'watching_fix_commit');
  resetLoopController();
});
