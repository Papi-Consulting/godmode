// Role-signed fallback verdict-comment parsing + evidence reconciliation tests
// for issue #60. Pure functions only — no filesystem, Electron, or `gh` — run
// against the compiled main output (`npm run build:main` first) via `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptedBlockers,
  computeMergeReadiness,
  currentHeadResults,
  parseReviewerVerdictComments,
  reconcileReviewerEvidence,
} from '../dist/main/findings.js';

// A full 40-char head SHA and a different (old) one.
const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80912';
const OLD = '0011223344556677889900aabbccddeeff001122';
const PR = 42;

const REVIEWERS = [
  { reviewerId: 'reviewer-a', paneId: 'reviewer_a' },
  { reviewerId: 'reviewer-b', paneId: 'reviewer_b' },
];

/** Build a verdict comment body (verdict line + optional BLOCKING blocks). */
function verdictComment(paneId, opts = {}) {
  const {
    reviewer = paneId === 'reviewer_a' ? 'reviewer-a' : 'reviewer-b',
    pane = paneId,
    pr = PR,
    head = HEAD,
    status = 'approved',
    blocking = 0,
    blocks = '',
    author = 'dogfood-bot',
    createdAt = '2026-06-17T00:00:00.000Z',
  } = opts;
  const line = `GODMODE_REVIEW_VERDICT reviewer=${reviewer} pane=${pane} pr=${pr} head=${head} status=${status} blocking=${blocking}`;
  return { author, body: blocks ? `${line}\n\n${blocks}` : line, createdAt };
}

/** A 1-blocker BLOCKING block for the given marker. */
function blockingBlock(marker) {
  return [`BLOCKING ${marker}: Real bug`, 'File: a.ts:1', 'Issue: trusts self-report', 'Suggested fix: use the #9 gate'].join('\n');
}

function parse(comments, { prNumber = PR, currentHeadSha = HEAD } = {}) {
  return parseReviewerVerdictComments({ comments, prNumber, currentHeadSha, reviewers: REVIEWERS });
}

/** A verified #9 verification stub carrying a resolvable PR head SHA. */
function verifiedHead(headSha) {
  return {
    status: 'verified',
    pr: { number: PR, url: 'https://github.com/x/y/pull/42', headRefName: 'fix', headSha, headShaShort: headSha.slice(0, 7) },
  };
}

/** Session/artifact head evidence (the shape reviewerHeadEvidence produces). */
function sessionHead(paneId, { head = HEAD, current = true, completed = true } = {}) {
  const reviewerId = paneId === 'reviewer_a' ? 'reviewer-a' : 'reviewer-b';
  return { reviewerId, paneId, attemptHeadSha: head, attemptHeadShaShort: head.slice(0, 7), current, completed };
}

/** A minimal captured-artifact result. */
function artifact(paneId, status, findings = []) {
  const reviewerId = paneId === 'reviewer_a' ? 'reviewer-a' : 'reviewer-b';
  return { reviewerId, paneId, status, findings, notes: [] };
}
const ambiguousArtifact = (paneId) => artifact(paneId, 'ambiguous');
const passArtifact = (paneId) => artifact(paneId, 'pass');

// --- Parsing -----------------------------------------------------------------

test('parses a clean current-head approved verdict', () => {
  const { outcomes } = parse([verdictComment('reviewer_a')]);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].kind, 'verdict');
  assert.equal(outcomes[0].paneId, 'reviewer_a');
  assert.equal(outcomes[0].verdict.status, 'approved');
  assert.equal(outcomes[0].verdict.declaredBlocking, 0);
  assert.equal(outcomes[0].verdict.findings.length, 0);
});

test('parses a short-SHA approved verdict (7-char head matches the full current head)', () => {
  const { outcomes } = parse([verdictComment('reviewer_a', { head: HEAD.slice(0, 7) })]);
  assert.equal(outcomes[0].kind, 'verdict');
  assert.equal(outcomes[0].verdict.status, 'approved');
});

test('parses a blocked verdict and normalizes its BLOCKING blocks into findings', () => {
  const { outcomes } = parse([
    verdictComment('reviewer_a', { status: 'blocked', blocking: 1, blocks: blockingBlock('A-1') }),
  ]);
  assert.equal(outcomes[0].kind, 'verdict');
  assert.equal(outcomes[0].verdict.status, 'blocked');
  assert.equal(outcomes[0].verdict.findings.length, 1);
  assert.equal(outcomes[0].verdict.findings[0].marker, 'A-1');
  assert.equal(outcomes[0].verdict.findings[0].file, 'a.ts');
  assert.equal(outcomes[0].verdict.findings[0].line, 1);
});

test('ignores a stale-head verdict safely (no outcome, audited)', () => {
  const { outcomes, ignored } = parse([verdictComment('reviewer_a', { head: OLD })]);
  assert.equal(outcomes.length, 0);
  assert.equal(ignored.length, 1);
  assert.match(ignored[0].reason, /stale-head/);
});

test('ignores a wrong-PR verdict safely', () => {
  const { outcomes, ignored } = parse([verdictComment('reviewer_a', { pr: 999 })]);
  assert.equal(outcomes.length, 0);
  assert.match(ignored[0].reason, /wrong-PR/);
});

test('ignores an unknown-reviewer verdict safely', () => {
  // No pane= and a reviewer id that matches no configured reviewer.
  const comment = {
    author: 'stranger',
    body: `GODMODE_REVIEW_VERDICT reviewer=mallory pr=${PR} head=${HEAD} status=approved blocking=0`,
    createdAt: '',
  };
  const { outcomes, ignored } = parse([comment]);
  assert.equal(outcomes.length, 0);
  assert.match(ignored[0].reason, /unknown-reviewer/);
});

test('ignores an inconsistent pane/reviewer pairing as unknown', () => {
  const { outcomes, ignored } = parse([verdictComment('reviewer_a', { reviewer: 'reviewer-b', pane: 'reviewer_a' })]);
  assert.equal(outcomes.length, 0);
  assert.match(ignored[0].reason, /unknown-reviewer/);
});

test('ignores a comment with no verdict marker (unrelated)', () => {
  const { outcomes, ignored } = parse([{ author: 'x', body: 'Looks great, nice work!', createdAt: '' }]);
  assert.equal(outcomes.length, 0);
  assert.equal(ignored.length, 0);
});

test('a malformed current-head verdict (missing status) routes to ambiguous, never a silent pass', () => {
  const comment = {
    author: 'dev',
    body: `GODMODE_REVIEW_VERDICT reviewer=reviewer-a pane=reviewer_a pr=${PR} head=${HEAD} blocking=0`,
    createdAt: '',
  };
  const { outcomes } = parse([comment]);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].kind, 'ambiguous');
  assert.match(outcomes[0].reason, /unknown status/);
});

test('an approved verdict that declares blocking>0 is malformed → ambiguous', () => {
  const { outcomes } = parse([verdictComment('reviewer_a', { status: 'approved', blocking: 2 })]);
  assert.equal(outcomes[0].kind, 'ambiguous');
  assert.match(outcomes[0].reason, /declares blocking=2/);
});

test('an approved blocking=0 verdict that embeds BLOCKING blocks is contradictory → ambiguous (B-1)', () => {
  // Regression for PR #68 B-1: the marker declares approved/blocking=0 but the
  // body lists a BLOCKING block. This contradiction must route to ambiguous,
  // never a silent approved pass that could clear a reviewer gate.
  const { outcomes } = parse([
    verdictComment('reviewer_a', { status: 'approved', blocking: 0, blocks: blockingBlock('A-1') }),
  ]);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].kind, 'ambiguous');
  assert.match(outcomes[0].reason, /contradicts itself with 1 BLOCKING block/);
});

test('an approved blocking=0 verdict embedding multiple BLOCKING blocks is contradictory → ambiguous (B-1)', () => {
  const blocks = `${blockingBlock('A-1')}\n\n${blockingBlock('A-2')}`;
  const { outcomes } = parse([
    verdictComment('reviewer_a', { status: 'approved', blocking: 0, blocks }),
  ]);
  assert.equal(outcomes[0].kind, 'ambiguous');
  assert.match(outcomes[0].reason, /contradicts itself with 2 BLOCKING block/);
});

test('a blocked verdict with no BLOCKING blocks is malformed → ambiguous', () => {
  const { outcomes } = parse([verdictComment('reviewer_a', { status: 'blocked', blocking: 1 })]);
  assert.equal(outcomes[0].kind, 'ambiguous');
  assert.match(outcomes[0].reason, /no BLOCKING blocks/);
});

test('duplicate-conflicting current-head verdicts route to ambiguous', () => {
  const { outcomes } = parse([
    verdictComment('reviewer_a', { status: 'approved' }),
    verdictComment('reviewer_a', { status: 'blocked', blocking: 1, blocks: blockingBlock('A-1') }),
  ]);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].kind, 'ambiguous');
  assert.match(outcomes[0].reason, /duplicate-conflicting/);
});

test('agreeing duplicate verdicts collapse to one accepted verdict', () => {
  const { outcomes } = parse([verdictComment('reviewer_a'), verdictComment('reviewer_a')]);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].kind, 'verdict');
  assert.equal(outcomes[0].verdict.status, 'approved');
});

test('no current head (no verified PR) produces no fallback evidence at all', () => {
  const { outcomes } = parse([verdictComment('reviewer_a')], { currentHeadSha: null });
  assert.equal(outcomes.length, 0);
});

// --- Reconciliation + merge gate ---------------------------------------------

function reconcile(verdicts, { artifacts, sessionHeads }) {
  return reconcileReviewerEvidence({
    reviewers: REVIEWERS,
    artifactResults: artifacts,
    sessionHeads,
    verdicts,
    currentHeadSha: HEAD,
    currentHeadShaShort: HEAD.slice(0, 7),
  });
}

test('no fallback verdict preserves the artifact result + session head (source=artifact)', () => {
  const evidence = reconcile([], {
    artifacts: [passArtifact('reviewer_a'), passArtifact('reviewer_b')],
    sessionHeads: [sessionHead('reviewer_a'), sessionHead('reviewer_b')],
  });
  assert.equal(evidence.every((e) => e.source === 'artifact'), true);
  assert.equal(evidence.every((e) => e.result.status === 'pass'), true);
});

test('a same-account fallback approved verdict supplies current-head evidence (source=fallback_comment)', () => {
  // Artifact captured nothing parseable (ambiguous); the verdict comment carries the result.
  const { outcomes } = parse([verdictComment('reviewer_a')]);
  const evidence = reconcile(outcomes, {
    artifacts: [ambiguousArtifact('reviewer_a'), ambiguousArtifact('reviewer_b')],
    sessionHeads: [sessionHead('reviewer_a'), sessionHead('reviewer_b')],
  });
  const a = evidence.find((e) => e.paneId === 'reviewer_a');
  assert.equal(a.result.status, 'pass');
  assert.equal(a.source, 'fallback_comment');
  assert.equal(a.head.current, true);
  assert.equal(a.head.completed, true);
  assert.equal(a.head.source, 'fallback_comment');
});

test('REGRESSION: fallback verdicts for A and B clear the reviewer gates only when verification is current+verified', () => {
  const { outcomes } = parse([verdictComment('reviewer_a'), verdictComment('reviewer_b')]);
  // No usable captured artifact (same-account: nothing parseable captured).
  const evidence = reconcile(outcomes, {
    artifacts: [ambiguousArtifact('reviewer_a'), ambiguousArtifact('reviewer_b')],
    sessionHeads: [sessionHead('reviewer_a'), sessionHead('reviewer_b')],
  });
  const results = evidence.map((e) => e.result);
  const reviewerHeads = evidence.map((e) => e.head);
  assert.equal(reviewerHeads.every((h) => h.source === 'fallback_comment'), true);

  // Verified + current head → both reviewer gates clear → merge_ready.
  const ready = computeMergeReadiness({
    results,
    verification: verifiedHead(HEAD),
    reviewerHeads,
    currentHeadShaShort: HEAD.slice(0, 7),
  });
  assert.equal(ready.mergeReady, true);
  assert.equal(ready.recommendation, 'merge_ready');

  // Same role-signed verdicts, but the commit gate is NOT verified → never merge-ready.
  const unverified = computeMergeReadiness({
    results,
    verification: { status: 'needs_refresh', pr: { number: PR } },
    reviewerHeads,
    currentHeadShaShort: HEAD.slice(0, 7),
  });
  assert.equal(unverified.mergeReady, false);
  assert.notEqual(unverified.recommendation, 'merge_ready');
});

test('REGRESSION: the SAME role-signed verdicts against an OLD head clear nothing', () => {
  // The comments name the old head, so parsing drops them as stale; with no fresh
  // evidence the gate cannot reach merge-ready even though the PR is verified.
  const { outcomes } = parse([
    verdictComment('reviewer_a', { head: OLD }),
    verdictComment('reviewer_b', { head: OLD }),
  ]);
  assert.equal(outcomes.length, 0);
  const evidence = reconcile(outcomes, {
    artifacts: [ambiguousArtifact('reviewer_a'), ambiguousArtifact('reviewer_b')],
    sessionHeads: [
      sessionHead('reviewer_a', { head: OLD, current: false }),
      sessionHead('reviewer_b', { head: OLD, current: false }),
    ],
  });
  const merge = computeMergeReadiness({
    results: evidence.map((e) => e.result),
    verification: verifiedHead(HEAD),
    reviewerHeads: evidence.map((e) => e.head),
    currentHeadShaShort: HEAD.slice(0, 7),
  });
  assert.equal(merge.mergeReady, false);
});

test('a fallback blocked verdict normalizes blockers into the accepted-blocker fix cycle', () => {
  const { outcomes } = parse([
    verdictComment('reviewer_a', { status: 'blocked', blocking: 1, blocks: blockingBlock('A-1') }),
    verdictComment('reviewer_b'),
  ]);
  const evidence = reconcile(outcomes, {
    artifacts: [ambiguousArtifact('reviewer_a'), ambiguousArtifact('reviewer_b')],
    sessionHeads: [sessionHead('reviewer_a'), sessionHead('reviewer_b')],
  });
  const results = evidence.map((e) => e.result);
  const reviewerHeads = evidence.map((e) => e.head);
  const blockers = acceptedBlockers(currentHeadResults(results, reviewerHeads));
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].marker, 'A-1');
  assert.equal(blockers[0].status, 'accepted');

  const merge = computeMergeReadiness({
    results,
    verification: verifiedHead(HEAD),
    reviewerHeads,
    currentHeadShaShort: HEAD.slice(0, 7),
  });
  assert.equal(merge.recommendation, 'request_fix');
});

test('artifact and fallback verdict that conflict for the same head route to needs_human (never the favorable result)', () => {
  // Reviewer A's captured artifact cleanly passed, but its current-head verdict comment blocks.
  const { outcomes } = parse([
    verdictComment('reviewer_a', { status: 'blocked', blocking: 1, blocks: blockingBlock('A-1') }),
  ]);
  const evidence = reconcile(outcomes, {
    artifacts: [passArtifact('reviewer_a'), passArtifact('reviewer_b')],
    sessionHeads: [sessionHead('reviewer_a'), sessionHead('reviewer_b')],
  });
  const a = evidence.find((e) => e.paneId === 'reviewer_a');
  assert.equal(a.result.status, 'ambiguous');
  assert.equal(a.source, 'reconciled');

  const merge = computeMergeReadiness({
    results: evidence.map((e) => e.result),
    verification: verifiedHead(HEAD),
    reviewerHeads: evidence.map((e) => e.head),
    currentHeadShaShort: HEAD.slice(0, 7),
  });
  assert.equal(merge.recommendation, 'needs_human');
  assert.equal(merge.anyAmbiguous, true);
});

test('agreeing artifact + fallback verdict are reconciled and clear the gate (source=reconciled)', () => {
  const { outcomes } = parse([verdictComment('reviewer_a'), verdictComment('reviewer_b')]);
  const evidence = reconcile(outcomes, {
    artifacts: [passArtifact('reviewer_a'), passArtifact('reviewer_b')],
    sessionHeads: [sessionHead('reviewer_a'), sessionHead('reviewer_b')],
  });
  assert.equal(evidence.every((e) => e.source === 'reconciled'), true);
  const merge = computeMergeReadiness({
    results: evidence.map((e) => e.result),
    verification: verifiedHead(HEAD),
    reviewerHeads: evidence.map((e) => e.head),
    currentHeadShaShort: HEAD.slice(0, 7),
  });
  assert.equal(merge.mergeReady, true);
});

test('a malformed current-head verdict taints an otherwise-clean artifact → needs_human', () => {
  const malformed = {
    author: 'dev',
    body: `GODMODE_REVIEW_VERDICT reviewer=reviewer-a pane=reviewer_a pr=${PR} head=${HEAD} blocking=0`,
    createdAt: '',
  };
  const { outcomes } = parse([malformed]);
  const evidence = reconcile(outcomes, {
    artifacts: [passArtifact('reviewer_a'), passArtifact('reviewer_b')],
    sessionHeads: [sessionHead('reviewer_a'), sessionHead('reviewer_b')],
  });
  const a = evidence.find((e) => e.paneId === 'reviewer_a');
  assert.equal(a.result.status, 'ambiguous');
  const merge = computeMergeReadiness({
    results: evidence.map((e) => e.result),
    verification: verifiedHead(HEAD),
    reviewerHeads: evidence.map((e) => e.head),
    currentHeadShaShort: HEAD.slice(0, 7),
  });
  assert.equal(merge.recommendation, 'needs_human');
});
