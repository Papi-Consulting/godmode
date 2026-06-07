// Reviewer launch composition tests for issue #10. Pure functions only — no
// filesystem, Electron, or `gh` — so they run under Node's built-in test runner
// against the compiled main output (`npm run build:main` first). Run via `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeReviewerLaunch, reviewerCommentBody } from '../dist/main/reviewer.js';
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
