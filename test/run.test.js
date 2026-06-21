// Run state-machine tests for issue #7. Pure transition logic plus the in-memory
// single-run controller — no Electron, no filesystem — so they run under Node's
// built-in test runner against the compiled main output (`npm run build:main`
// first). Run via `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MAX_CYCLES,
  TRANSITION_TABLE,
  adoptCurrentRunExpectedCommit,
  adoptExpectedCommit,
  adoptResumedRun,
  applyAction,
  clearRun,
  computeAvailableActions,
  createRun,
  dispatchRunAction,
  evaluateBuilderRecovery,
  evaluateClearRun,
  getCurrentRun,
  latestRunVerification,
  observedHeadDrifted,
  recordCurrentRunPrompt,
  recordCurrentRunVerification,
  recordPromptSent,
  recordVerification,
  selectIssueRun,
  selectManualTaskRun,
  setCurrentRunWorktree,
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

test('flag_needs_human is legal from paused so a resumed PR mismatch can escalate (issue #40)', () => {
  // Reproduce a run paused after PR discovery (carries a prNumber), as it would be
  // persisted and then resumed after the recorded PR is closed/deleted/replaced.
  const paused = applyAction(
    advance(createRun({ issueNumber: 40, now: NOW, id: 'run-resume-pr' }), [
      'select_issue',
      'mark_ready',
      'start_builder',
      'open_pr',
    ]),
    'pause',
    { now: NOW, reason: 'restart' },
  ).run;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.resumeStatus, 'pr_opened');

  // The resume-revalidation routing must succeed (previously this transition was
  // rejected and the failure was silently swallowed, leaving the run blind).
  const flagged = applyAction(paused, 'flag_needs_human', {
    now: NOW,
    reason: 'Resumed run revalidation: the recorded PR #54 is closed on GitHub, not open.',
  });
  assert.equal(flagged.ok, true);
  assert.equal(flagged.run.status, 'needs_human');
  assert.equal(flagged.run.reason, 'Resumed run revalidation: the recorded PR #54 is closed on GitHub, not open.');
  // Moving out of paused clears the dangling resume target.
  assert.equal(flagged.run.resumeStatus, undefined);
});

test('flag_needs_human is legal from the agent_failed and max_cycles_exceeded recovery states (issue #40)', () => {
  const failed = applyAction(
    advance(createRun({ issueNumber: 41, now: NOW, id: 'run-af-nh' }), [
      'select_issue',
      'mark_ready',
      'start_builder',
      'open_pr',
    ]),
    'report_agent_failed',
    { now: NOW, reason: 'crash' },
  ).run;
  assert.equal(failed.status, 'agent_failed');
  const failedFlagged = applyAction(failed, 'flag_needs_human', { now: NOW, reason: 'mismatch' });
  assert.equal(failedFlagged.ok, true);
  assert.equal(failedFlagged.run.status, 'needs_human');

  const exceeded = applyAction(
    advance(createRun({ issueNumber: 42, now: NOW, id: 'run-mc-nh' }), [
      'select_issue',
      'mark_ready',
      'start_builder',
      'open_pr',
      'start_reviewers',
      'synthesize_reviews',
      'request_fix',
    ]),
    'exceed_max_cycles',
    { now: NOW, reason: 'looping' },
  ).run;
  assert.equal(exceeded.status, 'max_cycles_exceeded');
  const exceededFlagged = applyAction(exceeded, 'flag_needs_human', { now: NOW, reason: 'mismatch' });
  assert.equal(exceededFlagged.ok, true);
  assert.equal(exceededFlagged.run.status, 'needs_human');
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

test('evidence-bound open_pr logs the discovery reason without leaving a sticky banner (#38)', () => {
  const run = createRun({ issueNumber: 38, now: NOW, id: 'run-discover' });
  const selected = applyAction(run, 'select_issue', { now: NOW }).run;
  const ready = applyAction(selected, 'mark_ready', { now: NOW }).run;
  const building = applyAction(ready, 'start_builder', { now: NOW }).run;
  const reason = 'PR #38 discovered by issue link on branch feat/issue-38 at commit abc1234; bound as open_pr evidence.';
  const opened = applyAction(building, 'open_pr', {
    now: NOW,
    branch: 'feat/issue-38',
    prNumber: 38,
    expectedCommit: 'a'.repeat(40),
    reason,
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.run.status, 'pr_opened');
  // The transition log names the PR and how it matched (issue #38 contract)...
  const last = opened.run.log[opened.run.log.length - 1];
  assert.equal(last.action, 'open_pr');
  assert.equal(last.reason, reason);
  // ...but forward progress leaves no sticky warn/blocker reason on the snapshot.
  assert.equal(opened.run.reason, undefined);
  assert.equal(opened.run.blocker, undefined);
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
    currentHeadVerified: true,
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
  // Issue #61: the observed head and current-head flag are recorded so a later
  // pass can detect head drift and merge gates consume only current-head evidence.
  assert.equal(entry.verifiedHeadSha, 'c'.repeat(40));
  assert.equal(entry.currentHeadVerified, true);
  assert.equal(entry.at, NOW);
  assert.equal(updated.updatedAt, NOW);
});

test('recordVerification records a stale-head result as not current-head verified (issue #61)', () => {
  const run = createRun({ issueNumber: 9, now: NOW, id: 'run-stale' });
  // The expected commit is in PR history but the head moved to a newer commit.
  const stale = verification({
    status: 'stale_head',
    matchesHead: false,
    currentHeadVerified: false,
    pr: { number: 9, state: 'OPEN', url: 'u', headRefName: 'b', headSha: 'd'.repeat(40), headShaShort: 'ddddddd' },
  });
  const updated = recordVerification(run, stale);
  const entry = updated.verifications[0];
  assert.equal(entry.status, 'stale_head');
  // The recorded head is the NEW head, and the entry is flagged not-current so a
  // merge-ready decision can never consume it as current-head evidence.
  assert.equal(entry.verifiedHeadSha, 'd'.repeat(40));
  assert.equal(entry.currentHeadVerified, false);
});

test('latestRunVerification returns the most recent entry or null (issue #61)', () => {
  const base = createRun({ issueNumber: 9, now: NOW, id: 'run-latest' });
  assert.equal(latestRunVerification(base), null);
  const one = recordVerification(base, verification({ status: 'missing_remote_commit' }));
  const two = recordVerification(one, verification());
  assert.equal(latestRunVerification(two).status, 'verified');
});

test('observedHeadDrifted detects an observed bound-PR head that moved off the verified head (issue #61)', () => {
  // A run bound to PR #9 with a recorded verification computed against head C.
  const base = createRun({ issueNumber: 9, now: NOW, id: 'run-drift' });
  const bound = recordVerification({ ...base, prNumber: 9, expectedCommit: 'c'.repeat(40) }, verification());
  // Observing the SAME head (full or abbreviated) is not drift.
  assert.equal(observedHeadDrifted(bound, 9, 'c'.repeat(40)), false);
  assert.equal(observedHeadDrifted(bound, 9, 'c'.repeat(7)), false);
  // Observing a NEW head on the bound PR IS drift — the observe-without-manual-
  // reverify path must mark the displayed evidence stale.
  assert.equal(observedHeadDrifted(bound, 9, 'd'.repeat(40)), true);
  // A different PR number, a missing observed head, or no recorded verification
  // never drifts (there is no current-head claim to invalidate).
  assert.equal(observedHeadDrifted(bound, 42, 'd'.repeat(40)), false);
  assert.equal(observedHeadDrifted(bound, 9, ''), false);
  assert.equal(observedHeadDrifted(bound, undefined, 'd'.repeat(40)), false);
  assert.equal(observedHeadDrifted({ ...base, prNumber: 9 }, 9, 'd'.repeat(40)), false);
});

test('observe-without-manual-reverify: drift triggers a stale_head record that is not current-head verified (issue #61)', () => {
  // Start from a green verification at head C (as if reviewers passed on C).
  const base = createRun({ issueNumber: 9, now: NOW, id: 'run-observe' });
  const verified = recordVerification({ ...base, prNumber: 9, expectedCommit: 'c'.repeat(40) }, verification());
  assert.equal(latestRunVerification(verified).currentHeadVerified, true);
  // GodMode OBSERVES the bound PR at a new head D (GitHub refresh / discovery pass)
  // with no manual Re-verify click — the drift trigger fires...
  assert.equal(observedHeadDrifted(verified, 9, 'd'.repeat(40)), true);
  // ...and main re-derives + records a stale_head result, so the displayed evidence
  // is staled rather than lingering as a green 'verified' for the old head.
  const reconciled = recordVerification(
    verified,
    verification({
      status: 'stale_head',
      matchesHead: false,
      currentHeadVerified: false,
      pr: { number: 9, state: 'OPEN', url: 'u', headRefName: 'b', headSha: 'd'.repeat(40), headShaShort: 'ddddddd' },
    }),
  );
  const entry = latestRunVerification(reconciled);
  assert.equal(entry.status, 'stale_head');
  assert.equal(entry.currentHeadVerified, false);
  assert.equal(entry.verifiedHeadSha, 'd'.repeat(40));
  // A subsequent observation of the SAME (now recorded) head no longer drifts.
  assert.equal(observedHeadDrifted(reconciled, 9, 'd'.repeat(40)), false);
});

test('adoptExpectedCommit re-records the head without mutating the input (issue #61)', () => {
  const base = createRun({ issueNumber: 9, now: NOW, id: 'run-adopt' });
  const run = { ...base, expectedCommit: 'c'.repeat(40) };
  const later = '2026-06-06T13:00:00.000Z';
  const adopted = adoptExpectedCommit(run, 'd'.repeat(40), later);
  assert.equal(run.expectedCommit, 'c'.repeat(40), 'input snapshot is not mutated');
  assert.equal(adopted.expectedCommit, 'd'.repeat(40));
  assert.equal(adopted.updatedAt, later);
});

test('adoptCurrentRunExpectedCommit adopts against the live run, null when none (issue #61)', () => {
  clearRun();
  assert.equal(adoptCurrentRunExpectedCommit('d'.repeat(40)), null);
  selectIssueRun({ issueNumber: 9, issueTitle: 'Adopt head' });
  const adopted = adoptCurrentRunExpectedCommit('d'.repeat(40), NOW);
  assert.equal(adopted.expectedCommit, 'd'.repeat(40));
  assert.equal(getCurrentRun().expectedCommit, 'd'.repeat(40));
  clearRun();
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
  { reviewerId: 'reviewer-a', paneId: 'reviewer_a', attemptId: '1-abc1234-reviewer-a-1', cycle: 1, prNumber: 42, branch: 'fix', targetHeadSha: 'abc1234def', targetHeadShaShort: 'abc1234', launchedAt: NOW, sessionToken: 'tok-a', displayName: 'Codex A', roleDoc: 'docs/review/a.md', status: 'launching', artifactPath: '.godmode/runs/run-10/reviewers/reviewer-a-1-abc1234-reviewer-a-1.log', promptChars: 200, commentPosted: false },
  { reviewerId: 'reviewer-b', paneId: 'reviewer_b', attemptId: '1-abc1234-reviewer-b-1', cycle: 1, prNumber: 42, branch: 'fix', targetHeadSha: 'abc1234def', targetHeadShaShort: 'abc1234', launchedAt: NOW, sessionToken: 'tok-b', displayName: 'Codex B', roleDoc: 'docs/review/b.md', status: 'launching', artifactPath: '.godmode/runs/run-10/reviewers/reviewer-b-1-abc1234-reviewer-b-1.log', promptChars: 210, commentPosted: false },
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

// --- Stale builder-session detection + recovery (issue #55) ------------------

/** A pure builder_running snapshot, advanced through the real transition table. */
function builderRunningRun(overrides = {}) {
  const created = createRun({ issueNumber: 55, issueTitle: 'Recover builder-running runs', now: NOW, id: 'run-55' });
  const running = advance(created, ['select_issue', 'mark_ready', 'start_builder']);
  return { ...running, ...overrides };
}

test('evaluateBuilderRecovery flags a builder_running run with no live builder PTY as stale', () => {
  const run = builderRunningRun();
  const recovery = evaluateBuilderRecovery(run, false);
  assert.equal(recovery.stale, true);
  assert.equal(recovery.hasBoundPr, false);
  assert.match(recovery.message, /no longer live/i);
  // No PR bound yet → the message points at a read-only discovery pass.
  assert.match(recovery.message, /check for a PR|no PR is bound/i);
});

test('evaluateBuilderRecovery is not stale while the builder PTY is live', () => {
  const run = builderRunningRun();
  const recovery = evaluateBuilderRecovery(run, true);
  assert.equal(recovery.stale, false);
  assert.equal(recovery.message, undefined);
});

test('evaluateBuilderRecovery is not stale from any non-builder_running status', () => {
  for (const status of ['issue_selected', 'ready_to_build', 'pr_opened', 'needs_human', 'closed']) {
    const run = { ...builderRunningRun(), status };
    assert.equal(evaluateBuilderRecovery(run, false).stale, false, `expected ${status} to not be stale`);
  }
});

test('evaluateBuilderRecovery handles a null run without throwing', () => {
  const recovery = evaluateBuilderRecovery(null, false);
  assert.deepEqual(recovery, { stale: false, hasBoundPr: false });
});

test('evaluateBuilderRecovery tailors its message when a PR is already bound', () => {
  const run = builderRunningRun({ prNumber: 123, branch: 'feat/x' });
  const recovery = evaluateBuilderRecovery(run, false);
  assert.equal(recovery.stale, true);
  assert.equal(recovery.hasBoundPr, true);
  assert.match(recovery.message, /#123/);
});

test('a resumed/persisted builder_running run has no live PTY and offers recovery actions', () => {
  clearRun();
  // Simulate a persisted builder_running run adopted on restart (issue #40 resume):
  // the in-memory builder PTY cannot survive the restart, so liveness is false.
  const persisted = builderRunningRun();
  const restored = adoptResumedRun(persisted, NOW);
  assert.equal(restored.status, 'builder_running');
  // Recovery is visibly distinct from an actively-running builder.
  assert.equal(evaluateBuilderRecovery(restored, false).stale, true);
  // The explicit "mark agent failed" recovery is a legal action from builder_running.
  assert.ok(
    restored.availableActions.includes('report_agent_failed'),
    'report_agent_failed must be available to recover a stale builder_running run',
  );
  // Marking the agent failed records an auditable transition with a reason.
  const failed = dispatchRunAction('report_agent_failed', {
    reason: 'Builder session was lost (no live PTY).',
    now: NOW,
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.run.status, 'agent_failed');
  const last = failed.run.log[failed.run.log.length - 1];
  assert.equal(last.action, 'report_agent_failed');
  assert.match(last.reason, /no live PTY/);
  // A failed run is no longer stale (it left builder_running).
  assert.equal(evaluateBuilderRecovery(failed.run, false).stale, false);
  clearRun();
});

test('builder relaunch guard contract: a live builder is never stale, so relaunch must refuse it (reviewer-b B-1)', () => {
  // handleRelaunchBuilder gates on this helper: recovery acts only on a genuinely
  // LOST builder. With a live PTY the run is not stale, so the relaunch handler
  // refuses rather than killing and replacing a running builder.
  const run = builderRunningRun();
  assert.equal(evaluateBuilderRecovery(run, true).stale, false, 'a live builder must not be treated as recoverable');
  assert.equal(evaluateBuilderRecovery(run, false).stale, true, 'only a lost builder is recoverable');
});

test('builder relaunch must re-validate across the async worktree gate, not trust a pre-await snapshot (reviewer-b B-1)', () => {
  // ensureRunWorktree awaits (yields the event loop). The relaunch handler's
  // initial live-PTY/status checks are therefore only a pre-await snapshot; before
  // the destructive openPtySession it must re-read the authoritative state and
  // refuse if anything moved. The two failure modes that re-check map to this pure
  // predicate are: (a) a builder PTY became live during the await, and (b) the run
  // is no longer builder_running. Both must read as not-recoverable so the handler
  // returns invalid_state instead of clobbering a live builder / stale context.
  const run = builderRunningRun();
  // (a) A PTY that appears during the await => no longer stale => relaunch refuses.
  assert.equal(
    evaluateBuilderRecovery(run, true).stale,
    false,
    'a builder PTY that becomes live during worktree prep must make recovery refuse',
  );
  // (b) Any drift off builder_running during the await => not stale => relaunch refuses.
  for (const status of ['issue_selected', 'ready_to_build', 'pr_opened', 'needs_human', 'closed']) {
    assert.equal(
      evaluateBuilderRecovery({ ...run, status }, false).stale,
      false,
      `a run that left builder_running (${status}) during worktree prep must make recovery refuse`,
    );
  }
});

const SAMPLE_WORKTREE = {
  path: '/tmp/gm-worktrees/run-55',
  branch: 'godmode/run-55',
  createdAt: NOW,
};

test('setCurrentRunWorktree records the worktree when the expected run is still current', () => {
  clearRun();
  adoptResumedRun(builderRunningRun(), NOW); // current run id === 'run-55'
  const updated = setCurrentRunWorktree(SAMPLE_WORKTREE, { expectedRunId: 'run-55' });
  assert.ok(updated, 'recording must succeed for the matching run');
  assert.equal(updated.id, 'run-55');
  assert.deepEqual(updated.worktree, SAMPLE_WORKTREE);
  // The branch is adopted as the run's working branch.
  assert.equal(updated.branch, SAMPLE_WORKTREE.branch);
  assert.equal(getCurrentRun().worktree.path, SAMPLE_WORKTREE.path);
  clearRun();
});

test('setCurrentRunWorktree refuses to record a stale worktree onto a different current run (reviewer-a A-2)', () => {
  // Models the async worktree gate: preparation began for run-55, but during the await
  // the operator replaced the run. The prepared worktree must NOT be attached to the
  // now-current, unrelated run — recording would corrupt its cwd/branch metadata.
  clearRun();
  const other = createRun({ issueNumber: 99, issueTitle: 'A different run', now: NOW, id: 'run-99' });
  adoptResumedRun(other, NOW); // current run id === 'run-99'
  const updated = setCurrentRunWorktree(SAMPLE_WORKTREE, { expectedRunId: 'run-55' });
  assert.equal(updated, null, 'recording must refuse when the current run is not the expected run');
  // No stale worktree was recorded onto the unrelated run.
  assert.equal(getCurrentRun().id, 'run-99');
  assert.equal(getCurrentRun().worktree, undefined, 'the unrelated run must keep no worktree metadata');
  assert.notEqual(getCurrentRun().branch, SAMPLE_WORKTREE.branch);
  clearRun();
});

test('setCurrentRunWorktree without expectedRunId stays backward-compatible (records onto current run)', () => {
  clearRun();
  adoptResumedRun(builderRunningRun(), NOW);
  const updated = setCurrentRunWorktree(SAMPLE_WORKTREE);
  assert.ok(updated);
  assert.deepEqual(updated.worktree, SAMPLE_WORKTREE);
  clearRun();
});
