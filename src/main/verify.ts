import type {
  CommitCheckSummary,
  CommitVerification,
  CommitVerificationStatus,
  ExpectedCommitSource,
  GithubCheck,
} from '../shared/types.js';

/**
 * Builder branch/PR/commit verification — the harness evidence layer (issue #9).
 *
 * GodMode must prove the expected builder commit is actually present on the
 * remote PR branch before treating builder output as valid. This module owns the
 * **pure** half of that gate: given evidence already gathered from `gh`/`git`
 * ({@link VerificationEvidence}), {@link deriveVerification} derives a single
 * deterministic {@link CommitVerificationStatus} and a renderer-ready
 * {@link CommitVerification}. It is Electron-free and shells out to nothing, so
 * the state-derivation and commit-list comparison are unit-tested directly
 * (`test/verify.test.js`).
 *
 * The impure half — running `git rev-parse HEAD`, `git branch --show-current`,
 * and `gh pr view <branch> --json …` — lives in `src/main/github.ts`
 * (`getCommitVerification`), which reuses the existing `gh`/`git` plumbing and
 * then calls into this module. Agent self-reports and pasted context are never
 * an input here: every field traces back to git/`gh`.
 */

/** Minimum overlap (chars) for two SHAs to be considered a prefix match. */
const MIN_SHA_PREFIX = 7;

/** Still-running check states already normalized by github.ts into PENDING. */
const PENDING = 'PENDING';
/** Terminal, non-blocking conclusions normalized by github.ts. */
const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** A PR matched to the current branch, with the commit evidence to compare. */
export type VerifiedPr = {
  number: number;
  /** OPEN, MERGED, or CLOSED, read live from GitHub. */
  state: string;
  url: string;
  headRefName: string;
  /** Remote PR head commit SHA (`headRefOid`). */
  headSha: string;
  /** Commit SHAs (oids) on the PR, in the order `gh` returns them. */
  commits: string[];
  /** Normalized PR checks (already collapsed to SUCCESS/PENDING/FAILURE/…). */
  checks: GithubCheck[];
};

/**
 * Everything {@link deriveVerification} needs, gathered impurely beforehand. A
 * failed `gh`/`git` query sets {@link queryFailed} so the derivation reports
 * `needs_refresh` instead of inventing a confident result from partial data.
 */
export type VerificationEvidence = {
  /** Current branch of the operated project, or null (detached/unresolved). */
  branch: string | null;
  /** Expected commit SHA to verify, or null when it could not be resolved. */
  expectedCommit: string | null;
  /** Where {@link expectedCommit} came from. */
  expectedCommitSource: ExpectedCommitSource;
  /** True when any underlying `gh`/`git` query failed (evidence incomplete). */
  queryFailed: boolean;
  /** The PR matched to the branch, or null when none was found. */
  pr: VerifiedPr | null;
};

/** Bucket a PR's normalized checks into pass/pending/fail counts. */
export function summarizeChecks(checks: GithubCheck[]): CommitCheckSummary {
  let passing = 0;
  let pending = 0;
  let failing = 0;
  for (const check of checks) {
    if (check.conclusion === PENDING) pending += 1;
    else if (PASSING.has(check.conclusion)) passing += 1;
    // Anything else is already normalized to FAILURE (or an unknown terminal
    // state) by github.ts — count it as failing so the gate never hides a block.
    else failing += 1;
  }
  return { total: checks.length, passing, pending, failing };
}

/** First 7 chars of a SHA, or null when there is no SHA. */
function shortSha(sha: string | null): string | null {
  return sha ? sha.slice(0, MIN_SHA_PREFIX) : null;
}

/**
 * Whether two commit SHAs refer to the same commit, tolerating short/long forms
 * (a 7+ char prefix match counts). `gh` returns full 40-char oids while a
 * run-recorded commit may be abbreviated, so an exact-equality check alone would
 * miss legitimate matches.
 */
export function commitMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < MIN_SHA_PREFIX) return false;
  return longer.startsWith(shorter);
}

/** True when `expected` appears anywhere in the PR's commit list. */
function commitInCommitList(expected: string, commits: string[]): boolean {
  return commits.some((oid) => commitMatches(expected, oid));
}

/**
 * Derive the verification status and a renderer-ready {@link CommitVerification}
 * from gathered evidence. Pure and deterministic: the same evidence always
 * yields the same status, so the gate is governed by this table — not by which
 * `gh` field happened to be present.
 *
 * Precedence (first match wins):
 * 1. `needs_refresh` — a query failed; evidence is incomplete, retry.
 * 2. `needs_human` — no commit could be resolved to verify at all.
 * 3. `no_pr_for_branch` — no PR exists for the current branch.
 * 4. `missing_remote_commit` — a PR exists but the expected commit is absent.
 * 5. `needs_human` — the PR was closed without merging (a stop-and-ask state).
 * 6. `verified` — the PR is confirmed merged (checks are moot post-merge).
 * 7. `checks_failed` / `checks_pending` — commit matched, checks block/pending.
 * 8. `verified` — commit present on the remote PR and checks are clear.
 */
export function deriveVerification(
  evidence: VerificationEvidence,
  fetchedAt: string,
): CommitVerification {
  const { branch, expectedCommit, expectedCommitSource, queryFailed, pr } = evidence;
  const checks = summarizeChecks(pr?.checks ?? []);
  const commitInList = pr && expectedCommit ? commitInCommitList(expectedCommit, pr.commits) : false;
  const matchesHead = pr && expectedCommit ? commitMatches(expectedCommit, pr.headSha) : false;
  const prState = pr ? pr.state : null;
  const mergeConfirmed = prState === 'MERGED';

  const base: Omit<CommitVerification, 'status' | 'message'> = {
    branch,
    expectedCommit,
    expectedCommitShort: shortSha(expectedCommit),
    expectedCommitSource,
    pr: pr
      ? {
          number: pr.number,
          state: pr.state,
          url: pr.url,
          headRefName: pr.headRefName,
          headSha: pr.headSha,
          headShaShort: pr.headSha.slice(0, MIN_SHA_PREFIX),
        }
      : null,
    commitInList,
    matchesHead,
    checks,
    prState,
    mergeConfirmed,
    partial: queryFailed,
    fetchedAt,
  };

  const result = (status: CommitVerificationStatus, message: string): CommitVerification => ({
    ...base,
    status,
    message,
  });

  if (queryFailed) {
    return result(
      'needs_refresh',
      'Verification queries did not all complete — the result is partial. Refresh to retry.',
    );
  }

  if (!expectedCommit) {
    return result(
      'needs_human',
      'Could not resolve a commit to verify (no run-recorded commit and no readable local HEAD).',
    );
  }

  if (!pr) {
    const where = branch ? `branch "${branch}"` : 'the current branch';
    return result('no_pr_for_branch', `No pull request found for ${where}. A human should open or link a PR.`);
  }

  const matched = commitInList || matchesHead;
  if (!matched) {
    return result(
      'missing_remote_commit',
      `Expected commit ${shortSha(expectedCommit)} is not on PR #${pr.number} (remote head ${pr.headSha.slice(0, MIN_SHA_PREFIX)}). Push the builder commit before advancing.`,
    );
  }

  if (prState === 'CLOSED' && !mergeConfirmed) {
    return result('needs_human', `PR #${pr.number} was closed without merging. A human should decide how to proceed.`);
  }

  if (mergeConfirmed) {
    return result('verified', `Commit ${shortSha(expectedCommit)} is on PR #${pr.number}, confirmed merged by GitHub.`);
  }

  if (checks.failing > 0) {
    return result(
      'checks_failed',
      `Commit ${shortSha(expectedCommit)} is on PR #${pr.number}, but ${checks.failing} check${checks.failing === 1 ? '' : 's'} failed.`,
    );
  }

  if (checks.pending > 0) {
    return result(
      'checks_pending',
      `Commit ${shortSha(expectedCommit)} is on PR #${pr.number}; ${checks.pending} check${checks.pending === 1 ? '' : 's'} still running.`,
    );
  }

  const checksNote = checks.total > 0 ? `${checks.passing}/${checks.total} checks passing` : 'no checks configured';
  return result('verified', `Commit ${shortSha(expectedCommit)} is on PR #${pr.number} (${checksNote}).`);
}
