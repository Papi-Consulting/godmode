// PR discovery tests for issue #38. Mostly pure candidate matching and the
// ambiguity decision (no Electron, no `gh`/`git`, no filesystem), plus one
// never-throw contract test for the impure `discoverRunPrCandidates` fetch. They
// run under Node's built-in test runner against the compiled main output
// (`npm run build:main` first). Run via `npm test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  matchPrCandidates,
  referencesIssue,
  selectPrCandidate,
} from '../dist/main/discovery.js';
import { discoverRunPrCandidates } from '../dist/main/github.js';

const HANDOFF = '2026-06-14T12:00:00.000Z';
const BEFORE = '2026-06-14T11:00:00.000Z';
const AFTER = '2026-06-14T13:00:00.000Z';

/** A PR with sensible defaults so each test overrides only what it asserts. */
function pr(overrides = {}) {
  return {
    number: 100,
    title: 'Some change',
    body: 'A description',
    url: 'https://github.com/o/r/pull/100',
    headRefName: 'feat/x',
    headSha: 'a'.repeat(40),
    author: 'octocat',
    createdAt: AFTER,
    ...overrides,
  };
}

test('referencesIssue matches #N, keyword forms, and rejects #NN false positives', () => {
  assert.equal(referencesIssue('Closes #38', 38), true);
  assert.equal(referencesIssue('fixes #38 in the body', 38), true);
  assert.equal(referencesIssue('see #38.', 38), true);
  // #380 must not match issue 38 (trailing-digit lookahead).
  assert.equal(referencesIssue('relates to #380', 38), false);
  assert.equal(referencesIssue('no reference here', 38), false);
  assert.equal(referencesIssue('', 38), false);
});

test('matchPrCandidates flags issue-link PRs by title or body', () => {
  const prs = [
    pr({ number: 1, title: 'Closes #38: discovery', body: 'work' }),
    pr({ number: 2, title: 'unrelated', body: 'Fixes #38 eventually' }),
    pr({ number: 3, title: 'noise', body: 'no link', createdAt: BEFORE }),
  ];
  const candidates = matchPrCandidates(prs, { issueNumber: 38, handoffSentAt: HANDOFF });
  const linked = candidates.filter((c) => c.matchReason === 'issue_link').map((c) => c.number);
  assert.deepEqual(linked, [1, 2]);
  // PR #3 has no link and predates the handoff → not a candidate at all.
  assert.equal(candidates.find((c) => c.number === 3), undefined);
});

test('matchPrCandidates surfaces recent-unlinked PRs created at/after handoff', () => {
  const prs = [
    pr({ number: 10, title: 'no link', body: 'no link', createdAt: AFTER }),
    pr({ number: 11, title: 'old PR', body: 'no link', createdAt: BEFORE }),
  ];
  const candidates = matchPrCandidates(prs, { issueNumber: 38, handoffSentAt: HANDOFF });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].number, 10);
  assert.equal(candidates[0].matchReason, 'recent_unlinked');
});

test('matchPrCandidates skips the recent fallback entirely without a handoff time', () => {
  const prs = [pr({ number: 10, title: 'no link', body: 'no link', createdAt: AFTER })];
  const candidates = matchPrCandidates(prs, { issueNumber: 38 });
  assert.deepEqual(candidates, []);
});

test('matchPrCandidates never double-counts an issue-linked PR as recent-unlinked', () => {
  const prs = [pr({ number: 5, title: 'Closes #38', body: 'x', createdAt: AFTER })];
  const candidates = matchPrCandidates(prs, { issueNumber: 38, handoffSentAt: HANDOFF });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].matchReason, 'issue_link');
});

test('matchPrCandidates carries the evidence fields the open_pr transition records', () => {
  const prs = [
    pr({
      number: 42,
      title: 'Closes #38',
      headRefName: 'feat/issue-38',
      headSha: 'c'.repeat(40),
      author: 'builder-bot',
      createdAt: AFTER,
      url: 'https://github.com/o/r/pull/42',
    }),
  ];
  const [candidate] = matchPrCandidates(prs, { issueNumber: 38, handoffSentAt: HANDOFF });
  assert.equal(candidate.number, 42);
  assert.equal(candidate.headRefName, 'feat/issue-38');
  assert.equal(candidate.headSha, 'c'.repeat(40));
  assert.equal(candidate.author, 'builder-bot');
  assert.equal(candidate.createdAt, AFTER);
  assert.equal(candidate.url, 'https://github.com/o/r/pull/42');
});

test('selectPrCandidate: none for an empty set', () => {
  assert.deepEqual(selectPrCandidate([]), { kind: 'none' });
});

test('selectPrCandidate: a single issue-link candidate is unambiguous', () => {
  const candidates = matchPrCandidates([pr({ number: 7, title: 'Closes #38' })], {
    issueNumber: 38,
    handoffSentAt: HANDOFF,
  });
  const selection = selectPrCandidate(candidates);
  assert.equal(selection.kind, 'unambiguous');
  assert.equal(selection.candidate.number, 7);
});

test('selectPrCandidate: one issue-link wins even alongside recent-unlinked noise', () => {
  const prs = [
    pr({ number: 7, title: 'Closes #38', createdAt: AFTER }),
    pr({ number: 8, title: 'unrelated recent', body: 'no link', createdAt: AFTER }),
  ];
  const selection = selectPrCandidate(matchPrCandidates(prs, { issueNumber: 38, handoffSentAt: HANDOFF }));
  assert.equal(selection.kind, 'unambiguous');
  assert.equal(selection.candidate.number, 7);
});

test('selectPrCandidate: multiple issue-link candidates are ambiguous (operator picks)', () => {
  const prs = [pr({ number: 7, title: 'Closes #38' }), pr({ number: 9, body: 'Fixes #38' })];
  const selection = selectPrCandidate(matchPrCandidates(prs, { issueNumber: 38, handoffSentAt: HANDOFF }));
  assert.equal(selection.kind, 'ambiguous');
  assert.equal(selection.candidates.length, 2);
});

test('selectPrCandidate: a lone recent-unlinked candidate is ambiguous (no auto-select)', () => {
  const prs = [pr({ number: 12, title: 'no link', body: 'no link', createdAt: AFTER })];
  const selection = selectPrCandidate(matchPrCandidates(prs, { issueNumber: 38, handoffSentAt: HANDOFF }));
  assert.equal(selection.kind, 'ambiguous');
});

test('discoverRunPrCandidates never throws: a non-repo dir folds into a non-ok status', async () => {
  // A directory with no git repo / GitHub remote: the read-only `gh pr list`
  // fails, and the failure must fold into status/message with empty candidates
  // (the run stays in builder_running) rather than rejecting the promise.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'godmode-discover-'));
  const result = await discoverRunPrCandidates(dir, { issueNumber: 38 }, '2026-06-15T00:00:00.000Z');
  assert.notEqual(result.status, 'ok');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.recommendedPrNumber, null);
  assert.equal(result.issueNumber, 38);
  assert.equal(result.fetchedAt, '2026-06-15T00:00:00.000Z');
  assert.equal(typeof result.message, 'string');
});
