import { contextBridge, ipcRenderer } from 'electron';
import type { PtyExit } from '../main/pty.js';

export type PtyDataEvent = {
  paneId: string;
  data: string;
};

export type PtyExitEvent = {
  paneId: string;
  exit: PtyExit;
};

const api = {
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
