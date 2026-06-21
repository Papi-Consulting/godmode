import type {
  AgentRole,
  BuilderRecoveryState,
  ClearRunResult,
  CommitVerification,
  RunAction,
  RunActionResult,
  RunBlockerKind,
  ReviewerSessionState,
  RunFindings,
  RunPromptLogEntry,
  RunSnapshot,
  RunSourceDetail,
  RunSourceType,
  RunStatus,
  RunTransitionLogEntry,
  RunVerificationLogEntry,
  RunWorktree,
  TransitionActor,
  WorkspaceIsolation,
} from '../shared/types.js';

/**
 * In-memory run state machine for the GodMode issue-to-PR workflow.
 *
 * This module is the single source of truth for what state a run is in and which
 * transitions are legal. The transition table is centralized here so neither the
 * renderer nor IPC handlers ever invent their own rules — they ask this module
 * what is allowed and dispatch named actions through {@link applyAction}.
 *
 * The core ({@link createRun}, {@link applyAction}, {@link computeAvailableActions})
 * is pure and Electron-free so it can be unit-tested directly. The mutable
 * single-run controller at the bottom holds the dashboard's current run in
 * memory for this issue; the snapshot shape is serializable so it can later be
 * persisted to `.godmode/runs/` or SQLite without reshaping.
 */

/** Default fix-loop budget when a run is started without an explicit cap. */
export const DEFAULT_MAX_CYCLES = 3;

/**
 * Working (non-terminal, non-paused) statuses. From any of these the operator can
 * interrupt the run — pause it, cancel it, flag for a human, report an agent
 * failure, or declare the cycle budget exhausted. The interrupt edges are merged
 * into the table for every status in this set so the rule lives in one place.
 */
const ACTIVE_STATUSES: readonly RunStatus[] = [
  'issue_selected',
  'needs_spec',
  'ready_to_build',
  'builder_running',
  'pr_opened',
  'reviewers_running',
  'review_synthesis',
  'builder_fixing',
  'fix_pushed',
  'reviewers_rerunning',
];

/** Interrupt edges available from every {@link ACTIVE_STATUSES} status. */
const INTERRUPT_EDGES: Partial<Record<RunAction, RunStatus>> = {
  pause: 'paused',
  cancel: 'cancelled',
  flag_needs_human: 'needs_human',
  report_agent_failed: 'agent_failed',
  exceed_max_cycles: 'max_cycles_exceeded',
};

/**
 * Explicit forward-workflow and recovery edges, before interrupt edges are
 * merged in. `resume` is deliberately absent: its target is dynamic (the status
 * the run was paused from) and is resolved in {@link resolveTarget}.
 */
const FORWARD_EDGES: Record<RunStatus, Partial<Record<RunAction, RunStatus>>> = {
  idle: { select_issue: 'issue_selected' },
  issue_selected: { require_spec: 'needs_spec', mark_ready: 'ready_to_build' },
  needs_spec: { mark_ready: 'ready_to_build' },
  ready_to_build: { start_builder: 'builder_running' },
  builder_running: { open_pr: 'pr_opened' },
  pr_opened: { start_reviewers: 'reviewers_running' },
  reviewers_running: { synthesize_reviews: 'review_synthesis' },
  review_synthesis: {
    request_fix: 'builder_fixing',
    mark_merge_ready: 'merge_ready',
    flag_needs_human: 'needs_human',
  },
  builder_fixing: { push_fix: 'fix_pushed' },
  fix_pushed: { rerun_reviewers: 'reviewers_rerunning' },
  reviewers_rerunning: { synthesize_reviews: 'review_synthesis' },
  merge_ready: {
    mark_merged: 'karan_merged',
    // Allow the operator to re-open a fix cycle or escalate after inspecting.
    request_fix: 'builder_fixing',
    flag_needs_human: 'needs_human',
    cancel: 'cancelled',
    close: 'closed',
  },
  // Human-merged: the only thing left is to file the run away.
  karan_merged: { close: 'closed' },
  // Recovery states: the operator decides how to proceed. Each carries a
  // `flag_needs_human` edge so a recorded-PR mismatch discovered on resume (issue
  // #40) can always be routed to `needs_human` with a visible reason — a resumed
  // run that was persisted in one of these states (with a `prNumber`) must never
  // continue blind because the escalation transition was illegal.
  needs_human: {
    mark_ready: 'ready_to_build',
    mark_merge_ready: 'merge_ready',
    cancel: 'cancelled',
    close: 'closed',
  },
  agent_failed: {
    mark_ready: 'ready_to_build',
    flag_needs_human: 'needs_human',
    cancel: 'cancelled',
    close: 'closed',
  },
  max_cycles_exceeded: {
    mark_merge_ready: 'merge_ready',
    flag_needs_human: 'needs_human',
    cancel: 'cancelled',
    close: 'closed',
  },
  // `resume` is handled dynamically; `flag_needs_human` lets resume-revalidation
  // escalate a paused-but-mismatched run, and cancel is the static escape.
  paused: { flag_needs_human: 'needs_human', cancel: 'cancelled' },
  cancelled: { close: 'closed' },
  closed: {},
};

/**
 * The resolved transition table: forward/recovery edges plus interrupt edges for
 * every active status. Built once at module load so the guard is a single lookup.
 */
export const TRANSITION_TABLE: Record<RunStatus, Partial<Record<RunAction, RunStatus>>> = (() => {
  const table = {} as Record<RunStatus, Partial<Record<RunAction, RunStatus>>>;
  for (const status of Object.keys(FORWARD_EDGES) as RunStatus[]) {
    const merged: Partial<Record<RunAction, RunStatus>> = { ...FORWARD_EDGES[status] };
    if (ACTIVE_STATUSES.includes(status)) {
      for (const [action, to] of Object.entries(INTERRUPT_EDGES) as [RunAction, RunStatus][]) {
        // Explicit forward edges win, but interrupt targets are identical anyway.
        if (merged[action] === undefined) merged[action] = to;
      }
    }
    table[status] = merged;
  }
  return table;
})();

/** Actions that carry an operator/system reason (and may set a blocker). */
const REASON_BEARING_ACTIONS: ReadonlySet<RunAction> = new Set<RunAction>([
  'pause',
  'cancel',
  'flag_needs_human',
  'report_agent_failed',
  'exceed_max_cycles',
  'close',
]);

/**
 * The status a transition would move to, or undefined if the action is illegal
 * from the run's current status. `resume` is dynamic: it returns to whatever
 * status the run was paused from.
 */
function resolveTarget(run: RunSnapshot, action: RunAction): RunStatus | undefined {
  if (run.status === 'paused' && action === 'resume') return run.resumeStatus;
  return TRANSITION_TABLE[run.status][action];
}

/**
 * The actions valid from a run's current state. Renderers render exactly these
 * as operator controls. `resume` is surfaced only while paused (and only when a
 * resume target was recorded). `request_fix` is dropped once the cycle budget is
 * exhausted, so the loop deterministically stops at `maxCycles`.
 */
export function computeAvailableActions(run: RunSnapshot): RunAction[] {
  let base = Object.keys(TRANSITION_TABLE[run.status]) as RunAction[];
  if (run.cycle >= run.maxCycles) base = base.filter((action) => action !== 'request_fix');
  if (run.status === 'paused' && run.resumeStatus) return ['resume', ...base];
  return base;
}

/** Optional context supplied with a transition. */
export type ApplyActionOptions = {
  /** Free-text reason recorded on the run and in the log (interrupts/endpoints). */
  reason?: string;
  /** Blocker condition, only meaningful with `flag_needs_human`. */
  blocker?: RunBlockerKind;
  /** Working branch to record (e.g. when the builder pushes). */
  branch?: string;
  /** PR number to record (e.g. on `open_pr`). */
  prNumber?: number;
  /**
   * Expected commit SHA to record from the builder phase (e.g. on `open_pr` or
   * `push_fix`). Becomes the run-recorded commit the verification gate (#9)
   * checks against the remote PR, in place of the local-HEAD fallback.
   */
  expectedCommit?: string;
  /**
   * Who initiated this transition (issue #39). Defaults to `operator`; the
   * review/fix loop controller passes `loop` so every automatic transition is
   * attributable in the log. Audit-only — it never affects transition legality.
   */
  actor?: TransitionActor;
  /** Override the timestamp; primarily for deterministic tests. */
  now?: string;
};

/**
 * Apply an action to a run, returning a new snapshot on success. Pure: the input
 * snapshot is never mutated. An illegal transition is rejected with a typed error
 * and the unchanged snapshot, so callers can surface *why* an action was refused
 * without any state change.
 */
export function applyAction(
  run: RunSnapshot,
  action: RunAction,
  options: ApplyActionOptions = {},
): RunActionResult {
  const to = resolveTarget(run, action);
  if (to === undefined) {
    return {
      ok: false,
      code: 'invalid_transition',
      error: `Action "${action}" is not allowed from status "${run.status}".`,
      run,
    };
  }

  // Numeric budget guard layered on top of the structural table: a fix cycle is
  // legal only while the cycle budget has room. At the cap, `request_fix` is also
  // dropped from `availableActions`, so the loop stops deterministically and the
  // operator/orchestrator routes to `max_cycles_exceeded` or `merge_ready`.
  if (action === 'request_fix' && run.cycle >= run.maxCycles) {
    return {
      ok: false,
      code: 'invalid_transition',
      error: `Fix-cycle budget reached (cycle ${run.cycle} of ${run.maxCycles}); cannot request another fix. Route to max_cycles_exceeded or mark merge-ready.`,
      run,
    };
  }

  const now = options.now ?? new Date().toISOString();
  const next: RunSnapshot = { ...run, status: to, updatedAt: now, log: [...run.log] };

  // Branch/PR/commit enrichment is independent of the action: record whatever
  // was provided so the snapshot reflects the latest known coordinates.
  if (options.branch !== undefined) next.branch = options.branch;
  if (options.prNumber !== undefined) next.prNumber = options.prNumber;
  if (options.expectedCommit !== undefined) next.expectedCommit = options.expectedCommit;

  // Pause/resume bookkeeping: remember where we paused from, and clear it on the
  // way out (whether via resume or cancel).
  if (action === 'pause') next.resumeStatus = run.status;
  else if (run.status === 'paused') next.resumeStatus = undefined;

  // A fix cycle counts as a new loop iteration.
  if (action === 'request_fix') next.cycle = run.cycle + 1;

  // Reason/blocker only persist on interrupt/endpoint actions; clean forward
  // progress clears any stale blocker so the UI never shows an outdated reason.
  if (REASON_BEARING_ACTIONS.has(action)) {
    next.reason = options.reason;
    next.blocker = action === 'flag_needs_human' ? options.blocker : undefined;
  } else {
    next.reason = undefined;
    next.blocker = undefined;
  }

  // The transition log records the reason supplied for *this* transition, even
  // for forward actions whose reason is not sticky on the snapshot (e.g. the
  // evidence-bound `open_pr` naming the discovered PR, issue #38). The sticky
  // `run.reason` banner stays governed by REASON_BEARING_ACTIONS so clean forward
  // progress never leaves a stale warn/blocker reason on the run.
  const entry: RunTransitionLogEntry = {
    at: now,
    from: run.status,
    to,
    action,
    reason: options.reason ?? next.reason,
    actor: options.actor ?? 'operator',
  };
  next.log.push(entry);
  next.availableActions = computeAvailableActions(next);

  return { ok: true, run: next };
}

/** Inputs for creating a fresh run. */
export type CreateRunInput = {
  sourceType?: RunSourceType;
  sourceId?: string;
  issueNumber?: number;
  issueTitle?: string;
  /** Selected-source detail (issue body/comments/URL, or manual task text). */
  sourceDetail?: RunSourceDetail;
  maxCycles?: number;
  /**
   * Effective workspace isolation for the run (issue #41). Resolved from config by
   * the caller (run.ts is Electron/config-free); defaults to `shared`.
   */
  isolation?: WorkspaceIsolation;
  /** Provide a stable id (and timestamp) for deterministic tests. */
  id?: string;
  now?: string;
};

let runIdCounter = 0;
let manualTaskCounter = 0;

function generateRunId(issueNumber: number | undefined): string {
  runIdCounter += 1;
  const stamp = Date.now().toString(36);
  const source = issueNumber !== undefined ? `issue-${issueNumber}` : 'task';
  return `run-${stamp}-${source}-${runIdCounter}`;
}

/** Stable, human-readable id for a manual task (no GitHub issue number). */
function generateManualTaskId(): string {
  manualTaskCounter += 1;
  return `task-${Date.now().toString(36)}-${manualTaskCounter}`;
}

/**
 * Create a fresh run in `idle`. The run is not yet attached to an issue — apply
 * `select_issue` (see {@link selectIssueRun}) to move it to `issue_selected`.
 */
export function createRun(input: CreateRunInput = {}): RunSnapshot {
  const now = input.now ?? new Date().toISOString();
  const issueNumber = input.issueNumber;
  const run: RunSnapshot = {
    id: input.id ?? generateRunId(issueNumber),
    sourceType: input.sourceType ?? 'github_issue',
    sourceId: input.sourceId ?? (issueNumber !== undefined ? String(issueNumber) : 'manual'),
    issueNumber,
    issueTitle: input.issueTitle,
    sourceDetail: input.sourceDetail,
    status: 'idle',
    cycle: 1,
    maxCycles: input.maxCycles ?? DEFAULT_MAX_CYCLES,
    isolation: input.isolation ?? 'shared',
    availableActions: [],
    log: [],
    prompts: [],
    verifications: [],
    createdAt: now,
    updatedAt: now,
  };
  run.availableActions = computeAvailableActions(run);
  return run;
}

// --- Mutable single-run controller -------------------------------------------

let currentRun: RunSnapshot | null = null;

/**
 * Write-through persistence hook (issue #40). The Electron/index wiring installs
 * a hook that persists every accepted mutation to the operated project's run
 * store; run.ts stays Electron/storage-free and just calls back through this
 * opaque callback. Fired only with a non-null snapshot — clearing the in-memory
 * run (e.g. on project switch) deliberately does NOT touch the persisted record,
 * so the run survives to be offered for resume when the project is reselected.
 */
export type RunPersistHook = (run: RunSnapshot) => void;

let persistHook: RunPersistHook | null = null;

/** Install (or clear with null) the write-through persistence hook (issue #40). */
export function setRunPersistHook(hook: RunPersistHook | null): void {
  persistHook = hook;
}

/**
 * The single funnel for replacing the current run. Every accepted mutation routes
 * its new snapshot through here so persistence can never be forgotten by one code
 * path — a rejected transition never calls this (it returns the unchanged run),
 * so illegal/rejected transitions are never persisted (issue #40 acceptance).
 */
function setCurrentRun(run: RunSnapshot): void {
  currentRun = run;
  persistHook?.(run);
}

/**
 * Finished lifecycle states. A run in one of these is "done" — its log is final,
 * so it can be replaced by selecting a new issue. Any other (non-terminal) run is
 * still live and must be explicitly cleared/closed before a new issue is started.
 */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['closed', 'cancelled', 'karan_merged']);

/** Whether a run status is a finished lifecycle endpoint (issue #41 cleanup gate). */
export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** The current run snapshot, or null when no run has been started/cleared. */
export function getCurrentRun(): RunSnapshot | null {
  return currentRun;
}

/**
 * Start a run for an issue: create it and immediately transition to
 * `issue_selected`. The v1 dashboard tracks one run at a time, but a still-live
 * run is never silently discarded — selecting a new issue while a non-terminal
 * run exists is rejected so its in-memory log/evidence is preserved until the
 * operator closes, cancels, or clears it. Returns the resulting action result so
 * callers can surface errors uniformly with {@link dispatchRunAction}.
 */
export function selectIssueRun(input: CreateRunInput): RunActionResult {
  if (currentRun && !TERMINAL_STATUSES.has(currentRun.status)) {
    const which = currentRun.issueNumber !== undefined ? `issue #${currentRun.issueNumber}` : currentRun.sourceId;
    return {
      ok: false,
      code: 'invalid_transition',
      error: `A run for ${which} is still active (${currentRun.status}). Close, cancel, or clear it before starting another issue.`,
      run: currentRun,
    };
  }
  const created = createRun(input);
  const result = applyAction(created, 'select_issue', { now: created.createdAt });
  if (result.ok) setCurrentRun(result.run);
  return result;
}

/** Inputs for starting a manual (non-GitHub) task run. */
export type SelectManualTaskInput = {
  /** Short task title (display + handoff source label). */
  title: string;
  /** Free-text task description, grounded into the handoff prompt. */
  text: string;
  maxCycles?: number;
  /** Effective workspace isolation for the run (issue #41). Defaults to `shared`. */
  isolation?: WorkspaceIsolation;
  /** Provide a stable id (and timestamp) for deterministic tests. */
  id?: string;
  now?: string;
};

/**
 * Start a run for an operator-entered manual task. Mirrors {@link selectIssueRun}
 * (same live-run guard) but binds a `manual_task` source: there is no GitHub
 * issue number, so the resulting handoff is deliberately not directly sendable
 * and the operator routes a vague task to `needs_spec` through the normal state
 * machine instead of sending it blindly.
 */
export function selectManualTaskRun(input: SelectManualTaskInput): RunActionResult {
  if (currentRun && !TERMINAL_STATUSES.has(currentRun.status)) {
    const which = currentRun.issueNumber !== undefined ? `issue #${currentRun.issueNumber}` : currentRun.sourceId;
    return {
      ok: false,
      code: 'invalid_transition',
      error: `A run for ${which} is still active (${currentRun.status}). Close, cancel, or clear it before starting another task.`,
      run: currentRun,
    };
  }
  const created = createRun({
    sourceType: 'manual_task',
    sourceId: input.id ?? generateManualTaskId(),
    issueTitle: input.title,
    sourceDetail: { body: input.text },
    maxCycles: input.maxCycles,
    isolation: input.isolation,
    id: input.id,
    now: input.now,
  });
  const result = applyAction(created, 'select_issue', { now: created.createdAt });
  if (result.ok) setCurrentRun(result.run);
  return result;
}

/**
 * Dispatch an action against the current run. Returns a typed rejection when
 * there is no run or the transition is illegal; on illegal transitions the
 * current run is left untouched (no mutation).
 */
export function dispatchRunAction(action: RunAction, options: ApplyActionOptions = {}): RunActionResult {
  if (!currentRun) {
    return { ok: false, code: 'no_run', error: 'There is no active run to act on.', run: null };
  }
  const result = applyAction(currentRun, action, options);
  if (result.ok) setCurrentRun(result.run);
  return result;
}

/** Details of a prompt sent to an agent, recorded for audit on the run. */
export type RecordPromptInput = {
  role: AgentRole;
  /** Single-line preview of the prompt sent. */
  digest: string;
  /** Character length of the full prompt sent. */
  promptChars: number;
  now?: string;
};

/**
 * Append a prompt-sent entry to a run, returning a new snapshot (the input is
 * never mutated, matching {@link applyAction}). The full prompt is not retained —
 * `digest`/`promptChars` are enough for audit without bloating the snapshot.
 */
export function recordPromptSent(run: RunSnapshot, input: RecordPromptInput): RunSnapshot {
  const at = input.now ?? new Date().toISOString();
  const entry: RunPromptLogEntry = {
    at,
    role: input.role,
    sourceType: run.sourceType,
    sourceId: run.sourceId,
    digest: input.digest,
    promptChars: input.promptChars,
  };
  return { ...run, prompts: [...run.prompts, entry], updatedAt: at };
}

/**
 * Record a prompt send against the current run (controller wrapper). Returns the
 * updated snapshot, or null when there is no active run.
 */
export function recordCurrentRunPrompt(input: RecordPromptInput): RunSnapshot | null {
  if (!currentRun) return null;
  setCurrentRun(recordPromptSent(currentRun, input));
  return currentRun;
}

/**
 * Append a commit-verification result to a run's history, returning a new
 * snapshot (the input is never mutated, matching {@link applyAction}). This is
 * the evidence-layer audit trail (#9): the derived status, the expected commit
 * and where it came from, and the matched PR are recorded with a timestamp so a
 * later merge-ready decision consumes recorded evidence rather than re-trusting a
 * transient query. The full {@link CommitVerification} is not stored — the
 * single-line summary plus key fields are enough for audit without bloat.
 */
export function recordVerification(run: RunSnapshot, verification: CommitVerification): RunSnapshot {
  const entry: RunVerificationLogEntry = {
    at: verification.fetchedAt,
    status: verification.status,
    expectedCommit: verification.expectedCommit,
    source: verification.expectedCommitSource,
    prNumber: verification.pr?.number,
    prState: verification.pr?.state,
    // Issue #61: record the observed PR head this result was computed against and
    // whether it corresponds to the current head, so a later pass can detect head
    // drift and a merge-ready decision only consumes current-head evidence.
    verifiedHeadSha: verification.pr?.headSha,
    currentHeadVerified: verification.currentHeadVerified,
    summary: verification.message,
  };
  return { ...run, verifications: [...run.verifications, entry], updatedAt: verification.fetchedAt };
}

/**
 * Record a commit-verification result against the current run (controller
 * wrapper). Returns the updated snapshot, or null when there is no active run.
 */
export function recordCurrentRunVerification(verification: CommitVerification): RunSnapshot | null {
  if (!currentRun) return null;
  setCurrentRun(recordVerification(currentRun, verification));
  return currentRun;
}

/**
 * Replace a run's tracked reviewer sessions, returning a new snapshot (the input
 * is never mutated, matching {@link applyAction}). Called when `start_reviewers`
 * launches the configured reviewers (issue #10): each descriptor is stamped with
 * the supplied timestamp so the dashboard can show independent reviewer state.
 */
export function setReviewerSessions(
  run: RunSnapshot,
  sessions: Omit<ReviewerSessionState, 'updatedAt'>[],
  now?: string,
): RunSnapshot {
  const at = now ?? new Date().toISOString();
  const reviewers = sessions.map((session) => ({ ...session, updatedAt: at }));
  return { ...run, reviewers, updatedAt: at };
}

/** Fields of a tracked reviewer session that a lifecycle update may patch. */
export type ReviewerSessionPatch = Partial<Omit<ReviewerSessionState, 'reviewerId' | 'paneId' | 'updatedAt'>>;

/**
 * Patch one reviewer session (matched by pane) on a run, returning a new snapshot
 * (the input is never mutated). Used as the reviewer lifecycle advances —
 * running → completed → comment_posted, or failed — so a later state is recorded
 * without losing the rest of the session's tracked detail. A pane with no tracked
 * session is left untouched.
 */
export function updateReviewerSession(
  run: RunSnapshot,
  paneId: AgentRole,
  patch: ReviewerSessionPatch,
  now?: string,
): RunSnapshot {
  if (!run.reviewers) return run;
  const at = now ?? new Date().toISOString();
  const reviewers = run.reviewers.map((session) =>
    session.paneId === paneId ? { ...session, ...patch, updatedAt: at } : session,
  );
  return { ...run, reviewers, updatedAt: at };
}

/**
 * Set the current run's reviewer sessions (controller wrapper). Returns the
 * updated snapshot, or null when there is no active run.
 */
export function setCurrentRunReviewers(
  sessions: Omit<ReviewerSessionState, 'updatedAt'>[],
  now?: string,
): RunSnapshot | null {
  if (!currentRun) return null;
  setCurrentRun(setReviewerSessions(currentRun, sessions, now));
  return currentRun;
}

/**
 * Patch one reviewer session on the current run (controller wrapper). Returns the
 * updated snapshot, or null when there is no active run.
 */
export function updateCurrentRunReviewer(
  paneId: AgentRole,
  patch: ReviewerSessionPatch,
  now?: string,
): RunSnapshot | null {
  if (!currentRun) return null;
  setCurrentRun(updateReviewerSession(currentRun, paneId, patch, now));
  return currentRun;
}

/**
 * Attach the parsed reviewer findings + merge-gate doc to a run, returning a new
 * snapshot (the input is never mutated). Recorded by the review-synthesis step
 * (issue #11) so the dashboard renders the latest blockers/merge gate; the same
 * doc is mirrored to `.godmode/runs/<run-id>/findings.json`.
 */
export function setRunFindings(run: RunSnapshot, findings: RunFindings, now?: string): RunSnapshot {
  const at = now ?? findings.fetchedAt ?? new Date().toISOString();
  return { ...run, findings, updatedAt: at };
}

/**
 * Set the current run's parsed findings (controller wrapper). Returns the updated
 * snapshot, or null when there is no active run.
 */
export function setCurrentRunFindings(findings: RunFindings, now?: string): RunSnapshot | null {
  if (!currentRun) return null;
  setCurrentRun(setRunFindings(currentRun, findings, now));
  return currentRun;
}

/**
 * Set a run's effective workspace isolation, returning a new snapshot (the input
 * is never mutated). Used by the dogfooding nudge to flip a run to `worktree`
 * before the builder starts. Switching to `shared` does not remove an
 * already-created worktree — the caller decides cleanup separately.
 */
export function setRunIsolation(run: RunSnapshot, isolation: WorkspaceIsolation, now?: string): RunSnapshot {
  const at = now ?? new Date().toISOString();
  return { ...run, isolation, updatedAt: at };
}

/** Set the current run's isolation (controller wrapper). Null when no active run. */
export function setCurrentRunIsolation(isolation: WorkspaceIsolation, now?: string): RunSnapshot | null {
  if (!currentRun) return null;
  setCurrentRun(setRunIsolation(currentRun, isolation, now));
  return currentRun;
}

/**
 * Attach (or clear) the run-scoped worktree, returning a new snapshot (the input
 * is never mutated). When a worktree is set, its branch is recorded as the run's
 * working branch so verification/reviewers scope to it; clearing it (after
 * cleanup) leaves the recorded branch in place for audit.
 */
export function setRunWorktree(run: RunSnapshot, worktree: RunWorktree | null, now?: string): RunSnapshot {
  const at = now ?? new Date().toISOString();
  if (!worktree) {
    const next = { ...run, updatedAt: at };
    delete next.worktree;
    return next;
  }
  return { ...run, worktree, branch: worktree.branch, updatedAt: at };
}

/**
 * Set/clear the current run's worktree (controller wrapper). Null when no run.
 *
 * Identity guard (reviewer-a A-2): worktree preparation awaits the event loop, so by
 * the time the caller records the prepared worktree the operator may have cancelled,
 * replaced, or switched away from the run it was prepared for. `currentRun` is a global
 * pointer, so an unconditional write would attach THIS run's worktree/branch metadata to
 * whatever unrelated run is now current and persist/emit that corrupted snapshot. When
 * `expectedRunId` is supplied this refuses (returns null, mutates nothing) unless the
 * current run is still that exact run.
 */
export function setCurrentRunWorktree(
  worktree: RunWorktree | null,
  opts: { expectedRunId?: string; now?: string } = {},
): RunSnapshot | null {
  if (!currentRun) return null;
  if (opts.expectedRunId !== undefined && currentRun.id !== opts.expectedRunId) return null;
  setCurrentRun(setRunWorktree(currentRun, worktree, opts.now));
  return currentRun;
}

/**
 * Decide whether the operator's "Clear run" request is allowed (issue #41).
 * Clearing drops the run record, so it must not strand the run's worktree or a
 * live builder session with nothing tracking them: it is refused while the run is
 * still active (non-terminal), still owns a worktree (clean it up first), or has a
 * live builder PTY (stop it first). Pure — the caller supplies the live-session
 * flag and performs the actual {@link clearRun} only when this returns `ok`.
 */
export function evaluateClearRun(
  run: RunSnapshot | null,
  hasLiveBuilderSession: boolean,
): ClearRunResult {
  if (run) {
    if (!isTerminalStatus(run.status)) {
      return {
        ok: false,
        run,
        error: `The run is still active (${run.status}). Cancel or close it before clearing, so its worktree and sessions are cleaned up first.`,
      };
    }
    if (run.worktree) {
      return {
        ok: false,
        run,
        error: 'This run still has a git worktree. Clean it up via the worktree controls before clearing the run.',
      };
    }
    if (hasLiveBuilderSession) {
      return {
        ok: false,
        run,
        error: 'The builder session is still running. Stop it before clearing the run.',
      };
    }
  }
  return { ok: true, run: null };
}

/**
 * Decide whether a `builder_running` run's live builder session has gone stale
 * (issue #55). The builder PTY lives only in main's process memory, so a reset or
 * an app restart (resume, issue #40) can leave a run persisted as `builder_running`
 * while no builder process is actually running. Pure — the caller supplies the
 * live-session flag (`hasPtySession('builder')`) — so it is unit-testable without a
 * PTY and the renderer renders an explicit recovery path instead of a generic
 * `blocked` label.
 *
 * `stale` is true exactly when the run is `builder_running` and the builder PTY is
 * gone; any other status, or a live builder, is not stale. The `message` names the
 * recovery options (relaunch + re-deliver, or mark the agent failed) and adapts to
 * whether a PR is already bound, since a builder that died before opening a PR is
 * still worth a read-only discovery pass.
 */
export function evaluateBuilderRecovery(
  run: RunSnapshot | null,
  hasLiveBuilderSession: boolean,
): BuilderRecoveryState {
  const hasBoundPr = run?.prNumber !== undefined;
  if (!run || run.status !== 'builder_running' || hasLiveBuilderSession) {
    return { stale: false, hasBoundPr };
  }
  const message = hasBoundPr
    ? `Builder session is no longer live. PR #${run.prNumber} is bound — verify it, relaunch the builder ` +
      'to re-deliver the handoff, or mark the agent failed.'
    : 'Builder session is no longer live, and no PR is bound yet. Relaunch the builder to re-deliver the ' +
      'handoff, check for a PR it may have opened, or mark the agent failed.';
  return { stale: true, hasBoundPr, message };
}

/**
 * Reviewer session statuses that represent a *live* session — one that cannot
 * survive an app restart. On resume these are marked `failed` with a restart
 * reason; already-terminal sessions (`completed`/`comment_posted`/`failed`) are
 * left intact so their captured outcome is preserved (issue #40).
 */
const LIVE_REVIEWER_STATUSES: ReadonlySet<ReviewerSessionState['status']> = new Set([
  'idle',
  'launching',
  'running',
]);

/** Visible reason stamped on a reviewer session that did not survive a restart. */
export const RESUMED_SESSION_DEAD_REASON =
  'Reviewer session did not survive the app restart; relaunch reviewers or synthesize from the captured artifacts.';

/**
 * Mark every previously-live PTY/reviewer session on a snapshot as dead (issue
 * #40). Live-session state (terminal PTYs, running reviewers) cannot be restored
 * across a restart, so a resumed run must never wait on a session that no longer
 * exists. Pure: returns a new snapshot; sessions already in a terminal state are
 * left untouched so their captured output/markers remain valid evidence.
 */
export function markRunSessionsDead(run: RunSnapshot, now?: string): RunSnapshot {
  if (!run.reviewers || run.reviewers.length === 0) return run;
  const at = now ?? new Date().toISOString();
  let changed = false;
  const reviewers = run.reviewers.map((session) => {
    if (!LIVE_REVIEWER_STATUSES.has(session.status)) return session;
    changed = true;
    return {
      ...session,
      status: 'failed' as ReviewerSessionState['status'],
      error: session.error ?? RESUMED_SESSION_DEAD_REASON,
      pid: undefined,
      updatedAt: at,
    };
  });
  return changed ? { ...run, reviewers, updatedAt: at } : run;
}

/**
 * Adopt a persisted snapshot as the current run on resume (issue #40). Restores
 * it through the normal model: previously-live sessions are marked dead, and
 * `availableActions` is recomputed from the transition table so the operator sees
 * exactly what is legal/relaunchable from the restored state — never a stale
 * action set captured before the restart. Persists the restored snapshot through
 * the write-through hook so the dead-session marking is durable. The transition
 * log is carried forward intact. Returns the adopted snapshot.
 */
export function adoptResumedRun(run: RunSnapshot, now?: string): RunSnapshot {
  const revived = markRunSessionsDead(run, now);
  const restored: RunSnapshot = { ...revived, availableActions: computeAvailableActions(revived) };
  setCurrentRun(restored);
  return restored;
}

/**
 * Discard the current run entirely (the "cleared" outcome): the dashboard returns
 * to a no-run state. Distinct from the `close` action, which records a terminal
 * `closed` status while keeping the run and its log visible. The operator-facing
 * guard ({@link evaluateClearRun}) lives in the IPC handler; this low-level reset
 * is also used internally (e.g. on project switch) and is unconditional.
 *
 * This intentionally does NOT touch the persisted store (issue #40): clearing the
 * in-memory run on a project switch must leave the persisted record so the run is
 * still offered for resume when the project is reselected. Permanent removal from
 * the resume offer is the explicit Discard/archive path in `store.ts`.
 */
export function clearRun(): void {
  currentRun = null;
}
