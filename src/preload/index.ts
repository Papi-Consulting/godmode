import { contextBridge, ipcRenderer } from 'electron';
import type { PtyExit } from '../main/pty.js';
import type { AppRepoState, GithubState, ProjectConfigState, ProjectState } from '../shared/types.js';

export type PtyDataEvent = {
  paneId: string;
  data: string;
};

export type PtyExitEvent = {
  paneId: string;
  exit: PtyExit;
};

const api = {
  getApp: () => ipcRenderer.invoke('godmode:app:get') as Promise<AppRepoState>,
  getProject: () => ipcRenderer.invoke('godmode:project:get') as Promise<ProjectState>,
  selectProject: (input: { path: string }) =>
    ipcRenderer.invoke('godmode:project:select', input) as Promise<ProjectState | undefined>,
  browseProject: () => ipcRenderer.invoke('godmode:project:browse') as Promise<ProjectState | undefined>,
  getGithub: () => ipcRenderer.invoke('godmode:github:get') as Promise<GithubState>,
  getConfig: () => ipcRenderer.invoke('godmode:config:get') as Promise<ProjectConfigState>,
  onProjectChanged: (callback: (state: ProjectState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ProjectState) => callback(payload);
    ipcRenderer.on('godmode:project:changed', listener);
    return () => ipcRenderer.off('godmode:project:changed', listener);
  },
  startPty: (input: { paneId: string }) =>
    ipcRenderer.invoke('godmode:pty:start', input) as Promise<{ paneId: string; pid: number } | undefined>,
  writePty: (input: { paneId: string; data: string }) => ipcRenderer.send('godmode:pty:write', input),
  resizePty: (input: { paneId: string; cols: number; rows: number }) => ipcRenderer.send('godmode:pty:resize', input),
  stopPty: (input: { paneId: string }) => ipcRenderer.send('godmode:pty:stop', input),
  onPtyData: (callback: (event: PtyDataEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PtyDataEvent) => callback(payload);
    ipcRenderer.on('godmode:pty:data', listener);
    return () => ipcRenderer.off('godmode:pty:data', listener);
  },
  onPtyExit: (callback: (event: PtyExitEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PtyExitEvent) => callback(payload);
    ipcRenderer.on('godmode:pty:exit', listener);
    return () => ipcRenderer.off('godmode:pty:exit', listener);
  },
};

contextBridge.exposeInMainWorld('godmode', api);

export type GodModeApi = typeof api;
