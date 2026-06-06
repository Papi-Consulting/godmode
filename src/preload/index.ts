import { contextBridge, ipcRenderer } from 'electron';
import type { PtyExit, PtyStartResult } from '../main/pty.js';
import type {
  AgentRegistryState,
  AppRepoState,
  BuilderHandoff,
  GithubIssueDetailResult,
  GithubState,
  HandoffSendResult,
  ProjectConfigState,
  ProjectState,
  RunAction,
  RunActionResult,
  RunBlockerKind,
  RunSnapshot,
  RunVerificationResult,
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
  getIssueDetail: (input: { issueNumber: number }) =>
    ipcRenderer.invoke(GODMODE_IPC.githubIssueGet, input) as Promise<GithubIssueDetailResult>,
  getConfig: () => ipcRenderer.invoke(GODMODE_IPC.configGet) as Promise<ProjectConfigState>,
  getRegistry: () => ipcRenderer.invoke(GODMODE_IPC.registryGet) as Promise<AgentRegistryState>,
  getRun: () => ipcRenderer.invoke(GODMODE_IPC.runGet) as Promise<RunSnapshot | null>,
  selectIssueRun: (input: { issueNumber: number; issueTitle?: string; maxCycles?: number }) =>
    ipcRenderer.invoke(GODMODE_IPC.runSelectIssue, input) as Promise<RunActionResult>,
  selectManualTask: (input: { title: string; text: string }) =>
    ipcRenderer.invoke(GODMODE_IPC.runSelectManual, input) as Promise<RunActionResult>,
  getHandoff: () => ipcRenderer.invoke(GODMODE_IPC.runHandoffGet) as Promise<BuilderHandoff>,
  sendHandoff: () => ipcRenderer.invoke(GODMODE_IPC.runHandoffSend) as Promise<HandoffSendResult>,
  verifyCommit: () => ipcRenderer.invoke(GODMODE_IPC.runVerify) as Promise<RunVerificationResult>,
  dispatchRun: (input: {
    action: RunAction;
    reason?: string;
    blocker?: RunBlockerKind;
    branch?: string;
    prNumber?: number;
    expectedCommit?: string;
  }) => ipcRenderer.invoke(GODMODE_IPC.runDispatch, input) as Promise<RunActionResult>,
  clearRun: () => ipcRenderer.invoke(GODMODE_IPC.runClear) as Promise<RunSnapshot | null>,
  onProjectChanged: (callback: (state: ProjectState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ProjectState) => callback(payload);
    ipcRenderer.on(GODMODE_IPC.projectChanged, listener);
    return () => ipcRenderer.off(GODMODE_IPC.projectChanged, listener);
  },
  startPty: (input: { paneId: string }) =>
    ipcRenderer.invoke(GODMODE_IPC.ptyStart, input) as Promise<PtyStartResult | undefined>,
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
