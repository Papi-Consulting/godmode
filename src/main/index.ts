import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { getAppRepoState } from './appRepo.js';
import { getGithubState } from './github.js';
import { killAllPtySessions, openPtySession, resizePtySession, stopPtySession, writeToPtySession } from './pty.js';
import { getProjectState, getSelectedProjectRoot, selectProject } from './project.js';
import { getConfigState } from './config.js';
import { getRegistryState } from './agents.js';

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
    for (const paneId of killAllPtySessions()) {
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('godmode:pty:exit', { paneId, exit: { exitCode: 0 } });
      }
    }
    // Role/agent config is project-local, so the renderer must reload it (panes,
    // labels, command hints) whenever the active root changes.
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('godmode:project:changed', state);
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

app.whenReady().then(() => {
  // Identity of the GodMode app repo itself, kept separate from the operated
  // project so the UI can show both contexts and flag self-dogfooding.
  ipcMain.handle('godmode:app:get', () => getAppRepoState());

  ipcMain.handle('godmode:project:get', () => getProjectState());

  ipcMain.handle('godmode:config:get', () => getConfigState());

  // Resolved adapter registry + auditable command-template previews. Issue/PR
  // variables stay unbound until run wiring exists, so previews render as mock.
  ipcMain.handle('godmode:registry:get', () => getRegistryState());

  ipcMain.handle('godmode:project:select', (_event, input: unknown) => {
    const payload = parseIpcPayload(projectSelectSchema, input);
    if (!payload) return undefined;
    return selectProjectAndResetSessions(payload.path);
  });

  ipcMain.handle('godmode:project:browse', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open GodMode project',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getSelectedProjectRoot(),
    });
    if (result.canceled || result.filePaths.length === 0) return undefined;
    return selectProjectAndResetSessions(result.filePaths[0]);
  });

  ipcMain.handle('godmode:github:get', () => getGithubState(getSelectedProjectRoot(), new Date().toISOString()));

  ipcMain.handle('godmode:pty:start', (event, input: unknown) => {
    const payload = parseIpcPayload(ptyStartSchema, input);
    if (!payload) return undefined;

    const stopOwnedSession = () => stopPtySession(payload.paneId);
    event.sender.once('destroyed', stopOwnedSession);
    event.sender.once('did-start-navigation', stopOwnedSession);

    return openPtySession({
      paneId: payload.paneId,
      projectRoot: getSelectedProjectRoot(),
      onData: (data) => event.sender.send('godmode:pty:data', { paneId: payload.paneId, data }),
      onExit: (exit) => event.sender.send('godmode:pty:exit', { paneId: payload.paneId, exit }),
    });
  });

  ipcMain.on('godmode:pty:write', (_event, input: unknown) => {
    const payload = parseIpcPayload(ptyWriteSchema, input);
    if (!payload) return;
    writeToPtySession(payload.paneId, payload.data);
  });

  ipcMain.on('godmode:pty:resize', (_event, input: unknown) => {
    const payload = parseIpcPayload(ptyResizeSchema, input);
    if (!payload) return;
    resizePtySession(payload.paneId, payload.cols, payload.rows);
  });

  ipcMain.on('godmode:pty:stop', (_event, input: unknown) => {
    const payload = parseIpcPayload(ptyStartSchema, input);
    if (!payload) return;
    stopPtySession(payload.paneId);
  });

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
