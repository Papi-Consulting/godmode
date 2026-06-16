import type { PrCandidate, PrCandidateMatchReason } from '../shared/types.js';

/**
 * PR discovery — the pure half of binding the builder's PR to a run (issue #38).
 *
 * GodMode must close the gap between "handoff sent" (`builder_running`) and
 * "PR opened" with real GitHub evidence rather than a blind operator click. This
 * module owns the **pure**, `gh`-free half: given PRs already fetched from `gh`
 * ({@link DiscoveryPr}) and the run's matching context ({@link DiscoveryContext}),
 * {@link matchPrCandidates} classifies which PRs are candidates and how they
 * matched, and {@link selectPrCandidate} decides whether there is an unambiguous
 * pick. It is Electron-free and shells out to nothing, so candidate matching and
 * the ambiguity decision are unit-tested directly (`test/github-discovery.test.js`).
 *
 * The impure half — running the read-only `gh pr list … --json …` query — lives
 * in `src/main/github.ts` (`discoverRunPrCandidates`), which reuses the existing
 * `gh` plumbing and then calls into this module. Mirrors the `verify.ts` (pure)
 * + `github.ts` (impure) split of the #9 commit-verification gate. Agent
 * self-reports and PTY transcript content are never inputs here.
 */

/** A PR as fetched from `gh pr list`, before candidate classification. */
export type DiscoveryPr = {
  number: number;
  title: string;
  body: string;
  url: string;
  headRefName: string;
  /** Remote PR head commit SHA (`headRefOid`). */
  headSha: string;
  /** PR author login, or '' when unresolved. */
  author: string;
  /** ISO timestamp the PR was created. */
  createdAt: string;
};

/** What a run brings to candidate matching. */
export type DiscoveryContext = {
  /** The run's GitHub issue number, when source is an issue. */
  issueNumber?: number;
  /**
   * ISO timestamp the builder handoff was sent. Bounds the conservative
   * recent-unlinked fallback to PRs created at/after the handoff; when unknown,
   * the fallback is skipped entirely so discovery never guesses from old PRs.
   */
  handoffSentAt?: string;
};

/**
 * Whether free text references the issue via `#N` (covering `Closes #N` /
 * `Fixes #N` / `Resolves #N` and a bare `#N`). The trailing negative lookahead
 * keeps `#12` from matching `#123`; a leading non-digit boundary is implied by
 * the `#`. Case is irrelevant — only the number is matched.
 */
export function referencesIssue(text: string, issueNumber: number): boolean {
  if (!text || !Number.isInteger(issueNumber) || issueNumber <= 0) return false;
  return new RegExp(`#${issueNumber}(?!\\d)`).test(text);
}

/** Whether a PR was created at/after the handoff send time (recent-unlinked gate). */
function createdAfterHandoff(createdAt: string, handoffSentAt: string | undefined): boolean {
  if (!handoffSentAt) return false;
  const created = Date.parse(createdAt);
  const sent = Date.parse(handoffSentAt);
  if (Number.isNaN(created) || Number.isNaN(sent)) return false;
  return created >= sent;
}

function toCandidate(pr: DiscoveryPr, matchReason: PrCandidateMatchReason): PrCandidate {
  return {
    number: pr.number,
    url: pr.url,
    headRefName: pr.headRefName,
    headSha: pr.headSha,
    author: pr.author,
    createdAt: pr.createdAt,
    title: pr.title,
    matchReason,
  };
}

/**
 * Classify fetched PRs into run candidates (issue #38). Two evidence tiers,
 * deliberately conservative:
 *
 * - `issue_link` — the PR title or body references the run's issue (`#N`). The
 *   strong signal; an explicit link is what `AGENTS.md` Completion Evidence wants.
 * - `recent_unlinked` — a fallback for when the builder forgot the link: open PRs
 *   created at/after the handoff send. Only ever produced when the handoff time is
 *   known, and a PR already matched by issue link is never double-counted here.
 *
 * Returned issue-linked first, then recent-unlinked, each in `gh`'s order. The
 * ambiguity decision is left to {@link selectPrCandidate}; this only labels.
 */
export function matchPrCandidates(prs: DiscoveryPr[], context: DiscoveryContext): PrCandidate[] {
  const issueLinked: PrCandidate[] = [];
  const recentUnlinked: PrCandidate[] = [];
  const linkedNumbers = new Set<number>();

  if (context.issueNumber !== undefined) {
    for (const pr of prs) {
      if (referencesIssue(pr.title, context.issueNumber) || referencesIssue(pr.body, context.issueNumber)) {
        issueLinked.push(toCandidate(pr, 'issue_link'));
        linkedNumbers.add(pr.number);
      }
    }
  }

  for (const pr of prs) {
    if (linkedNumbers.has(pr.number)) continue;
    if (createdAfterHandoff(pr.createdAt, context.handoffSentAt)) {
      recentUnlinked.push(toCandidate(pr, 'recent_unlinked'));
    }
  }

  return [...issueLinked, ...recentUnlinked];
}

/**
 * The ambiguity decision over matched candidates (issue #38). An explicit issue
 * link is authoritative: exactly one `issue_link` candidate is the unambiguous,
 * confirmed-pending pick — even alongside weaker recent-unlinked candidates. Any
 * other shape (zero candidates, multiple issue links, or only recent-unlinked
 * guesses) requires an explicit operator pick; discovery never auto-selects a
 * weak match. The transition itself is still an operator confirmation either way.
 */
export type PrCandidateSelection =
  | { kind: 'none' }
  | { kind: 'unambiguous'; candidate: PrCandidate }
  | { kind: 'ambiguous'; candidates: PrCandidate[] };

export function selectPrCandidate(candidates: PrCandidate[]): PrCandidateSelection {
  if (candidates.length === 0) return { kind: 'none' };
  const issueLinked = candidates.filter((candidate) => candidate.matchReason === 'issue_link');
  if (issueLinked.length === 1) return { kind: 'unambiguous', candidate: issueLinked[0] };
  return { kind: 'ambiguous', candidates };
}
