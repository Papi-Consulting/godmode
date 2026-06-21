import type { ReviewerSessionState, ReviewerSessionStatus, RunSnapshot } from '../../shared/types.js';

/** Human labels per reviewer session status. Display-only; the key is canonical. */
const STATUS_LABEL: Record<ReviewerSessionStatus, string> = {
  idle: 'Idle',
  launching: 'Launching',
  running: 'Running',
  completed: 'Completed',
  comment_posted: 'Comment posted',
  failed: 'Failed',
};

// Green is reserved for the confirmed-success state only (AGENTS.md / PR #12):
// a reviewer is "done" only once its marker comment is posted.
const SUCCESS_STATUSES: ReadonlySet<ReviewerSessionStatus> = new Set<ReviewerSessionStatus>(['comment_posted']);
const ERROR_STATUSES: ReadonlySet<ReviewerSessionStatus> = new Set<ReviewerSessionStatus>(['failed']);

function statusTone(status: ReviewerSessionStatus): string {
  if (SUCCESS_STATUSES.has(status)) return 'success';
  if (ERROR_STATUSES.has(status)) return 'error';
  return 'warn';
}

// Statuses from which reviewers may be (re)launched, mirroring
// reviewerLaunchTransition in src/main/reviewer.ts: the initial PR (`pr_opened`)
// and after a builder fix (`fix_pushed`), plus their already-running relaunch
// states. The main process re-validates and re-runs the #9 verification gate, so
// this only avoids an obviously-dead click.
const STARTABLE_RUN_STATUSES = ['pr_opened', 'reviewers_running', 'fix_pushed', 'reviewers_rerunning'];
const RELAUNCH_RUN_STATUSES = ['reviewers_running', 'reviewers_rerunning'];

// Reviewer statuses for which a marker comment may be (re)posted, mirroring
// canPostReviewerMarker in src/main/reviewer.ts. A failed (launch/capture/non-zero
// exit) or still-launching reviewer is intentionally excluded so the operator
// override can never convert a failure into the green comment_posted state.
const POSTABLE_REVIEWER_STATUSES: ReviewerSessionStatus[] = ['completed', 'comment_posted', 'running'];

type ReviewLaunchPaneProps = {
  run: RunSnapshot | null;
  /** Most recent start rejection (e.g. not_verified), surfaced inline. */
  startError: string | null;
  starting: boolean;
  /**
   * Full SHA of the current verified PR head (issue #59), from the latest live #9
   * verification. A reviewer attempt whose `targetHeadSha` differs from this is
   * labeled stale — it reviewed an older commit, so it is not current evidence.
   * Null when no verification has been run, in which case staleness is not shown.
   */
  currentHeadSha: string | null;
  /** 7-char form of {@link currentHeadSha} for the stale label. */
  currentHeadShaShort: string | null;
  /** Launch both configured reviewers from the verified PR. */
  onStart: () => void;
  /** Operator override / re-post for one reviewer's marker comment. */
  onPostComment: (paneId: 'reviewer_a' | 'reviewer_b') => void;
};

/**
 * Reviewer launch + comment cockpit (issue #10). Drives launching Reviewer A/B
 * from a verified PR and shows each reviewer's independent lifecycle —
 * launching → running → completed → comment-posted, or a visible failure. The
 * launch button only acts from a PR-opened (or already-running) run; the main
 * process re-runs the #9 commit-verification gate before any reviewer starts, so
 * plain PR existence is never enough. Until reviewers are actually launched the
 * pane is clearly a pre-launch preview, never confused with real reviewer state.
 */
/**
 * Whether a reviewer attempt is stale relative to the current verified PR head
 * (issue #59): it targeted a head SHA that differs from the live one. Only
 * decidable when both the attempt's head and the current head are known.
 */
function isAttemptStale(session: ReviewerSessionState, currentHeadSha: string | null): boolean {
  return currentHeadSha !== null && Boolean(session.targetHeadSha) && session.targetHeadSha !== currentHeadSha;
}

export function ReviewLaunchPane({
  run,
  startError,
  starting,
  currentHeadSha,
  currentHeadShaShort,
  onStart,
  onPostComment,
}: ReviewLaunchPaneProps) {
  const reviewers: ReviewerSessionState[] = run?.reviewers ?? [];
  const canStart = run !== null && STARTABLE_RUN_STATUSES.includes(run.status);
  const relaunch = run !== null && RELAUNCH_RUN_STATUSES.includes(run.status);
  const launched = reviewers.length > 0;

  const headerChip = !run
    ? { text: 'no run', tone: '' }
    : launched
      ? { text: `${reviewers.length} reviewer${reviewers.length === 1 ? '' : 's'}`, tone: 'success' }
      : canStart
        ? { text: 'ready to launch', tone: 'warn' }
        : { text: 'preview · open a PR first', tone: 'warn' };

  return (
    <section className="stack-section review-launch-pane" aria-label="Reviewer launch">
      <header>
        <span className="section-kicker">Reviewers</span>
        <span className={`header-chip ${headerChip.tone}`}>{headerChip.text}</span>
      </header>

      {!launched ? (
        <p className="run-hint">
          {run
            ? 'Launch Reviewer A and B from the verified PR. GodMode re-checks the branch/PR/commit gate (#9) before starting — plain PR existence is not enough.'
            : 'No active run. Select an issue and open a PR before launching reviewers.'}
        </p>
      ) : (
        <ul className="reviewer-list" aria-label="Reviewer sessions">
          {reviewers.map((reviewer) => {
            const stale = isAttemptStale(reviewer, currentHeadSha);
            return (
            <li key={reviewer.paneId} className={`reviewer-row ${stale ? 'warn' : statusTone(reviewer.status)}`}>
              <div className="reviewer-row-head">
                <span className="command-agent">{reviewer.displayName}</span>
                <span className="command-tag">{reviewer.reviewerId}</span>
                <span className={`header-chip ${statusTone(reviewer.status)}`}>{STATUS_LABEL[reviewer.status]}</span>
                {stale ? (
                  <span className="header-chip warn" role="status" title="This attempt reviewed an older PR head.">
                    stale
                  </span>
                ) : null}
              </div>
              {/* Attempt identity (issue #59): cycle + target short SHA so the
                  operator can tell which PR head each attempt reviewed. */}
              {reviewer.targetHeadShaShort ? (
                <span className="reviewer-attempt-meta run-hint">
                  attempt · cycle {reviewer.cycle ?? '—'} · head {reviewer.targetHeadShaShort}
                  {stale && currentHeadShaShort ? ` · current head ${currentHeadShaShort}` : ''}
                </span>
              ) : null}
              {reviewer.artifactPath ? (
                <code className="reviewer-artifact" title={reviewer.artifactPath}>
                  {reviewer.artifactPath}
                </code>
              ) : null}
              {reviewer.commentPosted ? (
                <span className="reviewer-comment" role="status">
                  marker comment posted
                  {reviewer.commentUrl ? (
                    <>
                      {' · '}
                      <a href={reviewer.commentUrl} target="_blank" rel="noreferrer">
                        view
                      </a>
                    </>
                  ) : null}
                </span>
              ) : null}
              {reviewer.error ? (
                <p className="run-error" role="alert">
                  {reviewer.error}
                </p>
              ) : null}
              {reviewer.commentError ? (
                <p className="run-error" role="alert">
                  {reviewer.commentError}
                </p>
              ) : null}
              {/* Only a session that actually ran can be marked — a failed
                  reviewer must never be turned green via a manual marker post.
                  Mirrors canPostReviewerMarker in src/main/reviewer.ts. */}
              {POSTABLE_REVIEWER_STATUSES.includes(reviewer.status) ? (
                <div className="reviewer-row-actions">
                  <button
                    onClick={() => onPostComment(reviewer.paneId as 'reviewer_a' | 'reviewer_b')}
                    disabled={run?.prNumber === undefined}
                    title={
                      run?.prNumber === undefined
                        ? 'No PR number recorded for this run.'
                        : reviewer.commentPosted
                          ? 'Re-post the role-signed marker comment'
                          : 'Post the role-signed marker comment now'
                    }
                  >
                    {reviewer.commentPosted ? 'Re-post comment' : 'Post comment'}
                  </button>
                </div>
              ) : null}
            </li>
            );
          })}
        </ul>
      )}

      {startError ? (
        <p className="run-error" role="alert">
          {startError}
        </p>
      ) : null}

      <div className="verify-footer">
        <span className="verify-meta">
          {launched ? 'reviewer findings are each reviewer’s own PR comments' : ''}
        </span>
        <button
          className="primary-action"
          onClick={onStart}
          disabled={!canStart || starting}
          title={
            canStart
              ? 'Verify the PR (#9) and launch both reviewers'
              : 'Reviewers launch from a PR-opened or fix-pushed run.'
          }
        >
          {starting ? 'Launching…' : relaunch ? 'Relaunch reviewers' : 'Start reviewers'}
        </button>
      </div>
    </section>
  );
}
