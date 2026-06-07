import type {
  AgentRole,
  CommitVerification,
  FindingStatus,
  MergeReadiness,
  MergeRecommendation,
  ReviewerFinding,
  ReviewerGateState,
  ReviewerResult,
  ReviewerResultStatus,
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
  const findings: ReviewerFinding[] = blocks.map((block) => {
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
  const findingStatus: FindingStatus = status === 'fail' ? 'accepted' : status === 'ambiguous' ? 'needs_human' : 'open';
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

/** Inputs for {@link computeMergeReadiness}. */
export type MergeReadinessInput = {
  results: ReviewerResult[];
  /** The latest #9 commit verification used as the evidence gate, or null. */
  verification: CommitVerification | null;
};

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
  const { results, verification } = input;
  const reviewerA = gateFor('reviewer_a', results.find((r) => r.paneId === 'reviewer_a'));
  const reviewerB = gateFor('reviewer_b', results.find((r) => r.paneId === 'reviewer_b'));

  const prVerified = verification?.status === 'verified';
  const totalAcceptedBlockers = acceptedBlockers(results).length;
  const noAcceptedBlockers = totalAcceptedBlockers === 0;
  const anyAmbiguous = results.some((r) => r.status === 'ambiguous');

  const reasons: string[] = [];
  const describeReviewer = (label: string, gate: ReviewerGateState | null) => {
    if (!gate) {
      reasons.push(`${label} has not produced a parseable result yet.`);
      return;
    }
    if (gate.status === 'ambiguous') reasons.push(`${label} output is ambiguous; a human must review it.`);
    else if (gate.acceptedBlockers > 0)
      reasons.push(`${label} has ${gate.acceptedBlockers} accepted blocking finding(s).`);
  };
  describeReviewer('Reviewer A', reviewerA);
  describeReviewer('Reviewer B', reviewerB);

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
    !anyAmbiguous;

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
  };
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
