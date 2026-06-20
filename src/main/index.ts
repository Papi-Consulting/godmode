import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getAppRepoState } from './appRepo.js';
import {
  discoverRunPrCandidates,
  getCommitVerification,
  getGithubState,
  getIssueDetail,
  postPrComment,
} from './github.js';
import type { DiscoveryContext } from './discovery.js';
import {
  getPtySessionCwd,
  hasPtySession,
  killAllPtySessions,
  openPtySession,
  resizePtySession,
  stopPtySession,
  writeToPtySession,
} from './pty.js';
import { getProjectState, getSelectedProjectRoot, selectProject } from './project.js';
import {
  DEFAULT_CONFIG,
  getConfigState,
  loadConfig,
  resolveLoopConfig,
  resolveWorkspaceIsolation,
} from './config.js';
import { getRegistryState, resolveRoleLaunch } from './agents.js';
import {
  captureLoopStageGeneration,
  configureLoopController,
  getLoopState,
  isLoopStageGenerationStale,
  notifyFixDelivered,
  preemptLoopStages,
  resetLoopController,
  setLoopMode,
  tickLoop,
} from './loop.js';
import {
  adoptResumedRun,
  clearRun,
  dispatchRunAction,
  evaluateBuilderRecovery,
  evaluateClearRun,
  getCurrentRun,
  isTerminalStatus,
  recordCurrentRunPrompt,
  recordCurrentRunVerification,
  selectIssueRun,
  selectManualTaskRun,
  setCurrentRunFindings,
  setCurrentRunIsolation,
  setCurrentRunReviewers,
  setCurrentRunWorktree,
  setRunPersistHook,
  updateCurrentRunReviewer,
} from './run.js';
import {
  archiveRun,
  loadUnfinishedRun,
  preferredBackendKind,
  saveRun,
  storeBackendKind,
} from './store.js';
import {
  createWorktree,
  deriveWorktreePlan,
  inspectWorktree,
  isGitRepo,
  isManagedWorktreePath,
  listManagedWorktrees,
  removeWorktree,
} from './worktree.js';
import { composeFixHandoff, getCurrentHandoff, promptDigest } from './handoff.js';
import {
  appendArtifact,
  ensureRunArtifactDir,
  readReviewerArtifact,
  reviewerArtifactPath,
  reviewerArtifactRelPath,
  writeRunFindings,
  writeRunSnapshot,
} from './artifacts.js';
import {
  acceptedBlockers,
  computeMergeReadiness,
  parseReviewerOutput,
  renderBlockersText,
} from './findings.js';
import {
  canPostReviewerMarker,
  canSynthesizeReviews,
  composeReviewerLaunch,
  isLoopReviewSynthesisPreempted,
  isLoopReviewerLaunchPreempted,
  isReviewerRunContextStale,
  isReviewerSessionStale,
  resolveReviewerExit,
  reviewerCommentBody,
  reviewerLaunchTransition,
} from './reviewer.js';
import type {
  AgentRole,
  BuilderHandoff,
  BuilderRecoveryState,
  ClearRunResult,
  CommitVerification,
  ConfirmPrCandidateResult,
  HandoffSendResult,
  LoopMode,
  LoopModeResult,
  LoopState,
  ManagedWorktree,
  PrDiscoveryResult,
  ReviewSynthesisResult,
  ReviewerCommentResult,
  ReviewerResult,
  RunDiscardResult,
  RunFindings,
  RunResumeResult,
  RunResumeState,
  RunSnapshot,
  RunSourceDetail,
  RunStorageStatus,
  RunVerificationResult,
  RunWorktree,
  StartReviewersResult,
  TransitionActor,
  WorktreeCleanupResult,
} from '../shared/types.js';
import { GODMODE_IPC } from '../shared/ipcChannels.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.env.VITE_DEV_SERVER_URL !== undefined || process.env.NODE_ENV === 'development';

const paneIdSchema = z.enum(['head', 'builder', 'reviewer_a', 'reviewer_b']);
const ptyStartSchema = z.object({ paneId: paneIdSchema });
const ptyWriteSchema = z.object({ paneId: paneIdSchema, data: z.string().max(100_000) });
const ptyResizeSchema = z.object({
  paneId: paneIdSchema,
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});
const projectSelectSchema = z.object({ path: z.string().min(1).max(4096) });

const runActionSchema = z.enum([
  'select_issue',
  'require_spec',
  'mark_ready',
  'start_builder',
  'open_pr',
  'start_reviewers',
  'synthesize_reviews',
  'request_fix',
  'push_fix',
  'rerun_reviewers',
  'mark_merge_ready',
  'mark_merged',
  'pause',
  'resume',
  'cancel',
  'flag_needs_human',
  'report_agent_failed',
  'exceed_max_cycles',
  'close',
]);
const runBlockerSchema = z.enum([
  'pr_conflicted',
  'tests_failed',
  'checks_unstable',
  'harness_missing',
  'repo_dirty',
]);
const runSelectIssueSchema = z.object({
  issueNumber: z.number().int().positive(),
  issueTitle: z.string().min(1).max(500).optional(),
  maxCycles: z.number().int().min(1).max(50).optional(),
});
const runDispatchSchema = z.object({
  action: runActionSchema,
  reason: z.string().max(2000).optional(),
  blocker: runBlockerSchema.optional(),
  branch: z.string().min(1).max(255).optional(),
  prNumber: z.number().int().positive().optional(),
  expectedCommit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i, 'expectedCommit must be a 7–40 char hex SHA')
    .optional(),
});
const githubIssueSchema = z.object({ issueNumber: z.number().int().positive() });
const runPrConfirmSchema = z.object({
  prNumber: z.number().int().positive(),
  branch: z.string().min(1).max(255),
  expectedCommit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i, 'expectedCommit must be a 7–40 char hex SHA'),
  matchReason: z.enum(['issue_link', 'recent_unlinked']).optional(),
});
const reviewerPaneSchema = z.enum(['reviewer_a', 'reviewer_b']);
const reviewerCommentSchema = z.object({ paneId: reviewerPaneSchema });
const runSelectManualSchema = z.object({
  title: z.string().min(1).max(200),
  text: z.string().min(1).max(20_000),
});
const runIsolationSchema = z.object({ isolation: z.enum(['worktree', 'shared']) });
const worktreeCleanupSchema = z.object({ path: z.string().min(1).max(4096) });
const loopModeSchema = z.object({ mode: z.enum(['manual', 'auto']) });

function parseIpcPayload<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    console.warn('Ignored invalid GodMode IPC payload', parsed.error.flatten());
    return undefined;
  }
  return parsed.data;
}

function isTrustedDevServerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  } catch {
    return false;
  }
}

let mainWindow: BrowserWindow | null = null;

// --- Run persistence health (issue #40) --------------------------------------
// Whether the last persistence write succeeded, the backend in use, and a
// one-time human-readable reason when it failed. Degradation is per-operated
// project: it is reset on a project switch so a read-only project's warning never
// bleeds into the next, writable one.
let storageBackend: RunStorageStatus['backend'] = 'none';
let storageDegraded = false;
let storageMessage: string | undefined;

/**
 * Apply a project selection and, if the root actually changed, tear down any
 * PTY sessions still rooted in the previous project. Agent commands must run in
 * the selected project directory (AGENTS.md safety rule), so a live terminal
 * must never outlive the project it was spawned in. Panes are reset in the UI
 * via a synthetic exit so the operator restarts them in the new root.
 */
function selectProjectAndResetSessions(input: string) {
  const previousRoot = getSelectedProjectRoot();
  const state = selectProject(input);
  const nextRoot = getSelectedProjectRoot();

  if (nextRoot !== previousRoot) {
    // A run is scoped to the project it was started in (its issue/branch/PR all
    // belong to that repo), so discard it when the operated project changes. The
    // renderer reloads run state on `projectChanged` like it does config/GitHub.
    clearRun();
    // The loop controller is bound to the discarded run — reset it so no watcher
    // or auto-mode carries over into the newly selected project (issue #39).
    resetLoopController();
    for (const paneId of killAllPtySessions()) {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(GODMODE_IPC.ptyExit, { paneId, exit: { exitCode: 0 } });
      }
    }
    // Persistence health is per-operated-project: reset the degraded banner so a
    // read-only project's warning never bleeds into the next, writable one (#40).
    storageDegraded = false;
    storageMessage = undefined;
    storageBackend = 'none';
    // Role/agent config is project-local, so the renderer must reload it (panes,
    // labels, command hints) whenever the active root changes.
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(GODMODE_IPC.projectChanged, state);
    }
    // The newly selected project may have its own persisted unfinished run — push
    // the resume offer (or its absence) so the operator is given the explicit
    // Resume/Discard choice without auto-resuming (issue #40).
    emitResumeChanged();
  }

  return state;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    title: 'GodMode',
    backgroundColor: '#07080d',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    if (!isTrustedDevServerUrl(process.env.VITE_DEV_SERVER_URL)) {
      throw new Error('Refusing to load untrusted VITE_DEV_SERVER_URL for a PTY-enabled renderer.');
    }
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (isDev) {
    void win.loadURL('http://127.0.0.1:5173');
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function handleGetApp() {
  return getAppRepoState();
}

function handleGetProject() {
  return getProjectState();
}

function handleGetConfig() {
  return getConfigState();
}

function handleGetRegistry() {
  return getRegistryState();
}

function handleSelectProject(_event: Electron.IpcMainInvokeEvent, input: unknown) {
  const payload = parseIpcPayload(projectSelectSchema, input);
  if (!payload) return undefined;
  return selectProjectAndResetSessions(payload.path);
}

async function handleBrowseProject() {
  const result = await dialog.showOpenDialog({
    title: 'Open GodMode project',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: getSelectedProjectRoot(),
  });
  if (result.canceled || result.filePaths.length === 0) return undefined;
  return selectProjectAndResetSessions(result.filePaths[0]);
}

function handleGetGithub() {
  return getGithubState(getSelectedProjectRoot(), new Date().toISOString());
}

/** Resolve the operated project's configured workspace isolation (issue #41). */
function currentConfigIsolation(): 'shared' | 'worktree' {
  const loaded = loadConfig();
  const config = loaded.status === 'loaded' ? loaded.config : DEFAULT_CONFIG;
  return resolveWorkspaceIsolation(config);
}

/** Resolve the operated project's effective review/fix loop settings (issue #39). */
function currentLoopConfig(): ReturnType<typeof resolveLoopConfig> {
  const loaded = loadConfig();
  const config = loaded.status === 'loaded' ? loaded.config : DEFAULT_CONFIG;
  return resolveLoopConfig(config);
}

/**
 * Ensure the run-scoped git worktree exists for an isolated run (issue #41),
 * creating it on its branch on first use and reusing it on fix cycles. Idempotent:
 * a run that already has a live worktree dir returns it unchanged. Records the
 * worktree (and working branch) on the run and emits the change. Returns a tagged
 * result so callers can tell "isolation off" apart from a real creation failure
 * (e.g. not a git repo), which must surface visibly and never advance the run.
 */
async function ensureRunWorktree(
  run: RunSnapshot,
): Promise<
  | { mode: 'shared' }
  | { mode: 'worktree'; ok: true; worktree: RunWorktree }
  | { mode: 'worktree'; ok: false; error: string }
> {
  if (run.isolation !== 'worktree') return { mode: 'shared' };

  // Snapshot the run identity and project root taken BEFORE the awaits below
  // (`isGitRepo`, `createWorktree`). Both yield the event loop, so by the time we
  // record the prepared worktree the operator may have cancelled/replaced the run or
  // switched projects (reviewer-a A-2). We must not attach this run's worktree to a
  // different run or a different project's tree.
  const expectedRunId = run.id;
  const projectRoot = getSelectedProjectRoot();
  if (!(await isGitRepo(projectRoot))) {
    return {
      mode: 'worktree',
      ok: false,
      error: 'The operated project is not a git repository, so a run worktree cannot be created.',
    };
  }

  // Reuse the recorded worktree on fix cycles / pane restarts, but NEVER on a
  // bare directory-exists check: a recorded directory that was manually removed
  // and recreated, converted to a foreign repo, or moved to the wrong branch after
  // initial creation must not be returned as valid and launched as the builder
  // cwd. Routing the recorded plan back through createWorktree runs the full
  // validateReusableWorktree gate (registered worktree of this repo, on the
  // expected branch) and surfaces a visible reason on conflict (issue #41).
  const plan = run.worktree
    ? { dir: run.worktree.path, branch: run.worktree.branch }
    : deriveWorktreePlan(projectRoot, run.id);
  const created = await createWorktree({ projectRoot, dir: plan.dir, branch: plan.branch });
  if (!created.ok) {
    return { mode: 'worktree', ok: false, error: created.error };
  }

  // Identity-aware recording (reviewer-a A-2): `createWorktree` awaited, so the global
  // current run / selected project may have moved out from under us during preparation.
  // `setCurrentRunWorktree` writes to whatever run is current, so recording now could
  // attach THIS run's worktree/branch to an unrelated run (or a different project) and
  // persist/emit that corrupted snapshot — even before a caller's own post-await guard
  // runs. Refuse to record if the world changed; the prepared worktree is left on disk
  // and is harmlessly re-validated/reused on the next attempt. The caller treats this as
  // a worktree failure and never spawns.
  if (getCurrentRun()?.id !== expectedRunId || getSelectedProjectRoot() !== projectRoot) {
    return {
      mode: 'worktree',
      ok: false,
      error:
        'The active run or project changed while preparing the worktree; recording was skipped to avoid attaching it to a different run.',
    };
  }

  const worktree: RunWorktree = {
    path: created.dir,
    branch: created.branch,
    // Preserve the original creation timestamp across validated reuse.
    createdAt: run.worktree?.createdAt ?? new Date().toISOString(),
  };
  // Pass the expected run id so the recording itself is identity-guarded: even if the
  // current run changed between the check above and this write, the controller refuses
  // rather than corrupting an unrelated run's metadata.
  const updated = setCurrentRunWorktree(worktree, { expectedRunId });
  if (!updated) {
    return {
      mode: 'worktree',
      ok: false,
      error:
        'The active run changed while preparing the worktree; recording was skipped to avoid attaching it to a different run.',
    };
  }
  emitRunChanged(updated);
  return { mode: 'worktree', ok: true, worktree };
}

function handleGetRun() {
  return getCurrentRun();
}

async function handleSelectIssueRun(_event: Electron.IpcMainInvokeEvent, input: unknown) {
  const payload = parseIpcPayload(runSelectIssueSchema, input);
  if (!payload) {
    return { ok: false, code: 'invalid_payload', error: 'Invalid run selection payload.', run: getCurrentRun() };
  }

  // Best-effort: fetch the full issue detail so the handoff can be grounded in
  // the real body/comments. A failure here (gh missing/auth/network) still starts
  // the run from summary metadata — the handoff degrades visibly (e.g. "issue
  // body unavailable") rather than blocking issue selection.
  let sourceDetail: RunSourceDetail | undefined;
  const detail = await getIssueDetail(getSelectedProjectRoot(), payload.issueNumber);
  if (detail.issue) {
    sourceDetail = {
      url: detail.issue.url,
      body: detail.issue.body,
      labels: detail.issue.labels.map((label) => label.name).filter(Boolean),
      comments: detail.issue.comments.map((comment) => ({ author: comment.author, body: comment.body })),
    };
  }

  const result = selectIssueRun({
    sourceType: 'github_issue',
    sourceId: String(payload.issueNumber),
    issueNumber: payload.issueNumber,
    issueTitle: payload.issueTitle,
    // The operator override wins; otherwise surface the config-derived budget
    // (loop.maxCycles) instead of the hardcoded default (issue #39 §5).
    maxCycles: payload.maxCycles ?? currentLoopConfig().maxCycles,
    isolation: currentConfigIsolation(),
    sourceDetail,
  });
  // Sync the loop controller to the freshly bound run so it adopts the
  // config-default mode and publishes its initial state (issue #39).
  void tickLoop();
  return result;
}

function handleGetIssueDetail(_event: Electron.IpcMainInvokeEvent, input: unknown) {
  const payload = parseIpcPayload(githubIssueSchema, input);
  if (!payload) return Promise.resolve({ status: 'error' as const, message: 'Invalid issue request.', issue: null });
  return getIssueDetail(getSelectedProjectRoot(), payload.issueNumber);
}

function handleSelectManualTask(_event: Electron.IpcMainInvokeEvent, input: unknown) {
  const payload = parseIpcPayload(runSelectManualSchema, input);
  if (!payload) {
    return { ok: false, code: 'invalid_payload', error: 'Invalid manual task payload.', run: getCurrentRun() };
  }
  const result = selectManualTaskRun({
    title: payload.title,
    text: payload.text,
    maxCycles: currentLoopConfig().maxCycles,
    isolation: currentConfigIsolation(),
  });
  void tickLoop();
  return result;
}

function handleGetHandoff() {
  return getCurrentHandoff(getCurrentRun());
}

/** Statuses from which an approved handoff can advance the run to `builder_running`. */
const HANDOFF_START_STATUSES = new Set(['issue_selected', 'needs_spec', 'ready_to_build']);

/**
 * Send the approved builder handoff: validate it is sendable, confirm a live
 * builder session, write the prompt into that session, record the prompt-sent
 * event for audit, and advance the run to `builder_running`. Nothing is written
 * unless every gate passes, so a rejected send leaves run and session untouched.
 * Reaching `builder_running` records that the prompt was *sent* — never that the
 * task succeeded.
 */
async function handleSendHandoff(): Promise<HandoffSendResult> {
  let run = getCurrentRun();
  if (!run) {
    return { ok: false, code: 'no_run', error: 'There is no active run to send a handoff for.', run: null };
  }

  if (!HANDOFF_START_STATUSES.has(run.status)) {
    return {
      ok: false,
      code: 'invalid_state',
      error: `The run must be issue-selected or ready-to-build to send the builder handoff (current: ${run.status}).`,
      run,
    };
  }

  // Isolation (issue #41): sending the builder handoff creates the run-scoped
  // worktree on its branch (or reuses it). A creation failure is visible and the
  // run does NOT advance as if the handoff were ready.
  const ensured = await ensureRunWorktree(run);
  if (ensured.mode === 'worktree' && !ensured.ok) {
    return {
      ok: false,
      code: 'worktree_failed',
      error: `Run worktree setup failed: ${ensured.error}`,
      run: getCurrentRun(),
    };
  }
  run = getCurrentRun() ?? run;

  const handoff = getCurrentHandoff(run);
  if (!handoff.canSend) {
    return {
      ok: false,
      code: 'not_sendable',
      error: handoff.blockedReason ?? 'This handoff is not ready to send.',
      run,
    };
  }

  if (!hasPtySession('builder')) {
    return {
      ok: false,
      code: 'no_builder_session',
      error: 'No live builder session. Start the builder pane first, then approve & send.',
      run,
    };
  }

  // When the run is isolated, the live builder PTY must actually be running in the
  // run worktree before we deliver the prompt — never into the shared checkout. If
  // the pane was started before the worktree existed, ask the operator to restart
  // it (handleStartPty launches the builder in the worktree once the run has one).
  if (ensured.mode === 'worktree' && ensured.ok) {
    const builderCwd = getPtySessionCwd('builder');
    if (builderCwd !== ensured.worktree.path) {
      return {
        ok: false,
        code: 'no_builder_session',
        error: `Isolation is enabled: restart the builder pane so it launches in the run worktree (${ensured.worktree.path}), then approve & send.`,
        run,
      };
    }
  }

  // Deliver the prompt into the live builder PTY. Interactive CLIs read it as a
  // submitted line; the trailing carriage return commits the input.
  writeToPtySession('builder', `${handoff.prompt}\r`);

  // Record the prompt send for audit before advancing the lifecycle.
  recordCurrentRunPrompt({
    role: 'builder',
    digest: promptDigest(handoff.prompt),
    promptChars: handoff.prompt.length,
  });

  // Advance through the deterministic state machine: ready the run if needed,
  // then mark the builder running. Each step is logged by the guard.
  if (run.status !== 'ready_to_build') {
    const readied = dispatchRunAction('mark_ready');
    if (!readied.ok) return { ok: false, code: 'invalid_transition', error: readied.error, run: readied.run };
  }
  const reason = `Builder handoff sent to ${handoff.displayName} (${handoff.prompt.length} chars) for ${handoff.sourceLabel}.`;
  const started = dispatchRunAction('start_builder', { reason });
  if (!started.ok) {
    return { ok: false, code: 'invalid_transition', error: started.error, run: started.run };
  }
  void tickLoop();
  return { ok: true, run: started.run };
}

// --- Stale builder-session detection + recovery (issue #55) ------------------

/**
 * Current builder-recovery state: whether the active run is `builder_running`
 * while no live builder PTY exists (issue #55). The live-session truth lives in
 * main's process memory (`hasPtySession`), so this binds it to the run snapshot.
 */
function currentBuilderRecovery(): BuilderRecoveryState {
  return evaluateBuilderRecovery(getCurrentRun(), hasPtySession('builder'));
}

/** Push the latest builder-recovery state so the cockpit can surface/clear the banner. */
function emitBuilderRecoveryChanged(): void {
  emitToRenderer(GODMODE_IPC.runBuilderRecoveryChanged, currentBuilderRecovery());
}

/** Return the builder-recovery state for the active run (issue #55). */
function handleGetBuilderRecovery(): BuilderRecoveryState {
  return currentBuilderRecovery();
}

/**
 * Recover a `builder_running` run whose builder PTY is gone (issue #55): relaunch
 * the builder session and re-deliver the *existing* pointer-first handoff prompt.
 * This is an explicit operator action — GodMode never auto-relaunches or silently
 * re-sends. The relaunch reuses the same cwd safety gate as the original send: an
 * isolated run's worktree is re-validated and the PTY launches inside it before any
 * prompt is written, so re-delivery can never land in the shared checkout. The
 * re-delivery is recorded on the run's prompt log for audit, and the run stays in
 * `builder_running` (re-delivery records that the prompt was sent, never that the
 * task succeeded). The alternative recovery — marking the agent failed — flows
 * through the existing `report_agent_failed` interrupt edge.
 *
 * Recovery acts ONLY on a genuinely lost session (the live-PTY guard below), and the
 * relaunched PTY shares the same renderer-ownership cleanup and a `pty:started`
 * signal as a normal pane start, so the builder pane reflects the recovered live
 * session instead of a process state that is not true (reviewer-a A-1 / reviewer-b
 * B-2). See docs/architecture/builder-recovery.md.
 */
async function handleRelaunchBuilder(event: Electron.IpcMainInvokeEvent): Promise<HandoffSendResult> {
  let run = getCurrentRun();
  if (!run) {
    return { ok: false, code: 'no_run', error: 'There is no active run to relaunch the builder for.', run: null };
  }
  if (run.status !== 'builder_running') {
    return {
      ok: false,
      code: 'invalid_state',
      error: `Builder relaunch is only available while the run is builder-running (current: ${run.status}).`,
      run,
    };
  }
  // Defense-in-depth, matching the UI (the recovery banner only renders when the
  // run is stale): recovery is for a LOST builder, never a live one (reviewer-b
  // B-1 / reviewer-a A-1). Refuse rather than kill+replace a running builder — that
  // would be the opposite of #55's "don't pretend a process state that isn't true".
  // Restarting a live builder stays the builder pane's own job.
  if (hasPtySession('builder')) {
    return {
      ok: false,
      code: 'invalid_state',
      error: 'The builder session is still live; relaunch only recovers a lost session. Use the builder pane to restart it.',
      run,
    };
  }

  // Recompose the pointer-first handoff and apply the SAME sendability gate as the
  // original send: only a bound GitHub issue with no unresolved variables is
  // re-deliverable (a manual task stays blocked, exactly as on first send).
  const handoff = getCurrentHandoff(run);
  if (!handoff.canSend) {
    return { ok: false, code: 'not_sendable', error: handoff.blockedReason ?? 'This handoff is not ready to re-send.', run };
  }

  // Resolve the builder command exactly like a manual pane launch so a non-cli /
  // unconfigured builder fails visibly here rather than spawning.
  const launch = resolveRoleLaunch('builder');
  if (!launch.ok) {
    return { ok: false, code: 'no_builder_session', error: launch.error, run };
  }

  // Isolation (issue #41): re-validate/re-create the run worktree and launch the
  // builder INSIDE it. A worktree failure is visible and nothing is relaunched.
  // Snapshot the run identity and project root taken BEFORE the await so we can
  // detect if the world moved out from under us during worktree preparation.
  const originalRunId = run.id;
  const projectRoot = getSelectedProjectRoot();
  const ensured = await ensureRunWorktree(run);
  if (ensured.mode === 'worktree' && !ensured.ok) {
    return { ok: false, code: 'worktree_failed', error: `Run worktree setup failed: ${ensured.error}`, run: getCurrentRun() };
  }
  run = getCurrentRun() ?? run;
  let cwd = projectRoot;
  let worktreePath: string | undefined;
  if (ensured.mode === 'worktree' && ensured.ok) {
    cwd = ensured.worktree.path;
    worktreePath = ensured.worktree.path;
  }

  // Re-validate the authoritative state immediately before the destructive spawn
  // (reviewer-b B-1). The guards near the top of this handler were a pre-await
  // snapshot, but `ensureRunWorktree` yields the event loop — during that await the
  // operator can start the builder from the pane, switch projects, or move to a
  // different run. `openPtySession` kills any existing builder PTY (src/main/pty.ts),
  // so spawning now could clobber a live builder or launch from a stale run/project
  // context. Re-read the current run, project root, and live-PTY state and refuse
  // (typed `invalid_state`) instead of spawning if anything changed under us.
  const liveRun = getCurrentRun();
  if (!liveRun || liveRun.id !== originalRunId || liveRun.status !== 'builder_running') {
    return {
      ok: false,
      code: 'invalid_state',
      error: 'The active run changed while preparing the builder relaunch; recovery was preempted. Re-open the recovery banner if the run is still stale.',
      run: liveRun,
    };
  }
  if (getSelectedProjectRoot() !== projectRoot) {
    return {
      ok: false,
      code: 'invalid_state',
      error: 'The selected project changed while preparing the builder relaunch; recovery was preempted.',
      run: liveRun,
    };
  }
  if (hasPtySession('builder')) {
    return {
      ok: false,
      code: 'invalid_state',
      error: 'A builder session became live while preparing the relaunch; recovery only recovers a lost session. Use the builder pane to restart it.',
      run: liveRun,
    };
  }
  run = liveRun;

  // Take renderer ownership of the relaunched session exactly like handleStartPty:
  // a window destroy or navigation must stop the recovered builder, never orphan it.
  const stopOwnedSession = () => stopPtySession('builder');
  event.sender.once('destroyed', stopOwnedSession);
  event.sender.once('did-start-navigation', stopOwnedSession);

  // Launch a fresh builder PTY (the prior session is already gone — guarded above)
  // in the gated cwd, streaming to the builder pane just like a renderer-driven
  // start. A builder exit still surfaces the #38 PR-discovery hint and refreshes the
  // recovery banner.
  const result = openPtySession({
    paneId: 'builder',
    projectRoot,
    cwd,
    worktreePath,
    command: launch.spec.command,
    onData: (data) => emitToRenderer(GODMODE_IPC.ptyData, { paneId: 'builder', data }),
    onExit: (exit) => {
      emitToRenderer(GODMODE_IPC.ptyExit, { paneId: 'builder', exit });
      emitBuilderRecoveryChanged();
      void handleBuilderExit();
    },
  });
  if (!result.ok) {
    return { ok: false, code: 'no_builder_session', error: `Builder relaunch failed: ${result.error}`, run };
  }
  // Tell the builder pane a session is now live so it reflects running/Stop-enabled
  // state — this relaunch happened in main, not via the pane's own start() click.
  emitToRenderer(GODMODE_IPC.ptyStarted, { paneId: 'builder' });

  // Re-deliver the pointer-first prompt into the fresh PTY and record the re-send
  // for audit (the trailing carriage return commits the line, as on first send).
  writeToPtySession('builder', `${handoff.prompt}\r`);
  const updated =
    recordCurrentRunPrompt({
      role: 'builder',
      digest: promptDigest(handoff.prompt),
      promptChars: handoff.prompt.length,
    }) ?? run;
  emitRunChanged(updated);
  emitBuilderRecoveryChanged();
  return { ok: true, run: updated };
}

/**
 * Run the builder branch/PR/commit verification gate (#9) for the operated
 * project. Reads live `gh`/`git` state (never agent self-report): resolves the
 * expected commit from the current run (run-recorded, else local HEAD), compares
 * it against the PR for the current branch, and derives a verification status.
 * When a run is active the result is appended to its history for audit. The
 * verification itself never throws — failures fold into its `status`/`partial`.
 */
async function handleVerifyRun(): Promise<RunVerificationResult> {
  const run = getCurrentRun();
  // Verify against the run's recorded branch (the bound #38 evidence) when a run is
  // active, for both shared and worktree runs — the operator's current checkout is
  // never authoritative once a PR branch is bound. With no run, fall back to the
  // operated project's current branch.
  const verification = await getCommitVerification(
    getSelectedProjectRoot(),
    { expectedCommit: run?.expectedCommit, branch: run?.branch },
    new Date().toISOString(),
  );
  // Persist the result on the current run for an auditable evidence trail. With
  // no active run, verification still runs (branch + local HEAD) but is not
  // recorded anywhere — `run` comes back null.
  const updatedRun = recordCurrentRunVerification(verification);
  return { verification, run: updatedRun };
}

/** Push a payload to the renderer if a live window exists (mirrors `projectChanged`). */
function emitToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** Push the latest run snapshot so async reviewer lifecycle changes reach the UI. */
function emitRunChanged(run: RunSnapshot | null): void {
  emitToRenderer(GODMODE_IPC.runChanged, run);
}

/** Push the latest loop-controller state to the run control pane (issue #39). */
function emitLoopChanged(loop: LoopState): void {
  emitToRenderer(GODMODE_IPC.runLoopChanged, loop);
}

// --- Run persistence + resume wiring (issue #40) -----------------------------

/** Current storage health for the resume surface. */
function currentStorageStatus(): RunStorageStatus {
  return { backend: storageBackend, degraded: storageDegraded, message: storageMessage };
}

/**
 * Write-through persistence hook installed on the run controller (issue #40).
 * Every accepted mutation funnels its new snapshot here: persist it to the
 * operated project's run store (synchronous, so killing the app right after a
 * transition loses nothing) and mirror the human-readable `run.json`. A failed
 * write degrades to in-memory with a one-time visible warning instead of crashing
 * or pretending to persist. The run belongs to the selected operated project, so
 * the store lives under that root — never the GodMode app repo, unless it *is* the
 * operated project (dogfooding).
 */
function persistCurrentRun(run: RunSnapshot): void {
  const root = getSelectedProjectRoot();
  const result = saveRun(root, run);
  storageBackend = result.backend;
  if (!result.ok) {
    if (!storageDegraded) {
      storageDegraded = true;
      storageMessage =
        `Run state could not be persisted (${result.error}). GodMode will keep running, ` +
        'but this run will not survive a restart until the operated project is writable.';
      emitResumeChanged();
    }
  } else if (storageDegraded) {
    // A later write succeeded — clear the degraded banner so it is not sticky.
    storageDegraded = false;
    storageMessage = undefined;
    emitResumeChanged();
  }
  // Best-effort human-readable mirror alongside the reviewer logs / findings.json.
  writeRunSnapshot(root, run.id, run);
}

/**
 * The resume surface for the selected project: an unfinished-run offer (mutually
 * exclusive with an active in-memory run — GodMode never auto-resumes) plus the
 * storage health so a degraded, in-memory-only state stays visible.
 */
function buildResumeState(): RunResumeState {
  const root = getSelectedProjectRoot();
  if (getCurrentRun()) {
    storageBackend = storeBackendKind(root);
    return { offer: null, storage: currentStorageStatus() };
  }
  const loaded = loadUnfinishedRun(root);
  storageBackend = loaded ? loaded.backend : preferredBackendKind();
  return {
    offer: loaded ? { run: loaded.run, storage: loaded.backend } : null,
    storage: currentStorageStatus(),
  };
}

/** Push the resume surface to the renderer (project switch, save failure, resume/discard). */
function emitResumeChanged(): void {
  emitToRenderer(GODMODE_IPC.runResumeChanged, buildResumeState());
}

/** Return the resume surface for the selected project (issue #40). */
function handleGetResume(): RunResumeState {
  return buildResumeState();
}

/**
 * Resume the persisted unfinished run for the selected project (issue #40). The
 * snapshot is restored through the normal model — previously-live PTY/reviewer
 * sessions are marked dead/stale and `availableActions` is recomputed — and then
 * revalidated against reality: if the recorded PR no longer matches what GitHub
 * reports (and GitHub is reachable), the resumed run is routed to `needs_human`
 * with a visible reason instead of continuing blind. Never auto-resumes; only
 * runs on the explicit operator choice.
 */
async function handleResume(): Promise<RunResumeResult> {
  if (getCurrentRun()) {
    return { ok: false, code: 'invalid', error: 'A run is already active; clear it before resuming another.' };
  }
  const root = getSelectedProjectRoot();
  const loaded = loadUnfinishedRun(root);
  if (!loaded) {
    return { ok: false, code: 'no_offer', error: 'There is no unfinished run to resume for this project.' };
  }

  // Restore through the state machine: dead sessions + recomputed actions.
  let restored = adoptResumedRun(loaded.run);
  // A resumed run starts supervised by the operator: reset the loop controller so
  // no stale auto-mode/watcher carries across the restart (it re-arms on request).
  resetLoopController();

  // Revalidate the recorded PR against reality with the read-only evidence gate.
  // Only a *definitive* mismatch routes to needs_human; an unreachable GitHub
  // (partial/needs_refresh) is surfaced but does not blindly escalate.
  let routedToNeedsHuman = false;
  let note: string | undefined;
  if (restored.prNumber !== undefined && !isTerminalStatus(restored.status)) {
    const verification = await getCommitVerification(
      root,
      { expectedCommit: restored.expectedCommit, branch: restored.branch },
      new Date().toISOString(),
    );
    // Re-confirm we still own this run/root after the await.
    const live = getCurrentRun();
    if (live && live.id === restored.id && getSelectedProjectRoot() === root) {
      restored = recordCurrentRunVerification(verification) ?? restored;
      const mismatch = prMismatchReason(restored.prNumber, verification);
      if (mismatch) {
        if (restored.status === 'needs_human') {
          // Already parked for a human (e.g. persisted mid-escalation): surface
          // the mismatch reason without a redundant (and illegal) self-transition.
          routedToNeedsHuman = true;
          note = mismatch;
        } else {
          // Every non-terminal status that can carry a recorded PR now has a legal
          // `flag_needs_human` edge (see run.ts recovery edges), so this routes
          // rather than silently leaving the run continuing blind.
          const flagged = dispatchRunAction('flag_needs_human', {
            reason: `Resumed run revalidation: ${mismatch}`,
            actor: 'operator',
          });
          if (flagged.ok) {
            restored = flagged.run;
            routedToNeedsHuman = true;
            note = mismatch;
          } else {
            // Defensive: should be unreachable, but never hide a real mismatch.
            note = `Recorded PR mismatch on resume (${mismatch}) could not be routed to needs_human from status "${restored.status}".`;
          }
        }
      }
    }
  }

  emitRunChanged(restored);
  emitResumeChanged();
  // A resumed `builder_running` run has no live builder PTY (it cannot survive a
  // restart), so surface the stale-session recovery banner right away (issue #55).
  emitBuilderRecoveryChanged();
  void tickLoop();
  return { ok: true, run: restored, routedToNeedsHuman, note };
}

/**
 * Whether a resumed run's recorded PR no longer matches GitHub reality (issue
 * #40). Returns a human-readable reason on a definitive mismatch, or null when it
 * still matches or the evidence is merely incomplete (GitHub unreachable).
 */
function prMismatchReason(prNumber: number | undefined, verification: CommitVerification): string | null {
  if (prNumber === undefined) return null;
  // Incomplete evidence (gh missing/unauthenticated/network) is not a mismatch.
  if (verification.partial || verification.status === 'needs_refresh') return null;
  if (!verification.pr) {
    return `the recorded PR #${prNumber} could not be found for the run's branch on GitHub.`;
  }
  if (verification.pr.number !== prNumber) {
    return `the branch's PR on GitHub is #${verification.pr.number}, not the recorded #${prNumber}.`;
  }
  if (verification.prState && verification.prState !== 'OPEN' && !verification.mergeConfirmed) {
    return `the recorded PR #${prNumber} is ${verification.prState.toLowerCase()} on GitHub, not open.`;
  }
  return null;
}

/**
 * Discard the persisted unfinished run for the selected project (issue #40):
 * archive it (kept in the store as history — never silently deleted) and clear any
 * in-memory copy so the dashboard starts clean.
 */
function handleDiscard(): RunDiscardResult {
  const root = getSelectedProjectRoot();
  const loaded = loadUnfinishedRun(root);
  if (!loaded) {
    // Nothing persisted to discard; ensure a clean in-memory slate regardless.
    clearRun();
    resetLoopController();
    emitResumeChanged();
    return { ok: true };
  }
  const archived = archiveRun(root, loaded.run.id);
  clearRun();
  resetLoopController();
  emitRunChanged(null);
  emitResumeChanged();
  return archived ? { ok: true } : { ok: false, error: 'The run could not be archived in the store.' };
}

/**
 * Build the PR-discovery matching context from a run (issue #38): its issue
 * number (for the `#N` link match) and the builder handoff send time (for the
 * conservative recent-unlinked fallback). The handoff time is the first builder
 * prompt recorded on the run; absent it, discovery skips the recent fallback and
 * relies on the explicit issue link only.
 */
function discoveryContext(run: RunSnapshot): DiscoveryContext {
  const builderPrompt = run.prompts.find((entry) => entry.role === 'builder');
  return { issueNumber: run.issueNumber, handoffSentAt: builderPrompt?.at };
}

/**
 * Discover the builder's PR for the current run from read-only GitHub evidence
 * (issue #38). Lists open PRs scoped to the operated project and classifies
 * candidates by issue link / recent-unlinked fallback. Never throws or mutates:
 * with no active run it returns an error-status result with no candidates, and
 * every `gh` failure folds into the result so the run stays in `builder_running`.
 */
function handleDiscoverPr(): Promise<PrDiscoveryResult> {
  const now = new Date().toISOString();
  const run = getCurrentRun();
  if (!run) {
    return Promise.resolve({
      status: 'error',
      message: 'There is no active run to discover a PR for.',
      candidates: [],
      recommendedPrNumber: null,
      fetchedAt: now,
    });
  }
  return discoverRunPrCandidates(getSelectedProjectRoot(), discoveryContext(run), now);
}

/**
 * Confirm a discovered PR candidate (issue #38): bind its branch / number / head
 * commit to the run through the existing `open_pr` guard, then immediately run the
 * #9 commit-verification gate and record it — so confirmation always carries
 * evidence (branch, PR number, expected commit) and the operator sees the
 * verification result right away. The transition-log reason names the PR and how
 * it matched. Only valid from `builder_running`; a rejected confirm leaves the run
 * untouched.
 */
async function handleConfirmPrCandidate(
  _event: Electron.IpcMainInvokeEvent,
  input: unknown,
): Promise<ConfirmPrCandidateResult> {
  const payload = parseIpcPayload(runPrConfirmSchema, input);
  if (!payload) {
    return { ok: false, code: 'invalid_payload', error: 'Invalid PR candidate payload.', run: getCurrentRun() };
  }
  const run = getCurrentRun();
  if (!run) {
    return { ok: false, code: 'no_run', error: 'There is no active run to bind a PR to.', run: null };
  }
  if (run.status !== 'builder_running') {
    return {
      ok: false,
      code: 'invalid_state',
      error: `A PR candidate is confirmed from a builder-running run (current: ${run.status}).`,
      run,
    };
  }

  // A manual/operator confirm is an observable event the loop re-syncs from; it
  // preempts any in-flight loop stage exactly like a raw dispatch (issue #39).
  preemptLoopStages();
  const matched = payload.matchReason === 'recent_unlinked' ? 'recent unlinked PR' : 'issue link';
  const reason =
    `PR #${payload.prNumber} discovered by ${matched} on branch ${payload.branch} ` +
    `at commit ${payload.expectedCommit.slice(0, 7)}; bound as open_pr evidence.`;
  const opened = dispatchRunAction('open_pr', {
    branch: payload.branch,
    prNumber: payload.prNumber,
    expectedCommit: payload.expectedCommit,
    reason,
  });
  if (!opened.ok) {
    return { ok: false, code: 'invalid_transition', error: opened.error, run: opened.run };
  }

  // Capture the run/root the confirmation belongs to before the async gate below,
  // so a project switch during the await can't record verification onto a
  // different run or emit a stale snapshot (mirrors handleStartReviewers).
  const bound = opened.run;
  const captured = { runId: bound.id, root: getSelectedProjectRoot() };

  // Immediately run the #9 evidence gate against the freshly bound coordinates and
  // record it, so the verification pane reflects the confirmation right away.
  // Verify against the *discovered* PR branch (the bound evidence), not the
  // operator's current checkout: a shared-mode confirm whose checkout sits on
  // `main`/detached must still verify the bound PR branch, exactly like a worktree
  // run. `getCommitVerification` resolves the branch tip correctly for both modes.
  const verification = await getCommitVerification(
    captured.root,
    { expectedCommit: bound.expectedCommit, branch: bound.branch },
    new Date().toISOString(),
  );

  // Stale guard: the operator may have switched the operated project (or cleared/
  // replaced the run) during the await above — `selectProjectAndResetSessions`
  // clears the run. Re-confirm the same run and root before recording/emitting, so
  // a stale invocation can't patch verification onto a run/root it no longer owns.
  if (isReviewerRunContextStale({ runId: getCurrentRun()?.id ?? null, root: getSelectedProjectRoot() }, captured)) {
    return {
      ok: false,
      code: 'invalid_state',
      error: 'The run or operated project changed during verification; the PR confirmation was not recorded.',
      run: getCurrentRun(),
    };
  }

  const updated = recordCurrentRunVerification(verification) ?? bound;
  emitRunChanged(updated);
  void tickLoop();
  return { ok: true, run: updated, verification };
}

/**
 * React to the builder pane's PTY exiting during `builder_running` (issue #38):
 * surface a non-blocking hint and run **one** discovery pass so a freshly opened
 * PR shows up without the operator alt-tabbing to a terminal. PTY exit alone must
 * never transition the run — this only pushes a hint + candidates; the operator
 * still confirms. A no-op unless a run is in `builder_running`.
 */
async function handleBuilderExit(): Promise<void> {
  const run = getCurrentRun();
  if (!run || run.status !== 'builder_running') return;
  const captured = { runId: run.id, root: getSelectedProjectRoot() };
  const discovery = await discoverRunPrCandidates(captured.root, discoveryContext(run), new Date().toISOString());
  // The operator may have switched project or cleared/replaced the run during the
  // await; don't push a discovery scoped to a run/root that is no longer current.
  const live = getCurrentRun();
  if (!live || live.id !== captured.runId || getSelectedProjectRoot() !== captured.root) return;
  emitToRenderer(GODMODE_IPC.runPrDiscovered, {
    hint: 'Builder session ended — check for the PR it opened.',
    discovery,
  });
}

/**
 * Post one reviewer's concise role-signed marker comment to the run's PR and
 * record the outcome on its tracked session (issue #10). Shared by the auto-post
 * on a clean session exit and the operator override.
 *
 * A *session* failure (launch/capture/non-zero exit) is terminal and refused
 * here: only a session that actually ran (`completed`/`comment_posted`/`running`)
 * is postable, so a failed reviewer can never be turned into the confirmed-success
 * `comment_posted` state. A *comment-post* failure is recorded on the separate
 * `commentError` field (not the session `error`/status), so it stays retryable via
 * the override without masking, or being masked by, the session's own outcome.
 * `runChanged` is emitted either way so the dashboard reflects the result.
 */
async function postReviewerCommentAndRecord(paneId: AgentRole): Promise<ReviewerCommentResult> {
  const run = getCurrentRun();
  if (!run) {
    return { ok: false, code: 'no_run', error: 'There is no active run.', run: null };
  }
  const session = run.reviewers?.find((reviewer) => reviewer.paneId === paneId);
  if (!session) {
    return { ok: false, code: 'unknown_reviewer', error: `No tracked reviewer session for pane ${paneId}.`, run };
  }
  // A failed (or not-yet-run) session must never become green via a marker post.
  if (!canPostReviewerMarker(session.status)) {
    return {
      ok: false,
      code: 'invalid_state',
      error: `Reviewer ${session.reviewerId} did not complete (${session.status}); its marker comment cannot be posted.`,
      run,
    };
  }
  if (run.prNumber === undefined) {
    const updated =
      updateCurrentRunReviewer(paneId, {
        commentError: 'No PR number recorded for this run; cannot post a reviewer comment.',
      }) ?? run;
    emitRunChanged(updated);
    return { ok: false, code: 'no_pr', error: 'No PR number is recorded for this run.', run: updated };
  }

  const artifactRelPath = session.artifactPath ?? reviewerArtifactRelPath(run.id, session.reviewerId);
  const body = reviewerCommentBody({
    reviewerId: session.reviewerId,
    displayName: session.displayName,
    roleDoc: session.roleDoc,
    prNumber: run.prNumber,
    branch: run.branch,
    artifactRelPath,
  });

  // Capture the run/root AND this reviewer's per-launch session token before the
  // live `gh` call so we can confirm they still match after the await — the
  // operator may switch project, clear the run, start another run, or relaunch
  // reviewers in the same run mid-post.
  const captured = { runId: run.id, root: getSelectedProjectRoot() };
  const capturedToken = session.sessionToken;
  const result = await postPrComment(captured.root, run.prNumber, body);

  // Stale guard (cross-run/project): if the run or operated project changed while
  // the comment posted, do NOT patch whatever run is now current (a different run
  // shares pane ids) or push a stale snapshot. The comment did reach GitHub; we
  // just don't mutate the wrong run.
  if (isReviewerRunContextStale({ runId: getCurrentRun()?.id ?? null, root: getSelectedProjectRoot() }, captured)) {
    return {
      ok: false,
      code: 'invalid_state',
      error: 'The run or operated project changed while posting the reviewer comment; no run state was changed.',
      run: getCurrentRun(),
    };
  }

  // Stale guard (same-run relaunch): even with the run id and root unchanged, an
  // idempotent reviewer relaunch replaces the tracked session under this pane. If
  // that happened during the await, the freshly relaunched session must not be
  // stamped `comment_posted`/`commentError` from this older post — its token
  // differs from the one captured above.
  const currentSession = getCurrentRun()?.reviewers?.find((reviewer) => reviewer.paneId === paneId);
  if (isReviewerSessionStale(currentSession?.sessionToken, capturedToken)) {
    return {
      ok: false,
      code: 'invalid_state',
      error: 'The reviewer session was relaunched while posting its comment; no run state was changed.',
      run: getCurrentRun(),
    };
  }

  if (!result.ok) {
    // Record on `commentError`, not the session status: the session outcome is
    // unchanged and the post stays retryable via the override.
    const updated =
      updateCurrentRunReviewer(paneId, { commentError: `Comment post failed: ${result.message}` }) ?? run;
    emitRunChanged(updated);
    return { ok: false, code: 'comment_failed', error: result.message, run: updated };
  }

  const updated =
    updateCurrentRunReviewer(paneId, {
      status: 'comment_posted',
      commentPosted: true,
      commentUrl: result.url,
      commentError: undefined,
    }) ?? run;
  emitRunChanged(updated);
  // The PR now has a new comment, so the operated project's GitHub snapshot is
  // stale — signal the GitHub pane to refetch (issue #10: refresh after posting).
  emitToRenderer(GODMODE_IPC.githubChanged, undefined);
  return { ok: true, run: updated, commentUrl: result.url };
}

/** The per-launch token currently tracked for a reviewer pane, if any. */
function currentReviewerToken(paneId: AgentRole): string | undefined {
  return getCurrentRun()?.reviewers?.find((reviewer) => reviewer.paneId === paneId)?.sessionToken;
}

/**
 * Handle a reviewer PTY session exit: mark the session `completed` (capturing the
 * exit code), then auto-post the role-signed marker comment. A reviewer that
 * already failed to launch has no live session, so this only fires for sessions
 * that actually ran.
 *
 * `sessionToken` is the launch this PTY belonged to. A prior launch's PTY is
 * killed only when its pane's `openPtySession` runs, so on a same-run relaunch an
 * old PTY can exit during the spawn window and fire this with the previous token
 * while the tracked record already carries the new one. Such a stale exit is
 * refused so it can never complete/post — or fail — the freshly launched session.
 */
async function handleReviewerExit(paneId: AgentRole, exitCode: number, sessionToken: string): Promise<void> {
  const run = getCurrentRun();
  const session = run?.reviewers?.find((reviewer) => reviewer.paneId === paneId);
  if (!session) return;
  if (isReviewerSessionStale(session.sessionToken, sessionToken)) return;

  const outcome = resolveReviewerExit(session.status, exitCode);
  // A capture failure mid-session already marked this reviewer `failed`; record
  // the exit code for audit but never flip it back to a success state.
  if (outcome.kind === 'keep_failed') {
    emitRunChanged(updateCurrentRunReviewer(paneId, { exitCode }));
    return;
  }
  // A non-zero exit is a reviewer command failure: surface it visibly and do NOT
  // auto-post a marker (which the UI treats as confirmed success).
  if (outcome.kind === 'failed') {
    emitRunChanged(updateCurrentRunReviewer(paneId, { status: 'failed', exitCode, error: outcome.error }));
    return;
  }
  // Clean exit: mark completed, then auto-post the role-signed marker comment.
  emitRunChanged(updateCurrentRunReviewer(paneId, { status: 'completed', exitCode }));
  await postReviewerCommentAndRecord(paneId);
  // A reviewer reaching a terminal state is an observable event the loop reacts
  // to (auto mode: both reviewers done → synthesize). No-op in manual mode.
  await tickLoop();
}

/**
 * Launch Reviewer A and B from a verified PR (issue #10). Order of operations:
 * re-run the #9 commit-verification gate live and record it — plain PR existence
 * or an agent self-report is never enough — and refuse to launch unless it is
 * `verified`. Then compose pointer-first prompts bound to the verified PR, prepare
 * the run-artifact dir, and launch each configured reviewer independently in the
 * operated-project root, capturing stdout/stderr to a local artifact and writing
 * the prompt into the session. Each reviewer's lifecycle is tracked on the run so
 * a launch failure is visible and never silently marked complete.
 *
 * Reviewers launch both after the first PR (`pr_opened`) and after a builder fix
 * (`fix_pushed`), plus idempotent relaunch while reviewers are already running in
 * either cycle. The matching forward action (`start_reviewers` / `rerun_reviewers`)
 * is resolved by {@link reviewerLaunchTransition} and dispatched once launched,
 * recording the PR number/branch so the later comment post has its coordinates.
 */
async function handleStartReviewers(actor: TransitionActor = 'operator'): Promise<StartReviewersResult> {
  const run = getCurrentRun();
  if (!run) {
    return { ok: false, code: 'no_run', error: 'There is no active run to start reviewers for.', run: null };
  }
  const transition = reviewerLaunchTransition(run.status);
  if (!transition.allowed) {
    return {
      ok: false,
      code: 'invalid_state',
      error: `Reviewers start from a PR-opened or fix-pushed run (current: ${run.status}).`,
      run,
    };
  }

  // Loop-stage preemption (issue #39, blocker B-1). A loop-driven launch captures
  // the controller's preemption generation BEFORE awaiting verification below; a
  // manual/operator launch instead BUMPS the generation so it preempts any loop
  // stage already in flight. This is what lets a manual dispatch that advances the
  // run into another launch-legal status (e.g. `pr_opened → reviewers_running`)
  // invalidate the stale loop stage that a status-only guard would wave through.
  const isLoopDriven = actor === 'loop';
  const stageGeneration = isLoopDriven ? captureLoopStageGeneration() : 0;
  if (!isLoopDriven) preemptLoopStages();

  const captured = { runId: run.id, root: getSelectedProjectRoot() };
  const projectRoot = captured.root;
  const now = new Date().toISOString();

  // #9 evidence gate: re-verify live and record it. Never trust plain PR
  // existence or an agent self-report as enough to launch reviewers. Verify
  // against the run's recorded branch (the bound #38 evidence) for both shared and
  // worktree runs: an isolated run's branch lives in its worktree, and a shared run
  // can have a checkout that isn't on the PR branch, so the local branch is never
  // authoritative once a PR branch is bound.
  const verification = await getCommitVerification(
    projectRoot,
    { expectedCommit: run.expectedCommit, branch: run.branch },
    now,
  );

  // Stale guard: the operator may have switched the operated project (or cleared
  // the run) during the await above — `selectProjectAndResetSessions` clears the
  // run and kills sessions. Re-confirm the same run and root before any side
  // effect, so a stale invocation can never spawn PTYs or write artifacts into a
  // root the run no longer belongs to (AGENTS.md operated-project safety rule).
  if (isReviewerRunContextStale({ runId: getCurrentRun()?.id ?? null, root: getSelectedProjectRoot() }, captured)) {
    return {
      ok: false,
      code: 'invalid_state',
      error: 'The run or operated project changed during verification; reviewers were not launched.',
      run: getCurrentRun(),
      verification,
    };
  }

  // Preemption guard (issue #39, blocker B-1). Two signals abort a loop-driven
  // launch after the await, before ANY side effect (reviewer-record install,
  // artifact prep, PTY spawn, prompt write, transition):
  //   1. generation-stale — an operator/manual dispatch, pause, or mode toggle
  //      bumped the loop-stage generation during the await, EVEN if it advanced
  //      the run into another launch-legal status (`reviewers_running`) that a
  //      status-only guard would treat as a legal idempotent relaunch;
  //   2. status preemption — the run left the launch-legal window (paused/
  //      cancelled/terminal) without necessarily bumping the generation.
  // Operator-driven launches (`generationStale = false`) keep their authority and
  // are gated only by the status signal. Both paths leave id/root unchanged, so
  // the run/root stale guard above cannot catch them.
  const livePreLaunch = getCurrentRun();
  const launchGenerationStale = isLoopDriven && isLoopStageGenerationStale(stageGeneration);
  if (isLoopReviewerLaunchPreempted(livePreLaunch?.status ?? null, launchGenerationStale)) {
    return {
      ok: false,
      code: 'preempted',
      error: launchGenerationStale
        ? `An operator action preempted the loop during verification (run now ${livePreLaunch?.status ?? 'no run'}); reviewers were not launched.`
        : `The run was preempted (now ${livePreLaunch?.status ?? 'no run'}) during verification; reviewers were not launched.`,
      run: livePreLaunch,
      verification,
    };
  }

  let updated = recordCurrentRunVerification(verification) ?? run;
  if (verification.status !== 'verified' || !verification.pr) {
    emitRunChanged(updated);
    return { ok: false, code: 'not_verified', error: verification.message, run: updated, verification };
  }

  const loaded = loadConfig();
  const config = loaded.status === 'loaded' ? loaded.config : DEFAULT_CONFIG;
  const pr = {
    number: verification.pr.number,
    url: verification.pr.url,
    branch: verification.pr.headRefName || verification.branch || '',
  };
  const plan = composeReviewerLaunch(config, updated, { projectName: loaded.projectName, pr, verified: true });
  if (plan.reviewers.length === 0) {
    return {
      ok: false,
      code: 'no_reviewers_configured',
      error: 'No reviewers are configured for this project.',
      run: updated,
      verification,
    };
  }
  if (!plan.canStart) {
    return {
      ok: false,
      code: 'not_startable',
      error: plan.blockedReason ?? 'Reviewers are not ready to launch.',
      run: updated,
      verification,
    };
  }

  ensureRunArtifactDir(projectRoot, updated.id);

  // One fresh per-launch identity per reviewer, shared by the tracked record AND
  // that launch's PTY callbacks. An idempotent same-run relaunch installs new
  // tokens here but the prior launch's PTYs are killed only when each pane's
  // openPtySession runs below — so an old PTY can still exit/emit during the
  // spawn window. Carrying the token into the callbacks lets a stale one be told
  // apart from the freshly installed session and refused (delayed marker posts
  // are guarded the same way after their `gh` await).
  const launchTokens = new Map<AgentRole, string>(
    plan.reviewers.map((reviewer) => [reviewer.paneId, randomUUID()]),
  );

  // Record every reviewer as `launching` first so the dashboard shows tracked
  // reviewers even when a subsequent launch fails.
  updated =
    setCurrentRunReviewers(
      plan.reviewers.map((reviewer) => ({
        reviewerId: reviewer.reviewerId,
        paneId: reviewer.paneId,
        sessionToken: launchTokens.get(reviewer.paneId) ?? randomUUID(),
        displayName: reviewer.displayName,
        roleDoc: reviewer.roleDoc,
        status: 'launching' as const,
        artifactPath: reviewerArtifactRelPath(updated.id, reviewer.reviewerId),
        promptChars: reviewer.prompt.length,
        commentPosted: false,
      })),
      now,
    ) ?? updated;

  let launched = 0;
  for (const reviewer of plan.reviewers) {
    // Reuse the role→command resolver so the cli-adapter gate and visible errors
    // are identical to a manual pane launch (non-cli adapters fail visibly here).
    const resolved = resolveRoleLaunch(reviewer.paneId);
    if (!resolved.ok) {
      updateCurrentRunReviewer(reviewer.paneId, { status: 'failed', error: resolved.error });
      continue;
    }

    const absArtifact = reviewerArtifactPath(projectRoot, updated.id, reviewer.reviewerId);
    const relArtifact = reviewerArtifactRelPath(updated.id, reviewer.reviewerId);
    // A one-shot reviewer reads its prompt and exits, so deliver the prompt as a
    // launch argument (present at spawn) rather than writing it into the PTY
    // afterward, which could no-op against an already-exited process and lose the
    // prompt. Interactive reviewers stay live, so the prompt is written in.
    const oneshot = resolved.spec.mode === 'oneshot';
    // This launch's identity, closed over by its PTY callbacks so a stale
    // callback from a prior same-run launch can never patch the fresh session.
    const sessionToken = launchTokens.get(reviewer.paneId) ?? randomUUID();
    // Capture is best-effort, but a capture *failure* must be visible, not
    // silently dropped. The first failed write flips the reviewer to `failed`
    // (once), and the exit handler then skips marking it completed/comment-posted.
    let captureFailed = false;
    const result = openPtySession({
      paneId: reviewer.paneId,
      projectRoot,
      command: resolved.spec.command,
      extraArgs: oneshot ? [reviewer.prompt] : undefined,
      onData: (data) => {
        if (!appendArtifact(absArtifact, data) && !captureFailed) {
          captureFailed = true;
          // Only patch if the tracked session is still this launch's: a relaunch
          // may have replaced it under this pane while the old PTY drained.
          if (!isReviewerSessionStale(currentReviewerToken(reviewer.paneId), sessionToken)) {
            updateCurrentRunReviewer(reviewer.paneId, {
              status: 'failed',
              error: `Output capture failed: could not write ${relArtifact}.`,
            });
            emitRunChanged(getCurrentRun());
          }
        }
        emitToRenderer(GODMODE_IPC.ptyData, { paneId: reviewer.paneId, data });
      },
      onExit: (exit) => {
        emitToRenderer(GODMODE_IPC.ptyExit, { paneId: reviewer.paneId, exit });
        void handleReviewerExit(reviewer.paneId, exit.exitCode, sessionToken);
      },
    });
    if (!result.ok) {
      updateCurrentRunReviewer(reviewer.paneId, { status: 'failed', error: `Launch failed: ${result.error}` });
      continue;
    }

    // Interactive delivery only: stream the pointer-first prompt into the live
    // reviewer PTY (the trailing carriage return commits the line). One-shot
    // reviewers already received it as a launch argument above.
    if (!oneshot) writeToPtySession(reviewer.paneId, `${reviewer.prompt}\r`);
    updateCurrentRunReviewer(reviewer.paneId, { status: 'running', pid: result.pid });
    launched += 1;
  }

  if (launched === 0) {
    updated = getCurrentRun() ?? updated;
    emitRunChanged(updated);
    return {
      ok: false,
      code: 'not_startable',
      error: 'All reviewer launches failed; see the reviewer statuses for the reason.',
      run: updated,
      verification,
    };
  }

  // Advance through the matching forward action once (start_reviewers from
  // pr_opened, rerun_reviewers from fix_pushed), recording the PR number/branch
  // so the later comment post has its coordinates. An idempotent relaunch
  // (reviewers already running) has no transition and keeps its coordinates.
  if (transition.action) {
    const advanced = dispatchRunAction(transition.action, {
      reason: `Launched ${launched} reviewer session(s) for PR #${pr.number}.`,
      prNumber: pr.number,
      branch: pr.branch,
      actor,
    });
    if (advanced.ok) updated = advanced.run;
  }
  updated = getCurrentRun() ?? updated;
  emitRunChanged(updated);
  return { ok: true, run: updated, verification };
}

/**
 * Operator override / re-post for one reviewer's marker comment (issue #10):
 * post (or re-post) the role-signed marker for the named reviewer pane. Used for
 * interactive reviewers that never exit, or to retry a failed post.
 */
function handlePostReviewerComment(
  _event: Electron.IpcMainInvokeEvent,
  input: unknown,
): Promise<ReviewerCommentResult> {
  const payload = parseIpcPayload(reviewerCommentSchema, input);
  if (!payload) {
    return Promise.resolve({
      ok: false,
      code: 'unknown_reviewer',
      error: 'Invalid reviewer comment payload.',
      run: getCurrentRun(),
    });
  }
  return postReviewerCommentAndRecord(payload.paneId);
}

/**
 * Parse each tracked reviewer's captured output into a normalized result. A
 * reviewer whose artifact is absent/unreadable (e.g. a launch failure) parses to
 * an ambiguous "no output captured" result rather than being skipped, so it can
 * never silently clear the merge gate.
 */
function parseReviewerResults(run: RunSnapshot, projectRoot: string): ReviewerResult[] {
  const reviewers = run.reviewers ?? [];
  return reviewers.map((session) =>
    parseReviewerOutput({
      reviewerId: session.reviewerId,
      paneId: session.paneId,
      text: readReviewerArtifact(projectRoot, run.id, session.reviewerId) ?? '',
    }),
  );
}

/**
 * Synthesize the reviewer sessions for the current run and drive the first
 * verified fix cycle (issue #11). Order of operations:
 *  1. Re-run the #9 commit-verification gate live and record it — a reviewer
 *     self-report is never enough to mark merge-ready.
 *  2. Parse each reviewer's captured output into normalized findings.
 *  3. Compute the merge gate from the parsed results AND the verified evidence.
 *  4. Persist the findings on the run and to `.godmode/runs/<run-id>/findings.json`.
 *  5. Advance to `review_synthesis`, then route by the recommendation:
 *     - `merge_ready`: mark merge-ready (only reachable with verified evidence);
 *     - `request_fix`: open a fix cycle (or `max_cycles_exceeded` when the budget
 *       is spent) and render the pointer-first fix handoff with normalized blockers;
 *     - `needs_human`: flag for a human (ambiguous/contradictory output);
 *     - `hold`: stay in synthesis (a non-reviewer gate, e.g. an unverified PR).
 */
async function handleSynthesizeReviews(actor: TransitionActor = 'operator'): Promise<ReviewSynthesisResult> {
  const run = getCurrentRun();
  if (!run) {
    return { ok: false, code: 'no_run', error: 'There is no active run to synthesize reviews for.', run: null };
  }
  if (!canSynthesizeReviews(run.status)) {
    return {
      ok: false,
      code: 'invalid_state',
      error: `Reviews are synthesized from a reviewers-running run (current: ${run.status}).`,
      run,
    };
  }
  if (!run.reviewers || run.reviewers.length === 0) {
    return { ok: false, code: 'no_reviewers', error: 'No reviewer sessions are tracked for this run.', run };
  }

  // Loop-stage preemption generation (issue #39, blocker B-1) — see
  // handleStartReviewers. A loop-driven synthesis captures the generation before
  // the await; a manual/operator synthesis bumps it to preempt any in-flight loop
  // stage. This catches a manual dispatch that keeps the run inside the
  // reviewers-running window the status-only synthesis guard treats as legal.
  const isLoopDriven = actor === 'loop';
  const stageGeneration = isLoopDriven ? captureLoopStageGeneration() : 0;
  if (!isLoopDriven) preemptLoopStages();

  const captured = { runId: run.id, root: getSelectedProjectRoot() };
  const projectRoot = captured.root;
  const now = new Date().toISOString();

  // #9 evidence gate: re-verify live and record it. The merge gate consumes this
  // verified status, not plain PR existence or an agent self-report. Verify against
  // the run's recorded branch (the bound #38 evidence) for both shared and worktree
  // runs — the operator's current checkout is never authoritative once a PR branch
  // is bound.
  const verification = await getCommitVerification(
    projectRoot,
    { expectedCommit: run.expectedCommit, branch: run.branch },
    now,
  );

  // Stale guard: the operator may have switched project or cleared/replaced the
  // run during the await. Re-confirm the same run and root before any mutation.
  if (isReviewerRunContextStale({ runId: getCurrentRun()?.id ?? null, root: getSelectedProjectRoot() }, captured)) {
    return {
      ok: false,
      code: 'invalid_state',
      error: 'The run or operated project changed during verification; reviews were not synthesized.',
      run: getCurrentRun(),
      verification,
    };
  }

  // Preemption guard (issue #39, blocker B-1): abort before writing findings or
  // transitioning when either the loop-stage generation went stale (an operator/
  // manual dispatch preempted this loop stage mid-await, even inside the still-
  // legal reviewers-running window) or the run left the synthesis window. Both
  // leave the run id/root unchanged, so the stale guard above cannot catch them.
  const livePreSynth = getCurrentRun();
  const synthGenerationStale = isLoopDriven && isLoopStageGenerationStale(stageGeneration);
  if (isLoopReviewSynthesisPreempted(livePreSynth?.status ?? null, synthGenerationStale)) {
    return {
      ok: false,
      code: 'preempted',
      error: synthGenerationStale
        ? `An operator action preempted the loop during verification (run now ${livePreSynth?.status ?? 'no run'}); reviews were not synthesized.`
        : `The run was preempted (now ${livePreSynth?.status ?? 'no run'}) during verification; reviews were not synthesized.`,
      run: livePreSynth,
      verification,
    };
  }

  let updated = recordCurrentRunVerification(verification) ?? run;

  const results = parseReviewerResults(updated, projectRoot);
  const merge = computeMergeReadiness({ results, verification });
  const blockers = acceptedBlockers(results);
  const findings: RunFindings = {
    runId: updated.id,
    cycle: updated.cycle,
    results,
    merge,
    acceptedBlockers: blockers,
    prUrl: verification.pr?.url,
    fetchedAt: now,
  };
  // Mirror to disk (best-effort) and attach to the run for the dashboard.
  writeRunFindings(projectRoot, updated.id, findings);
  updated = setCurrentRunFindings(findings, now) ?? updated;

  // Advance reviewers_running/reviewers_rerunning → review_synthesis.
  const synthReason = `Synthesized ${results.length} reviewer result(s): ${merge.recommendation}.`;
  const synthesized = dispatchRunAction('synthesize_reviews', { reason: synthReason, actor });
  if (synthesized.ok) updated = synthesized.run;

  let fixHandoff: BuilderHandoff | undefined;

  if (merge.recommendation === 'merge_ready') {
    const marked = dispatchRunAction('mark_merge_ready', {
      reason: 'Both reviewers cleared and the PR commit is verified.',
      actor,
    });
    if (marked.ok) updated = marked.run;
  } else if (merge.recommendation === 'request_fix') {
    if (updated.cycle >= updated.maxCycles) {
      // Budget spent: the state machine forbids another fix cycle. Route to the
      // authoritative terminal-ish state rather than re-requesting a fix.
      const exceeded = dispatchRunAction('exceed_max_cycles', {
        reason: `Fix-cycle budget reached (${updated.cycle}/${updated.maxCycles}) with ${blockers.length} accepted blocker(s) remaining.`,
        actor,
      });
      if (exceeded.ok) updated = exceeded.run;
    } else {
      const requested = dispatchRunAction('request_fix', {
        reason: `${blockers.length} accepted blocker(s) require a fix cycle.`,
        actor,
      });
      if (requested.ok) {
        updated = requested.run;
        // Render the pointer-first fix handoff with normalized blocker text. Not
        // sent here — the operator reviews it, then sends via runSendFix.
        const loaded = loadConfig();
        const config = loaded.status === 'loaded' ? loaded.config : DEFAULT_CONFIG;
        const pr = verification.pr
          ? { number: verification.pr.number, url: verification.pr.url, branch: verification.pr.headRefName }
          : undefined;
        fixHandoff = composeFixHandoff(config, updated, {
          projectName: loaded.projectName,
          pr,
          blockersText: renderBlockersText(blockers),
          blockerCount: blockers.length,
          worktreePath: updated.worktree?.path,
        });
      }
    }
  } else if (merge.recommendation === 'needs_human') {
    const flagged = dispatchRunAction('flag_needs_human', {
      reason: `Reviewer output is ambiguous or contradictory: ${merge.reasons.join(' ')}`,
      actor,
    });
    if (flagged.ok) updated = flagged.run;
  }
  // `hold`: leave the run in review_synthesis; the dashboard shows the unmet gate.

  updated = getCurrentRun() ?? updated;
  emitRunChanged(updated);
  return { ok: true, run: updated, findings, verification, fixHandoff };
}

/**
 * Send the rendered builder-fix handoff into the live builder session (issue #11).
 * Recomposes the fix prompt deterministically from the run's recorded findings —
 * the accepted blockers and the PR coordinates bound at synthesis time — so
 * `{{blockers}}` is never unresolved, writes it into the builder PTY, and records
 * the prompt send. No `gh` round-trip is needed: the #9 gate already ran to OPEN
 * this fix cycle, and the pushed commit is re-verified later before reviewers
 * re-review. The run stays in `builder_fixing`: sending records that the fix prompt
 * was *delivered*, never that the fix succeeded — the operator dispatches
 * `push_fix` after the builder pushes.
 */
async function handleSendFix(): Promise<HandoffSendResult> {
  let run = getCurrentRun();
  if (!run) {
    return { ok: false, code: 'no_run', error: 'There is no active run to send a fix for.', run: null };
  }
  if (run.status !== 'builder_fixing') {
    return {
      ok: false,
      code: 'invalid_state',
      error: `A fix handoff sends from a builder-fixing run (current: ${run.status}).`,
      run,
    };
  }
  const blockers = run.findings?.acceptedBlockers ?? [];
  if (blockers.length === 0) {
    return { ok: false, code: 'not_sendable', error: 'No accepted blockers are recorded to fix.', run };
  }
  if (run.prNumber === undefined) {
    return { ok: false, code: 'invalid_state', error: 'No PR number is recorded for this run.', run };
  }
  // Verified-PR gate (defense in depth). The synthesis that opened this cycle only
  // recommends request_fix against a verified PR, but re-confirm here: the recorded
  // findings must carry a verified merge gate AND the bound PR URL. Sending a fix
  // against a stale/unverified PR target would break the verified-coordinates
  // safety contract — re-verify (#9) and re-synthesize before sending.
  if (!run.findings?.merge.prVerified || !run.findings.prUrl) {
    return {
      ok: false,
      code: 'invalid_state',
      error: 'The PR is not verified for this run; re-verify (#9) and re-synthesize before sending a fix.',
      run,
    };
  }
  if (!hasPtySession('builder')) {
    return {
      ok: false,
      code: 'no_builder_session',
      error: 'No live builder session. Start the builder pane first, then send the fix.',
      run,
    };
  }

  // Isolation (issue #41): the fix cycle reuses the same run worktree/branch. Make
  // sure it still exists and the builder PTY is running in it before delivering.
  const ensured = await ensureRunWorktree(run);
  if (ensured.mode === 'worktree' && !ensured.ok) {
    return { ok: false, code: 'worktree_failed', error: `Run worktree setup failed: ${ensured.error}`, run: getCurrentRun() };
  }
  if (ensured.mode === 'worktree' && ensured.ok && getPtySessionCwd('builder') !== ensured.worktree.path) {
    return {
      ok: false,
      code: 'no_builder_session',
      error: `Isolation is enabled: restart the builder pane so it launches in the run worktree (${ensured.worktree.path}), then send the fix.`,
      run,
    };
  }

  const loaded = loadConfig();
  const config = loaded.status === 'loaded' ? loaded.config : DEFAULT_CONFIG;
  const pr = { number: run.prNumber, url: run.findings.prUrl, branch: run.branch };
  const handoff = composeFixHandoff(config, run, {
    projectName: loaded.projectName,
    pr,
    blockersText: renderBlockersText(blockers),
    blockerCount: blockers.length,
    worktreePath: run.worktree?.path,
  });
  if (!handoff.canSend) {
    return { ok: false, code: 'not_sendable', error: handoff.blockedReason ?? 'The fix handoff is not ready to send.', run };
  }

  writeToPtySession('builder', `${handoff.prompt}\r`);
  const updated =
    recordCurrentRunPrompt({
      role: 'builder',
      digest: promptDigest(handoff.prompt),
      promptChars: handoff.prompt.length,
    }) ?? run;
  emitRunChanged(updated);
  // The fix prompt is delivered (operator-approved or loop-auto): tell the loop
  // so auto mode begins watching the PR for the resulting fix commit (issue #39).
  notifyFixDelivered();
  void tickLoop();
  return { ok: true, run: updated };
}

function handleDispatchRun(_event: Electron.IpcMainInvokeEvent, input: unknown) {
  const payload = parseIpcPayload(runDispatchSchema, input);
  if (!payload) {
    return { ok: false, code: 'invalid_payload', error: 'Invalid run action payload.', run: getCurrentRun() };
  }
  const { action, ...options } = payload;
  // Operator dispatches are attributed to the operator (the default); a manual
  // transition is an observable event the loop re-syncs from (it preempts the
  // controller and resumes auto-advancing from the new state). No-op in manual.
  //
  // Invalidate any in-flight loop-driven stage FIRST (issue #39, blocker B-1):
  // bumping the loop-stage generation synchronously, before the transition,
  // guarantees that a loop stage suspended on its live verification aborts when it
  // resumes — even when this dispatch advances the run into another launch-legal
  // status (e.g. a manual `start_reviewers` taking `pr_opened → reviewers_running`)
  // that the loop stage's status-only guard would otherwise wave through.
  preemptLoopStages();
  const result = dispatchRunAction(action, options);
  void tickLoop();
  return result;
}

/**
 * Guarded "Clear run" (issue #41). Clearing drops the run record, so it is refused
 * while the run is still active, still owns a git worktree, or has a live builder
 * session — otherwise the worktree/PTY would be orphaned with no run protecting it
 * from cleanup. The operator is routed through cancel/close + worktree cleanup
 * first; the run record is preserved until then.
 */
function handleClearRun(): ClearRunResult {
  const decision = evaluateClearRun(getCurrentRun(), hasPtySession('builder'));
  if (decision.ok) {
    clearRun();
    resetLoopController();
  }
  return decision;
}

/** Return the current loop-controller state for the run control pane (issue #39). */
function handleGetLoop(): LoopState {
  return getLoopState();
}

/** Set the loop mode (manual/auto) for the current run (issue #39). */
function handleSetLoopMode(_event: Electron.IpcMainInvokeEvent, input: unknown): Promise<LoopModeResult> {
  const payload = parseIpcPayload(loopModeSchema, input);
  if (!payload) {
    return Promise.resolve({ ok: false, code: 'no_run', error: 'Invalid loop mode payload.' });
  }
  return setLoopMode(payload.mode as LoopMode);
}

/**
 * Wire the deterministic loop controller (issue #39) with the existing IPC-layer
 * functions. The controller advances a run *only* by calling these — it never
 * duplicates transition rules — and attributes every dispatch it drives to the
 * `loop` actor so the transition log distinguishes automatic progress from
 * operator clicks. Configured once at startup.
 */
function configureLoop(): void {
  configureLoopController({
    getRun: getCurrentRun,
    defaultAuto: () => currentLoopConfig().auto,
    autoSendFix: () => currentLoopConfig().autoSendFix,
    startReviewers: async (actor) => {
      const result = await handleStartReviewers(actor);
      return {
        ok: result.ok,
        error: result.ok ? undefined : result.error,
        // An operator/manual dispatch preempted this loop stage mid-flight: a clean
        // hand-off, not a stage failure to halt/retry on (issue #39, blocker B-1).
        preempted: !result.ok && result.code === 'preempted',
        // A failed launch whose #9 gate could not complete is transient (one retry).
        transient: !result.ok && result.verification?.status === 'needs_refresh',
      };
    },
    synthesize: async (actor) => {
      const result = await handleSynthesizeReviews(actor);
      return {
        ok: result.ok,
        error: result.ok ? undefined : result.error,
        preempted: !result.ok && result.code === 'preempted',
        transient: !result.ok && result.verification?.status === 'needs_refresh',
      };
    },
    sendFix: async () => {
      const result = await handleSendFix();
      return { ok: result.ok, error: result.ok ? undefined : result.error };
    },
    dispatch: (action, options) => {
      const result = dispatchRunAction(action, options);
      return { ok: result.ok, error: result.ok ? undefined : result.error };
    },
    verifyForFix: () => {
      const run = getCurrentRun();
      return getCommitVerification(
        getSelectedProjectRoot(),
        { expectedCommit: run?.expectedCommit, branch: run?.branch },
        new Date().toISOString(),
      );
    },
    emitLoopChanged,
    emitRunChanged: () => emitRunChanged(getCurrentRun()),
  });
}

async function handleStartPty(event: Electron.IpcMainInvokeEvent, input: unknown) {
  const payload = parseIpcPayload(ptyStartSchema, input);
  if (!payload) return undefined;

  // Map the pane/role to its configured agent command. An unlaunchable role
  // (no agent, non-cli adapter) returns a visible error instead of spawning.
  const launch = resolveRoleLaunch(payload.paneId);
  if (!launch.ok) {
    return { ok: false, paneId: payload.paneId, error: launch.error };
  }

  const projectRoot = getSelectedProjectRoot();

  // Isolation (issue #41): the builder pane launches in the run's worktree when
  // the active run is isolated; every other pane (head, reviewers) stays in the
  // operated-project root (read-only roles, and the GitHub/harness scope). A
  // worktree creation failure is visible — never silently launch in the root.
  let cwd = projectRoot;
  let worktreePath: string | undefined;
  if (payload.paneId === 'builder') {
    const run = getCurrentRun();
    if (run && run.isolation === 'worktree') {
      const ensured = await ensureRunWorktree(run);
      if (ensured.mode === 'worktree') {
        if (!ensured.ok) {
          return { ok: false, paneId: payload.paneId, error: `Run worktree setup failed: ${ensured.error}` };
        }
        cwd = ensured.worktree.path;
        worktreePath = ensured.worktree.path;
      }
    }
  }

  const stopOwnedSession = () => stopPtySession(payload.paneId);
  event.sender.once('destroyed', stopOwnedSession);
  event.sender.once('did-start-navigation', stopOwnedSession);

  const result = openPtySession({
    paneId: payload.paneId,
    projectRoot,
    cwd,
    worktreePath,
    command: launch.spec.command,
    onData: (data) => event.sender.send(GODMODE_IPC.ptyData, { paneId: payload.paneId, data }),
    onExit: (exit) => {
      event.sender.send(GODMODE_IPC.ptyExit, { paneId: payload.paneId, exit });
      // A builder pane exiting during builder_running is an observable signal that
      // the builder may have just opened a PR. Surface a non-blocking hint and run
      // one discovery pass (issue #38). This never transitions the run by itself.
      // The live builder PTY is also now gone, so refresh the recovery banner (#55).
      if (payload.paneId === 'builder') {
        emitBuilderRecoveryChanged();
        void handleBuilderExit();
      }
    },
  });
  // Starting the builder pane clears any stale-session banner (issue #55): the run
  // again has a live builder PTY, so the recovery state flips back to not-stale.
  if (payload.paneId === 'builder' && result.ok) emitBuilderRecoveryChanged();
  return result;
}

function handleWritePty(_event: Electron.IpcMainEvent, input: unknown) {
  const payload = parseIpcPayload(ptyWriteSchema, input);
  if (!payload) return;
  writeToPtySession(payload.paneId, payload.data);
}

function handleResizePty(_event: Electron.IpcMainEvent, input: unknown) {
  const payload = parseIpcPayload(ptyResizeSchema, input);
  if (!payload) return;
  resizePtySession(payload.paneId, payload.cols, payload.rows);
}

function handleStopPty(_event: Electron.IpcMainEvent, input: unknown) {
  const payload = parseIpcPayload(ptyStartSchema, input);
  if (!payload) return;
  stopPtySession(payload.paneId);
}

/** Statuses from which the operator may still flip a run's isolation (issue #41). */
const ISOLATION_TOGGLE_STATUSES = new Set(['issue_selected', 'needs_spec', 'ready_to_build']);

/**
 * Set the current run's workspace isolation (issue #41 dogfooding nudge). Only
 * allowed before the builder starts — once a worktree is in use, switching modes
 * mid-run would orphan it. Returns the updated run, or a typed rejection.
 */
function handleSetRunIsolation(_event: Electron.IpcMainInvokeEvent, input: unknown) {
  const payload = parseIpcPayload(runIsolationSchema, input);
  if (!payload) {
    return { ok: false, code: 'invalid_payload', error: 'Invalid isolation payload.', run: getCurrentRun() };
  }
  const run = getCurrentRun();
  if (!run) {
    return { ok: false, code: 'no_run', error: 'There is no active run.', run: null };
  }
  if (!ISOLATION_TOGGLE_STATUSES.has(run.status)) {
    return {
      ok: false,
      code: 'invalid_state',
      error: `Isolation can only be changed before the builder starts (current: ${run.status}).`,
      run,
    };
  }
  const updated = setCurrentRunIsolation(payload.isolation) ?? run;
  emitRunChanged(updated);
  return { ok: true, run: updated };
}

/** List GodMode-managed worktrees for the operated project, with cleanliness (#41). */
function handleListWorktrees(): Promise<ManagedWorktree[]> {
  return listManagedWorktrees(getSelectedProjectRoot(), getCurrentRun()?.worktree?.path);
}

/**
 * Remove a GodMode-managed worktree (issue #41). Refuses anything outside the
 * managed dir, the active run's worktree while the run is still live, and any tree
 * with uncommitted changes or unpushed commits — dirty work is never auto-deleted.
 * Clean removal succeeds and, when it was the current run's worktree, clears it
 * from the run snapshot.
 */
async function handleCleanupWorktree(
  _event: Electron.IpcMainInvokeEvent,
  input: unknown,
): Promise<WorktreeCleanupResult> {
  const payload = parseIpcPayload(worktreeCleanupSchema, input);
  if (!payload) return { ok: false, error: 'Invalid worktree cleanup payload.' };

  const projectRoot = getSelectedProjectRoot();
  const target = path.resolve(payload.path);
  if (!isManagedWorktreePath(projectRoot, target)) {
    return { ok: false, error: 'Refusing to remove a path that is not a GodMode-managed worktree.' };
  }

  const run = getCurrentRun();
  const isCurrentRunWorktree = run?.worktree !== undefined && path.resolve(run.worktree.path) === target;
  if (isCurrentRunWorktree && run && !isTerminalStatus(run.status)) {
    return {
      ok: false,
      error: `The run is still active (${run.status}); finish, close, or cancel it before cleaning up its worktree.`,
    };
  }

  const cleanliness = await inspectWorktree(target);
  if (!cleanliness.clean) {
    return { ok: false, error: `Refusing to remove worktree: ${cleanliness.reasons.join(' ')}` };
  }

  const removed = await removeWorktree({ projectRoot, dir: target });
  if (!removed.ok) return { ok: false, error: removed.error };

  if (isCurrentRunWorktree && run) {
    // Identity-guard the clear too (reviewer-a A-2): inspect/remove awaited, so only
    // detach the worktree if the run that owned it is still current — never blank a
    // different run's worktree metadata.
    const updated = setCurrentRunWorktree(null, { expectedRunId: run.id });
    if (updated) emitRunChanged(updated);
  }
  console.log(`[godmode] Removed clean run worktree: ${target}`);
  return { ok: true, removedPath: target };
}

function registerIpcHandlers(): void {
  ipcMain.handle(GODMODE_IPC.appGet, handleGetApp);
  ipcMain.handle(GODMODE_IPC.projectGet, handleGetProject);
  ipcMain.handle(GODMODE_IPC.configGet, handleGetConfig);
  ipcMain.handle(GODMODE_IPC.registryGet, handleGetRegistry);
  ipcMain.handle(GODMODE_IPC.projectSelect, handleSelectProject);
  ipcMain.handle(GODMODE_IPC.projectBrowse, handleBrowseProject);
  ipcMain.handle(GODMODE_IPC.githubGet, handleGetGithub);
  ipcMain.handle(GODMODE_IPC.githubIssueGet, handleGetIssueDetail);
  ipcMain.handle(GODMODE_IPC.runGet, handleGetRun);
  ipcMain.handle(GODMODE_IPC.runSelectIssue, handleSelectIssueRun);
  ipcMain.handle(GODMODE_IPC.runSelectManual, handleSelectManualTask);
  ipcMain.handle(GODMODE_IPC.runDispatch, handleDispatchRun);
  ipcMain.handle(GODMODE_IPC.runClear, handleClearRun);
  ipcMain.handle(GODMODE_IPC.runBuilderRecoveryGet, handleGetBuilderRecovery);
  ipcMain.handle(GODMODE_IPC.runBuilderRelaunch, (event) => handleRelaunchBuilder(event));
  ipcMain.handle(GODMODE_IPC.runHandoffGet, handleGetHandoff);
  ipcMain.handle(GODMODE_IPC.runHandoffSend, handleSendHandoff);
  ipcMain.handle(GODMODE_IPC.runVerify, handleVerifyRun);
  ipcMain.handle(GODMODE_IPC.runPrDiscover, handleDiscoverPr);
  ipcMain.handle(GODMODE_IPC.runPrConfirm, handleConfirmPrCandidate);
  // Operator-triggered launches/synthesis default to the operator actor; the loop
  // controller calls these same handlers with the `loop` actor (issue #39). Wrap
  // in arrows so ipcMain's (event, …) args never bind to the actor parameter.
  ipcMain.handle(GODMODE_IPC.runStartReviewers, () => handleStartReviewers());
  ipcMain.handle(GODMODE_IPC.runReviewerComment, handlePostReviewerComment);
  ipcMain.handle(GODMODE_IPC.runSynthesizeReviews, () => handleSynthesizeReviews());
  ipcMain.handle(GODMODE_IPC.runSendFix, () => handleSendFix());
  ipcMain.handle(GODMODE_IPC.runSetIsolation, handleSetRunIsolation);
  ipcMain.handle(GODMODE_IPC.runLoopGet, handleGetLoop);
  ipcMain.handle(GODMODE_IPC.runLoopSetMode, handleSetLoopMode);
  ipcMain.handle(GODMODE_IPC.runResumeGet, handleGetResume);
  ipcMain.handle(GODMODE_IPC.runResume, handleResume);
  ipcMain.handle(GODMODE_IPC.runDiscard, handleDiscard);
  ipcMain.handle(GODMODE_IPC.worktreeList, handleListWorktrees);
  ipcMain.handle(GODMODE_IPC.worktreeCleanup, handleCleanupWorktree);
  ipcMain.handle(GODMODE_IPC.ptyStart, handleStartPty);
  ipcMain.on(GODMODE_IPC.ptyWrite, handleWritePty);
  ipcMain.on(GODMODE_IPC.ptyResize, handleResizePty);
  ipcMain.on(GODMODE_IPC.ptyStop, handleStopPty);
}

app.whenReady().then(() => {
  registerIpcHandlers();
  // Install the write-through run-persistence hook (issue #40): every accepted run
  // mutation is persisted to the operated project's run store and mirrored to
  // run.json. Installed before the window so no early mutation escapes persistence.
  setRunPersistHook(persistCurrentRun);
  // Wire the deterministic review/fix loop controller (issue #39). It stays a
  // no-op until a run opts into auto mode; manual mode is the regression-safe
  // default.
  configureLoop();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  killAllPtySessions();
});

app.on('window-all-closed', () => {
  killAllPtySessions();
  app.quit();
});
