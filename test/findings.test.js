// Reviewer-findings parsing, merge-gate, and fix-handoff tests for issue #11.
// Pure functions only — no filesystem, Electron, or `gh` — run against the
// compiled main output (`npm run build:main` first) via `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptedBlockers,
  computeMergeReadiness,
  currentHeadResults,
  parseReviewerOutput,
  renderBlockersText,
  reviewerHeadEvidence,
} from '../dist/main/findings.js';
import { composeFixHandoff } from '../dist/main/handoff.js';
import { DEFAULT_CONFIG } from '../dist/main/config.js';
import { applyAction, createRun } from '../dist/main/run.js';

const NOW = '2026-06-06T12:00:00.000Z';

function parseA(text) {
  return parseReviewerOutput({ reviewerId: 'reviewer-a', paneId: 'reviewer_a', text });
}
function parseB(text) {
  return parseReviewerOutput({ reviewerId: 'reviewer-b', paneId: 'reviewer_b', text });
}

/** A verified #9 verification stub (only the fields the gate reads). */
function verified() {
  return { status: 'verified', pr: { number: 42, url: 'https://github.com/x/y/pull/42', headRefName: 'fix' } };
}

// --- Parsing: reviewer pass output -------------------------------------------

test('a DONE pass marker with zero blocking parses as a clean pass', () => {
  const result = parseA('Looks good.\nReviewer A: PASS — no blocking findings.\nDONE: ROLE=reviewer STATUS=pass BLOCKING=0');
  assert.equal(result.status, 'pass');
  assert.equal(result.declaredStatus, 'pass');
  assert.equal(result.declaredBlocking, 0);
  assert.equal(result.findings.length, 0);
});

test('a PASS line with no marker infers a pass', () => {
  const result = parseA('Reviewer A: PASS — no blocking correctness/security/test findings.');
  assert.equal(result.status, 'pass');
  assert.equal(result.declaredStatus, undefined);
  assert.equal(result.findings.length, 0);
});

// --- Parsing: reviewer fail output with blocker blocks -----------------------

test('a fail marker with a BLOCKING block parses a normalized, accepted finding', () => {
  const text = [
    'BLOCKING A-1: Unverified GitHub state claim',
    'File: src/main/index.ts:512',
    'Issue: The merge gate trusts the agent self-report.',
    'Why it blocks: Violates the verification-first rule.',
    'Suggested fix: Consume the #9 verified status instead.',
    '',
    'DONE: ROLE=reviewer STATUS=fail BLOCKING=1',
  ].join('\n');
  const result = parseA(text);

  assert.equal(result.status, 'fail');
  assert.equal(result.declaredBlocking, 1);
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding.severity, 'blocking');
  assert.equal(finding.status, 'accepted');
  assert.equal(finding.marker, 'A-1');
  assert.equal(finding.title, 'Unverified GitHub state claim');
  assert.equal(finding.file, 'src/main/index.ts');
  assert.equal(finding.line, 512);
  assert.match(finding.details, /trusts the agent self-report/);
  assert.match(finding.details, /Why it blocks: Violates/);
  assert.equal(finding.suggestedFix, 'Consume the #9 verified status instead.');
});

test('multiple blocking blocks without a marker infer a fail with each finding parsed', () => {
  const text = [
    'BLOCKING B-1: Hardcoded vendor branch',
    'File: src/main/agents.ts:88',
    'Issue: Branches on Claude directly.',
    'BLOCKING B-2: Spec drift',
    'File: docs/spec.md',
    'Issue: PR diverges from the spec.',
  ].join('\n');
  const result = parseB(text);
  assert.equal(result.status, 'fail');
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].marker, 'B-1');
  assert.equal(result.findings[1].marker, 'B-2');
  assert.equal(result.findings[1].file, 'docs/spec.md');
  assert.equal(result.findings[1].line, undefined);
  // No marker → all parsed blockers accepted by default for the first cycle.
  assert.ok(result.findings.every((f) => f.status === 'accepted'));
});

// --- Parsing: malformed / ambiguous / contradictory output -------------------

test('empty output is ambiguous, never a silent pass', () => {
  const result = parseA('   \n  \n');
  assert.equal(result.status, 'ambiguous');
  assert.match(result.notes.join(' '), /No reviewer output/);
});

test('a pass marker contradicted by a BLOCKING block is ambiguous', () => {
  const text = 'BLOCKING A-1: Race condition\nFile: a.ts:1\nDONE: ROLE=reviewer STATUS=pass BLOCKING=0';
  const result = parseA(text);
  assert.equal(result.status, 'ambiguous');
  // Contradiction must not leave an accepted blocker that a fix cycle would consume.
  assert.ok(result.findings.every((f) => f.status === 'needs_human'));
});

test('a fail marker declaring blockers but with none parseable is ambiguous', () => {
  const result = parseA('Some prose with no structured blocks.\nDONE: ROLE=reviewer STATUS=fail BLOCKING=2');
  assert.equal(result.status, 'ambiguous');
  assert.match(result.notes.join(' '), /BLOCKING=2 but no BLOCKING blocks/);
});

test('a PASS line and a BLOCKING block together are contradictory → ambiguous', () => {
  const text = 'Reviewer A: PASS — all good.\nBLOCKING A-1: But also this bug\nFile: a.ts:9';
  const result = parseA(text);
  assert.equal(result.status, 'ambiguous');
});

test('prose with no marker, PASS line, or blocking block is ambiguous', () => {
  const result = parseA('I looked at the PR and have some thoughts but nothing structured.');
  assert.equal(result.status, 'ambiguous');
});

test('conflicting DONE markers are ambiguous', () => {
  const text = 'DONE: ROLE=reviewer STATUS=pass BLOCKING=0\nDONE: ROLE=reviewer STATUS=fail BLOCKING=1';
  const result = parseA(text);
  assert.equal(result.status, 'ambiguous');
  assert.match(result.notes.join(' '), /conflicting DONE markers/);
});

// --- Merge gate --------------------------------------------------------------

test('both reviewers pass + verified PR → merge_ready', () => {
  const results = [parseA('DONE: ROLE=reviewer STATUS=pass BLOCKING=0'), parseB('DONE: ROLE=reviewer STATUS=pass BLOCKING=0')];
  const merge = computeMergeReadiness({ results, verification: verified() });
  assert.equal(merge.mergeReady, true);
  assert.equal(merge.recommendation, 'merge_ready');
  assert.equal(merge.prVerified, true);
});

test('merge-ready gate is blocked when PR verification is not verified', () => {
  const results = [parseA('DONE: ROLE=reviewer STATUS=pass BLOCKING=0'), parseB('DONE: ROLE=reviewer STATUS=pass BLOCKING=0')];
  const merge = computeMergeReadiness({ results, verification: { status: 'checks_failed', pr: { number: 42 } } });
  assert.equal(merge.mergeReady, false);
  // Reviewers cleared and there is nothing to fix, but the evidence gate is unmet.
  assert.equal(merge.recommendation, 'hold');
  assert.match(merge.reasons.join(' '), /checks_failed/);
});

test('a reviewer self-report alone (no verification) is never merge-ready', () => {
  const results = [parseA('DONE: ROLE=reviewer STATUS=pass BLOCKING=0'), parseB('DONE: ROLE=reviewer STATUS=pass BLOCKING=0')];
  const merge = computeMergeReadiness({ results, verification: null });
  assert.equal(merge.mergeReady, false);
  assert.match(merge.reasons.join(' '), /No commit verification/);
});

test('accepted blockers recommend a fix cycle', () => {
  const failText = 'BLOCKING A-1: Bug\nFile: a.ts:1\nDONE: ROLE=reviewer STATUS=fail BLOCKING=1';
  const results = [parseA(failText), parseB('DONE: ROLE=reviewer STATUS=pass BLOCKING=0')];
  const merge = computeMergeReadiness({ results, verification: verified() });
  assert.equal(merge.recommendation, 'request_fix');
  assert.equal(merge.mergeReady, false);
  assert.equal(merge.reviewerA.acceptedBlockers, 1);
});

test('accepted blockers hold (never request_fix) when the PR is not verified', () => {
  // Codex #11 P1: a fix cycle must never target a stale/unverified PR. Blockers
  // exist, but the #9 gate is unverified → hold until the operator re-verifies.
  const failText = 'BLOCKING A-1: Bug\nFile: a.ts:1\nDONE: ROLE=reviewer STATUS=fail BLOCKING=1';
  const results = [parseA(failText), parseB('DONE: ROLE=reviewer STATUS=pass BLOCKING=0')];
  const unverified = computeMergeReadiness({ results, verification: { status: 'needs_refresh', pr: { number: 42 } } });
  assert.equal(unverified.recommendation, 'hold');
  assert.equal(unverified.mergeReady, false);
  assert.match(unverified.reasons.join(' '), /held until the PR is verified/);

  // Same blockers with no verification at all still holds — never a fix.
  const noVerif = computeMergeReadiness({ results, verification: null });
  assert.equal(noVerif.recommendation, 'hold');
});

test('ambiguous reviewer output forces needs_human even with a verified PR', () => {
  const results = [parseA('total nonsense'), parseB('DONE: ROLE=reviewer STATUS=pass BLOCKING=0')];
  const merge = computeMergeReadiness({ results, verification: verified() });
  assert.equal(merge.recommendation, 'needs_human');
  assert.equal(merge.anyAmbiguous, true);
  assert.equal(merge.mergeReady, false);
});

test('a missing reviewer result holds the gate (not merge-ready)', () => {
  const results = [parseA('DONE: ROLE=reviewer STATUS=pass BLOCKING=0')];
  const merge = computeMergeReadiness({ results, verification: verified() });
  assert.equal(merge.mergeReady, false);
  assert.equal(merge.recommendation, 'hold');
  assert.match(merge.reasons.join(' '), /Reviewer B has not produced/);
});

// --- Current-head reviewer evidence (issue #59) ------------------------------

const HEAD_A = 'aaaaaaa000';
const HEAD_B = 'bbbbbbb111';

/** A verified #9 verification stub carrying a resolvable PR head SHA. */
function verifiedHead(headSha) {
  return {
    status: 'verified',
    pr: { number: 42, url: 'https://github.com/x/y/pull/42', headRefName: 'fix', headSha, headShaShort: headSha.slice(0, 7) },
  };
}

/** A tracked reviewer session stub (only the fields head-evidence reads). */
function session(paneId, { status = 'completed', head = HEAD_A, cycle = 1 } = {}) {
  const reviewerId = paneId === 'reviewer_a' ? 'reviewer-a' : 'reviewer-b';
  return {
    reviewerId,
    paneId,
    status,
    cycle,
    attemptId: `${cycle}-${head.slice(0, 7)}-${reviewerId}-1`,
    targetHeadSha: head,
    targetHeadShaShort: head.slice(0, 7),
  };
}

test('reviewerHeadEvidence flags a current, completed attempt as usable evidence', () => {
  const ev = reviewerHeadEvidence(session('reviewer_a', { head: HEAD_A, status: 'completed' }), HEAD_A);
  assert.equal(ev.current, true);
  assert.equal(ev.completed, true);
  assert.equal(ev.attemptHeadShaShort, HEAD_A.slice(0, 7));
});

test('reviewerHeadEvidence flags an attempt from a previous head as not current', () => {
  const ev = reviewerHeadEvidence(session('reviewer_a', { head: HEAD_A, status: 'completed' }), HEAD_B);
  assert.equal(ev.current, false);
  assert.equal(ev.completed, true);
});

test('reviewerHeadEvidence flags a still-running attempt as incomplete', () => {
  const ev = reviewerHeadEvidence(session('reviewer_a', { head: HEAD_A, status: 'running' }), HEAD_A);
  assert.equal(ev.current, true);
  assert.equal(ev.completed, false);
});

test('currentHeadResults drops a reviewer whose attempt targeted a previous head', () => {
  const results = [parseA('DONE: ROLE=reviewer STATUS=pass BLOCKING=0'), parseB('DONE: ROLE=reviewer STATUS=pass BLOCKING=0')];
  const heads = [
    reviewerHeadEvidence(session('reviewer_a', { head: HEAD_B }), HEAD_B), // current
    reviewerHeadEvidence(session('reviewer_b', { head: HEAD_A }), HEAD_B), // stale
  ];
  const usable = currentHeadResults(results, heads);
  assert.equal(usable.length, 1);
  assert.equal(usable[0].paneId, 'reviewer_a');
});

test('merge gate: both reviewers current+completed for the head → merge_ready', () => {
  const results = [parseA('DONE: ROLE=reviewer STATUS=pass BLOCKING=0'), parseB('DONE: ROLE=reviewer STATUS=pass BLOCKING=0')];
  const reviewerHeads = [
    reviewerHeadEvidence(session('reviewer_a', { head: HEAD_B }), HEAD_B),
    reviewerHeadEvidence(session('reviewer_b', { head: HEAD_B }), HEAD_B),
  ];
  const merge = computeMergeReadiness({
    results,
    verification: verifiedHead(HEAD_B),
    reviewerHeads,
    currentHeadShaShort: HEAD_B.slice(0, 7),
  });
  assert.equal(merge.mergeReady, true);
  assert.equal(merge.recommendation, 'merge_ready');
  assert.equal(merge.prHeadShaShort, HEAD_B.slice(0, 7));
});

test('merge gate: a stale reviewer attempt cannot reach merge_ready (holds, explains which/head)', () => {
  // Reviewer B passed, but only against the OLD head A — after the PR head moved
  // to B, that is stale evidence and must not clear the gate.
  const results = [parseA('DONE: ROLE=reviewer STATUS=pass BLOCKING=0'), parseB('DONE: ROLE=reviewer STATUS=pass BLOCKING=0')];
  const reviewerHeads = [
    reviewerHeadEvidence(session('reviewer_a', { head: HEAD_B }), HEAD_B), // fresh
    reviewerHeadEvidence(session('reviewer_b', { head: HEAD_A }), HEAD_B), // stale
  ];
  const merge = computeMergeReadiness({
    results,
    verification: verifiedHead(HEAD_B),
    reviewerHeads,
    currentHeadShaShort: HEAD_B.slice(0, 7),
  });
  assert.equal(merge.mergeReady, false);
  assert.equal(merge.recommendation, 'hold');
  assert.match(merge.reasons.join(' '), /Reviewer B last reviewed .* current PR head .* stale/i);
});

test('merge gate: an incomplete (still-running) attempt for the current head holds', () => {
  const results = [parseA('DONE: ROLE=reviewer STATUS=pass BLOCKING=0'), parseB('')];
  const reviewerHeads = [
    reviewerHeadEvidence(session('reviewer_a', { head: HEAD_B, status: 'completed' }), HEAD_B),
    reviewerHeadEvidence(session('reviewer_b', { head: HEAD_B, status: 'running' }), HEAD_B),
  ];
  const merge = computeMergeReadiness({
    results,
    verification: verifiedHead(HEAD_B),
    reviewerHeads,
    currentHeadShaShort: HEAD_B.slice(0, 7),
  });
  assert.equal(merge.mergeReady, false);
  assert.equal(merge.recommendation, 'hold');
  assert.match(merge.reasons.join(' '), /Reviewer B has not produced a completed review/i);
});

test('merge gate: a stale reviewer\'s blockers are not consumed for the current head', () => {
  // Reviewer A raised a blocker, but only against the old head A. With the head at
  // B and A's attempt stale, that blocker is not current-head evidence, so it does
  // not open a fix cycle — the gate holds for a fresh re-review instead.
  const results = [
    parseA('BLOCKING A-1: stale concern\nFile: a.ts:1\nDONE: ROLE=reviewer STATUS=fail BLOCKING=1'),
    parseB('DONE: ROLE=reviewer STATUS=pass BLOCKING=0'),
  ];
  const reviewerHeads = [
    reviewerHeadEvidence(session('reviewer_a', { head: HEAD_A }), HEAD_B), // stale
    reviewerHeadEvidence(session('reviewer_b', { head: HEAD_B }), HEAD_B), // fresh
  ];
  const usableBlockers = acceptedBlockers(currentHeadResults(results, reviewerHeads));
  assert.equal(usableBlockers.length, 0, 'a stale attempt\'s blockers are not consumed');
  const merge = computeMergeReadiness({
    results,
    verification: verifiedHead(HEAD_B),
    reviewerHeads,
    currentHeadShaShort: HEAD_B.slice(0, 7),
  });
  assert.equal(merge.recommendation, 'hold');
  assert.notEqual(merge.recommendation, 'request_fix');
});

test('merge gate without head evidence keeps the pre-#59 behavior (every result consumed)', () => {
  // Backward compatibility: callers that pass no reviewerHeads get the legacy gate.
  const results = [parseA('DONE: ROLE=reviewer STATUS=pass BLOCKING=0'), parseB('DONE: ROLE=reviewer STATUS=pass BLOCKING=0')];
  const merge = computeMergeReadiness({ results, verification: verified() });
  assert.equal(merge.mergeReady, true);
  assert.equal(merge.recommendation, 'merge_ready');
});

// --- Accepted-blocker flattening + normalized text ---------------------------

test('acceptedBlockers flattens only accepted blocking findings', () => {
  const fail = parseA('BLOCKING A-1: X\nFile: a.ts:1\nDONE: ROLE=reviewer STATUS=fail BLOCKING=1');
  const ambiguous = parseB('BLOCKING B-1: Y\nFile: b.ts:2\nDONE: ROLE=reviewer STATUS=pass BLOCKING=0');
  const blockers = acceptedBlockers([fail, ambiguous]);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].marker, 'A-1');
});

test('renderBlockersText is a compact normalized capsule, not a transcript', () => {
  const fail = parseA(
    'BLOCKING A-1: Unverified claim\nFile: src/x.ts:5\nIssue: trusts self-report\nSuggested fix: use #9\nDONE: ROLE=reviewer STATUS=fail BLOCKING=1',
  );
  const text = renderBlockersText(acceptedBlockers([fail]));
  assert.match(text, /A-1 · reviewer-a/);
  assert.match(text, /Unverified claim/);
  assert.match(text, /src\/x\.ts:5/);
  assert.match(text, /Suggested fix: use #9/);
  assert.equal(renderBlockersText([]), '(none)');
});

// --- Fix-cycle handoff -------------------------------------------------------

function fixRun() {
  return {
    ...createRun({ sourceType: 'github_issue', sourceId: '11', issueNumber: 11, issueTitle: 'Fix cycle', now: NOW, id: 'run-11' }),
    status: 'builder_fixing',
    prNumber: 42,
    branch: 'fix',
  };
}

test('the fix handoff binds normalized blockers and never leaves {{blockers}} unresolved', () => {
  const fail = parseA('BLOCKING A-1: Race\nFile: a.ts:1\nSuggested fix: lock it\nDONE: ROLE=reviewer STATUS=fail BLOCKING=1');
  const blockers = acceptedBlockers([fail]);
  const handoff = composeFixHandoff(DEFAULT_CONFIG, fixRun(), {
    projectName: 'godmode',
    pr: { number: 42, url: 'https://github.com/x/y/pull/42', branch: 'fix' },
    blockersText: renderBlockersText(blockers),
    blockerCount: blockers.length,
  });
  assert.equal(handoff.canSend, true);
  assert.deepEqual(handoff.missingVariables, []);
  assert.doesNotMatch(handoff.prompt, /\{\{blockers\}\}/);
  assert.match(handoff.prompt, /A-1/);
  assert.match(handoff.prompt, /PR #42/);
  // Pointer-first: it directs the builder to the live PR, not a pasted transcript.
  assert.match(handoff.prompt, /gh pr (view|diff) 42/);
});

test('a fix handoff with no blockers is not sendable', () => {
  const handoff = composeFixHandoff(DEFAULT_CONFIG, fixRun(), {
    projectName: 'godmode',
    pr: { number: 42, url: 'https://github.com/x/y/pull/42', branch: 'fix' },
    blockersText: '(none)',
    blockerCount: 0,
  });
  assert.equal(handoff.canSend, false);
  assert.match(handoff.blockedReason, /No accepted blockers/);
});

// --- Max-cycle budget is authoritative through the state machine -------------

test('request_fix is refused once the cycle budget is exhausted', () => {
  // Drive a run to review_synthesis at the cycle cap and confirm the guard drops
  // request_fix, so the synthesis fix loop deterministically stops at maxCycles.
  const run = { ...createRun({ issueNumber: 11, maxCycles: 1, now: NOW, id: 'run-cap' }), status: 'review_synthesis', cycle: 1 };
  const result = applyAction(run, 'request_fix', { now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.error, /budget/i);
});
