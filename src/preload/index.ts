import { contextBridge, ipcRenderer } from 'electron';
import type { PtyExit, PtyStartResult } from '../main/pty.js';
import type {
  AgentRegistryState,
  AppRepoState,
  BuilderHandoff,
  ClearRunResult,
  ConfirmPrCandidateResult,
  GithubIssueDetailResult,
  GithubState,
  HandoffSendResult,
  LoopMode,
  LoopModeResult,
  LoopState,
  ManagedWorktree,
  PrCandidateMatchReason,
  PrDiscoveryEvent,
  PrDiscoveryResult,
  ProjectConfigState,
  ProjectState,
  ReviewSynthesisResult,
  ReviewerCommentResult,
  RunAction,
  RunActionResult,
  RunBlockerKind,
  RunSnapshot,
  RunVerificationResult,
  StartReviewersResult,
  WorkspaceIsolation,
  WorktreeCleanupResult,
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
  discoverPr: () => ipcRenderer.invoke(GODMODE_IPC.runPrDiscover) as Promise<PrDiscoveryResult>,
  confirmPrCandidate: (input: {
    prNumber: number;
    branch: string;
    expectedCommit: string;
    matchReason?: PrCandidateMatchReason;
  }) => ipcRenderer.invoke(GODMODE_IPC.runPrConfirm, input) as Promise<ConfirmPrCandidateResult>,
  startReviewers: () => ipcRenderer.invoke(GODMODE_IPC.runStartReviewers) as Promise<StartReviewersResult>,
  postReviewerComment: (input: { paneId: 'reviewer_a' | 'reviewer_b' }) =>
    ipcRenderer.invoke(GODMODE_IPC.runReviewerComment, input) as Promise<ReviewerCommentResult>,
  synthesizeReviews: () => ipcRenderer.invoke(GODMODE_IPC.runSynthesizeReviews) as Promise<ReviewSynthesisResult>,
  sendFix: () => ipcRenderer.invoke(GODMODE_IPC.runSendFix) as Promise<HandoffSendResult>,
  getLoop: () => ipcRenderer.invoke(GODMODE_IPC.runLoopGet) as Promise<LoopState>,
  setLoopMode: (input: { mode: LoopMode }) =>
    ipcRenderer.invoke(GODMODE_IPC.runLoopSetMode, input) as Promise<LoopModeResult>,
  setRunIsolation: (input: { isolation: WorkspaceIsolation }) =>
    ipcRenderer.invoke(GODMODE_IPC.runSetIsolation, input) as Promise<
      { ok: true; run: RunSnapshot } | { ok: false; code: string; error: string; run: RunSnapshot | null }
    >,
  listWorktrees: () => ipcRenderer.invoke(GODMODE_IPC.worktreeList) as Promise<ManagedWorktree[]>,
  cleanupWorktree: (input: { path: string }) =>
    ipcRenderer.invoke(GODMODE_IPC.worktreeCleanup, input) as Promise<WorktreeCleanupResult>,
  dispatchRun: (input: {
    action: RunAction;
    reason?: string;
    blocker?: RunBlockerKind;
    branch?: string;
    prNumber?: number;
    expectedCommit?: string;
  }) => ipcRenderer.invoke(GODMODE_IPC.runDispatch, input) as Promise<RunActionResult>,
  clearRun: () => ipcRenderer.invoke(GODMODE_IPC.runClear) as Promise<ClearRunResult>,
  onProjectChanged: (callback: (state: ProjectState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ProjectState) => callback(payload);
    ipcRenderer.on(GODMODE_IPC.projectChanged, listener);
    return () => ipcRenderer.off(GODMODE_IPC.projectChanged, listener);
  },
  onRunChanged: (callback: (run: RunSnapshot | null) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RunSnapshot | null) => callback(payload);
    ipcRenderer.on(GODMODE_IPC.runChanged, listener);
    return () => ipcRenderer.off(GODMODE_IPC.runChanged, listener);
  },
  onLoopChanged: (callback: (loop: LoopState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: LoopState) => callback(payload);
    ipcRenderer.on(GODMODE_IPC.runLoopChanged, listener);
    return () => ipcRenderer.off(GODMODE_IPC.runLoopChanged, listener);
  },
  onPrDiscovered: (callback: (event: PrDiscoveryEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PrDiscoveryEvent) => callback(payload);
    ipcRenderer.on(GODMODE_IPC.runPrDiscovered, listener);
    return () => ipcRenderer.off(GODMODE_IPC.runPrDiscovered, listener);
  },
  onGithubChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(GODMODE_IPC.githubChanged, listener);
    return () => ipcRenderer.off(GODMODE_IPC.githubChanged, listener);
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
