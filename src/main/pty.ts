import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';

export type PtyExit = {
  exitCode: number;
  signal?: number;
};

export type OpenPtyInput = {
  paneId: string;
  projectRoot: string;
  onData: (data: string) => void;
  onExit: (exit: PtyExit) => void;
};

const allowedPaneIds = new Set(['head', 'builder', 'reviewer_a', 'reviewer_b']);
const sessions = new Map<string, pty.IPty>();

function buildSafeEnv(): Record<string, string> {
  const keys = ['HOME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL'];
  const env: Record<string, string> = {};

  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }

  env.TERM = env.TERM ?? 'xterm-256color';
  return env;
}

export function openPtySession(input: OpenPtyInput): { paneId: string; pid: number } {
  if (!allowedPaneIds.has(input.paneId)) {
    throw new Error(`Unknown pane id: ${input.paneId}`);
  }

  const existing = sessions.get(input.paneId);
  if (existing) {
    existing.kill();
    sessions.delete(input.paneId);
  }

  const shell = process.env.SHELL ?? (os.platform() === 'win32' ? 'powershell.exe' : 'zsh');
  const projectRoot = path.resolve(input.projectRoot);

  const session = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 100,
    rows: 28,
    cwd: projectRoot,
    env: buildSafeEnv(),
  });

  session.onData(input.onData);
  session.onExit(({ exitCode, signal }) => {
    if (sessions.get(input.paneId) !== session) return;
    sessions.delete(input.paneId);
    input.onExit({ exitCode, signal });
  });

  sessions.set(input.paneId, session);

  return { paneId: input.paneId, pid: session.pid };
}

export function writeToPtySession(paneId: string, data: string): void {
  const session = sessions.get(paneId);
  if (!session) return;
  session.write(data);
}

export function stopPtySession(paneId: string): void {
  const session = sessions.get(paneId);
  if (!session) return;
  session.kill();
  sessions.delete(paneId);
}

export function killAllPtySessions(): void {
  for (const [paneId, session] of sessions.entries()) {
    session.kill();
    sessions.delete(paneId);
  }
}

export function resizePtySession(paneId: string, cols: number, rows: number): void {
  const session = sessions.get(paneId);
  if (!session) return;
  session.resize(cols, rows);
}
