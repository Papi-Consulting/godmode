// Commit-verification tests for issue #9. Pure state-derivation and commit-list
// comparison — no Electron, no `gh`/`git`, no filesystem — so they run under
// Node's built-in test runner against the compiled main output
// (`npm run build:main` first). Run via `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitMatches, deriveVerification, summarizeChecks } from '../dist/main/verify.js';

const NOW = '2026-06-06T12:00:00.000Z';
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** Build evidence with sensible defaults so each test overrides only what it asserts. */
function evidence(overrides = {}) {
  return {
    branch: 'claude/issue-9',
    expectedCommit: HEAD,
    expectedCommitSource: 'local_head',
    queryFailed: false,
    pr: null,
    ...overrides,
  };
}

/** A PR with the expected commit on its head and all checks passing. */
function prWith(overrides = {}) {
  return {
    number: 9,
    state: 'OPEN',
    url: 'https://github.com/o/r/pull/9',
    headRefName: 'claude/issue-9',
    headSha: HEAD,
    commits: [OTHER, HEAD],
    checks: [{ name: 'build', conclusion: 'SUCCESS' }],
    ...overrides,
  };
}

test('commitMatches: exact, prefix, and non-match', () => {
  assert.equal(commitMatches(HEAD, HEAD), true);
  // 7-char prefix of a full SHA matches.
  assert.equal(commitMatches('aaaaaaa', HEAD), true);
  assert.equal(commitMatches(HEAD, 'aaaaaaa'), true);
  // Different commits do not match.
  assert.equal(commitMatches(HEAD, OTHER), false);
  // Prefixes shorter than 7 chars are rejected to avoid false matches.
  assert.equal(commitMatches('aaa', HEAD), false);
  // Empty/null-ish inputs never match.
  assert.equal(commitMatches('', HEAD), false);
});

test('summarizeChecks buckets pass/pending/fail and counts unknowns as failing', () => {
  const summary = summarizeChecks([
    { name: 'a', conclusion: 'SUCCESS' },
    { name: 'b', conclusion: 'NEUTRAL' },
    { name: 'c', conclusion: 'SKIPPED' },
    { name: 'd', conclusion: 'PENDING' },
    { name: 'e', conclusion: 'FAILURE' },
    { name: 'f', conclusion: 'WHATEVER' },
  ]);
  assert.deepEqual(summary, { total: 6, passing: 3, pending: 1, failing: 2 });
});

test('verified when the expected commit is on the PR and checks pass', () => {
  const v = deriveVerification(evidence({ pr: prWith() }), NOW);
  assert.equal(v.status, 'verified');
  assert.equal(v.commitInList, true);
  assert.equal(v.matchesHead, true);
  assert.equal(v.currentHeadVerified, true);
  assert.equal(v.prState, 'OPEN');
  assert.equal(v.mergeConfirmed, false);
  assert.equal(v.partial, false);
  assert.equal(v.expectedCommitShort, 'aaaaaaa');
  assert.equal(v.pr.number, 9);
  assert.equal(v.fetchedAt, NOW);
});

test('stale_head when the expected commit is in PR history but no longer the head (issue #61)', () => {
  // Expected commit is in the list but the remote head moved on (newer commit).
  // Presence in history must NOT be treated as current-head verification: this is
  // the regression guard for stale evidence gating reviewer launch/merge-ready.
  const pr = prWith({ headSha: OTHER, commits: [OTHER, HEAD] });
  const v = deriveVerification(evidence({ pr }), NOW);
  assert.equal(v.commitInList, true);
  assert.equal(v.matchesHead, false);
  assert.equal(v.status, 'stale_head');
  // The invariant: history presence is not current-head evidence.
  assert.equal(v.currentHeadVerified, false);
  // The message names both SHAs so an operator sees exactly what drifted.
  assert.match(v.message, /history/);
  assert.match(v.message, /bbbbbbb/);
});

test('stale_head takes precedence over passing checks on the moved head', () => {
  // Even if the (new-head) checks are green, an old expected commit that is no
  // longer the head cannot read as verified — the head was never verified.
  const pr = prWith({
    headSha: OTHER,
    commits: [OTHER, HEAD],
    checks: [{ name: 'build', conclusion: 'SUCCESS' }],
  });
  const v = deriveVerification(evidence({ pr }), NOW);
  assert.equal(v.status, 'stale_head');
  assert.equal(v.currentHeadVerified, false);
});

test('merged PR with the expected commit only in history is still verified (head freshness moot)', () => {
  // Once merged, the head-drift concern is terminal: the merge confirms the code.
  const pr = prWith({ state: 'MERGED', headSha: OTHER, commits: [OTHER, HEAD] });
  const v = deriveVerification(evidence({ pr }), NOW);
  assert.equal(v.status, 'verified');
  assert.equal(v.mergeConfirmed, true);
  assert.equal(v.currentHeadVerified, true);
});

test('missing_remote_commit when the expected commit is absent from the PR', () => {
  const pr = prWith({ headSha: OTHER, commits: [OTHER] });
  const v = deriveVerification(evidence({ pr }), NOW);
  assert.equal(v.status, 'missing_remote_commit');
  assert.equal(v.commitInList, false);
  assert.equal(v.matchesHead, false);
});

test('no_pr_for_branch when no PR is matched', () => {
  const v = deriveVerification(evidence({ pr: null }), NOW);
  assert.equal(v.status, 'no_pr_for_branch');
  assert.equal(v.pr, null);
});

test('needs_refresh when a query failed (partial evidence)', () => {
  const v = deriveVerification(evidence({ queryFailed: true, pr: null }), NOW);
  assert.equal(v.status, 'needs_refresh');
  assert.equal(v.partial, true);
});

test('needs_human when no commit could be resolved', () => {
  const v = deriveVerification(
    evidence({ expectedCommit: null, expectedCommitSource: 'unknown', pr: prWith() }),
    NOW,
  );
  assert.equal(v.status, 'needs_human');
  assert.equal(v.expectedCommit, null);
  assert.equal(v.expectedCommitShort, null);
});

test('checks_failed when commit matches but a check failed', () => {
  const pr = prWith({ checks: [{ name: 'build', conclusion: 'FAILURE' }] });
  const v = deriveVerification(evidence({ pr }), NOW);
  assert.equal(v.status, 'checks_failed');
  assert.equal(v.checks.failing, 1);
});

test('checks_pending when commit matches and a check is still running', () => {
  const pr = prWith({
    checks: [
      { name: 'build', conclusion: 'SUCCESS' },
      { name: 'e2e', conclusion: 'PENDING' },
    ],
  });
  const v = deriveVerification(evidence({ pr }), NOW);
  assert.equal(v.status, 'checks_pending');
  assert.equal(v.checks.pending, 1);
});

test('failing checks take precedence over pending', () => {
  const pr = prWith({
    checks: [
      { name: 'lint', conclusion: 'FAILURE' },
      { name: 'e2e', conclusion: 'PENDING' },
    ],
  });
  assert.equal(deriveVerification(evidence({ pr }), NOW).status, 'checks_failed');
});

test('merged PR is verified and merge-confirmed regardless of stale checks', () => {
  const pr = prWith({ state: 'MERGED', checks: [{ name: 'e2e', conclusion: 'PENDING' }] });
  const v = deriveVerification(evidence({ pr }), NOW);
  assert.equal(v.status, 'verified');
  assert.equal(v.prState, 'MERGED');
  assert.equal(v.mergeConfirmed, true);
});

test('closed-without-merge PR routes to needs_human', () => {
  const pr = prWith({ state: 'CLOSED' });
  const v = deriveVerification(evidence({ pr }), NOW);
  assert.equal(v.status, 'needs_human');
  assert.equal(v.mergeConfirmed, false);
  assert.equal(v.prState, 'CLOSED');
});

test('a missing commit on a closed PR still reports missing_remote_commit first', () => {
  // The commit-presence gate runs before the closed-PR gate: an unpushed commit
  // is the more actionable signal than the closed state.
  const pr = prWith({ state: 'CLOSED', headSha: OTHER, commits: [OTHER] });
  assert.equal(deriveVerification(evidence({ pr }), NOW).status, 'missing_remote_commit');
});
