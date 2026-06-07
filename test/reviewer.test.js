// Reviewer launch composition tests for issue #10. Pure functions only — no
// filesystem, Electron, or `gh` — so they run under Node's built-in test runner
// against the compiled main output (`npm run build:main` first). Run via `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canPostReviewerMarker,
  composeReviewerLaunch,
  isReviewerRunContextStale,
  isReviewerSessionStale,
  resolveReviewerExit,
  reviewerCommentBody,
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
