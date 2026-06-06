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
  runGet: 'godmode:run:get',
  runSelectIssue: 'godmode:run:select-issue',
  runDispatch: 'godmode:run:dispatch',
  runClear: 'godmode:run:clear',
  ptyStart: 'godmode:pty:start',
  ptyWrite: 'godmode:pty:write',
  ptyResize: 'godmode:pty:resize',
  ptyStop: 'godmode:pty:stop',
  ptyData: 'godmode:pty:data',
  ptyExit: 'godmode:pty:exit',
} as const;

export type GodmodeIpcChannel = (typeof GODMODE_IPC)[keyof typeof GODMODE_IPC];

export const GODMODE_IPC_CHANNELS: readonly GodmodeIpcChannel[] = Object.values(GODMODE_IPC);
