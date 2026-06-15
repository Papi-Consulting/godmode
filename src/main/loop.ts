import type {
  CommitVerification,
  LoopMode,
  LoopModeResult,
  LoopState,
  LoopWaitReason,
  RunAction,
  RunSnapshot,
  RunStatus,
  TransitionActor,
} from '../shared/types.js';
import { commitMatches } from './verify.js';

/**
 * Automatic review/fix loop controller (issue #39).
 *
 * This is the deterministic loop controller that, once a run has a verified PR,
 * chains reviewer launch → synthesis → fix handoff → re-verification → re-review
 * automatically so the operator supervises the loop instead of clicking every
 * stage. It is **plain code reacting to observable events** — run transitions,
 * reviewer session exits, and live verification results — never a head-agent
 * prompt and never an interpreter of agent prose (it consumes the same
 * `findings.ts`/state-machine outputs the operator-triggered handlers do).
 *
 * Two halves, mirroring the rest of the codebase:
 *  1. A **pure decision core** ({@link decideLoopAction}, {@link reviewersTerminal},
 *     {@link detectFixLanded}, {@link isLoopStopStatus}) that is Electron-free and
 *     unit-tested directly (`test/loop.test.js`). It decides what the controller
 *     should do next from a snapshot + mode; it never mutates anything.
 *  2. A **stateful controller** ({@link configureLoopController}, {@link tickLoop},
 *     {@link setLoopMode}, …) wired by `src/main/index.ts` with the existing
 *     IPC-layer functions. It advances the run *exclusively* by calling those
 *     functions / `dispatchRunAction`, so the run state machine in `run.ts` stays
 *     the single transition authority — the controller duplicates no transition
 *     rules.
 *
 * Operator authority is preserved at all times: manual mode (the default) makes
 * the controller a no-op; pausing or any manual dispatch preempts it (it re-syncs
 * from the snapshot rather than fighting the operator); fix-handoff send stays
 * operator-approved unless `loop.autoSendFix` is explicitly enabled; and merge is
 * never automated.
 */

/** How often the fix-commit watcher polls GitHub while watching a PR (ms). */
const DEFAULT_WATCH_INTERVAL_MS = 15_000;

/**
 * How many transient fix-commit-watch verification failures (partial query /
 * thrown error) are tolerated before the watcher halts visibly. Watching a PR is
 * inherently a repeated check, so a single incomplete poll is logged and retried
 * once; a second consecutive failure means `gh`/network/auth is broken, so the
 * watcher stops and the controller halts instead of polling forever with no
 * dashboard error (issue #39 — stage failures must surface visibly, no silent
 * retry loops). This mirrors the single-retry budget the stage actions use.
 */
const WATCH_RETRY_BUDGET = 1;

/**
 * Statuses at which the loop stops auto-advancing. These are the merge gate, the
 * human-intervention/▸budget endpoints, pause (operator preemption), and every
 * terminal lifecycle status. From any of these the controller does nothing until
 * the run changes — merge in particular is always manual.
 */
const STOP_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'merge_ready',
  'needs_human',
  'agent_failed',
  'max_cycles_exceeded',
  'paused',
  'cancelled',
  'closed',
  'karan_merged',
]);

/** Pre-PR statuses — the loop only engages once a run has reached a PR. */
const PRE_PR_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'idle',
  'issue_selected',
  'needs_spec',
  'ready_to_build',
  'builder_running',
]);

/** Reviewer session statuses that count as terminal for synthesis gating. */
const TERMINAL_REVIEWER_STATUSES = new Set(['completed', 'comment_posted', 'failed']);

/** Whether a run status is one the loop deliberately stops at (no auto-advance). */
export function isLoopStopStatus(status: RunStatus): boolean {
  return STOP_STATUSES.has(status);
}

/**
 * Whether every tracked reviewer session has reached a terminal state
 * (completed/comment_posted/failed). Synthesis only auto-fires once both
 * reviewers are done; a still-`launching`/`running` reviewer keeps the loop
 * waiting. A run with no tracked reviewers is not "terminal" — there is nothing
 * to synthesize yet — so this returns false.
 */
export function reviewersTerminal(run: RunSnapshot): boolean {
  const reviewers = run.reviewers ?? [];
  if (reviewers.length === 0) return false;
  return reviewers.every((session) => TERMINAL_REVIEWER_STATUSES.has(session.status));
}

/**
 * Whether a fresh fix commit has landed on the PR since the run's recorded
 * expected commit. The watcher arms once a fix handoff has been delivered (the
 * run is `builder_fixing`); at that point the run's `expectedCommit` is still the
 * pre-fix commit, so a PR whose head no longer matches it means the builder
 * pushed the fix. Pure and evidence-bound: it reads only the live verification's
 * PR head against the recorded commit — never agent self-report. Returns null
 * when there is not enough evidence yet (no PR, no recorded commit, or an
 * incomplete query), so a partial result never looks like a landed fix.
 */
export function detectFixLanded(
  run: RunSnapshot,
  verification: CommitVerification,
): { landed: true; headSha: string } | { landed: false } {
  if (verification.partial) return { landed: false };
  if (!verification.pr) return { landed: false };
  const head = verification.pr.headSha;
  if (!head) return { landed: false };
  const baseline = run.expectedCommit;
  // Without a recorded baseline we cannot tell a fresh push apart from the
  // original commit, so we do not claim a fix landed (the operator can still
  // dispatch push_fix manually).
  if (!baseline) return { landed: false };
  if (commitMatches(baseline, head)) return { landed: false };
  return { landed: true, headSha: head };
}

/** A stage the controller can drive by calling an injected IPC-layer function. */
export type LoopStageAction = 'start_reviewers' | 'synthesize' | 'send_fix';

/**
 * The controller's next move, decided purely from a snapshot + mode. `act`
 * carries the stage to run; `wait`/`idle`/`stop` carry only a wait reason + label
 * for the dashboard. The label is human-facing; `waitingOn` is the stable key.
 */
export type LoopDecision =
  | { kind: 'idle'; waitingOn: LoopWaitReason; label: string }
  | { kind: 'wait'; waitingOn: LoopWaitReason; label: string }
  | { kind: 'act'; action: LoopStageAction; waitingOn: LoopWaitReason; label: string }
  | { kind: 'stop'; waitingOn: LoopWaitReason; label: string };

/** Runtime context the pure decision needs beyond the snapshot. */
export type LoopDecisionContext = {
  /** Whether `loop.autoSendFix` is enabled (default false — operator approves). */
  autoSendFix: boolean;
  /** Whether a fix handoff has already been delivered for the current cycle. */
  fixDelivered: boolean;
};

/**
 * Decide the controller's next move. Pure and deterministic: the same
 * (run, mode, context) always yields the same decision, so the loop is governed
 * by this table — not by which event happened to fire. It never advances state;
 * the stateful controller executes the `act` decisions through the existing
 * handlers and re-decides from the resulting snapshot.
 */
export function decideLoopAction(
  run: RunSnapshot | null,
  mode: LoopMode,
  context: LoopDecisionContext,
): LoopDecision {
  if (mode === 'manual') {
    return { kind: 'idle', waitingOn: 'inactive', label: 'Manual mode — the operator drives every step.' };
  }
  if (!run) {
    return { kind: 'idle', waitingOn: 'inactive', label: 'No active run.' };
  }

  if (isLoopStopStatus(run.status)) {
    return { kind: 'stop', waitingOn: 'stopped', label: stopLabel(run.status) };
  }

  if (PRE_PR_STATUSES.has(run.status)) {
    return {
      kind: 'wait',
      waitingOn: 'waiting_pr',
      label: 'Waiting for the builder to open a verified PR.',
    };
  }

  switch (run.status) {
    case 'pr_opened':
      return {
        kind: 'act',
        action: 'start_reviewers',
        waitingOn: 'working',
        label: 'Launching reviewers for the PR.',
      };
    case 'reviewers_running':
    case 'reviewers_rerunning':
      if (reviewersTerminal(run)) {
        return {
          kind: 'act',
          action: 'synthesize',
          waitingOn: 'working',
          label: 'Both reviewers finished — synthesizing findings.',
        };
      }
      return {
        kind: 'wait',
        waitingOn: 'waiting_reviewers',
        label: 'Waiting for the reviewer sessions to finish.',
      };
    case 'review_synthesis':
      // Synthesis ran but did not route forward (e.g. an unverified PR holds the
      // gate). The controller never converts a hold into progress — the operator
      // resolves it (re-verify / re-synthesize / flag).
      return {
        kind: 'wait',
        waitingOn: 'synthesis_hold',
        label: 'Synthesis held — the operator must resolve the merge gate.',
      };
    case 'builder_fixing':
      if (context.fixDelivered) {
        return {
          kind: 'wait',
          waitingOn: 'watching_fix_commit',
          label: 'Fix handoff delivered — watching the PR for the new commit.',
        };
      }
      if (context.autoSendFix) {
        return {
          kind: 'act',
          action: 'send_fix',
          waitingOn: 'working',
          label: 'Auto-sending the fix handoff to the builder.',
        };
      }
      return {
        kind: 'wait',
        waitingOn: 'waiting_fix_approval',
        label: 'Fix cycle open — waiting for operator approval to send the fix handoff.',
      };
    case 'fix_pushed':
      return {
        kind: 'act',
        action: 'start_reviewers',
        waitingOn: 'working',
        label: 'Fix commit landed — re-launching reviewers.',
      };
    default:
      return { kind: 'wait', waitingOn: 'inactive', label: 'No automatic action for the current state.' };
  }
}

function stopLabel(status: RunStatus): string {
  switch (status) {
    case 'merge_ready':
      return 'Merge-ready — both reviewers cleared and the PR is verified. Merge stays manual.';
    case 'needs_human':
      return 'Stopped: the run needs a human (ambiguous review or held gate).';
    case 'max_cycles_exceeded':
      return 'Stopped: the fix-cycle budget is exhausted.';
    case 'agent_failed':
      return 'Stopped: an agent session failed.';
    case 'paused':
      return 'Paused by the operator — the loop is preempted until resume.';
    default:
      return 'Stopped: the run reached a terminal state.';
  }
}

// --- Stateful controller -----------------------------------------------------

/** Outcome of an injected stage execution, normalized for the controller. */
export type LoopStageResult = {
  ok: boolean;
  error?: string;
  /** True when the failure was a transient `gh`/network condition (one retry). */
  transient?: boolean;
  /**
   * True when the stage refused its side effects because an operator/manual
   * dispatch, pause, or mode toggle preempted it mid-flight (issue #39, blocker
   * B-1). The controller treats this as a clean operator hand-off — neither a
   * halt nor a retry — even when the resulting run status is still launch-legal
   * (e.g. a manual `start_reviewers` advanced `pr_opened → reviewers_running`).
   */
  preempted?: boolean;
};

/**
 * Dependencies the controller is wired with by `src/main/index.ts`. Keeping them
 * injected lets `loop.ts` stay free of Electron/IPC imports (no circular
 * dependency on index.ts) and lets the controller be driven in tests with fakes.
 */
export type LoopControllerDeps = {
  /** The current run snapshot (the controller never caches it). */
  getRun: () => RunSnapshot | null;
  /** Effective default loop mode for a freshly started run (config-derived). */
  defaultAuto: () => boolean;
  /** Effective `loop.autoSendFix` (config-derived). */
  autoSendFix: () => boolean;
  /** Launch/relaunch reviewers (the #9-gated handler), attributing to the loop. */
  startReviewers: (actor: TransitionActor) => Promise<LoopStageResult>;
  /** Synthesize reviewer findings + route the run, attributing to the loop. */
  synthesize: (actor: TransitionActor) => Promise<LoopStageResult>;
  /** Send the composed fix handoff into the builder (no transition). */
  sendFix: () => Promise<LoopStageResult>;
  /** Dispatch a run action directly (used for the watcher's push_fix). */
  dispatch: (
    action: RunAction,
    options: { actor: TransitionActor; reason?: string; expectedCommit?: string; branch?: string },
  ) => { ok: boolean; error?: string };
  /** Re-run the #9 verification scoped to the current run (fix-commit watcher). */
  verifyForFix: () => Promise<CommitVerification>;
  /** Push the latest loop state to the renderer. */
  emitLoopChanged: (state: LoopState) => void;
  /** Push the latest run snapshot to the renderer (after a loop-driven change). */
  emitRunChanged: () => void;
  /** Clock injection for deterministic tests. */
  now?: () => string;
  /** Watcher poll interval override (tests). */
  watchIntervalMs?: number;
  /** Timer injection for deterministic tests; defaults to global setInterval. */
  setWatchTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearWatchTimer?: (handle: ReturnType<typeof setInterval>) => void;
  /** Logger injection; defaults to console. */
  log?: (message: string) => void;
};

let deps: LoopControllerDeps | null = null;

// Per-run controller state. `mode` is the explicit per-run mode; it resets to the
// config default whenever the bound run changes.
let mode: LoopMode = 'manual';
let lastRunId: string | null = null;
let fixDelivered = false;
let lastError: string | null = null;
// The status the controller halted at (a stage failed). While the run stays at
// this status the controller will not retry — no silent retry loops. It clears
// the moment the status changes or the operator re-arms the mode.
let haltedStatus: RunStatus | null = null;
let waitingOn: LoopWaitReason = 'inactive';
let label = 'Manual mode — the operator drives every step.';
let updatedAt = '1970-01-01T00:00:00.000Z';

// Re-entrancy control: only one stage runs at a time; external ticks during a
// stage set `pending` so the loop re-evaluates once the stage completes.
let busy = false;
let pending = false;

// Single-retry bookkeeping: a transient `gh` failure for a given status is
// retried at most once. Cleared whenever the status changes.
let retriedStatus: RunStatus | null = null;

// --- Loop-stage preemption generation (issue #39, blocker B-1) ----------------
//
// A monotonic token bumped on every operator/manual preemption: each manual run
// dispatch, loop-mode toggle, and controller reset. A loop-driven async stage
// (`handleStartReviewers`/`handleSynthesizeReviews` with the `loop` actor)
// captures this value *before* it awaits its live #9 verification and re-checks
// it after the await, before any side effect. If the value changed, an operator
// action preempted the stage mid-flight and it must abort — even when the
// resulting run status is still launch-legal. A status-only guard cannot tell
// "this loop stage is still valid" from "the operator already performed the
// stage manually" (a manual `start_reviewers` advancing `pr_opened →
// reviewers_running`, which `reviewerLaunchTransition` treats as an idempotent
// relaunch), so the generation token is the authority for loop-driven stages.
let stageGeneration = 0;

/**
 * Capture the current loop-stage generation. A loop-driven stage calls this at
 * entry (before its first await) and passes the value to
 * {@link isLoopStageGenerationStale} after the await to detect preemption.
 */
export function captureLoopStageGeneration(): number {
  return stageGeneration;
}

/**
 * Whether the loop-stage generation has advanced since `captured` was taken —
 * i.e. an operator/manual action preempted the in-flight loop stage. Pure read.
 */
export function isLoopStageGenerationStale(captured: number): boolean {
  return captured !== stageGeneration;
}

/**
 * Invalidate any in-flight loop-driven stage. Called synchronously at the entry
 * of every operator/manual run dispatch (and operator-driven reviewer/synthesis
 * launch) so a loop stage that captured an earlier generation aborts after its
 * next await, before performing side effects. Bumping is a no-op for the
 * operator's own stage (only `loop`-actor stages consult the generation).
 */
export function preemptLoopStages(): void {
  stageGeneration += 1;
}

// Fix-commit watcher state.
let watchTimer: ReturnType<typeof setInterval> | null = null;
let watchPolling = false;
// Consecutive transient watch failures (partial/thrown). Reset when the watcher
// arms fresh, the bound run changes, or a complete poll succeeds.
let watchFailures = 0;

function clock(): string {
  return deps?.now ? deps.now() : new Date().toISOString();
}

function logMessage(message: string): void {
  if (deps?.log) deps.log(message);
  else console.log(message);
}

/** The current renderer-facing loop state. */
export function getLoopState(): LoopState {
  return { mode, waitingOn, label, lastError, updatedAt };
}

function publish(nextWaitingOn: LoopWaitReason, nextLabel: string): void {
  const changed = nextWaitingOn !== waitingOn || nextLabel !== label;
  waitingOn = nextWaitingOn;
  label = nextLabel;
  if (changed) {
    updatedAt = clock();
    deps?.emitLoopChanged(getLoopState());
  }
}

/**
 * Wire the controller with its dependencies. Idempotent; called once at startup.
 * Resets all per-run state so a configure in tests starts clean.
 */
export function configureLoopController(injected: LoopControllerDeps): void {
  deps = injected;
  mode = 'manual';
  lastRunId = null;
  fixDelivered = false;
  lastError = null;
  haltedStatus = null;
  waitingOn = 'inactive';
  label = 'Manual mode — the operator drives every step.';
  updatedAt = clock();
  busy = false;
  pending = false;
  retriedStatus = null;
  watchFailures = 0;
  stageGeneration = 0;
  stopWatcher();
}

/** Reset the controller (used when a run is cleared/project switched). */
export function resetLoopController(): void {
  stopWatcher();
  // Clearing the run preempts any loop stage that was in flight against it.
  preemptLoopStages();
  mode = 'manual';
  lastRunId = null;
  fixDelivered = false;
  lastError = null;
  haltedStatus = null;
  retriedStatus = null;
  watchFailures = 0;
  busy = false;
  pending = false;
  publish('inactive', 'Manual mode — the operator drives every step.');
}

/**
 * Sync per-run state to the bound run. When the run id changes, the controller
 * adopts the config-default mode and clears all per-run flags (a fresh run starts
 * from a clean slate, in manual unless the project opted into auto). The
 * fix-delivered flag is cleared once the run leaves the fix-send window so a later
 * cycle re-arms cleanly; it is preserved across a `paused` blip so resume does not
 * re-send.
 */
function syncRun(run: RunSnapshot | null): void {
  const id = run?.id ?? null;
  if (id !== lastRunId) {
    lastRunId = id;
    mode = run && deps ? (deps.defaultAuto() ? 'auto' : 'manual') : 'manual';
    fixDelivered = false;
    haltedStatus = null;
    lastError = null;
    retriedStatus = null;
    watchFailures = 0;
    stopWatcher();
  }
  // Once the run has moved on from the fix-send window, the cycle's delivered
  // flag is stale — a later builder_fixing belongs to a new cycle.
  if (run && run.status !== 'builder_fixing' && run.status !== 'paused') {
    fixDelivered = false;
  }
  if (run && haltedStatus !== null && run.status !== haltedStatus) {
    haltedStatus = null;
    lastError = null;
  }
  if (run && retriedStatus !== null && run.status !== retriedStatus) {
    retriedStatus = null;
  }
}

/**
 * Set the loop mode for the current run. Toggling re-arms a halted controller and
 * takes effect at the next event boundary (it ticks immediately). Rejected with a
 * typed error when there is no run to attach a mode to.
 */
export async function setLoopMode(next: LoopMode): Promise<LoopModeResult> {
  if (!deps) {
    return { ok: false, code: 'no_run', error: 'The loop controller is not configured.' };
  }
  const run = deps.getRun();
  if (!run) {
    return { ok: false, code: 'no_run', error: 'There is no active run to set a loop mode for.' };
  }
  // An operator mode toggle preempts any loop stage in flight: a stage that
  // captured the prior generation aborts after its await rather than completing
  // side effects against a controller the operator just re-armed/disarmed.
  preemptLoopStages();
  // Adopt the run id so syncRun does not immediately reset the operator's choice.
  lastRunId = run.id;
  mode = next;
  // Re-arm: an explicit mode change clears a prior halt so the operator can
  // resume automation after fixing the underlying problem.
  haltedStatus = null;
  lastError = null;
  retriedStatus = null;
  updatedAt = clock();
  deps.emitLoopChanged(getLoopState());
  await tickLoop();
  return { ok: true, loop: getLoopState() };
}

/**
 * Drive the controller from the current snapshot. Safe to call on every
 * observable event (run change, reviewer exit, mode toggle, fix sent) — in manual
 * mode it is a no-op, and re-entrant calls coalesce. It runs at most one stage per
 * step and re-evaluates after each, so a single tick chains forward as far as the
 * deterministic decisions allow.
 */
export async function tickLoop(): Promise<void> {
  if (!deps) return;
  if (busy) {
    pending = true;
    return;
  }
  busy = true;
  try {
    let acted = true;
    // Each stage advances the deterministic state machine, so a single tick
    // chains through at most a handful of states. The bound is a defensive
    // backstop against any pathological no-progress spin (it should never hit).
    let guard = 0;
    while (acted && guard < 24) {
      acted = await step();
      guard += 1;
    }
    if (guard >= 24) {
      logMessage('[godmode:loop] Tick exceeded its step budget; stopping to avoid a spin.');
    }
  } finally {
    busy = false;
  }
  if (pending) {
    pending = false;
    await tickLoop();
  }
}

/** Notify the controller that a fix handoff was delivered (auto or manual send). */
export function notifyFixDelivered(): void {
  fixDelivered = true;
}

/**
 * One decision+action step. Returns true when it executed a stage (so the caller
 * re-evaluates), false when it only waited/idled/stopped or halted.
 */
async function step(): Promise<boolean> {
  if (!deps) return false;
  const run = deps.getRun();
  syncRun(run);

  // Honor an active halt: while the run sits at the halted status, do nothing
  // (no retry loop). syncRun already cleared the halt if the status moved on.
  if (haltedStatus !== null && run && run.status === haltedStatus) {
    publish('halted', lastError ? `Loop halted: ${lastError}` : 'Loop halted on a stage failure.');
    return false;
  }

  const decision = decideLoopAction(run, mode, {
    autoSendFix: deps.autoSendFix(),
    fixDelivered,
  });

  // Manage the fix-commit watcher purely from the decision: it runs only while
  // the decision says we are watching, and is torn down for every other state.
  if (decision.waitingOn === 'watching_fix_commit') ensureWatcher();
  else stopWatcher();

  publish(decision.waitingOn, decision.label);

  if (decision.kind !== 'act') return false;

  const result = await execute(decision.action);
  if (!result.ok) {
    const current = deps.getRun();
    const status = current?.status ?? run?.status ?? null;
    // Preemption, not failure: an operator/manual dispatch, pause, or mode toggle
    // preempted the stage mid-flight, so its own preemption guard refused all side
    // effects. This covers two shapes:
    //  - a generation-preemption (`result.preempted`): the manual dispatch may have
    //    advanced the run to a still-launch-legal status (e.g. `reviewers_running`),
    //    so a status check alone would not catch it;
    //  - a stop-status transition (paused/cancelled/terminal) during the await.
    // In both cases re-sync and let the tick the manual dispatch queued surface the
    // new state — never record a halt or retry (operator authority over the loop).
    if (result.preempted || (status && isLoopStopStatus(status))) {
      syncRun(current);
      if (status && isLoopStopStatus(status)) publish('stopped', stopLabel(status));
      return false;
    }
    // One automatic retry for a transient gh/network failure, only if logged.
    if (result.transient && status && retriedStatus !== status) {
      retriedStatus = status;
      logMessage(`[godmode:loop] Transient failure on ${decision.action}; retrying once: ${result.error ?? ''}`);
      return true;
    }
    halt(status, result.error ?? 'stage failed');
    return false;
  }

  if (decision.action === 'send_fix') {
    fixDelivered = true;
  }
  return true;
}

/** Execute one stage by delegating to the injected IPC-layer function. */
async function execute(action: LoopStageAction): Promise<LoopStageResult> {
  if (!deps) return { ok: false, error: 'controller not configured' };
  switch (action) {
    case 'start_reviewers':
      return deps.startReviewers('loop');
    case 'synthesize':
      return deps.synthesize('loop');
    case 'send_fix':
      return deps.sendFix();
    default:
      return { ok: false, error: `unknown stage ${action as string}` };
  }
}

/** Record a halt: stop auto-advancing at the failed status until it changes. */
function halt(status: RunStatus | null, error: string): void {
  haltedStatus = status;
  lastError = error;
  logMessage(`[godmode:loop] Halted at ${status ?? 'unknown'}: ${error}`);
  publish('halted', `Loop halted: ${error}`);
}

// --- Fix-commit watcher ------------------------------------------------------

function ensureWatcher(): void {
  if (!deps || watchTimer !== null) return;
  // A fresh watch window starts with a clean transient-failure budget.
  watchFailures = 0;
  const interval = deps.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const start = deps.setWatchTimer ?? ((fn, ms) => setInterval(fn, ms));
  watchTimer = start(() => {
    void pollFixCommit();
  }, interval);
}

/**
 * Record a transient fix-commit-watch failure (incomplete query or thrown
 * watcher error). The first such failure in a window is logged and retried on the
 * next poll; a second consecutive one means the verification path is broken, so
 * the watcher stops and the controller halts visibly — the same single-retry
 * budget the stage actions use, never an indefinite silent retry loop (issue #39).
 */
function failWatch(reason: string): void {
  watchFailures += 1;
  if (watchFailures <= WATCH_RETRY_BUDGET) {
    logMessage(
      `[godmode:loop] Fix-commit watch: ${reason}; retrying once (${watchFailures}/${WATCH_RETRY_BUDGET}).`,
    );
    return;
  }
  stopWatcher();
  halt('builder_fixing', `fix-commit verification failed: ${reason}`);
}

function stopWatcher(): void {
  if (watchTimer === null) return;
  const clear = deps?.clearWatchTimer ?? ((handle) => clearInterval(handle));
  clear(watchTimer);
  watchTimer = null;
  watchPolling = false;
}

/**
 * One watcher poll: re-run the #9 verification scoped to the run and, when a fresh
 * fix commit has landed on the PR, dispatch `push_fix` (attributed to the loop)
 * recording the new head as the expected commit. The normal chaining then
 * re-launches reviewers for the next cycle. Transient query failures are logged
 * and the watcher keeps polling — watching a PR is inherently a repeated check, so
 * this is not a silent retry of a stage action.
 */
async function pollFixCommit(): Promise<void> {
  if (!deps || watchPolling) return;
  const run = deps.getRun();
  // Only watch while still in the fix-send window; otherwise tear down.
  if (!run || run.status !== 'builder_fixing' || mode !== 'auto') {
    stopWatcher();
    return;
  }
  watchPolling = true;
  try {
    const verification = await deps.verifyForFix();
    const current = deps.getRun();
    // Preemption guard: the operator may have paused/cleared the run or left auto
    // mode while the verification was in flight. Tear down without side effects.
    if (!current || current.status !== 'builder_fixing' || mode !== 'auto') {
      stopWatcher();
      return;
    }
    if (verification.partial) {
      // An incomplete query is a transient failure, not "no commit yet": route it
      // through the retry budget so a broken `gh`/network/auth halts visibly
      // instead of polling forever (issue #39, blocker A-1).
      failWatch('verification query incomplete');
      return;
    }
    // A complete query: clear the transient-failure budget for this window.
    watchFailures = 0;
    const detected = detectFixLanded(current, verification);
    if (!detected.landed) return;

    stopWatcher();
    const branch = verification.pr?.headRefName || current.branch;
    const dispatched = deps.dispatch('push_fix', {
      actor: 'loop',
      reason: `Fix commit ${detected.headSha.slice(0, 7)} detected on PR #${verification.pr?.number}; advancing to re-review.`,
      expectedCommit: detected.headSha,
      branch,
    });
    if (!dispatched.ok) {
      halt('builder_fixing', dispatched.error ?? 'failed to record the fix commit');
      return;
    }
    deps.emitRunChanged();
    // Chain forward: fix_pushed → re-launch reviewers.
    await tickLoop();
  } catch (error) {
    // A thrown watcher error is the same class of transient failure as a partial
    // query: retry once, then halt visibly rather than leaving the watcher armed
    // and silently retrying every poll (issue #39, blocker A-1).
    failWatch((error as Error).message);
  } finally {
    watchPolling = false;
  }
}

/** Whether the fix-commit watcher is currently armed (test/inspection helper). */
export function isFixWatcherActive(): boolean {
  return watchTimer !== null;
}
