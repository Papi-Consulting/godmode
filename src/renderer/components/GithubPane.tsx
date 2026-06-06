import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GithubActivePullRequest,
  GithubIssue,
  GithubPullRequest,
  GithubState,
  GithubStatus,
} from '../../shared/types.js';

const STATUS_CHIP: Record<GithubStatus, { label: string; tone: string }> = {
  ok: { label: 'live', tone: 'success' },
  gh_missing: { label: 'gh missing', tone: 'error' },
  unauthenticated: { label: 'auth required', tone: 'error' },
  no_repo: { label: 'no remote', tone: 'error' },
  error: { label: 'error', tone: 'error' },
};

// Shown when status is `ok` but the snapshot is incomplete (a sub-query failed).
const PARTIAL_CHIP = { label: 'partial', tone: 'warn' } as const;

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
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function prStateClass(pr: { state: string; isDraft: boolean }): string {
  if (pr.isDraft) return 'pr-draft';
  if (pr.state === 'MERGED') return 'pr-merged';
  if (pr.state === 'CLOSED') return 'pr-closed';
  return 'pr-open';
}

function prStateLabel(pr: { state: string; isDraft: boolean }): string {
  if (pr.isDraft && pr.state === 'OPEN') return 'draft';
  return pr.state.toLowerCase();
}

function reviewDecisionLabel(decision: string): string | null {
  switch (decision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes requested';
    case 'REVIEW_REQUIRED':
      return 'review required';
    default:
      return null;
  }
}

function IssueRow({
  issue,
  isActive,
  locked,
  onSelect,
}: {
  issue: GithubIssue;
  isActive: boolean;
  /** True when another run is live, so a new issue cannot be started. */
  locked: boolean;
  onSelect?: (issueNumber: number, issueTitle: string) => void;
}) {
  const startTitle = isActive
    ? 'Issue already selected for the active run'
    : locked
      ? 'Finish, cancel, or clear the active run before starting another issue'
      : 'Start a run for this issue';
  return (
    <li className={isActive ? 'issue-active' : undefined}>
      <span className="status-dot" />
      <span className="feed-num">#{issue.number}</span>
      <span className="feed-title" title={issue.title}>
        {issue.title}
      </span>
      <span className="feed-meta">
        {onSelect ? (
          <button
            className="issue-start"
            disabled={isActive || locked}
            title={startTitle}
            onClick={() => onSelect(issue.number, issue.title)}
          >
            {isActive ? 'selected' : 'Start run'}
          </button>
        ) : (
          relativeTime(issue.updatedAt)
        )}
      </span>
    </li>
  );
}

function PullRow({ pr }: { pr: GithubPullRequest }) {
  const decision = reviewDecisionLabel(pr.reviewDecision);
  return (
    <li>
      <span className={`status-dot ${prStateClass(pr)}`} />
      <span className="feed-num">#{pr.number}</span>
      <span className="feed-title" title={`${pr.headRefName} — ${pr.title}`}>
        {pr.title}
      </span>
      <span className="feed-meta">
        <span className={`pr-tag ${prStateClass(pr)}`}>{prStateLabel(pr)}</span>
        {decision ? <span className="pr-tag decision">{decision}</span> : null}
      </span>
    </li>
  );
}

function ActivePrCard({ pr }: { pr: GithubActivePullRequest }) {
  const decision = reviewDecisionLabel(pr.reviewDecision);
  // Bucket as a catch-all so the manual merge gate never hides a check: only
  // clearly-passing (SUCCESS/NEUTRAL/SKIPPED) and still-running (PENDING) states
  // are excluded from failing — every other terminal conclusion counts as failing.
  const pendingChecks = pr.checks.filter((c) => c.conclusion === 'PENDING');
  const passingChecks = pr.checks.filter(
    (c) => c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED',
  );
  const failingChecks = pr.checks.filter((c) => !pendingChecks.includes(c) && !passingChecks.includes(c));

  return (
    <section className="active-pr" aria-label="Active pull request for current branch">
      <header className="sub-header">
        <span>Active PR · current branch</span>
        <strong>Manual merge gate</strong>
      </header>
      <div className="active-pr-body">
        <div className="active-pr-title">
          <span className={`status-dot ${prStateClass(pr)}`} />
          <span className="feed-num">#{pr.number}</span>
          <span className="feed-title" title={pr.title}>
            {pr.title}
          </span>
          <span className={`pr-tag ${prStateClass(pr)}`}>{prStateLabel(pr)}</span>
          {decision ? <span className="pr-tag decision">{decision}</span> : null}
        </div>

        {pr.checks.length > 0 ? (
          <div className="active-pr-checks" aria-label="Checks">
            {failingChecks.length > 0 ? <span className="check-pill fail">{failingChecks.length} failing</span> : null}
            {pendingChecks.length > 0 ? <span className="check-pill pending">{pendingChecks.length} pending</span> : null}
            {passingChecks.length > 0 ? <span className="check-pill pass">{passingChecks.length} passing</span> : null}
          </div>
        ) : null}

        {pr.reviews.length > 0 ? (
          <ul className="review-list" aria-label="Reviews">
            {pr.reviews.map((review, index) => (
              <li key={`${review.author}-${review.submittedAt}-${index}`}>
                <span className={`review-state ${review.state.toLowerCase()}`}>{review.state.replace('_', ' ').toLowerCase()}</span>
                <span className="review-author">{review.author}</span>
                {review.body ? <span className="review-body">{review.body}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-line">No reviews submitted yet.</p>
        )}

        {pr.comments.length > 0 ? (
          <details className="comment-block">
            <summary>{pr.comments.length} comment{pr.comments.length === 1 ? '' : 's'}</summary>
            <ul className="comment-list">
              {pr.comments.map((comment, index) => (
                <li key={`${comment.author}-${comment.createdAt}-${index}`}>
                  <span className="review-author">{comment.author}</span>
                  <span className="review-body">{comment.body}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}

type GithubPaneProps = {
  /** Issue number currently bound to the active run, to mark it as selected. */
  activeIssueNumber?: number | null;
  /** True when a live run holds the slot, so other issues cannot be started. */
  selectionLocked?: boolean;
  /** Start a run for an open issue. Omitted when issue selection is unavailable. */
  onSelectIssue?: (issueNumber: number, issueTitle: string) => void;
};

export function GithubPane({
  activeIssueNumber = null,
  selectionLocked = false,
  onSelectIssue,
}: GithubPaneProps = {}) {
  const [state, setState] = useState<GithubState | null>(null);
  const [loading, setLoading] = useState(false);
  // Monotonic id for the most recent refresh. `godmode:github:get` snapshots the
  // selected project root at invocation time, so an older request for project A
  // can resolve after the operator switches to project B. Only the latest
  // request may apply its result, so a late A response can never repopulate the
  // pane with A's issues/PRs under the current project's label.
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!window.godmode) return;
    const seq = (requestSeq.current += 1);
    setLoading(true);
    try {
      const next = await window.godmode.getGithub();
      // A newer refresh (e.g. after a project change) superseded this one.
      if (seq !== requestSeq.current) return;
      if (next) setState(next);
    } finally {
      // Leave the loading flag to whichever request is now current.
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The GitHub snapshot belongs to the operated project. When the operated
    // project changes, clear the stale snapshot immediately so the previous
    // repo's issues/PRs never linger under the new project's label, then
    // refetch for the newly selected project.
    const off = window.godmode?.onProjectChanged(() => {
      // Invalidate any in-flight request for the previous project, clear the
      // stale snapshot, then refetch for the new operated project.
      requestSeq.current += 1;
      setState(null);
      void refresh();
    });
    return () => {
      off?.();
    };
  }, [refresh]);

  const status = state?.status ?? 'ok';
  // A partial snapshot (repo probe ok, but a sub-query failed) must not read as
  // fully `live`: show a distinct "partial" chip and surface the guidance.
  const isPartial = state ? state.status === 'ok' && state.partial : false;
  const chip = isPartial ? PARTIAL_CHIP : STATUS_CHIP[status];
  const repoLabel = state?.repo ? `${state.repo.owner}/${state.repo.name}` : null;
  const isError = state ? state.status !== 'ok' : false;
  const showGuidance = (isError || isPartial) && Boolean(state?.message);

  return (
    <section className="panel github-pane">
      <header className="panel-header">
        <div>
          <span className="section-kicker">GitHub · operated project</span>
          <strong>Issues · Pull Requests · Reviews</strong>
        </div>
        <span className={`header-chip ${chip.tone}`}>{state ? chip.label : 'connecting…'}</span>
      </header>

      <div className="github-body">
        <div className="repo-summary">
          <span className="repo-name" title={repoLabel ?? undefined}>
            {repoLabel ?? (window.godmode ? 'No repository' : 'Run inside the GodMode app')}
          </span>
          {state?.branch ? <span className="repo-branch">⎇ {state.branch}</span> : null}
        </div>

        {showGuidance ? (
          <div className="github-guidance" role="status">
            {state?.message}
          </div>
        ) : null}

        {state && state.status === 'ok' ? (
          <>
            {state.activePr ? <ActivePrCard pr={state.activePr} /> : null}

            <div className="github-columns">
              <section>
                <header className="sub-header">
                  <span>Open issues ({state.issues.length})</span>
                </header>
                {state.issues.length > 0 ? (
                  <ul className="feed-list">
                    {state.issues.map((issue) => (
                      <IssueRow
                        key={issue.number}
                        issue={issue}
                        isActive={activeIssueNumber === issue.number}
                        locked={selectionLocked}
                        onSelect={onSelectIssue}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="empty-line">No open issues.</p>
                )}
              </section>
              <section>
                <header className="sub-header">
                  <span>Pull requests ({state.pulls.length})</span>
                </header>
                {state.pulls.length > 0 ? (
                  <ul className="feed-list">
                    {state.pulls.map((pr) => (
                      <PullRow key={pr.number} pr={pr} />
                    ))}
                  </ul>
                ) : (
                  <p className="empty-line">No pull requests.</p>
                )}
              </section>
            </div>
          </>
        ) : null}
      </div>

      <footer className="queue-footer">
        <span>
          {state ? `Manual merge gate · updated ${relativeTime(state.fetchedAt) || 'now'}` : 'Loading GitHub state…'}
        </span>
        <button onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </footer>
    </section>
  );
}
