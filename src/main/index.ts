import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getAppRepoState } from './appRepo.js';
import { getGithubState } from './github.js';
import { killAllPtySessions, openPtySession, resizePtySession, stopPtySession, writeToPtySession } from './pty.js';
import { getProjectState, getSelectedProjectRoot, selectProject } from './project.js';
import { getConfigState } from './config.js';
import { getRegistryState, resolveRoleLaunch } from './agents.js';
import { clearRun, dispatchRunAction, getCurrentRun, selectIssueRun } from './run.js';
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

function handleSelectIssueRun(_event: Electron.IpcMainInvokeEvent, input: unknown) {
  const payload = parseIpcPayload(runSelectIssueSchema, input);
  if (!payload) {
    return { ok: false, code: 'invalid_payload', error: 'Invalid run selection payload.', run: getCurrentRun() };
  }
  return selectIssueRun({
    sourceType: 'github_issue',
    sourceId: String(payload.issueNumber),
    issueNumber: payload.issueNumber,
    issueTitle: payload.issueTitle,
    maxCycles: payload.maxCycles,
  });
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
  ipcMain.handle(GODMODE_IPC.runGet, handleGetRun);
  ipcMain.handle(GODMODE_IPC.runSelectIssue, handleSelectIssueRun);
  ipcMain.handle(GODMODE_IPC.runDispatch, handleDispatchRun);
  ipcMain.handle(GODMODE_IPC.runClear, handleClearRun);
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
