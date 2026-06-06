import fs from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';

export type PtyExit = {
  exitCode: number;
  signal?: number;
};

/**
 * Outcome of starting a role session. Success carries the live pid; failure
 * carries a human-readable reason so the renderer can show it inside the
 * relevant pane (AGENTS.md: launch errors are visible, never a crash) instead of
 * rejecting the IPC call.
 */
export type PtyStartResult =
  | { ok: true; paneId: string; pid: number }
  | { ok: false; paneId: string; error: string };

export type OpenPtyInput = {
  paneId: string;
  projectRoot: string;
  /** Configured agent command for the role, e.g. "claude" or "node --version". */
  command: string;
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

/**
 * Split a configured command string into its executable and argument tokens.
 * Whitespace-only splitting keeps v1 simple/boring (AGENTS.md): it covers bare
 * binaries and smoke commands like `node --version`; quoting is out of scope.
 */
function splitCommand(command: string): { file: string; args: string[] } {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  return { file: parts[0] ?? '', args: parts.slice(1) };
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a command's executable to an absolute path before spawning. A bare
 * name is searched on the safe env PATH; a path-bearing token is resolved
 * against the project root (never the GodMode app repo). Returning null lets the
 * caller surface a visible "command not found" error rather than spawning a
 * doomed process whose failure mode depends on node-pty internals.
 */
export function resolveExecutable(
  file: string,
  projectRoot: string,
  env: Record<string, string>,
): string | null {
  if (!file) return null;
  if (file.includes(path.sep) || file.includes('/')) {
    const abs = path.isAbsolute(file) ? file : path.resolve(projectRoot, file);
    return isExecutableFile(abs) ? abs : null;
  }
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

export function openPtySession(input: OpenPtyInput): PtyStartResult {
  if (!allowedPaneIds.has(input.paneId)) {
    return { ok: false, paneId: input.paneId, error: `Unknown pane id: ${input.paneId}` };
  }

  const { file, args } = splitCommand(input.command);
  if (!file) {
    return { ok: false, paneId: input.paneId, error: 'No command is configured for this role.' };
  }

  // Restrict the launch cwd to the selected operated-project root and confirm it
  // is a readable directory before spawning anything.
  const projectRoot = path.resolve(input.projectRoot);
  try {
    if (!fs.statSync(projectRoot).isDirectory()) {
      return { ok: false, paneId: input.paneId, error: `Project root is not a directory: ${projectRoot}` };
    }
  } catch {
    return { ok: false, paneId: input.paneId, error: `Project root is not accessible: ${projectRoot}` };
  }

  const env = buildSafeEnv();
  const executable = resolveExecutable(file, projectRoot, env);
  if (!executable) {
    return { ok: false, paneId: input.paneId, error: `Command not found: ${file}` };
  }

  // Only tear down the existing session once the new command is known good, so a
  // restart with a now-broken command leaves the running session in place.
  const existing = sessions.get(input.paneId);
  if (existing) {
    existing.kill();
    sessions.delete(input.paneId);
  }

  let session: pty.IPty;
  try {
    session = pty.spawn(executable, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 28,
      cwd: projectRoot,
      env,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, paneId: input.paneId, error: `Failed to launch ${file}: ${reason}` };
  }

  session.onData(input.onData);
  session.onExit(({ exitCode, signal }) => {
    if (sessions.get(input.paneId) !== session) return;
    sessions.delete(input.paneId);
    input.onExit({ exitCode, signal });
  });

  sessions.set(input.paneId, session);

  return { ok: true, paneId: input.paneId, pid: session.pid };
}

export function writeToPtySession(paneId: string, data: string): void {
  const session = sessions.get(paneId);
  if (!session) return;
  session.write(data);
}

/** Whether a live PTY session exists for the pane (e.g. before sending a prompt). */
export function hasPtySession(paneId: string): boolean {
  return sessions.has(paneId);
}

export function stopPtySession(paneId: string): void {
  const session = sessions.get(paneId);
  if (!session) return;
  session.kill();
  sessions.delete(paneId);
}

export function killAllPtySessions(): string[] {
  const killed: string[] = [];
  for (const [paneId, session] of sessions.entries()) {
    session.kill();
    sessions.delete(paneId);
    killed.push(paneId);
  }
  return killed;
}

export function resizePtySession(paneId: string, cols: number, rows: number): void {
  const session = sessions.get(paneId);
  if (!session) return;
  session.resize(cols, rows);
}
