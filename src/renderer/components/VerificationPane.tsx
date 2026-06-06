import type { CommitVerification, CommitVerificationStatus, ExpectedCommitSource } from '../../shared/types.js';

/** Human labels for each verification status. Display-only; the key is canonical. */
const STATUS_LABEL: Record<CommitVerificationStatus, string> = {
  verified: 'Verified',
  missing_remote_commit: 'Missing remote commit',
  no_pr_for_branch: 'No PR for branch',
  needs_refresh: 'Needs refresh',
  checks_pending: 'Checks pending',
  checks_failed: 'Checks failed',
  needs_human: 'Needs human',
};

// Green is reserved for the confirmed-success state only (AGENTS.md / PR #12).
const SUCCESS_STATUSES: ReadonlySet<CommitVerificationStatus> = new Set<CommitVerificationStatus>(['verified']);
const ERROR_STATUSES: ReadonlySet<CommitVerificationStatus> = new Set<CommitVerificationStatus>([
  'missing_remote_commit',
  'checks_failed',
  'needs_human',
]);
// no_pr_for_branch, needs_refresh, checks_pending → warn (amber).

function statusTone(status: CommitVerificationStatus): string {
  if (SUCCESS_STATUSES.has(status)) return 'success';
  if (ERROR_STATUSES.has(status)) return 'error';
  return 'warn';
}

const SOURCE_LABEL: Record<ExpectedCommitSource, string> = {
  run_recorded: 'run-recorded',
  local_head: 'local HEAD',
  unknown: 'unresolved',
};

function relativeTime(iso: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

type VerificationPaneProps = {
  verification: CommitVerification | null;
  loading: boolean;
  /** Whether a run is bound, so results are recorded to its history. */
  hasRun: boolean;
  onVerify: () => void;
};

/**
 * Commit-verification evidence panel (issue #9). Surfaces the branch/PR/commit
 * proof that the expected builder commit is present on the remote PR — read live
 * from `gh`/`git`, never from agent self-report. The status chip, expected
 * commit + source, PR number/state/url, remote-head match, and check counts are
 * all visible so the operator can audit *why* a run is (or is not) verified
 * before any merge-ready decision consumes this state.
 */
export function VerificationPane({ verification, loading, hasRun, onVerify }: VerificationPaneProps) {
  const v = verification;
  return (
    <section className="stack-section verify-pane" aria-label="Commit verification">
      <header>
        <span className="section-kicker">Commit Verification</span>
        {v ? (
          <span className={`header-chip ${statusTone(v.status)}`}>{STATUS_LABEL[v.status]}</span>
        ) : (
          <span className="header-chip">not run</span>
        )}
      </header>

      {v ? (
        <>
          {v.partial ? (
            <p className="verify-partial" role="status">
              Partial evidence — a query did not complete. Refresh to retry.
            </p>
          ) : null}

          <dl className="run-state-grid verify-grid" aria-label="Verification evidence">
            <div>
              <dt>Branch</dt>
              <dd>{v.branch ?? '—'}</dd>
            </div>
            <div>
              <dt>Expected commit</dt>
              <dd title={v.expectedCommit ?? undefined}>
                {v.expectedCommitShort ?? '—'}
                <span className="verify-source"> · {SOURCE_LABEL[v.expectedCommitSource]}</span>
              </dd>
            </div>
            <div>
              <dt>PR</dt>
              <dd>
                {v.pr ? (
                  <a href={v.pr.url} target="_blank" rel="noreferrer" title={v.pr.url}>
                    #{v.pr.number} · {v.prState?.toLowerCase()}
                  </a>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div>
              <dt>Remote head</dt>
              <dd>
                {v.pr ? v.pr.headShaShort : '—'}
                {v.pr ? (
                  <span className={`verify-match ${v.matchesHead ? 'ok' : v.commitInList ? 'warn' : 'no'}`}>
                    {v.matchesHead ? ' · matches head' : v.commitInList ? ' · in commit list' : ' · not present'}
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>

          {v.pr && v.checks.total > 0 ? (
            <div className="active-pr-checks" aria-label="PR checks">
              {v.checks.failing > 0 ? <span className="check-pill fail">{v.checks.failing} failing</span> : null}
              {v.checks.pending > 0 ? <span className="check-pill pending">{v.checks.pending} pending</span> : null}
              {v.checks.passing > 0 ? <span className="check-pill pass">{v.checks.passing} passing</span> : null}
            </div>
          ) : null}

          <p className={`run-reason ${statusTone(v.status)}`} role="status">
            {v.message}
          </p>

          <div className="verify-footer">
            <span className="verify-meta">
              {v.mergeConfirmed ? 'merge confirmed · ' : ''}
              {hasRun ? 'recorded to run · ' : ''}
              updated {relativeTime(v.fetchedAt) || 'now'}
            </span>
            <button onClick={onVerify} disabled={loading}>
              {loading ? 'Verifying…' : 'Re-verify'}
            </button>
          </div>
        </>
      ) : (
        <div className="verify-empty">
          <p className="empty-line">No verification run yet.</p>
          <p className="run-hint">
            Verify that the expected builder commit is present on the remote PR before trusting builder output.
          </p>
          <div className="verify-footer">
            <span />
            <button onClick={onVerify} disabled={loading}>
              {loading ? 'Verifying…' : 'Verify commit'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
