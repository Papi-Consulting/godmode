import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getAppRepoState } from './appRepo.js';
import { getCommitVerification, getGithubState, getIssueDetail } from './github.js';
import {
  hasPtySession,
  killAllPtySessions,
  openPtySession,
  resizePtySession,
  stopPtySession,
  writeToPtySession,
} from './pty.js';
import { getProjectState, getSelectedProjectRoot, selectProject } from './project.js';
import { getConfigState } from './config.js';
import { getRegistryState, resolveRoleLaunch } from './agents.js';
import {
  clearRun,
  dispatchRunAction,
  getCurrentRun,
  recordCurrentRunPrompt,
  recordCurrentRunVerification,
  selectIssueRun,
  selectManualTaskRun,
} from './run.js';
import { getCurrentHandoff, promptDigest } from './handoff.js';
import type { HandoffSendResult, RunSourceDetail, RunVerificationResult } from '../shared/types.js';
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
      preload: path.join(__dirname, '../preload/index.js'),
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
