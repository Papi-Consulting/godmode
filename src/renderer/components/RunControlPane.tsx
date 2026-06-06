import type { RunAction, RunBlockerKind, RunSnapshot, RunStatus } from '../../shared/types.js';

/** Human labels for each run status. Display-only; the status key is canonical. */
export const STATUS_LABEL: Record<RunStatus, string> = {
  idle: 'Idle',
  issue_selected: 'Issue selected',
  needs_spec: 'Needs spec',
  ready_to_build: 'Ready to build',
  builder_running: 'Builder running',
  pr_opened: 'PR opened',
  reviewers_running: 'Reviewers running',
  review_synthesis: 'Review synthesis',
  builder_fixing: 'Builder fixing',
  fix_pushed: 'Fix pushed',
  reviewers_rerunning: 'Reviewers rerunning',
  merge_ready: 'Merge ready',
  karan_merged: 'Merged',
  closed: 'Closed',
  paused: 'Paused',
  cancelled: 'Cancelled',
  needs_human: 'Needs human',
  agent_failed: 'Agent failed',
  max_cycles_exceeded: 'Max cycles exceeded',
};

/** Human labels for each operator action shown on a control button. */
const ACTION_LABEL: Record<RunAction, string> = {
  select_issue: 'Select issue',
  require_spec: 'Send to spec',
  mark_ready: 'Mark ready to build',
  start_builder: 'Start builder',
  open_pr: 'PR opened',
  start_reviewers: 'Start reviewers',
  synthesize_reviews: 'Synthesize reviews',
  request_fix: 'Request fix',
  push_fix: 'Fix pushed',
  rerun_reviewers: 'Rerun reviewers',
  mark_merge_ready: 'Mark merge-ready',
  mark_merged: 'Mark merged',
  pause: 'Pause',
  resume: 'Resume',
  cancel: 'Cancel run',
  flag_needs_human: 'Flag for human',
  report_agent_failed: 'Agent failed',
  exceed_max_cycles: 'Max cycles hit',
  close: 'Close run',
};

const BLOCKER_LABEL: Record<RunBlockerKind, string> = {
  pr_conflicted: 'PR conflicted',
  tests_failed: 'Tests failed',
  checks_unstable: 'Checks unstable',
  harness_missing: 'Harness missing',
  repo_dirty: 'Repo dirty',
};

// Green is reserved for positive status only (AGENTS.md / PR #12 direction).
const POSITIVE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['merge_ready', 'karan_merged']);
const WARN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'needs_spec',
  'needs_human',
  'paused',
  'max_cycles_exceeded',
]);
const ERROR_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['agent_failed', 'cancelled']);

function statusTone(status: RunStatus): string {
  if (POSITIVE_STATUSES.has(status)) return 'success';
  if (ERROR_STATUSES.has(status)) return 'error';
  if (WARN_STATUSES.has(status)) return 'warn';
  return '';
}

// Positive gates render as primary; destructive/failure actions as danger.
const PRIMARY_ACTIONS: ReadonlySet<RunAction> = new Set<RunAction>(['mark_merge_ready', 'mark_merged', 'resume']);
const DANGER_ACTIONS: ReadonlySet<RunAction> = new Set<RunAction>([
  'cancel',
  'close',
  'report_agent_failed',
  'exceed_max_cycles',
]);

function actionClass(action: RunAction): string {
  if (PRIMARY_ACTIONS.has(action)) return 'primary-action';
  if (DANGER_ACTIONS.has(action)) return 'danger-action';
  return '';
}

export type RunDispatchOptions = {
  reason?: string;
  blocker?: RunBlockerKind;
  branch?: string;
  prNumber?: number;
};

type RunControlPaneProps = {
  run: RunSnapshot | null;
  /** Most recent rejected-action message, surfaced inline. */
  error: string | null;
  onDispatch: (action: RunAction, options?: RunDispatchOptions) => void;
  onClear: () => void;
};

function dispatchOptionsFor(action: RunAction): RunDispatchOptions | undefined {
  // The dashboard supplies a minimal, auditable reason for interrupt actions so
  // the transition log reads meaningfully; richer reasons/blockers arrive from
  // the orchestrator (later issues) over the same typed channel.
  switch (action) {
    case 'flag_needs_human':
      return { reason: 'Flagged for human review from the dashboard.' };
    case 'pause':
      return { reason: 'Paused by operator.' };
    case 'cancel':
      return { reason: 'Cancelled by operator.' };
    default:
      return undefined;
  }
}

export function RunControlPane({ run, error, onDispatch, onClear }: RunControlPaneProps) {
  const lastTransition = run && run.log.length > 0 ? run.log[run.log.length - 1] : null;

  return (
    <section className="stack-section run-control" aria-label="Run control">
      <header>
        <span className="section-kicker">Run Control</span>
        {run ? (
          <span className={`header-chip ${statusTone(run.status)}`}>{STATUS_LABEL[run.status]}</span>
        ) : (
          <span className="header-chip">no run</span>
        )}
      </header>

      <div className="run-body">
        {run ? (
          <>
            <dl className="run-state-grid" aria-label="Current run state">
              <div>
                <dt>Issue</dt>
                <dd title={run.issueTitle ?? undefined}>
                  {run.issueNumber !== undefined ? `#${run.issueNumber}` : run.sourceId}
                  {run.issueTitle ? ` · ${run.issueTitle}` : ''}
                </dd>
              </div>
              <div>
                <dt>Cycle</dt>
                <dd>
                  {run.cycle}/{run.maxCycles}
                </dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd>{run.branch ?? '—'}</dd>
              </div>
              <div>
                <dt>PR</dt>
                <dd>{run.prNumber !== undefined ? `#${run.prNumber}` : '—'}</dd>
              </div>
            </dl>

            {run.reason || run.blocker ? (
              <p className={`run-reason ${statusTone(run.status) || 'warn'}`} role="status">
                {run.blocker ? <span className="run-blocker">{BLOCKER_LABEL[run.blocker]}</span> : null}
                {run.reason}
              </p>
            ) : null}

            {lastTransition ? (
              <p className="run-last-transition">
                <span className="section-kicker">Last transition</span>
                {STATUS_LABEL[lastTransition.from]} → {STATUS_LABEL[lastTransition.to]}
                <span className="run-action-name"> · {ACTION_LABEL[lastTransition.action]}</span>
              </p>
            ) : null}

            {error ? (
              <p className="run-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="run-actions" aria-label="Available run actions">
              {run.availableActions.length > 0 ? (
                run.availableActions.map((action) => (
                  <button
                    key={action}
                    className={actionClass(action)}
                    onClick={() => onDispatch(action, dispatchOptionsFor(action))}
                  >
                    {ACTION_LABEL[action]}
                  </button>
                ))
              ) : (
                <span className="empty-line">No actions available from this state.</span>
              )}
            </div>

            <div className="run-footer-actions">
              <button onClick={onClear}>Clear run</button>
            </div>
          </>
        ) : (
          <div className="run-empty">
            <p className="empty-line">No active run.</p>
            <p className="run-hint">Select an open issue from the GitHub pane to start a run.</p>
            {error ? (
              <p className="run-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
