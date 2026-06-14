import type {
  ManagedWorktree,
  RunAction,
  RunBlockerKind,
  RunSnapshot,
  RunStatus,
  WorkspaceIsolation,
} from '../../shared/types.js';

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

// Statuses from which the operator may still flip a run's isolation (mirrors
// ISOLATION_TOGGLE_STATUSES in src/main/index.ts, the authoritative guard).
const ISOLATION_TOGGLE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'issue_selected',
  'needs_spec',
  'ready_to_build',
]);

// Terminal run statuses; mirrors TERMINAL_STATUSES in src/main/run.ts. Current-run
// worktree cleanup is only offered once the run is finished.
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['closed', 'cancelled', 'karan_merged']);

type RunControlPaneProps = {
  run: RunSnapshot | null;
  /** Most recent rejected-action message, surfaced inline. */
  error: string | null;
  onDispatch: (action: RunAction, options?: RunDispatchOptions) => void;
  onClear: () => void;
  /** True when the operated project is the GodMode app repo (dogfooding nudge, #41). */
  isAppRepo: boolean;
  /** Toggle the run's workspace isolation (the dogfooding nudge's one-click enable). */
  onSetIsolation: (isolation: WorkspaceIsolation) => void;
  /** GodMode-managed worktrees for the project, for orphan cleanup (#41). */
  orphanWorktrees: ManagedWorktree[];
  /** Remove a managed worktree by path (current-run or orphaned). */
  onCleanupWorktree: (path: string) => void;
  /** Last worktree action message (cleanup refusal/success), surfaced inline. */
  worktreeMessage: string | null;
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

export function RunControlPane({
  run,
  error,
  onDispatch,
  onClear,
  isAppRepo,
  onSetIsolation,
  orphanWorktrees,
  onCleanupWorktree,
  worktreeMessage,
}: RunControlPaneProps) {
  const lastTransition = run && run.log.length > 0 ? run.log[run.log.length - 1] : null;
  const canToggleIsolation = run !== null && ISOLATION_TOGGLE_STATUSES.has(run.status);
  const showDogfoodNudge = isAppRepo && run !== null && run.isolation === 'shared' && canToggleIsolation;
  const runIsTerminal = run !== null && TERMINAL_RUN_STATUSES.has(run.status);
  // Orphans = managed worktrees not belonging to the active run (the current run's
  // worktree gets its own cleanup affordance below).
  const orphans = orphanWorktrees.filter((wt) => !wt.isCurrentRun);

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
              <div>
                <dt>Isolation</dt>
                <dd>{run.isolation === 'worktree' ? 'worktree' : 'shared checkout'}</dd>
              </div>
              <div>
                <dt>Worktree</dt>
                <dd title={run.worktree?.path ?? undefined}>
                  {run.worktree ? run.worktree.path : run.isolation === 'worktree' ? 'pending' : '—'}
                </dd>
              </div>
            </dl>

            {showDogfoodNudge ? (
              <p className="run-nudge" role="status">
                Dogfooding GodMode on its own repo — enable a per-run git worktree so the builder can’t
                disturb the running app’s checkout.{' '}
                <button className="primary-action" onClick={() => onSetIsolation('worktree')}>
                  Enable worktree for this run
                </button>
              </p>
            ) : null}

            {run.worktree ? (
              <div className="run-worktree-actions">
                <button
                  onClick={() => onCleanupWorktree(run.worktree!.path)}
                  disabled={!runIsTerminal}
                  title={
                    runIsTerminal
                      ? 'Remove the run worktree (refused if dirty or unpushed)'
                      : 'Available once the run is closed, cancelled, or merged'
                  }
                >
                  Clean up worktree
                </button>
              </div>
            ) : null}

            {worktreeMessage ? (
              <p className="run-worktree-message" role="status">
                {worktreeMessage}
              </p>
            ) : null}

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

        {orphans.length > 0 ? (
          <div className="run-orphan-worktrees" aria-label="Orphaned worktrees">
            <span className="section-kicker">Orphaned worktrees</span>
            <ul>
              {orphans.map((wt) => (
                <li key={wt.path}>
                  <span className="orphan-path" title={wt.path}>
                    {wt.branch ?? wt.path.split('/').pop()}
                  </span>
                  <button
                    onClick={() => onCleanupWorktree(wt.path)}
                    disabled={!wt.cleanliness.clean}
                    title={wt.cleanliness.clean ? 'Remove this worktree' : wt.cleanliness.reasons.join(' ')}
                  >
                    {wt.cleanliness.clean ? 'Remove' : 'Dirty'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
