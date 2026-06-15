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
  evaluateClearRun,
  getCurrentRun,
  recordCurrentRunPrompt,
  recordCurrentRunVerification,
  recordPromptSent,
  recordVerification,
  selectIssueRun,
  selectManualTaskRun,
  setReviewerSessions,
  setCurrentRunReviewers,
  updateReviewerSession,
  updateCurrentRunReviewer,
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

test('selectManualTaskRun starts a manual_task run that can be routed to needs_spec', () => {
  clearRun();
  const result = selectManualTaskRun({ title: 'Tidy cockpit', text: 'Make panes compact' });
  assert.equal(result.ok, true);
  const run = getCurrentRun();
  assert.equal(run.sourceType, 'manual_task');
  assert.equal(run.issueNumber, undefined);
  assert.equal(run.issueTitle, 'Tidy cockpit');
  assert.equal(run.sourceDetail.body, 'Make panes compact');
  assert.equal(run.status, 'issue_selected');

  // A vague manual task is routed through the existing state machine, not sent.
  const specced = dispatchRunAction('require_spec', { reason: 'needs scoping' });
  assert.equal(specced.ok, true);
  assert.equal(getCurrentRun().status, 'needs_spec');
  clearRun();
});

test('selectManualTaskRun refuses to replace a live run', () => {
  clearRun();
  selectManualTaskRun({ title: 'First', text: 'one' });
  const blocked = selectManualTaskRun({ title: 'Second', text: 'two' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'invalid_transition');
  assert.match(blocked.error, /still active/);
  clearRun();
});

test('recordPromptSent appends an audit entry without mutating the input', () => {
  const run = createRun({ issueNumber: 8, issueTitle: 'Handoff', now: NOW, id: 'run-prompt' });
  const before = JSON.stringify(run);
  const next = recordPromptSent(run, { role: 'builder', digest: 'Build #8', promptChars: 420, now: NOW });
  assert.equal(JSON.stringify(run), before, 'recordPromptSent must not mutate its input');
  assert.equal(next.prompts.length, 1);
  assert.deepEqual(next.prompts[0], {
    at: NOW,
    role: 'builder',
    sourceType: 'github_issue',
    sourceId: '8',
    digest: 'Build #8',
    promptChars: 420,
  });
});

test('recordCurrentRunPrompt records against the live run and is visible in history', () => {
  clearRun();
  assert.equal(recordCurrentRunPrompt({ role: 'builder', digest: 'x', promptChars: 1 }), null);
  selectIssueRun({ issueNumber: 8, issueTitle: 'Handoff' });
  const updated = recordCurrentRunPrompt({ role: 'builder', digest: 'Build #8 handoff', promptChars: 512 });
  assert.equal(updated.prompts.length, 1);
  assert.equal(getCurrentRun().prompts[0].digest, 'Build #8 handoff');
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
  // Every transition is stamped with the initiating actor (issue #39); a plain
  // dispatch defaults to the operator.
  assert.deepEqual(run.log[0], {
    at: NOW,
    from: 'idle',
    to: 'issue_selected',
    action: 'select_issue',
    reason: undefined,
    actor: 'operator',
  });
  assert.deepEqual(run.log[1], {
    at: NOW,
    from: 'issue_selected',
    to: 'ready_to_build',
    action: 'mark_ready',
    reason: undefined,
    actor: 'operator',
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

test('evaluateClearRun guards clear as a terminal-only operation (issue #41)', () => {
  // No run: clearing is always allowed.
  assert.deepEqual(evaluateClearRun(null, false), { ok: true, run: null });

  // Active (non-terminal) run: refused, run preserved.
  const active = createRun({ issueNumber: 41, now: NOW, id: 'run-clear-active' });
  const activeSelected = applyAction(active, 'select_issue', { now: NOW }).run;
  const refusedActive = evaluateClearRun(activeSelected, false);
  assert.equal(refusedActive.ok, false);
  assert.equal(refusedActive.run, activeSelected);
  assert.match(refusedActive.error, /still active/i);

  // Terminal run with a lingering worktree: refused until cleanup.
  const terminal = applyAction(activeSelected, 'cancel', { now: NOW, reason: 'done' }).run;
  assert.equal(terminal.status, 'cancelled');
  const withWorktree = {
    ...terminal,
    worktree: { path: '/tmp/.godmode-worktrees/p-run', branch: 'godmode/run', createdAt: NOW },
  };
  const refusedWorktree = evaluateClearRun(withWorktree, false);
  assert.equal(refusedWorktree.ok, false);
  assert.match(refusedWorktree.error, /worktree/i);

  // Terminal, no worktree, but a live builder session: refused.
  const refusedPty = evaluateClearRun(terminal, true);
  assert.equal(refusedPty.ok, false);
  assert.match(refusedPty.error, /builder session/i);

  // Terminal, no worktree, no live session: cleared.
  assert.deepEqual(evaluateClearRun(terminal, false), { ok: true, run: null });
});

test('createRun initializes an empty verification history', () => {
  const run = createRun({ issueNumber: 9, now: NOW, id: 'run-verify' });
  assert.deepEqual(run.verifications, []);
});

test('applyAction records the run-recorded expected commit from the builder phase', () => {
  const run = createRun({ issueNumber: 9, now: NOW, id: 'run-commit' });
  const selected = applyAction(run, 'select_issue', { now: NOW }).run;
  const ready = applyAction(selected, 'mark_ready', { now: NOW }).run;
  const building = applyAction(ready, 'start_builder', { now: NOW }).run;
  const opened = applyAction(building, 'open_pr', {
    now: NOW,
    branch: 'claude/issue-9',
    prNumber: 9,
    expectedCommit: 'c'.repeat(40),
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.run.expectedCommit, 'c'.repeat(40));
  assert.equal(opened.run.branch, 'claude/issue-9');
  assert.equal(opened.run.prNumber, 9);
});

/** A minimal CommitVerification, as main would hand to the recorder. */
function verification(overrides = {}) {
  return {
    status: 'verified',
    message: 'Commit ccccccc is on PR #9 (1/1 checks passing).',
    branch: 'claude/issue-9',
    expectedCommit: 'c'.repeat(40),
    expectedCommitShort: 'ccccccc',
    expectedCommitSource: 'run_recorded',
    pr: { number: 9, state: 'OPEN', url: 'u', headRefName: 'b', headSha: 'c'.repeat(40), headShaShort: 'ccccccc' },
    commitInList: true,
    matchesHead: true,
    checks: { total: 1, passing: 1, pending: 0, failing: 0 },
    prState: 'OPEN',
    mergeConfirmed: false,
    partial: false,
    fetchedAt: NOW,
    ...overrides,
  };
}

test('recordVerification appends an audit entry without mutating the input', () => {
  const run = createRun({ issueNumber: 9, now: NOW, id: 'run-rec' });
  const updated = recordVerification(run, verification());
  assert.equal(run.verifications.length, 0, 'input snapshot is not mutated');
  assert.equal(updated.verifications.length, 1);
  const entry = updated.verifications[0];
  assert.equal(entry.status, 'verified');
  assert.equal(entry.expectedCommit, 'c'.repeat(40));
  assert.equal(entry.source, 'run_recorded');
  assert.equal(entry.prNumber, 9);
  assert.equal(entry.prState, 'OPEN');
  assert.equal(entry.at, NOW);
  assert.equal(updated.updatedAt, NOW);
});

test('recordCurrentRunVerification records against the live run, null when none', () => {
  clearRun();
  assert.equal(recordCurrentRunVerification(verification()), null);

  selectIssueRun({ issueNumber: 9, issueTitle: 'Verify commit state' });
  const first = recordCurrentRunVerification(verification({ status: 'missing_remote_commit' }));
  assert.equal(first.verifications.length, 1);
  assert.equal(first.verifications[0].status, 'missing_remote_commit');

  const second = recordCurrentRunVerification(verification({ status: 'verified' }));
  assert.equal(second.verifications.length, 2, 'history is append-only');
  assert.equal(second.verifications[1].status, 'verified');
  clearRun();
});

// --- Reviewer session lifecycle (issue #10) ---------------------------------

const reviewerDescriptors = [
  { reviewerId: 'reviewer-a', paneId: 'reviewer_a', sessionToken: 'tok-a', displayName: 'Codex A', roleDoc: 'docs/review/a.md', status: 'launching', artifactPath: '.godmode/runs/run-10/reviewer-a.log', promptChars: 200, commentPosted: false },
  { reviewerId: 'reviewer-b', paneId: 'reviewer_b', sessionToken: 'tok-b', displayName: 'Codex B', roleDoc: 'docs/review/b.md', status: 'launching', artifactPath: '.godmode/runs/run-10/reviewer-b.log', promptChars: 210, commentPosted: false },
];

test('setReviewerSessions stamps reviewers without mutating the input', () => {
  const run = createRun({ issueNumber: 10, now: NOW, id: 'run-10' });
  const updated = setReviewerSessions(run, reviewerDescriptors, NOW);
  assert.equal(run.reviewers, undefined, 'input snapshot is not mutated');
  assert.equal(updated.reviewers.length, 2);
  assert.equal(updated.reviewers[0].reviewerId, 'reviewer-a');
  assert.equal(updated.reviewers[0].status, 'launching');
  assert.equal(updated.reviewers[0].updatedAt, NOW);
  assert.equal(updated.updatedAt, NOW);
});

test('updateReviewerSession patches one pane immutably and leaves the other untouched', () => {
  const run = setReviewerSessions(createRun({ issueNumber: 10, now: NOW, id: 'run-10' }), reviewerDescriptors, NOW);
  const running = updateReviewerSession(run, 'reviewer_a', { status: 'running', pid: 4321 }, NOW);
  assert.equal(run.reviewers[0].status, 'launching', 'input snapshot is not mutated');
  assert.equal(running.reviewers[0].status, 'running');
  assert.equal(running.reviewers[0].pid, 4321);
  assert.equal(running.reviewers[1].status, 'launching', 'the other reviewer is untouched');

  const posted = updateReviewerSession(running, 'reviewer_a', { status: 'comment_posted', commentPosted: true, commentUrl: 'https://gh/c/1' }, NOW);
  assert.equal(posted.reviewers[0].status, 'comment_posted');
  assert.equal(posted.reviewers[0].commentPosted, true);
  assert.equal(posted.reviewers[0].commentUrl, 'https://gh/c/1');
});

test('updateReviewerSession is a no-op when the run has no tracked reviewers', () => {
  const run = createRun({ issueNumber: 10, now: NOW, id: 'run-10' });
  const same = updateReviewerSession(run, 'reviewer_a', { status: 'failed' }, NOW);
  assert.equal(same, run);
});

test('reviewer controller wrappers act on the live run, null when none', () => {
  clearRun();
  assert.equal(setCurrentRunReviewers(reviewerDescriptors, NOW), null);
  assert.equal(updateCurrentRunReviewer('reviewer_a', { status: 'failed' }, NOW), null);

  selectIssueRun({ issueNumber: 10, issueTitle: 'Launch reviewers' });
  const set = setCurrentRunReviewers(reviewerDescriptors, NOW);
  assert.equal(set.reviewers.length, 2);

  const failed = updateCurrentRunReviewer('reviewer_b', { status: 'failed', error: 'Launch failed: command not found' }, NOW);
  assert.equal(failed.reviewers[1].status, 'failed');
  assert.match(failed.reviewers[1].error, /command not found/);
  assert.equal(getCurrentRun().reviewers[1].status, 'failed');
  clearRun();
});
