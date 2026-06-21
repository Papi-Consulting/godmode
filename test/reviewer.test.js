// Reviewer launch composition tests for issue #10. Pure functions only — no
// filesystem, Electron, or `gh` — so they run under Node's built-in test runner
// against the compiled main output (`npm run build:main` first). Run via `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ONESHOT_REVIEWER_GENERIC_START_MESSAGE,
  REVIEWER_VERDICT_MARKER,
  canPostReviewerMarker,
  canSynthesizeReviews,
  classifyGenericPaneLaunch,
  composeReviewerLaunch,
  isLoopReviewSynthesisPreempted,
  isLoopReviewerLaunchPreempted,
  isReviewSynthesisPreempted,
  isReviewerLaunchPreempted,
  isReviewerPane,
  isReviewerRunContextStale,
  isReviewerSessionStale,
  resolveReviewerExit,
  reviewerAttemptFingerprint,
  reviewerAttemptId,
  reviewerAttemptsReplaced,
  reviewerCommentBody,
  reviewerLaunchArgs,
  reviewerVerdictExampleLine,
  reviewerLaunchTransition,
} from '../dist/main/reviewer.js';
import { DEFAULT_CONFIG } from '../dist/main/config.js';
import { createRun } from '../dist/main/run.js';

const NOW = '2026-06-06T12:00:00.000Z';
const PR = { number: 42, url: 'https://github.com/x/y/pull/42', branch: 'claude/issue-10-reviewers' };

function issueRun(overrides = {}) {
  return {
    ...createRun({
      sourceType: 'github_issue',
      sourceId: '10',
      issueNumber: 10,
      issueTitle: 'Launch reviewers from a verified PR',
      now: NOW,
      id: 'run-10',
    }),
    status: 'pr_opened',
    prNumber: 42,
    branch: PR.branch,
    ...overrides,
  };
}

test('a verified PR produces a startable, pointer-first plan per configured reviewer', () => {
  const plan = composeReviewerLaunch(DEFAULT_CONFIG, issueRun(), {
    projectName: 'godmode',
    pr: PR,
    verified: true,
  });

  assert.equal(plan.isMock, false);
  assert.equal(plan.canStart, true);
  assert.equal(plan.blockedReason, undefined);
  assert.equal(plan.prNumber, 42);
  assert.equal(plan.prUrl, PR.url);
  assert.equal(plan.branch, PR.branch);
  assert.equal(plan.reviewers.length, 2);

  const [a, b] = plan.reviewers;
  assert.equal(a.reviewerId, 'reviewer-a');
  assert.equal(a.paneId, 'reviewer_a');
  assert.equal(b.reviewerId, 'reviewer-b');
  assert.deepEqual(a.missingVariables, []);

  // Bound to the verified PR coordinates, reviewer id, and role doc.
  assert.match(a.prompt, /PR #42/);
  assert.match(a.prompt, /https:\/\/github\.com\/x\/y\/pull\/42/);
  assert.match(a.prompt, /claude\/issue-10-reviewers/);
  assert.match(a.prompt, /reviewer-a/);
  assert.match(a.prompt, /docs\/review\/reviewer-a-correctness\.md/);
  // Pointer-first: read AGENTS.md + the live PR yourself, scoped to the operated project.
  assert.match(a.prompt, /AGENTS\.md/);
  assert.match(a.prompt, /gh pr diff 42/);
  assert.match(a.prompt, /gh pr view 42/);
  assert.match(a.prompt, /gh issue view 10 --comments/);
  assert.match(a.prompt, /operated project/i);
  assert.match(a.prompt, /FRESH review session/);
  // No template tokens left unresolved in a startable plan.
  assert.ok(!a.prompt.includes('{{'));
  // It is a pointer, not a paste: the prompt explicitly says the diff is not inlined.
  assert.match(a.prompt, /it is not pasted here/);
});

test('issue #60: the reviewer prompt documents the role-signed fallback verdict protocol', () => {
  const plan = composeReviewerLaunch(DEFAULT_CONFIG, issueRun(), {
    projectName: 'godmode',
    pr: PR,
    verified: true,
  });
  const [a, b] = plan.reviewers;

  // Prefer a formal review; fall back to the role-signed verdict only when GitHub
  // refuses same-account approval. The grammar is present and pane-specific.
  assert.match(a.prompt, /FORMAL GitHub review/);
  assert.match(a.prompt, /same account owns the PR branch/i);
  assert.match(a.prompt, new RegExp(REVIEWER_VERDICT_MARKER));
  assert.match(a.prompt, /reviewer=reviewer-a pane=reviewer_a pr=42/);
  assert.match(b.prompt, /reviewer=reviewer-b pane=reviewer_b pr=42/);
  // The blocked-verdict block label is pane-specific (A- vs B-).
  assert.match(a.prompt, /BLOCKING A-1:/);
  assert.match(b.prompt, /BLOCKING B-1:/);
  // Framed as harness evidence, NOT a GitHub-native approval, distinct from the marker.
  assert.match(a.prompt, /harness/i);
  assert.match(a.prompt, /NOT a\s+GitHub-native approval/i);
  assert.ok(!a.prompt.includes('{{'));
});

test('issue #60: reviewerVerdictExampleLine builds a pane-specific, parseable grammar line', () => {
  const line = reviewerVerdictExampleLine('reviewer-b', 'reviewer_b', 7);
  assert.match(line, /^GODMODE_REVIEW_VERDICT /);
  assert.match(line, /reviewer=reviewer-b/);
  assert.match(line, /pane=reviewer_b/);
  assert.match(line, /pr=7/);
  assert.match(line, /status=approved/);
  assert.match(line, /blocking=0/);
});

test('default reviewers are one-shot and launch the non-interactive codex exec path', () => {
  // Regression guard: a one-shot reviewer must run to completion and exit (so it
  // auto-posts), which requires the non-interactive `codex exec` command — plain
  // `codex` opens the interactive CLI and never returns.
  const plan = composeReviewerLaunch(DEFAULT_CONFIG, issueRun(), {
    projectName: 'godmode',
    pr: PR,
    verified: true,
  });
  for (const reviewer of plan.reviewers) {
    assert.equal(reviewer.delivery, 'oneshot');
    assert.match(reviewer.commandLine, /codex exec/);
  }
});

test('issue #58: a one-shot reviewer pane cannot be generically started (no run-bound prompt)', () => {
  // The generic pane Start/Restart path provides no prompt, so spawning a one-shot
  // reviewer there would launch an empty `codex exec` that exits with a no-prompt
  // error. Both reviewer panes must be refused before spawn, with an actionable
  // message pointing at the run-bound "Start reviewers" launch.
  for (const pane of ['reviewer_a', 'reviewer_b']) {
    const decision = classifyGenericPaneLaunch(pane, 'oneshot');
    assert.equal(decision.allowed, false, `${pane} one-shot generic start must be refused`);
    assert.equal(decision.reason, ONESHOT_REVIEWER_GENERIC_START_MESSAGE);
    assert.match(decision.reason, /Start reviewers/);
    assert.match(decision.reason, /verified PR/i);
  }
});

test('issue #58: interactive reviewers and non-reviewer panes keep their generic launch', () => {
  // An interactive reviewer is a normal live shell the operator may start directly;
  // builder/head panes are never reviewer one-shot launches. Keys off role + mode,
  // not a vendor branch — `oneshot_or_interactive` reviewers deliver over the PTY.
  assert.deepEqual(classifyGenericPaneLaunch('reviewer_a', 'interactive'), { allowed: true });
  assert.deepEqual(classifyGenericPaneLaunch('reviewer_b', 'oneshot_or_interactive'), { allowed: true });
  assert.deepEqual(classifyGenericPaneLaunch('builder', 'oneshot'), { allowed: true });
  assert.deepEqual(classifyGenericPaneLaunch('head', 'interactive'), { allowed: true });
  assert.equal(isReviewerPane('reviewer_a'), true);
  assert.equal(isReviewerPane('reviewer_b'), true);
  assert.equal(isReviewerPane('builder'), false);
  assert.equal(isReviewerPane('head'), false);
});

test('issue #58: the run-bound reviewer launch passes a one-shot reviewer its full prompt at process start', () => {
  // The prompt-bearing workflow must keep delivering the rendered prompt as a launch
  // argument for one-shot reviewers (present at spawn, so it is never lost against an
  // already-exited process), while interactive reviewers take no launch arg and
  // receive the prompt over the PTY instead.
  const plan = composeReviewerLaunch(DEFAULT_CONFIG, issueRun(), {
    projectName: 'godmode',
    pr: PR,
    verified: true,
  });
  assert.ok(plan.reviewers.length > 0);
  for (const reviewer of plan.reviewers) {
    const args = reviewerLaunchArgs('oneshot', reviewer.prompt);
    assert.deepEqual(args, [reviewer.prompt]);
    assert.ok(args[0].length > 0, 'one-shot reviewer must launch with a non-empty prompt');
    assert.match(args[0], new RegExp(`PR #${PR.number}`));
  }
  assert.equal(reviewerLaunchArgs('interactive', 'hello'), undefined);
  assert.equal(reviewerLaunchArgs('oneshot_or_interactive', 'hello'), undefined);
});

test('an unverified PR blocks launch even when the PR is bound', () => {
  const plan = composeReviewerLaunch(DEFAULT_CONFIG, issueRun(), {
    projectName: 'godmode',
    pr: PR,
    verified: false,
  });
  assert.equal(plan.isMock, false);
  assert.equal(plan.canStart, false);
  assert.match(plan.blockedReason, /not verified/i);
});

test('no bound PR yields a clearly-mock plan that cannot start', () => {
  const plan = composeReviewerLaunch(DEFAULT_CONFIG, issueRun(), {
    projectName: 'godmode',
    verified: true,
  });
  assert.equal(plan.isMock, true);
  assert.equal(plan.canStart, false);
  assert.match(plan.blockedReason, /verified PR/i);
  // Without PR coordinates the per-reviewer template leaves PR tokens unresolved.
  assert.ok(plan.reviewers[0].missingVariables.length > 0);
});

test('a reviewer with no role doc blocks the plan rather than launching with an unbound token', () => {
  const config = {
    ...DEFAULT_CONFIG,
    roles: {
      ...DEFAULT_CONFIG.roles,
      reviewers: [{ pane: 'reviewer_a', id: 'reviewer-a', agent: 'codex', display_name: 'Codex' }],
    },
  };
  const plan = composeReviewerLaunch(config, issueRun(), { projectName: 'godmode', pr: PR, verified: true });
  assert.equal(plan.canStart, false);
  assert.ok(plan.reviewers[0].missingVariables.includes('roleDoc'));
  assert.match(plan.blockedReason, /reviewer-a/);
});

test('the marker comment is role-signed, references the artifact, and asserts no merge-readiness', () => {
  const body = reviewerCommentBody({
    reviewerId: 'reviewer-a',
    displayName: 'Codex A',
    roleDoc: 'docs/review/reviewer-a-correctness.md',
    prNumber: 42,
    branch: 'claude/issue-10-reviewers',
    artifactRelPath: '.godmode/runs/run-10/reviewer-a.log',
  });
  assert.match(body, /GodMode/);
  assert.match(body, /reviewer-a/);
  assert.match(body, /Codex A/);
  assert.match(body, /PR #42/);
  assert.match(body, /\.godmode\/runs\/run-10\/reviewer-a\.log/);
  assert.match(body, /does not assert merge-readiness/i);
  // It is a marker, not the reviewer's verdict.
  assert.match(body, /reviewer’s own .*PR comments/);
});

// --- Launch transition + exit resolution (Hermes review) --------------------

test('reviewers launch from both the initial PR and a fix-pushed cycle', () => {
  // Initial PR and its relaunch.
  assert.deepEqual(reviewerLaunchTransition('pr_opened'), {
    allowed: true,
    action: 'start_reviewers',
    relaunch: false,
  });
  assert.deepEqual(reviewerLaunchTransition('reviewers_running'), { allowed: true, action: null, relaunch: true });

  // Fix cycle: after a builder fix is pushed, reviewers must be relaunchable for
  // the new commit — otherwise the run advances to synthesis with stale evidence.
  assert.deepEqual(reviewerLaunchTransition('fix_pushed'), {
    allowed: true,
    action: 'rerun_reviewers',
    relaunch: false,
  });
  assert.deepEqual(reviewerLaunchTransition('reviewers_rerunning'), {
    allowed: true,
    action: null,
    relaunch: true,
  });

  // Everything else is disallowed (the main process still re-validates).
  for (const status of ['idle', 'issue_selected', 'builder_running', 'review_synthesis', 'merge_ready']) {
    assert.deepEqual(reviewerLaunchTransition(status), { allowed: false }, `expected ${status} disallowed`);
  }
});

test('a non-zero reviewer exit becomes failed with no auto marker comment', () => {
  // Clean exit → completed (the caller then auto-posts the marker).
  assert.deepEqual(resolveReviewerExit('running', 0), { kind: 'completed' });

  // Non-zero exit → failed, surfaced visibly, never collapsed into success.
  const failed = resolveReviewerExit('running', 1);
  assert.equal(failed.kind, 'failed');
  assert.match(failed.error, /exited with code 1/);
  assert.match(failed.error, /no marker comment/i);

  // A capture failure already flipped it to failed mid-run — keep it failed.
  assert.deepEqual(resolveReviewerExit('failed', 0), { kind: 'keep_failed' });
  assert.deepEqual(resolveReviewerExit('failed', 1), { kind: 'keep_failed' });
});

test('only a reviewer session that actually ran can have its marker posted', () => {
  // Postable: a session that ran (and re-post of an already-posted one).
  assert.equal(canPostReviewerMarker('completed'), true);
  assert.equal(canPostReviewerMarker('comment_posted'), true);
  assert.equal(canPostReviewerMarker('running'), true);

  // Not postable: a failed (launch/capture/non-zero exit) or not-yet-run session,
  // so the operator override can never turn a failure green.
  assert.equal(canPostReviewerMarker('failed'), false);
  assert.equal(canPostReviewerMarker('launching'), false);
  assert.equal(canPostReviewerMarker('idle'), false);
});

test('isReviewerRunContextStale detects a changed run or operated project across an await', () => {
  const captured = { runId: 'run-10', root: '/p/alpha' };
  // Unchanged context → not stale, safe to mutate.
  assert.equal(isReviewerRunContextStale({ runId: 'run-10', root: '/p/alpha' }, captured), false);
  // Run cleared mid-await (no current run) → stale.
  assert.equal(isReviewerRunContextStale({ runId: null, root: '/p/alpha' }, captured), true);
  // A different run now current (same pane ids) → stale.
  assert.equal(isReviewerRunContextStale({ runId: 'run-11', root: '/p/alpha' }, captured), true);
  // Operated project switched → stale.
  assert.equal(isReviewerRunContextStale({ runId: 'run-10', root: '/p/beta' }, captured), true);
});

test('isReviewerSessionStale detects a same-run reviewer relaunch across an await', () => {
  const capturedToken = 'tok-launch-1';
  // Same tracked session (token unchanged) → not stale, safe to record the post.
  assert.equal(isReviewerSessionStale('tok-launch-1', capturedToken), false);
  // The pane was relaunched in the same run/root → a fresh token → stale, so an
  // in-flight post can't stamp the new session comment_posted with the old URL.
  assert.equal(isReviewerSessionStale('tok-launch-2', capturedToken), true);
  // The session vanished (cleared/replaced with no token) → stale.
  assert.equal(isReviewerSessionStale(undefined, capturedToken), true);
});

// --- Preemption guards (issue #39, blocker B-1) ------------------------------
// A loop- or operator-driven stage captures the run, then `await`s the live #9
// verification. Pausing or any manual dispatch during that await advances the run
// WITHOUT changing its id/root, so the stale guard alone would still pass. These
// pure predicates re-gate the stage on the live status so no PTY spawn / artifact
// write / finding write / transition happens after operator preemption.

test('canSynthesizeReviews: only the reviewers-running window is synthesis-legal', () => {
  assert.equal(canSynthesizeReviews('reviewers_running'), true);
  assert.equal(canSynthesizeReviews('reviewers_rerunning'), true);
  for (const status of ['pr_opened', 'review_synthesis', 'paused', 'merge_ready', 'builder_fixing']) {
    assert.equal(canSynthesizeReviews(status), false, `expected ${status} not synthesis-legal`);
  }
});

test('isReviewerLaunchPreempted: launch-legal statuses are not preempted', () => {
  for (const status of ['pr_opened', 'fix_pushed', 'reviewers_running', 'reviewers_rerunning']) {
    assert.equal(isReviewerLaunchPreempted(status), false, `expected ${status} launchable`);
  }
});

test('isReviewerLaunchPreempted: a pause/cancel/terminal during verification aborts the launch', () => {
  for (const status of ['paused', 'cancelled', 'closed', 'merge_ready', 'needs_human', 'review_synthesis']) {
    assert.equal(isReviewerLaunchPreempted(status), true, `expected ${status} to preempt launch`);
  }
  // No current run (cleared during the await) is preempted by definition.
  assert.equal(isReviewerLaunchPreempted(null), true);
});

test('isReviewSynthesisPreempted: leaving the reviewers-running window aborts synthesis', () => {
  assert.equal(isReviewSynthesisPreempted('reviewers_running'), false);
  assert.equal(isReviewSynthesisPreempted('reviewers_rerunning'), false);
  for (const status of ['paused', 'cancelled', 'review_synthesis', 'merge_ready', 'pr_opened']) {
    assert.equal(isReviewSynthesisPreempted(status), true, `expected ${status} to preempt synthesis`);
  }
  assert.equal(isReviewSynthesisPreempted(null), true);
});

// Blocker B-1 (re-review): the status-only guard above treats a manual
// `start_reviewers` that advanced `pr_opened → reviewers_running` as a legal
// idempotent relaunch, so it cannot tell "this loop stage is still valid" from
// "the operator already performed the stage." The loop-stage generation token
// closes that gap: a loop-driven stage is preempted whenever its captured
// generation went stale, EVEN when the live status is otherwise launch-legal.
test('isLoopReviewerLaunchPreempted: a generation bump preempts a loop stage even in a launch-legal status', () => {
  // The exact manual-dispatch race: status is still launch-legal but an operator
  // dispatch bumped the generation while verification was in flight.
  for (const status of ['pr_opened', 'fix_pushed', 'reviewers_running', 'reviewers_rerunning']) {
    assert.equal(
      isLoopReviewerLaunchPreempted(status, true),
      true,
      `expected a stale generation to preempt the loop stage at ${status}`,
    );
    // No generation bump at the same launch-legal status: a legitimate idempotent
    // relaunch is NOT preempted (operator-triggered relaunches keep working).
    assert.equal(
      isLoopReviewerLaunchPreempted(status, false),
      false,
      `expected ${status} with a fresh generation to remain launchable`,
    );
  }
});

test('isLoopReviewerLaunchPreempted: the status guard still preempts without a generation bump', () => {
  // A stop transition that did not bump the generation still aborts the stage.
  for (const status of ['paused', 'cancelled', 'review_synthesis', null]) {
    assert.equal(isLoopReviewerLaunchPreempted(status, false), true, `expected ${status} to preempt`);
  }
});

test('isLoopReviewSynthesisPreempted: a generation bump preempts synthesis inside the legal window', () => {
  // reviewers_running/reviewers_rerunning are the legal synthesis window, yet a
  // manual dispatch that bumped the generation must still preempt the loop stage.
  for (const status of ['reviewers_running', 'reviewers_rerunning']) {
    assert.equal(isLoopReviewSynthesisPreempted(status, true), true, `expected stale gen to preempt at ${status}`);
    assert.equal(isLoopReviewSynthesisPreempted(status, false), false, `expected fresh gen legal at ${status}`);
  }
  // The status guard still preempts a stop transition with no generation bump.
  assert.equal(isLoopReviewSynthesisPreempted('paused', false), true);
  assert.equal(isLoopReviewSynthesisPreempted(null, false), true);
});

// --- Reviewer attempt identity (issue #59) -----------------------------------

test('reviewerAttemptId composes <cycle>-<shortSha>-<reviewerId>-<timestamp>', () => {
  const id = reviewerAttemptId({
    cycle: 2,
    headShaShort: 'abc1234',
    reviewerId: 'reviewer-a',
    launchedAt: '2026-06-20T10:11:12.000Z',
  });
  assert.equal(id, '2-abc1234-reviewer-a-20260620101112000');
});

test('reviewerAttemptId is distinct across same-head relaunches (timestamp varies)', () => {
  const base = { cycle: 1, headShaShort: 'deadbee', reviewerId: 'reviewer-b' };
  const first = reviewerAttemptId({ ...base, launchedAt: '2026-06-20T10:00:00.000Z' });
  const second = reviewerAttemptId({ ...base, launchedAt: '2026-06-20T10:05:00.000Z' });
  assert.notEqual(first, second, 'a relaunch for the same cycle+head is still a distinct attempt');
});

test('reviewerAttemptId sanitizes unsafe characters so it is filename-safe', () => {
  const id = reviewerAttemptId({
    cycle: 1,
    headShaShort: 'ab/cd',
    reviewerId: '../evil',
    launchedAt: '2026-06-20T00:00:00.000Z',
  });
  assert.ok(!id.includes('/'), 'no path separators');
  assert.ok(!id.includes('..'), 'no parent-dir segments');
  assert.match(id, /^[A-Za-z0-9_-]+$/);
});

// --- Reviewer-attempt fingerprint / relaunch detection (issue #59, A-2) -------
// Synthesis re-runs the live #9 gate across an `await`; a concurrent operator
// reviewer relaunch can replace `run.reviewers` during that window while keeping
// the run in `reviewers_running` (an idempotent relaunch), so neither the status
// guard nor the loop-generation guard catches it. Comparing attempt fingerprints
// across the await is what aborts the stale synthesis (blocker A-2).

test('reviewerAttemptFingerprint is order-independent and ignores non-attempt fields', () => {
  const a = { paneId: 'reviewer_a', attemptId: '1-aaa-reviewer-a-t1', status: 'running' };
  const b = { paneId: 'reviewer_b', attemptId: '1-aaa-reviewer-b-t1', status: 'completed' };
  // Same attempts in any order produce the same fingerprint.
  assert.equal(reviewerAttemptFingerprint([a, b]), reviewerAttemptFingerprint([b, a]));
  // A status change (not an attempt change) does not move the fingerprint.
  assert.equal(
    reviewerAttemptFingerprint([a, b]),
    reviewerAttemptFingerprint([{ ...a, status: 'completed' }, { ...b, status: 'failed' }]),
  );
  // No reviewers → empty fingerprint.
  assert.equal(reviewerAttemptFingerprint([]), '');
  assert.equal(reviewerAttemptFingerprint(undefined), '');
});

test('reviewerAttemptsReplaced: a concurrent relaunch (new attemptIds) is detected', () => {
  const before = [
    { paneId: 'reviewer_a', attemptId: '1-aaa-reviewer-a-t1' },
    { paneId: 'reviewer_b', attemptId: '1-aaa-reviewer-b-t1' },
  ];
  const captured = reviewerAttemptFingerprint(before);
  // No relaunch: same attempts (status may have advanced) → not replaced.
  assert.equal(
    reviewerAttemptsReplaced(captured, [
      { ...before[0], status: 'completed' },
      { ...before[1], status: 'completed' },
    ]),
    false,
  );
  // A relaunch mints fresh attemptIds for the same panes → replaced.
  assert.equal(
    reviewerAttemptsReplaced(captured, [
      { paneId: 'reviewer_a', attemptId: '2-bbb-reviewer-a-t2' },
      { paneId: 'reviewer_b', attemptId: '2-bbb-reviewer-b-t2' },
    ]),
    true,
  );
  // The sessions were cleared/replaced entirely → replaced.
  assert.equal(reviewerAttemptsReplaced(captured, undefined), true);
  assert.equal(reviewerAttemptsReplaced(captured, []), true);
});
