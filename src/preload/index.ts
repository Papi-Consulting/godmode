import { contextBridge, ipcRenderer } from 'electron';
import type { PtyExit } from '../main/pty.js';
import type {
  AgentRegistryState,
  AppRepoState,
  GithubState,
  ProjectConfigState,
  ProjectState,
} from '../shared/types.js';
import { GODMODE_IPC } from '../shared/ipcChannels.js';

export type PtyDataEvent = {
  paneId: string;
  data: string;
};

export type PtyExitEvent = {
  paneId: string;
  exit: PtyExit;
};

const api = {
  getApp: () => ipcRenderer.invoke(GODMODE_IPC.appGet) as Promise<AppRepoState>,
  getProject: () => ipcRenderer.invoke(GODMODE_IPC.projectGet) as Promise<ProjectState>,
  selectProject: (input: { path: string }) =>
    ipcRenderer.invoke(GODMODE_IPC.projectSelect, input) as Promise<ProjectState | undefined>,
  browseProject: () => ipcRenderer.invoke(GODMODE_IPC.projectBrowse) as Promise<ProjectState | undefined>,
  getGithub: () => ipcRenderer.invoke(GODMODE_IPC.githubGet) as Promise<GithubState>,
  getConfig: () => ipcRenderer.invoke(GODMODE_IPC.configGet) as Promise<ProjectConfigState>,
  getRegistry: () => ipcRenderer.invoke(GODMODE_IPC.registryGet) as Promise<AgentRegistryState>,
  onProjectChanged: (callback: (state: ProjectState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ProjectState) => callback(payload);
    ipcRenderer.on(GODMODE_IPC.projectChanged, listener);
    return () => ipcRenderer.off(GODMODE_IPC.projectChanged, listener);
  },
  startPty: (input: { paneId: string }) =>
    ipcRenderer.invoke(GODMODE_IPC.ptyStart, input) as Promise<{ paneId: string; pid: number } | undefined>,
  writePty: (input: { paneId: string; data: string }) => ipcRenderer.send(GODMODE_IPC.ptyWrite, input),
  resizePty: (input: { paneId: string; cols: number; rows: number }) => ipcRenderer.send(GODMODE_IPC.ptyResize, input),
  stopPty: (input: { paneId: string }) => ipcRenderer.send(GODMODE_IPC.ptyStop, input),
  onPtyData: (callback: (event: PtyDataEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PtyDataEvent) => callback(payload);
    ipcRenderer.on(GODMODE_IPC.ptyData, listener);
    return () => ipcRenderer.off(GODMODE_IPC.ptyData, listener);
  },
  onPtyExit: (callback: (event: PtyExitEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PtyExitEvent) => callback(payload);
    ipcRenderer.on(GODMODE_IPC.ptyExit, listener);
    return () => ipcRenderer.off(GODMODE_IPC.ptyExit, listener);
  },
};

contextBridge.exposeInMainWorld('godmode', api);

export type GodModeApi = typeof api;
