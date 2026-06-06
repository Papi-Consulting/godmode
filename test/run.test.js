// Run state-machine tests for issue #7. Pure transition logic plus the in-memory
// single-run controller — no Electron, no filesystem — so they run under Node's
// built-in test runner against the compiled main output (`npm run build:main`
// first). Run via `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MAX_CYCLES,
  TRANSITION_TABLE,
  applyAction,
  clearRun,
  computeAvailableActions,
  createRun,
  dispatchRunAction,
  getCurrentRun,
  selectIssueRun,
} from '../dist/main/run.js';

const NOW = '2026-06-06T12:00:00.000Z';

/** Drive a run through a sequence of actions, asserting each one succeeds. */
function advance(run, steps) {
  let current = run;
  for (const step of steps) {
    const action = typeof step === 'string' ? step : step.action;
    const options = typeof step === 'string' ? { now: NOW } : { now: NOW, ...step.options };
    const result = applyAction(current, action, options);
    assert.equal(result.ok, true, `expected "${action}" to be allowed from "${current.status}"`);
    current = result.run;
  }
  return current;
}

test('createRun starts idle with only select_issue available', () => {
  const run = createRun({ issueNumber: 7, issueTitle: 'State machine', now: NOW, id: 'run-test' });
  assert.equal(run.status, 'idle');
  assert.equal(run.cycle, 1);
  assert.equal(run.maxCycles, DEFAULT_MAX_CYCLES);
  assert.deepEqual(run.availableActions, ['select_issue']);
  assert.deepEqual(run.log, []);
  assert.equal(run.issueNumber, 7);
  assert.equal(run.sourceType, 'github_issue');
});

test('happy path advances idle → … → merge_ready → karan_merged → closed', () => {
  const run = createRun({ issueNumber: 12, now: NOW, id: 'run-happy' });
  const merged = advance(run, [
    'select_issue',
    'mark_ready',
    'start_builder',
    { action: 'open_pr', options: { branch: 'feat/12', prNumber: 12 } },
    'start_reviewers',
    'synthesize_reviews',
    'mark_merge_ready',
    'mark_merged',
  ]);
  assert.equal(merged.status, 'karan_merged');
  assert.equal(merged.branch, 'feat/12');
  assert.equal(merged.prNumber, 12);

  const closed = applyAction(merged, 'close', { now: NOW });
  assert.equal(closed.ok, true);
  assert.equal(closed.run.status, 'closed');
  assert.deepEqual(closed.run.availableActions, []);
});

test('invalid transition is rejected with a typed error and no mutation', () => {
  const run = applyAction(createRun({ issueNumber: 1, now: NOW, id: 'run-idle' }), 'select_issue', {
    now: NOW,
  }).run;
  const before = JSON.stringify(run);

  const result = applyAction(run, 'mark_merge_ready', { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_transition');
  assert.match(result.error, /not allowed/);
  // The rejected result returns the unchanged snapshot, and the input is intact.
  assert.equal(result.run.status, 'issue_selected');
  assert.equal(JSON.stringify(run), before, 'applyAction must not mutate its input');
});

test('idle → merge_ready is rejected (no illegal jumps)', () => {
  // Sanity-check the table is the single source of truth: idle declares only one
  // legal action, so any merge-ward jump from idle must be refused.
  assert.deepEqual(Object.keys(TRANSITION_TABLE.idle), ['select_issue']);
  const run = createRun({ issueNumber: 1, now: NOW, id: 'run-jump' });
  const result = applyAction(run, 'mark_merge_ready', { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.run.status, 'idle');
});

test('fix loop increments the cycle counter', () => {
  const run = advance(createRun({ issueNumber: 2, now: NOW, id: 'run-fix' }), [
    'select_issue',
    'mark_ready',
    'start_builder',
    'open_pr',
    'start_reviewers',
    'synthesize_reviews',
  ]);
  assert.equal(run.cycle, 1);

  const fixing = applyAction(run, 'request_fix', { now: NOW }).run;
  assert.equal(fixing.status, 'builder_fixing');
  assert.equal(fixing.cycle, 2);

  const back = advance(fixing, ['push_fix', 'rerun_reviewers', 'synthesize_reviews']);
  assert.equal(back.status, 'review_synthesis');
  assert.equal(back.cycle, 2);
});

test('request_fix is bounded by maxCycles', () => {
  // maxCycles: 1 means no fix cycles — the loop must not advance to a 2nd cycle.
  const synth1 = advance(createRun({ issueNumber: 30, maxCycles: 1, now: NOW, id: 'run-cap1' }), [
    'select_issue',
    'mark_ready',
    'start_builder',
    'open_pr',
    'start_reviewers',
    'synthesize_reviews',
  ]);
  assert.equal(synth1.cycle, 1);
  assert.ok(!synth1.availableActions.includes('request_fix'), 'request_fix must be gone at the cap');
  const rejected = applyAction(synth1, 'request_fix', { now: NOW });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid_transition');
  assert.match(rejected.error, /budget/i);
  assert.equal(rejected.run.status, 'review_synthesis');
  // At the cap the operator can still escalate or merge.
  assert.ok(synth1.availableActions.includes('exceed_max_cycles'));
  assert.ok(synth1.availableActions.includes('mark_merge_ready'));

  // maxCycles: 2 allows exactly one fix cycle, then the cap blocks the next.
  let run = advance(createRun({ issueNumber: 31, maxCycles: 2, now: NOW, id: 'run-cap2' }), [
    'select_issue',
    'mark_ready',
    'start_builder',
    'open_pr',
    'start_reviewers',
    'synthesize_reviews',
  ]);
  assert.ok(run.availableActions.includes('request_fix'));
  run = advance(run, ['request_fix', 'push_fix', 'rerun_reviewers', 'synthesize_reviews']);
  assert.equal(run.cycle, 2);
  assert.equal(applyAction(run, 'request_fix', { now: NOW }).ok, false);
});

test('selectIssueRun refuses to replace a live run but allows replacing a finished one', () => {
  clearRun();
  const first = selectIssueRun({ issueNumber: 40, issueTitle: 'First' });
  assert.equal(first.ok, true);

  // A live run must not be silently discarded.
  const blocked = selectIssueRun({ issueNumber: 41, issueTitle: 'Second' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'invalid_transition');
  assert.match(blocked.error, /still active/);
  assert.equal(getCurrentRun().issueNumber, 40);

  // Drive the run to a terminal state, then a new selection is allowed.
  dispatchRunAction('cancel', { reason: 'abandon' });
  assert.equal(getCurrentRun().status, 'cancelled');
  const replaced = selectIssueRun({ issueNumber: 41, issueTitle: 'Second' });
  assert.equal(replaced.ok, true);
  assert.equal(getCurrentRun().issueNumber, 41);
  clearRun();
});

test('pause records the resume target and resume returns to it', () => {
  const running = advance(createRun({ issueNumber: 3, now: NOW, id: 'run-pause' }), [
    'select_issue',
    'mark_ready',
    'start_builder',
  ]);
  assert.equal(running.status, 'builder_running');

  const paused = applyAction(running, 'pause', { now: NOW, reason: 'lunch' }).run;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.resumeStatus, 'builder_running');
  assert.equal(paused.reason, 'lunch');
  assert.ok(paused.availableActions.includes('resume'));

  const resumed = applyAction(paused, 'resume', { now: NOW }).run;
  assert.equal(resumed.status, 'builder_running');
  assert.equal(resumed.resumeStatus, undefined);
  assert.equal(resumed.reason, undefined);
});

test('cancel from paused clears the resume target', () => {
  const paused = applyAction(
    advance(createRun({ issueNumber: 4, now: NOW, id: 'run-pc' }), ['select_issue', 'mark_ready', 'start_builder']),
    'pause',
    { now: NOW },
  ).run;
  const cancelled = applyAction(paused, 'cancel', { now: NOW }).run;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.resumeStatus, undefined);
});

test('flag_needs_human records reason and blocker, cleared on recovery', () => {
  const synth = advance(createRun({ issueNumber: 5, now: NOW, id: 'run-nh' }), [
    'select_issue',
    'mark_ready',
    'start_builder',
    'open_pr',
    'start_reviewers',
    'synthesize_reviews',
  ]);
  const flagged = applyAction(synth, 'flag_needs_human', {
    now: NOW,
    reason: 'merge conflict on main',
    blocker: 'pr_conflicted',
  }).run;
  assert.equal(flagged.status, 'needs_human');
  assert.equal(flagged.blocker, 'pr_conflicted');
  assert.equal(flagged.reason, 'merge conflict on main');

  // Operator overrides to merge-ready: blocker/reason must clear.
  const overridden = applyAction(flagged, 'mark_merge_ready', { now: NOW }).run;
  assert.equal(overridden.status, 'merge_ready');
  assert.equal(overridden.blocker, undefined);
  assert.equal(overridden.reason, undefined);
});

test('agent failure is recoverable back to ready_to_build', () => {
  const building = advance(createRun({ issueNumber: 6, now: NOW, id: 'run-af' }), [
    'select_issue',
    'mark_ready',
    'start_builder',
  ]);
  const failed = applyAction(building, 'report_agent_failed', { now: NOW, reason: 'crash' }).run;
  assert.equal(failed.status, 'agent_failed');
  assert.equal(failed.reason, 'crash');

  const recovered = applyAction(failed, 'mark_ready', { now: NOW }).run;
  assert.equal(recovered.status, 'ready_to_build');
});

test('max_cycles_exceeded can be force-resolved to merge_ready', () => {
  const fixing = advance(createRun({ issueNumber: 7, now: NOW, id: 'run-mc' }), [
    'select_issue',
    'mark_ready',
    'start_builder',
    'open_pr',
    'start_reviewers',
    'synthesize_reviews',
    'request_fix',
  ]);
  const exceeded = applyAction(fixing, 'exceed_max_cycles', { now: NOW, reason: 'looping' }).run;
  assert.equal(exceeded.status, 'max_cycles_exceeded');

  const forced = applyAction(exceeded, 'mark_merge_ready', { now: NOW });
  assert.equal(forced.ok, true);
  assert.equal(forced.run.status, 'merge_ready');

  // But it cannot jump straight back into the build loop.
  assert.equal(applyAction(exceeded, 'start_builder', { now: NOW }).ok, false);
});

test('every successful transition is logged with from/to/action/reason', () => {
  const run = advance(createRun({ issueNumber: 8, now: NOW, id: 'run-log' }), ['select_issue', 'mark_ready']);
  assert.equal(run.log.length, 2);
  assert.deepEqual(run.log[0], { at: NOW, from: 'idle', to: 'issue_selected', action: 'select_issue', reason: undefined });
  assert.deepEqual(run.log[1], {
    at: NOW,
    from: 'issue_selected',
    to: 'ready_to_build',
    action: 'mark_ready',
    reason: undefined,
  });
});

test('computeAvailableActions exposes forward edges plus interrupts', () => {
  const synth = advance(createRun({ issueNumber: 9, now: NOW, id: 'run-aa' }), [
    'select_issue',
    'mark_ready',
    'start_builder',
    'open_pr',
    'start_reviewers',
    'synthesize_reviews',
  ]);
  const actions = computeAvailableActions(synth);
  for (const expected of ['request_fix', 'mark_merge_ready', 'flag_needs_human', 'pause', 'cancel']) {
    assert.ok(actions.includes(expected), `expected ${expected} to be available from review_synthesis`);
  }
  // Idle exposes no interrupts — it is not an active state.
  assert.deepEqual(computeAvailableActions(createRun({ now: NOW, id: 'run-idle2' })), ['select_issue']);
});

test('controller: selectIssueRun, dispatchRunAction, and clearRun', () => {
  clearRun();
  assert.equal(getCurrentRun(), null);
  assert.equal(dispatchRunAction('mark_ready').code, 'no_run');

  const started = selectIssueRun({ issueNumber: 21, issueTitle: 'Wire run state' });
  assert.equal(started.ok, true);
  assert.equal(started.run.status, 'issue_selected');
  assert.equal(getCurrentRun().status, 'issue_selected');

  // A rejected dispatch leaves the current run unchanged.
  const rejected = dispatchRunAction('mark_merged');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid_transition');
  assert.equal(getCurrentRun().status, 'issue_selected');

  const advanced = dispatchRunAction('mark_ready');
  assert.equal(advanced.ok, true);
  assert.equal(getCurrentRun().status, 'ready_to_build');

  clearRun();
  assert.equal(getCurrentRun(), null);
});
