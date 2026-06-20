/**
 * Shared Electron IPC channel names. Keep channel strings centralized so
 * CodeGraph/users can search one symbol before manually pairing main, preload,
 * and renderer wiring.
 */
export const GODMODE_IPC = {
  appGet: 'godmode:app:get',
  projectGet: 'godmode:project:get',
  projectSelect: 'godmode:project:select',
  projectBrowse: 'godmode:project:browse',
  projectChanged: 'godmode:project:changed',
  configGet: 'godmode:config:get',
  registryGet: 'godmode:registry:get',
  githubGet: 'godmode:github:get',
  githubIssueGet: 'godmode:github:issue:get',
  githubChanged: 'godmode:github:changed',
  runGet: 'godmode:run:get',
  runSelectIssue: 'godmode:run:select-issue',
  runSelectManual: 'godmode:run:select-manual',
  runDispatch: 'godmode:run:dispatch',
  runClear: 'godmode:run:clear',
  runHandoffGet: 'godmode:run:handoff:get',
  runHandoffSend: 'godmode:run:handoff:send',
  runVerify: 'godmode:run:verify',
  runPrDiscover: 'godmode:run:pr:discover',
  runPrConfirm: 'godmode:run:pr:confirm',
  runPrDiscovered: 'godmode:run:pr:discovered',
  runStartReviewers: 'godmode:run:reviewers:start',
  runReviewerComment: 'godmode:run:reviewers:comment',
  runSynthesizeReviews: 'godmode:run:reviews:synthesize',
  runSendFix: 'godmode:run:fix:send',
  runSetIsolation: 'godmode:run:isolation:set',
  runChanged: 'godmode:run:changed',
  // Stale builder-session detection + recovery (issue #55).
  runBuilderRecoveryGet: 'godmode:run:builder:recovery:get',
  runBuilderRecoveryChanged: 'godmode:run:builder:recovery:changed',
  runBuilderRelaunch: 'godmode:run:builder:relaunch',
  runLoopGet: 'godmode:run:loop:get',
  runLoopSetMode: 'godmode:run:loop:set-mode',
  runLoopChanged: 'godmode:run:loop:changed',
  // Run persistence / resume-after-restart (issue #40).
  runResumeGet: 'godmode:run:resume:get',
  runResume: 'godmode:run:resume:apply',
  runDiscard: 'godmode:run:resume:discard',
  runResumeChanged: 'godmode:run:resume:changed',
  worktreeList: 'godmode:worktree:list',
  worktreeCleanup: 'godmode:worktree:cleanup',
  ptyStart: 'godmode:pty:start',
  ptyWrite: 'godmode:pty:write',
  // Operator role-message delivery with a typed result (issue #57). Distinct from
  // the fire-and-forget `ptyWrite` (raw xterm typing): this is an `invoke` so the
  // renderer learns whether the bytes reached a live PTY or no-op'd.
  ptySend: 'godmode:pty:send',
  ptyResize: 'godmode:pty:resize',
  ptyStop: 'godmode:pty:stop',
  ptyData: 'godmode:pty:data',
  ptyExit: 'godmode:pty:exit',
  // Pushed when main starts a PTY on the pane's behalf (e.g. builder recovery
  // relaunch, issue #55) so the pane reflects the live session it did not start.
  ptyStarted: 'godmode:pty:started',
} as const;

export type GodmodeIpcChannel = (typeof GODMODE_IPC)[keyof typeof GODMODE_IPC];

export const GODMODE_IPC_CHANNELS: readonly GodmodeIpcChannel[] = Object.values(GODMODE_IPC);
