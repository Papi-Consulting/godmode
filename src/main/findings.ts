import type {
  AgentRole,
  CommitVerification,
  FallbackVerdictOutcome,
  FindingStatus,
  GithubComment,
  IgnoredVerdictComment,
  MergeReadiness,
  MergeRecommendation,
  ReviewerEvidenceSource,
  ReviewerFallbackVerdict,
  ReviewerFinding,
  ReviewerGateState,
  ReviewerHeadEvidence,
  ReviewerResult,
  ReviewerResultStatus,
  ReviewerSessionState,
  ReviewerVerdictParse,
  ReviewerVerdictStatus,
} from '../shared/types.js';

/**
 * Reviewer-output parsing, the merge-readiness gate, and the accepted-blocker
 * text builder — the analysis half of the first verified fix cycle (issue #11).
 *
 * GodMode is an agent harness, not a self-report trust layer: this module turns a
 * reviewer session's *captured output* into normalized, advisory findings and a
 * pass/fail/ambiguous status, but the merge gate it computes still requires the
 * **verified** #9 commit evidence — a reviewer marker alone never marks merge-ready.
 * Missing, malformed, contradictory, or internally inconsistent reviewer output is
 * routed to `ambiguous` (→ needs-human), never silently treated as a pass.
 *
 * Everything here is pure and Electron/`gh`/filesystem-free so the parsing,
 * gate, and prompt-text logic are unit-tested directly (`test/findings.test.js`).
 * The IO — reading captured artifacts, re-running #9, persisting findings, and
 * driving transitions — lives in `src/main/index.ts`.
 */

/** A reviewer completion marker: `DONE: ROLE=reviewer STATUS=pass|fail BLOCKING=<count>`. */
const DONE_MARKER = /^\s*DONE:\s*ROLE=reviewer\s+STATUS=(pass|fail)\s+BLOCKING=(\d+)\b/i;

/** A clean PASS line per the reviewer role docs, e.g. `Reviewer A: PASS — …`. */
const PASS_LINE = /^\s*reviewer\b[^\n]*\bpass\b/i;

/** A `BLOCKING A-1: <title>` / `BLOCKING B-2: <title>` block header. */
const BLOCKING_HEADER = /^\s*BLOCKING\s+([A-Za-z]+-\d+)\s*:?\s*(.*)$/i;

/** Labeled field lines within a blocking block. */
const FILE_FIELD = /^\s*File\s*:\s*(.+)$/i;
const ISSUE_FIELD = /^\s*Issue\s*:\s*(.+)$/i;
const WHY_FIELD = /^\s*Why it blocks\s*:\s*(.+)$/i;
const FIX_FIELD = /^\s*Suggested fix\s*:\s*(.+)$/i;

/** Split a `path/to/file.ts:42` reference into its file and 1-based line. */
function parseFileRef(raw: string): { file?: string; line?: number } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const match = trimmed.match(/^(.*?):(\d+)\s*$/);
  if (match) {
    const line = Number.parseInt(match[2], 10);
    return { file: match[1].trim(), line: Number.isFinite(line) ? line : undefined };
  }
  return { file: trimmed };
}

/** Join the issue/why-it-blocks lines into a single details string. */
function joinDetails(parts: string[]): string | undefined {
  const joined = parts.map((part) => part.trim()).filter(Boolean).join(' ');
  return joined.length > 0 ? joined : undefined;
}

type RawBlock = {
  marker: string;
  title: string;
  fileRaw?: string;
  detailParts: string[];
  suggestedFix?: string;
};

/**
 * Extract the raw `BLOCKING …` blocks from reviewer output. A block runs from its
 * header to the next header (or a DONE marker, or end). Unlabeled continuation
 * lines extend the most recent labeled field so multi-line issue/fix text is kept.
 */
function extractBlocks(lines: string[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  let current: RawBlock | null = null;
  // Which field a bare continuation line should extend.
  let lastField: 'issue' | 'fix' | null = null;

  const flush = () => {
    if (current) blocks.push(current);
    current = null;
    lastField = null;
  };

  for (const line of lines) {
    const header = line.match(BLOCKING_HEADER);
    if (header) {
      flush();
      current = { marker: header[1].toUpperCase(), title: header[2].trim(), detailParts: [] };
      lastField = null;
      continue;
    }
    if (!current) continue;

    // A DONE marker terminates the in-progress block (it is never a field).
    if (DONE_MARKER.test(line)) {
      flush();
      continue;
    }

    const fileMatch = line.match(FILE_FIELD);
    if (fileMatch) {
      current.fileRaw = fileMatch[1];
      lastField = null;
      continue;
    }
    const issueMatch = line.match(ISSUE_FIELD);
    if (issueMatch) {
      current.detailParts.push(issueMatch[1]);
      lastField = 'issue';
      continue;
    }
    const whyMatch = line.match(WHY_FIELD);
    if (whyMatch) {
      current.detailParts.push(`Why it blocks: ${whyMatch[1]}`);
      lastField = 'issue';
      continue;
    }
    const fixMatch = line.match(FIX_FIELD);
    if (fixMatch) {
      current.suggestedFix = fixMatch[1].trim();
      lastField = 'fix';
      continue;
    }

    // Bare continuation line: extend the most recent field, if any.
    const text = line.trim();
    if (!text) continue;
    if (lastField === 'fix' && current.suggestedFix !== undefined) {
      current.suggestedFix = `${current.suggestedFix} ${text}`.trim();
    } else if (lastField === 'issue') {
      current.detailParts.push(text);
    } else if (!current.title) {
      // Title was empty on the header line; adopt the first content line.
      current.title = text;
    }
  }
  flush();
  return blocks;
}

/**
 * Build normalized {@link ReviewerFinding}s from parsed `BLOCKING …` blocks, all
 * marked `severity: 'blocking'` and `status: 'open'` (the caller patches the
 * lifecycle status once the overall result status is known). Shared by the
 * captured-output parser and the fallback verdict-comment parser (issue #60) so
 * both produce identical finding shapes that flow through the same fix cycle.
 */
function findingsFromBlocks(blocks: RawBlock[], reviewerId: string, paneId: AgentRole): ReviewerFinding[] {
  return blocks.map((block) => {
    const ref = block.fileRaw ? parseFileRef(block.fileRaw) : {};
    return {
      reviewerId,
      paneId,
      marker: block.marker,
      severity: 'blocking',
      status: 'open',
      file: ref.file,
      line: ref.line,
      title: block.title || block.marker,
      details: joinDetails(block.detailParts),
      suggestedFix: block.suggestedFix,
    };
  });
}

/** Map a resolved result status to the lifecycle each of its findings carries. */
function findingStatusFor(status: ReviewerResultStatus): FindingStatus {
  return status === 'fail' ? 'accepted' : status === 'ambiguous' ? 'needs_human' : 'open';
}

/** Inputs for {@link parseReviewerOutput}. */
export type ParseReviewerInput = {
  reviewerId: string;
  paneId: AgentRole;
  /** The reviewer session's captured output (stdout/stderr log). */
  text: string;
};

/**
 * Parse one reviewer session's captured output into a normalized
 * {@link ReviewerResult}. Pure and deterministic.
 *
 * Status resolution, in order:
 * - empty output → `ambiguous` (nothing was captured).
 * - multiple conflicting DONE markers → `ambiguous`.
 * - a DONE marker is authoritative for the declared verdict, but is cross-checked
 *   against the parsed blocks: pass-with-blockers, fail-with-no-blockers, or a
 *   pass marker that declares a non-zero count are all internally inconsistent →
 *   `ambiguous`.
 * - no marker: infer `fail` from parsed blocking blocks, `pass` from a PASS line,
 *   `ambiguous` when both (contradiction) or neither (no parseable result) appear.
 *
 * Blocking findings are marked `accepted` on a clean `fail` (this first slice
 * accepts cleanly-parsed blockers by default) and `needs_human` on an `ambiguous`
 * result, so an ambiguous reviewer never feeds accepted blockers into a fix cycle.
 */
export function parseReviewerOutput(input: ParseReviewerInput): ReviewerResult {
  const { reviewerId, paneId, text } = input;
  const notes: string[] = [];
  const lines = text.split(/\r?\n/);

  // Collect DONE markers and detect conflicting ones.
  const markers: { status: 'pass' | 'fail'; blocking: number }[] = [];
  let hasPassLine = false;
  for (const line of lines) {
    const m = line.match(DONE_MARKER);
    if (m) markers.push({ status: m[1].toLowerCase() as 'pass' | 'fail', blocking: Number.parseInt(m[2], 10) });
    if (PASS_LINE.test(line)) hasPassLine = true;
  }
  const conflictingMarkers =
    markers.length > 1 && markers.some((m) => m.status !== markers[0].status || m.blocking !== markers[0].blocking);
  const marker = markers[0];

  const blocks = extractBlocks(lines);
  const blockerCount = blocks.length;

  // Build findings before status is known; status is patched on below.
  const findings: ReviewerFinding[] = findingsFromBlocks(blocks, reviewerId, paneId);

  let status: ReviewerResultStatus;
  if (text.trim().length === 0) {
    status = 'ambiguous';
    notes.push('No reviewer output was captured.');
  } else if (conflictingMarkers) {
    status = 'ambiguous';
    notes.push('Multiple conflicting DONE markers were found in the reviewer output.');
  } else if (marker) {
    if (marker.status === 'pass') {
      if (marker.blocking > 0) {
        status = 'ambiguous';
        notes.push(`Marker reports pass but declares BLOCKING=${marker.blocking}.`);
      } else if (blockerCount > 0) {
        status = 'ambiguous';
        notes.push(`Marker reports pass but ${blockerCount} BLOCKING block(s) were found.`);
      } else {
        status = 'pass';
      }
    } else {
      // fail
      if (blockerCount === 0) {
        status = 'ambiguous';
        notes.push(
          marker.blocking > 0
            ? `Marker declares BLOCKING=${marker.blocking} but no BLOCKING blocks could be parsed.`
            : 'Marker reports fail but declares BLOCKING=0 and no BLOCKING blocks were found.',
        );
      } else {
        status = 'fail';
        if (marker.blocking !== blockerCount) {
          notes.push(`Marker declares BLOCKING=${marker.blocking} but ${blockerCount} block(s) were parsed.`);
        }
      }
    }
  } else if (hasPassLine && blockerCount > 0) {
    status = 'ambiguous';
    notes.push(`A reviewer PASS line and ${blockerCount} BLOCKING block(s) both appear; the result is contradictory.`);
  } else if (blockerCount > 0) {
    status = 'fail';
    notes.push(`No DONE marker; inferred fail from ${blockerCount} BLOCKING block(s).`);
  } else if (hasPassLine) {
    status = 'pass';
    notes.push('No DONE marker; inferred pass from the reviewer PASS line.');
  } else {
    status = 'ambiguous';
    notes.push('No reviewer DONE marker, PASS line, or BLOCKING block was found.');
  }

  // Patch finding lifecycle from the resolved status: accept cleanly-parsed
  // blockers on a fail; on an ambiguous result they need a human, never accepted.
  const findingStatus = findingStatusFor(status);
  for (const finding of findings) finding.status = findingStatus;

  return {
    reviewerId,
    paneId,
    status,
    declaredStatus: marker?.status,
    declaredBlocking: marker?.blocking,
    findings,
    notes,
  };
}

/** Flatten the accepted blocking findings across all reviewer results. */
export function acceptedBlockers(results: ReviewerResult[]): ReviewerFinding[] {
  return results.flatMap((result) =>
    result.findings.filter((finding) => finding.severity === 'blocking' && finding.status === 'accepted'),
  );
}

/** Build the per-reviewer gate state for one pane's result (or absent result). */
function gateFor(paneId: AgentRole, result: ReviewerResult | undefined): ReviewerGateState | null {
  if (!result) return null;
  const acceptedCount = result.findings.filter(
    (finding) => finding.severity === 'blocking' && finding.status === 'accepted',
  ).length;
  // Cleared = not ambiguous AND no accepted blockers (passed, or had nothing to block on).
  const cleared = result.status !== 'ambiguous' && acceptedCount === 0;
  return { reviewerId: result.reviewerId, paneId, status: result.status, cleared, acceptedBlockers: acceptedCount };
}

/**
 * Reviewer session statuses that represent a completed, parseable attempt — the
 * captured output exists and the session reached a terminal state synthesis can
 * consume. A still-`running`/`launching` or `failed` attempt is not completed
 * evidence (issue #59).
 */
const COMPLETED_REVIEWER_STATUSES: ReadonlySet<ReviewerSessionState['status']> = new Set([
  'completed',
  'comment_posted',
]);

/** The minimal reviewer-session shape {@link reviewerHeadEvidence} needs. */
export type ReviewerHeadEvidenceInput = Pick<
  ReviewerSessionState,
  'reviewerId' | 'paneId' | 'status'
> &
  Partial<Pick<ReviewerSessionState, 'attemptId' | 'cycle' | 'targetHeadSha' | 'targetHeadShaShort'>>;

/**
 * Build the current-head evidence for one reviewer session (issue #59): whether
 * its latest attempt targeted the current verified PR head AND reached a
 * completed/parseable state. Used by synthesis to decide which reviewer results
 * the merge gate may consume, and surfaced to the UI so a stale attempt is labeled
 * rather than read as current approval. Pure.
 */
export function reviewerHeadEvidence(
  session: ReviewerHeadEvidenceInput,
  currentHeadSha: string | null,
): ReviewerHeadEvidence {
  const completed = COMPLETED_REVIEWER_STATUSES.has(session.status);
  const current = Boolean(currentHeadSha) && session.targetHeadSha === currentHeadSha;
  return {
    reviewerId: session.reviewerId,
    paneId: session.paneId,
    attemptId: session.attemptId,
    cycle: session.cycle,
    attemptHeadSha: session.targetHeadSha,
    attemptHeadShaShort: session.targetHeadShaShort,
    current,
    completed,
  };
}

/** Panes whose reviewer has completed, current-head evidence the gate may consume. */
function usablePanes(reviewerHeads: ReviewerHeadEvidence[]): Set<AgentRole> {
  return new Set(reviewerHeads.filter((head) => head.current && head.completed).map((head) => head.paneId));
}

/**
 * Filter reviewer results to those backed by completed, current-head evidence
 * (issue #59). A reviewer whose latest attempt targeted a previous PR head, or has
 * not completed, is dropped — its output is **not** consumed as current evidence,
 * so neither its clear nor its blockers feed the merge decision for the new head.
 */
export function currentHeadResults(
  results: ReviewerResult[],
  reviewerHeads: ReviewerHeadEvidence[],
): ReviewerResult[] {
  const panes = usablePanes(reviewerHeads);
  return results.filter((result) => panes.has(result.paneId));
}

/** Inputs for {@link computeMergeReadiness}. */
export type MergeReadinessInput = {
  results: ReviewerResult[];
  /** The latest #9 commit verification used as the evidence gate, or null. */
  verification: CommitVerification | null;
  /**
   * Per-reviewer current-head evidence (issue #59). When provided, the gate only
   * consumes reviewer results whose attempt targeted the current PR head and
   * completed — a stale or incomplete reviewer is treated as having no usable
   * result, so the gate can never reach `merge_ready` on stale evidence and the
   * reasons explain which reviewer/head is missing. Omitted → legacy behavior
   * (every result is consumed), preserving the pre-#59 callers/tests.
   */
  reviewerHeads?: ReviewerHeadEvidence[];
  /** Short SHA of the PR head the gate is computed against, for the reasons text. */
  currentHeadShaShort?: string | null;
};

/** Human label for a reviewer pane in gate reasons. */
function reviewerLabel(paneId: AgentRole): string {
  return paneId === 'reviewer_a' ? 'Reviewer A' : 'Reviewer B';
}

/**
 * Compute the merge-readiness gate (issue #11). Merge-ready requires BOTH
 * reviewers cleared, the verified #9 commit evidence, and no accepted blockers —
 * a reviewer self-report alone is never enough. Recommendation precedence:
 * ambiguous output → `needs_human`; remaining accepted blockers on a verified PR →
 * `request_fix` (blockers but an unverified PR → `hold`, never a fix against a
 * stale target); all gates satisfied → `merge_ready`; otherwise `hold` (a
 * non-reviewer gate, e.g. an unverified PR, is unmet but nothing can auto-fix).
 */
export function computeMergeReadiness(input: MergeReadinessInput): MergeReadiness {
  const { results, verification, reviewerHeads, currentHeadShaShort } = input;

  // Head-gating (issue #59): when per-reviewer head evidence is supplied, the gate
  // consumes ONLY reviewer results whose attempt targeted the current PR head and
  // completed. A stale/incomplete reviewer is dropped from `usable`, so its gate is
  // null (not cleared) and its blockers/ambiguity never feed the decision — the
  // merge gate can never reach `merge_ready` on evidence from a previous head.
  const headGating = reviewerHeads !== undefined;
  const headByPane = new Map<AgentRole, ReviewerHeadEvidence>(
    (reviewerHeads ?? []).map((head) => [head.paneId, head]),
  );
  const usable = headGating ? currentHeadResults(results, reviewerHeads) : results;

  const reviewerA = gateFor('reviewer_a', usable.find((r) => r.paneId === 'reviewer_a'));
  const reviewerB = gateFor('reviewer_b', usable.find((r) => r.paneId === 'reviewer_b'));

  // Issue #61: merge-readiness requires current-head evidence. `verified` already
  // implies `currentHeadVerified` (an open PR only verifies when the expected
  // commit IS the head, or the PR merged), but require the flag explicitly so a
  // `stale_head` result — the expected commit still in PR history after the head
  // moved — can never satisfy the gate. `currentHeadVerified` defaults to true
  // when absent so pre-#61 verification fixtures/callers keep their behavior.
  const prVerified = verification?.status === 'verified' && verification.currentHeadVerified !== false;
  const totalAcceptedBlockers = acceptedBlockers(usable).length;
  const noAcceptedBlockers = totalAcceptedBlockers === 0;
  const anyAmbiguous = usable.some((r) => r.status === 'ambiguous');
  // A reviewer that ran but whose attempt is stale/incomplete for the current head
  // blocks merge-readiness and routes to `hold` (relaunch reviewers), not a human.
  const anyStaleHead = headGating && (reviewerHeads ?? []).some((head) => !(head.current && head.completed));

  const reasons: string[] = [];
  const currentShort = currentHeadShaShort ?? null;
  const describeReviewer = (paneId: AgentRole, gate: ReviewerGateState | null) => {
    const label = reviewerLabel(paneId);
    // Head-specific reasons take precedence: a reviewer with a stale/incomplete
    // attempt for the current head is NOT "no parseable result" — it reviewed a
    // different (or not-yet-finished) head, so say exactly that.
    const head = headGating ? headByPane.get(paneId) : undefined;
    if (head && !(head.current && head.completed)) {
      if (head.attemptHeadShaShort && !head.current) {
        reasons.push(
          `${label} last reviewed ${head.attemptHeadShaShort}, but the current PR head is ` +
            `${currentShort ?? 'unknown'}; its review is stale — relaunch reviewers for a fresh review.`,
        );
      } else {
        reasons.push(
          `${label} has not produced a completed review for the current PR head` +
            `${currentShort ? ` ${currentShort}` : ''} yet.`,
        );
      }
      return;
    }
    if (!gate) {
      reasons.push(`${label} has not produced a parseable result yet.`);
      return;
    }
    if (gate.status === 'ambiguous') reasons.push(`${label} output is ambiguous; a human must review it.`);
    else if (gate.acceptedBlockers > 0)
      reasons.push(`${label} has ${gate.acceptedBlockers} accepted blocking finding(s).`);
  };
  describeReviewer('reviewer_a', reviewerA);
  describeReviewer('reviewer_b', reviewerB);

  if (!prVerified) {
    reasons.push(
      verification
        ? `PR verification is "${verification.status}", not verified.`
        : 'No commit verification (#9) has been recorded for this run.',
    );
  }

  const mergeReady =
    Boolean(reviewerA?.cleared) &&
    Boolean(reviewerB?.cleared) &&
    prVerified &&
    noAcceptedBlockers &&
    !anyAmbiguous &&
    // A stale/incomplete reviewer attempt for the current head can never clear the
    // gate, even if both usable gates happen to read cleared (issue #59).
    !anyStaleHead;

  let recommendation: MergeRecommendation;
  if (anyAmbiguous) recommendation = 'needs_human';
  // Accepted blockers only open a fix cycle against a VERIFIED PR. Without the #9
  // evidence (no PR, needs-refresh, checks-failed, …) the PR coordinates are stale
  // or unverified, so a fix prompt would target an unverified PR — hold until the
  // operator re-verifies, then this recomputes to request_fix.
  else if (totalAcceptedBlockers > 0) recommendation = prVerified ? 'request_fix' : 'hold';
  else if (mergeReady) recommendation = 'merge_ready';
  else recommendation = 'hold';

  if (totalAcceptedBlockers > 0 && !prVerified) {
    reasons.push(
      `${totalAcceptedBlockers} accepted blocker(s) need a fix, but the fix cycle is held until the PR is verified again.`,
    );
  }
  if (mergeReady) reasons.push('Both reviewers cleared and the PR commit is verified — merge-ready.');

  return {
    mergeReady,
    reviewerA,
    reviewerB,
    prVerified,
    noAcceptedBlockers,
    anyAmbiguous,
    recommendation,
    reasons,
    prHeadShaShort: currentShort,
    reviewerHeads,
  };
}

// ===========================================================================
// Role-signed fallback verdict comments (issue #60)
// ===========================================================================
//
// In dogfooding the same GitHub account often owns the PR branch, so a reviewer
// agent cannot submit a *formal* approving GitHub review (GitHub refuses
// same-author approval). The harness lets such a reviewer post a documented,
// role-signed PR comment verdict instead — explicit, machine-readable, and tied
// to the current PR head. This is deliberately distinct from GodMode's automatic
// marker comment (`reviewerCommentBody`), which never asserts a verdict.
//
// The verdict line grammar (one line, anywhere in the comment body):
//
//   GODMODE_REVIEW_VERDICT reviewer=<id> pane=<reviewer_a|reviewer_b> pr=<n> \
//     head=<7-or-40-char-sha> status=<approved|blocked> blocking=<count>
//
// A `blocked` verdict carries the same `BLOCKING A-1:` blocks the captured-output
// parser understands, so its blockers normalize into the existing accepted-blocker
// fix cycle. Everything below is pure so it is unit-tested without `gh`.

/** The token that identifies a fallback verdict line. */
export const VERDICT_MARKER_TOKEN = 'GODMODE_REVIEW_VERDICT';

const VERDICT_MARKER_LINE = /\bGODMODE_REVIEW_VERDICT\b/i;
/** A status token is canonicalized to one of the two verdict states. */
const APPROVED_TOKENS = new Set(['approved', 'approve', 'pass']);
const BLOCKED_TOKENS = new Set(['blocked', 'block', 'fail']);

/** Read a `key=value` field from a verdict line; trims surrounding backticks. */
function verdictField(line: string, key: string): string | undefined {
  const match = line.match(new RegExp(`\\b${key}=([^\\s\`]+)`, 'i'));
  return match ? match[1].trim() : undefined;
}

/**
 * Parse a verdict token that must be a base-10 non-negative integer with **no**
 * trailing/leading junk (e.g. `pr=`/`blocking=`). Returns undefined for missing
 * or malformed tokens such as `42x` or `0x`, so the caller routes them to
 * ambiguous rather than letting `Number.parseInt`'s prefix-parsing (`42x` → 42,
 * `0x` → 0) silently accept them (issue #60 blocker A-1).
 */
function strictNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Whether two SHAs refer to the same commit, tolerating short (≥7) vs full. */
function shaMatches(written: string | undefined, current: string | null): boolean {
  if (!written || !current) return false;
  const a = written.toLowerCase();
  const b = current.toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(a) || b.length < 7) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** Whether a field looks like a real (hex, ≥7 char) SHA, so a mismatch is "stale". */
function looksLikeSha(value: string | undefined): boolean {
  return value !== undefined && /^[0-9a-f]{7,40}$/i.test(value);
}

type ConfiguredReviewer = { reviewerId: string; paneId: AgentRole };

/**
 * Attribute a verdict line to a configured reviewer by its `pane=` and/or
 * `reviewer=` fields. Both must point at the *same* configured reviewer when both
 * are present (an inconsistent pair is treated as unknown). Returns null when the
 * comment cannot be tied to any configured reviewer — an unknown/unrelated author.
 */
function attributeReviewer(
  reviewers: ConfiguredReviewer[],
  reviewerField: string | undefined,
  paneField: string | undefined,
): ConfiguredReviewer | null {
  const byPane = paneField ? reviewers.find((r) => r.paneId === paneField) : undefined;
  const byId = reviewerField ? reviewers.find((r) => r.reviewerId === reviewerField) : undefined;
  if (byPane && byId) return byPane.paneId === byId.paneId ? byPane : null;
  return byPane ?? byId ?? null;
}

/**
 * A stable, content-addressable signature of a fallback verdict's *meaningful*
 * payload: its status, declared blocking count, and the full set of normalized
 * blocker findings (marker/file/line/title/details/fix), order-independent. Two
 * current-head verdict comments for the same reviewer collapse as agreeing
 * duplicates only when their signatures match — so two `blocked blocking=1`
 * comments carrying *different* BLOCKING blocks no longer silently drop one
 * blocker but route to ambiguous (issue #60 blocker B-2).
 */
function verdictSignature(verdict: ReviewerFallbackVerdict): string {
  const findings = verdict.findings
    .map((f) =>
      [f.marker ?? '', f.file ?? '', f.line ?? '', f.title, f.details ?? '', f.suggestedFix ?? ''].join('\u0001'),
    )
    .sort()
    .join('\u0002');
  return [verdict.status, verdict.declaredBlocking, findings].join('\u0003');
}

/** Canonicalize a `status=` token, or undefined when it is not a known verdict. */
function canonicalVerdictStatus(token: string | undefined): ReviewerVerdictStatus | undefined {
  if (!token) return undefined;
  const lower = token.toLowerCase();
  if (APPROVED_TOKENS.has(lower)) return 'approved';
  if (BLOCKED_TOKENS.has(lower)) return 'blocked';
  return undefined;
}

/** Inputs for {@link parseReviewerVerdictComments}. */
export type ParseVerdictCommentsInput = {
  /** The bound PR's comments, read live from `gh`. */
  comments: GithubComment[];
  /** The bound PR number — verdicts for any other PR are ignored. */
  prNumber: number;
  /** The verified current PR head SHA — verdicts for any other head are ignored. */
  currentHeadSha: string | null;
  /** The configured reviewers; verdicts from any other author/role are ignored. */
  reviewers: ConfiguredReviewer[];
};

/** Per-pane accumulator while scanning comments. */
type PaneAccumulator = {
  reviewer: ConfiguredReviewer;
  valid: ReviewerFallbackVerdict[];
  malformed: string[];
};

/**
 * Parse a PR's comments into role-signed fallback verdicts for the *current* head
 * (issue #60). Pure and deterministic. Safety rules, in order, for every comment
 * that contains the `GODMODE_REVIEW_VERDICT` token:
 *
 *  - it must be attributable to a configured reviewer (`pane=`/`reviewer=`); else
 *    it is ignored as unknown/unrelated;
 *  - a `pr=` that is a valid integer naming a different PR → ignored (wrong-PR);
 *  - a `head=` that is a real SHA not matching the current head → ignored
 *    (stale-head);
 *  - otherwise it is attributed to the pane and validated. A current-head verdict
 *    that is malformed (missing fields, a `pr=`/`blocking=` that is not a strict
 *    base-10 integer — e.g. `42x`/`0x`, unknown status, `approved` with
 *    `blocking>0`, `approved` that nonetheless embeds `BLOCKING` blocks, or
 *    `blocked` with no `BLOCKING` blocks) routes that pane to **ambiguous**,
 *    never a silent pass;
 *  - a pane with two or more current-head verdicts whose full normalized payload
 *    disagrees (status, declared count, **or** blocker markers/files/details/fixes)
 *    routes to **ambiguous** (duplicate-conflicting); only fully-agreeing
 *    duplicates collapse to one accepted verdict.
 *
 * When `currentHeadSha` is null (no verified PR head) there is no current head to
 * tie a verdict to, so no fallback evidence is produced at all.
 */
export function parseReviewerVerdictComments(input: ParseVerdictCommentsInput): ReviewerVerdictParse {
  const { comments, prNumber, currentHeadSha, reviewers } = input;
  const ignored: IgnoredVerdictComment[] = [];
  if (!currentHeadSha) return { outcomes: [], ignored };

  const byPane = new Map<AgentRole, PaneAccumulator>();
  const accFor = (reviewer: ConfiguredReviewer): PaneAccumulator => {
    let acc = byPane.get(reviewer.paneId);
    if (!acc) {
      acc = { reviewer, valid: [], malformed: [] };
      byPane.set(reviewer.paneId, acc);
    }
    return acc;
  };

  for (const comment of comments) {
    const body = comment.body ?? '';
    const lines = body.split(/\r?\n/);
    const markerLine = lines.find((line) => VERDICT_MARKER_LINE.test(line));
    if (markerLine === undefined) continue; // not a verdict comment

    const author = comment.author ?? 'unknown';
    const reviewerField = verdictField(markerLine, 'reviewer');
    const paneField = verdictField(markerLine, 'pane');
    const reviewer = attributeReviewer(reviewers, reviewerField, paneField);
    if (!reviewer) {
      ignored.push({ reason: 'unknown-reviewer: verdict not tied to a configured reviewer', author });
      continue;
    }

    const prField = verdictField(markerLine, 'pr');
    const prValue = strictNonNegativeInt(prField);
    if (prValue !== undefined && prValue !== prNumber) {
      ignored.push({ reason: `wrong-PR: verdict targets PR #${prValue}, not #${prNumber}`, author });
      continue;
    }

    const headField = verdictField(markerLine, 'head');
    if (looksLikeSha(headField) && !shaMatches(headField, currentHeadSha)) {
      ignored.push({ reason: `stale-head: verdict targets ${headField}, not the current head`, author });
      continue;
    }

    // Attributed to our pane, current PR, current (or unconfirmable) head: from
    // here a problem is malformed → ambiguous, never a silent ignore.
    const acc = accFor(reviewer);
    const statusField = verdictField(markerLine, 'status');
    const status = canonicalVerdictStatus(statusField);
    const blockingField = verdictField(markerLine, 'blocking');
    const blockingValue = strictNonNegativeInt(blockingField);

    const problems: string[] = [];
    if (prField === undefined || prValue === undefined) problems.push('missing/invalid pr=');
    if (!looksLikeSha(headField)) problems.push('missing/invalid head=');
    if (!status) problems.push(`unknown status=${statusField ?? '(none)'}`);
    if (blockingField === undefined || blockingValue === undefined) problems.push('missing/invalid blocking=');

    if (problems.length > 0 || status === undefined || prValue === undefined || blockingValue === undefined) {
      acc.malformed.push(`malformed verdict from ${author}: ${problems.join(', ')}`);
      continue;
    }

    if (status === 'approved') {
      if (blockingValue !== 0) {
        acc.malformed.push(`approved verdict from ${author} declares blocking=${blockingValue}`);
        continue;
      }
      // An approved verdict that nonetheless carries BLOCKING blocks contradicts
      // itself (declared blocking=0 but lists blockers). Treat it as ambiguous
      // rather than a silent pass, mirroring parseReviewerOutput's
      // pass-with-blockers handling and the #60 contract.
      const approvedBlocks = extractBlocks(lines);
      if (approvedBlocks.length > 0) {
        acc.malformed.push(
          `approved verdict from ${author} contradicts itself with ${approvedBlocks.length} BLOCKING block(s)`,
        );
        continue;
      }
      acc.valid.push({
        reviewerId: reviewer.reviewerId,
        paneId: reviewer.paneId,
        prNumber,
        headSha: headField as string,
        status: 'approved',
        declaredBlocking: 0,
        findings: [],
        author,
        createdAt: comment.createdAt ?? '',
      });
      continue;
    }

    // blocked: structured blockers must be present so they can drive the fix cycle.
    const blocks = extractBlocks(lines);
    if (blocks.length === 0) {
      acc.malformed.push(`blocked verdict from ${author} carries no BLOCKING blocks`);
      continue;
    }
    const findings = findingsFromBlocks(blocks, reviewer.reviewerId, reviewer.paneId);
    for (const finding of findings) finding.status = 'open';
    acc.valid.push({
      reviewerId: reviewer.reviewerId,
      paneId: reviewer.paneId,
      prNumber,
      headSha: headField as string,
      status: 'blocked',
      declaredBlocking: blockingValue,
      findings,
      author,
      createdAt: comment.createdAt ?? '',
    });
  }

  const outcomes: FallbackVerdictOutcome[] = [];
  for (const acc of byPane.values()) {
    const { reviewer, valid, malformed } = acc;
    const base = { paneId: reviewer.paneId, reviewerId: reviewer.reviewerId } as const;
    if (malformed.length > 0) {
      outcomes.push({ ...base, kind: 'ambiguous', reason: malformed[0] });
      continue;
    }
    if (valid.length === 0) continue;
    if (valid.length === 1) {
      outcomes.push({ ...base, kind: 'verdict', verdict: valid[0] });
      continue;
    }
    const first = valid[0];
    const firstSignature = verdictSignature(first);
    const allAgree = valid.every((v) => verdictSignature(v) === firstSignature);
    if (allAgree) {
      outcomes.push({ ...base, kind: 'verdict', verdict: first });
    } else {
      outcomes.push({
        ...base,
        kind: 'ambiguous',
        reason: `duplicate-conflicting verdicts: ${valid.length} current-head verdicts disagree (${valid
          .map((v) => `${v.status}/${v.declaredBlocking}+${v.findings.length}b`)
          .join(' vs ')})`,
      });
    }
  }

  return { outcomes, ignored };
}

/**
 * One reviewer's *effective* current-head evidence after reconciling its
 * captured-output artifact with any role-signed fallback verdict comment (issue
 * #60): the result the merge gate should consume, the head evidence (with its
 * {@link ReviewerEvidenceSource}), and the source for the UI.
 */
export type ReviewerEvidence = {
  paneId: AgentRole;
  reviewerId: string;
  result: ReviewerResult;
  head: ReviewerHeadEvidence;
  source: ReviewerEvidenceSource;
};

/** Inputs for {@link reconcileReviewerEvidence}. */
export type ReconcileReviewerEvidenceInput = {
  reviewers: ConfiguredReviewer[];
  /** Artifact-parsed results (from {@link parseReviewerOutput}). */
  artifactResults: ReviewerResult[];
  /** Session/artifact-derived head evidence (from {@link reviewerHeadEvidence}). */
  sessionHeads: ReviewerHeadEvidence[];
  /** Parsed fallback verdict outcomes (from {@link parseReviewerVerdictComments}). */
  verdicts: FallbackVerdictOutcome[];
  /** Verified current PR head SHA, for the fallback head evidence. */
  currentHeadSha: string | null;
  /** 7-char current head SHA, for compact display on fallback head evidence. */
  currentHeadShaShort?: string | null;
};

function ambiguousResult(reviewer: ConfiguredReviewer, notes: string[]): ReviewerResult {
  return { reviewerId: reviewer.reviewerId, paneId: reviewer.paneId, status: 'ambiguous', findings: [], notes };
}

/** Convert an accepted fallback verdict into a normalized {@link ReviewerResult}. */
function verdictToResult(verdict: ReviewerFallbackVerdict, extraNotes: string[]): ReviewerResult {
  const status: ReviewerResultStatus = verdict.status === 'approved' ? 'pass' : 'fail';
  const findingStatus = findingStatusFor(status);
  const findings = verdict.findings.map((finding) => ({ ...finding, status: findingStatus }));
  return {
    reviewerId: verdict.reviewerId,
    paneId: verdict.paneId,
    status,
    declaredBlocking: verdict.declaredBlocking,
    findings,
    notes: [
      `Cleared via role-signed fallback verdict comment (${verdict.status}) for the current head — harness evidence, not a formal GitHub approval.`,
      ...extraNotes,
    ],
  };
}

function fallbackHead(
  reviewer: ConfiguredReviewer,
  currentHeadSha: string | null,
  currentHeadShaShort: string | null | undefined,
  source: ReviewerEvidenceSource,
): ReviewerHeadEvidence {
  return {
    reviewerId: reviewer.reviewerId,
    paneId: reviewer.paneId,
    attemptHeadSha: currentHeadSha ?? undefined,
    attemptHeadShaShort: currentHeadShaShort ?? undefined,
    current: true,
    completed: true,
    source,
  };
}

/**
 * Reconcile each configured reviewer's captured-output artifact with its
 * role-signed fallback verdict comment into one effective evidence record (issue
 * #60). Precedence per reviewer:
 *
 *  - a fallback **ambiguous** outcome (malformed/duplicate-conflicting current-head
 *    verdict) routes the reviewer to ambiguous → needs-human, even when its
 *    artifact looks clean: a current-head verdict must never pass silently;
 *  - a valid fallback **verdict** with a *conclusive* current-head artifact that
 *    **conflicts** (one approves, the other blocks) → ambiguous (never the more
 *    favorable result); when they **agree** the gate consumes the agreement
 *    (`reconciled`);
 *  - a valid fallback **verdict** with no usable current-head artifact (the
 *    same-account case) → the gate consumes the verdict (`fallback_comment`), with
 *    current/completed head evidence so it can clear the gate;
 *  - no fallback verdict → the artifact result and its session head are used
 *    unchanged (`artifact`), preserving the pre-#60 behavior.
 *
 * The merge gate (`computeMergeReadiness`) still requires the verified #9 commit
 * evidence on top of this, so a fallback verdict can clear a reviewer gate only
 * when the PR head is current and verified. Pure for direct unit testing.
 */
export function reconcileReviewerEvidence(input: ReconcileReviewerEvidenceInput): ReviewerEvidence[] {
  const { reviewers, artifactResults, sessionHeads, verdicts, currentHeadSha, currentHeadShaShort } = input;

  return reviewers.map((reviewer) => {
    const pane = reviewer.paneId;
    const artifact = artifactResults.find((r) => r.paneId === pane);
    const sessionHead = sessionHeads.find((h) => h.paneId === pane);
    const artifactUsable = Boolean(sessionHead && sessionHead.current && sessionHead.completed);
    const artifactConclusive = artifactUsable && Boolean(artifact) && artifact!.status !== 'ambiguous';
    const outcome = verdicts.find((v) => v.paneId === pane);

    // Default (no fallback verdict): keep the artifact result + session head.
    const artifactEvidence = (): ReviewerEvidence => ({
      paneId: pane,
      reviewerId: reviewer.reviewerId,
      result: artifact ?? ambiguousResult(reviewer, ['No reviewer output was captured.']),
      head: sessionHead
        ? { ...sessionHead, source: 'artifact' }
        : { reviewerId: reviewer.reviewerId, paneId: pane, current: false, completed: false, source: 'artifact' },
      source: 'artifact',
    });

    if (!outcome) return artifactEvidence();

    if (outcome.kind === 'ambiguous') {
      return {
        paneId: pane,
        reviewerId: reviewer.reviewerId,
        result: ambiguousResult(reviewer, [
          `Role-signed fallback verdict comment is ambiguous: ${outcome.reason}. Routed to needs-human.`,
        ]),
        head: fallbackHead(reviewer, currentHeadSha, currentHeadShaShort, 'fallback_comment'),
        source: 'fallback_comment',
      };
    }

    const verdict = outcome.verdict;
    if (artifactConclusive) {
      const artifactPassed = artifact!.status === 'pass';
      const verdictApproved = verdict.status === 'approved';
      if (artifactPassed === verdictApproved) {
        // Agreement: consume it, preferring the verdict's structured blockers.
        return {
          paneId: pane,
          reviewerId: reviewer.reviewerId,
          result: verdictToResult(verdict, [
            'Captured artifact and fallback verdict agree for the current head.',
          ]),
          head: fallbackHead(reviewer, currentHeadSha, currentHeadShaShort, 'reconciled'),
          source: 'reconciled',
        };
      }
      // Conflict: never pick the favorable result.
      return {
        paneId: pane,
        reviewerId: reviewer.reviewerId,
        result: ambiguousResult(reviewer, [
          `Captured artifact (${artifact!.status}) and fallback verdict (${verdict.status}) conflict for the current head; routed to needs-human rather than choosing the favorable result.`,
        ]),
        head: fallbackHead(reviewer, currentHeadSha, currentHeadShaShort, 'reconciled'),
        source: 'reconciled',
      };
    }

    // No usable current-head artifact: the same-account fallback case.
    return {
      paneId: pane,
      reviewerId: reviewer.reviewerId,
      result: verdictToResult(verdict, []),
      head: fallbackHead(reviewer, currentHeadSha, currentHeadShaShort, 'fallback_comment'),
      source: 'fallback_comment',
    };
  });
}

/**
 * Render accepted blockers as compact, normalized text for the `builder_fix`
 * prompt's `{{blockers}}` variable. Deliberately a concise capsule — the reviewer
 * id, marker, title, file/line, issue, and suggested fix — NOT a transcript dump;
 * the fix handoff points the builder back to the live PR/review artifacts for the
 * full context (issue #11 pointer-first rule).
 */
export function renderBlockersText(blockers: ReviewerFinding[]): string {
  if (blockers.length === 0) return '(none)';
  return blockers
    .map((blocker) => {
      const label = blocker.marker ? `${blocker.marker} · ${blocker.reviewerId}` : blocker.reviewerId;
      const where = blocker.file ? ` (${blocker.file}${blocker.line !== undefined ? `:${blocker.line}` : ''})` : '';
      const lines = [`- [${label}] ${blocker.title}${where}`];
      if (blocker.details) lines.push(`    Issue: ${blocker.details}`);
      if (blocker.suggestedFix) lines.push(`    Suggested fix: ${blocker.suggestedFix}`);
      return lines.join('\n');
    })
    .join('\n');
}
