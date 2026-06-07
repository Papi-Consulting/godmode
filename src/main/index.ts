import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getAppRepoState } from './appRepo.js';
import { getCommitVerification, getGithubState, getIssueDetail, postPrComment } from './github.js';
import {
  hasPtySession,
  killAllPtySessions,
  openPtySession,
  resizePtySession,
  stopPtySession,
  writeToPtySession,
} from './pty.js';
import { getProjectState, getSelectedProjectRoot, selectProject } from './project.js';
import { DEFAULT_CONFIG, getConfigState, loadConfig } from './config.js';
import { getRegistryState, resolveRoleLaunch } from './agents.js';
import {
  clearRun,
  dispatchRunAction,
  getCurrentRun,
  recordCurrentRunPrompt,
  recordCurrentRunVerification,
  selectIssueRun,
  selectManualTaskRun,
  setCurrentRunReviewers,
  updateCurrentRunReviewer,
} from './run.js';
import { getCurrentHandoff, promptDigest } from './handoff.js';
import {
  appendArtifact,
  ensureRunArtifactDir,
  reviewerArtifactPath,
  reviewerArtifactRelPath,
} from './artifacts.js';
import {
  canPostReviewerMarker,
  composeReviewerLaunch,
  isReviewerRunContextStale,
  isReviewerSessionStale,
  resolveReviewerExit,
  reviewerCommentBody,
  reviewerLaunchTransition,
} from './reviewer.js';
import type {
  AgentRole,
  HandoffSendResult,
  ReviewerCommentResult,
  RunSnapshot,
  RunSourceDetail,
  RunVerificationResult,
  StartReviewersResult,
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
const reviewerPaneSchema = z.enum(['reviewer_a', 'reviewer_b']);
const reviewerCommentSchema = z.object({ paneId: reviewerPaneSchema });
const runSelectManualSchema = z.object({
  title: z.string().min(1).max(200),
  text: z.string().min(1).max(20_000),
});

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
    for (const paneId of killAllPtySessions()) {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(GODMODE_IPC.ptyExit, { paneId, exit: { exitCode: 0 } });
      }
    }
    // Role/agent config is project-local, so the renderer must reload it (panes,
    // labels, command hints) whenever the active root changes.
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(GODMODE_IPC.projectChanged, state);
    }
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

  return selectIssueRun({
    sourceType: 'github_issue',
    sourceId: String(payload.issueNumber),
    issueNumber: payload.issueNumber,
    issueTitle: payload.issueTitle,
    maxCycles: payload.maxCycles,
    sourceDetail,
  });
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
  return selectManualTaskRun({ title: payload.title, text: payload.text });
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
function handleSendHandoff(): HandoffSendResult {
  const run = getCurrentRun();
  if (!run) {
    return { ok: false, code: 'no_run', error: 'There is no active run to send a handoff for.', run: null };
  }

  const handoff = getCurrentHandoff(run);
  if (!handoff.canSend) {
    return {
      ok: false,
      code: 'not_sendable',
      error: handoff.blockedReason ?? 'This handoff is not ready to send.',
      run,
    };
  }

  if (!HANDOFF_START_STATUSES.has(run.status)) {
    return {
      ok: false,
      code: 'invalid_state',
      error: `The run must be issue-selected or ready-to-build to send the builder handoff (current: ${run.status}).`,
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
  return { ok: true, run: started.run };
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
  const verification = await getCommitVerification(
    getSelectedProjectRoot(),
    { expectedCommit: run?.expectedCommit },
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
async function handleStartReviewers(): Promise<StartReviewersResult> {
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

  const captured = { runId: run.id, root: getSelectedProjectRoot() };
  const projectRoot = captured.root;
  const now = new Date().toISOString();

  // #9 evidence gate: re-verify live and record it. Never trust plain PR
  // existence or an agent self-report as enough to launch reviewers.
  const verification = await getCommitVerification(projectRoot, { expectedCommit: run.expectedCommit }, now);

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

function handleDispatchRun(_event: Electron.IpcMainInvokeEvent, input: unknown) {
  const payload = parseIpcPayload(runDispatchSchema, input);
  if (!payload) {
    return { ok: false, code: 'invalid_payload', error: 'Invalid run action payload.', run: getCurrentRun() };
  }
  const { action, ...options } = payload;
  return dispatchRunAction(action, options);
}

function handleClearRun() {
  clearRun();
  return getCurrentRun();
}

function handleStartPty(event: Electron.IpcMainInvokeEvent, input: unknown) {
  const payload = parseIpcPayload(ptyStartSchema, input);
  if (!payload) return undefined;

  // Map the pane/role to its configured agent command. An unlaunchable role
  // (no agent, non-cli adapter) returns a visible error instead of spawning.
  const launch = resolveRoleLaunch(payload.paneId);
  if (!launch.ok) {
    return { ok: false, paneId: payload.paneId, error: launch.error };
  }

  const stopOwnedSession = () => stopPtySession(payload.paneId);
  event.sender.once('destroyed', stopOwnedSession);
  event.sender.once('did-start-navigation', stopOwnedSession);

  return openPtySession({
    paneId: payload.paneId,
    projectRoot: getSelectedProjectRoot(),
    command: launch.spec.command,
    onData: (data) => event.sender.send(GODMODE_IPC.ptyData, { paneId: payload.paneId, data }),
    onExit: (exit) => event.sender.send(GODMODE_IPC.ptyExit, { paneId: payload.paneId, exit }),
  });
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
  ipcMain.handle(GODMODE_IPC.runHandoffGet, handleGetHandoff);
  ipcMain.handle(GODMODE_IPC.runHandoffSend, handleSendHandoff);
  ipcMain.handle(GODMODE_IPC.runVerify, handleVerifyRun);
  ipcMain.handle(GODMODE_IPC.runStartReviewers, handleStartReviewers);
  ipcMain.handle(GODMODE_IPC.runReviewerComment, handlePostReviewerComment);
  ipcMain.handle(GODMODE_IPC.ptyStart, handleStartPty);
  ipcMain.on(GODMODE_IPC.ptyWrite, handleWritePty);
  ipcMain.on(GODMODE_IPC.ptyResize, handleResizePty);
  ipcMain.on(GODMODE_IPC.ptyStop, handleStopPty);
}

app.whenReady().then(() => {
  registerIpcHandlers();

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
