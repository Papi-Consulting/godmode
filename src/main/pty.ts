import fs from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import type { PtyWriteResult } from '../shared/types.js';

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
  /**
   * Extra arguments appended after the command's own tokens at spawn time. Used
   * to deliver a one-shot agent's prompt as a final argv element (so it is
   * present when the process starts and reads it to completion), instead of
   * writing it into the PTY after spawn — which a one-shot process may have
   * already exited past. Each element becomes one argv entry (no shell), so no
   * quoting is needed.
   */
  extraArgs?: string[];
  /**
   * Working directory to launch in (issue #41). Defaults to {@link projectRoot}.
   * Must be either the operated-project root or {@link worktreePath}; anything
   * else is rejected with a visible error rather than spawned.
   */
  cwd?: string;
  /**
   * The active run's registered git worktree, when the session is isolated
   * (issue #41). This is the ONLY non-root directory the cwd allowlist admits.
   */
  worktreePath?: string;
  onData: (data: string) => void;
  onExit: (exit: PtyExit) => void;
};

const allowedPaneIds = new Set(['head', 'builder', 'reviewer_a', 'reviewer_b']);
const sessions = new Map<string, pty.IPty>();
/** The launch cwd per live pane, so the handoff send can confirm isolation (issue #41). */
const sessionCwds = new Map<string, string>();

/**
 * Whether a candidate launch cwd is admissible: exactly the operated-project root
 * or the active run's registered worktree, nothing else (issue #41). Pure and
 * exported so the allowlist is unit-testable without spawning a PTY.
 */
export function isAllowedPtyCwd(
  projectRoot: string,
  worktreePath: string | undefined,
  candidate: string,
): boolean {
  const cand = path.resolve(candidate);
  if (cand === path.resolve(projectRoot)) return true;
  if (worktreePath && cand === path.resolve(worktreePath)) return true;
  return false;
}

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

  // Restrict the launch cwd to the selected operated-project root OR the active
  // run's registered worktree (issue #41) — nothing else — and confirm it is a
  // readable directory before spawning anything.
  const projectRoot = path.resolve(input.projectRoot);
  const launchCwd = path.resolve(input.cwd ?? projectRoot);
  if (!isAllowedPtyCwd(projectRoot, input.worktreePath, launchCwd)) {
    return {
      ok: false,
      paneId: input.paneId,
      error: `Refusing to launch outside the operated project root or its run worktree: ${launchCwd}`,
    };
  }
  try {
    if (!fs.statSync(launchCwd).isDirectory()) {
      return { ok: false, paneId: input.paneId, error: `Launch directory is not a directory: ${launchCwd}` };
    }
  } catch {
    return { ok: false, paneId: input.paneId, error: `Launch directory is not accessible: ${launchCwd}` };
  }

  const env = buildSafeEnv();
  // Resolve a path-bearing command against the actual launch dir (the worktree
  // when isolated), so a project-relative executable resolves where it runs.
  const executable = resolveExecutable(file, launchCwd, env);
  if (!executable) {
    return { ok: false, paneId: input.paneId, error: `Command not found: ${file}` };
  }

  // Only tear down the existing session once the new command is known good, so a
  // restart with a now-broken command leaves the running session in place.
  const existing = sessions.get(input.paneId);
  if (existing) {
    existing.kill();
    sessions.delete(input.paneId);
    sessionCwds.delete(input.paneId);
  }

  const spawnArgs = input.extraArgs ? [...args, ...input.extraArgs] : args;
  let session: pty.IPty;
  try {
    session = pty.spawn(executable, spawnArgs, {
      name: 'xterm-256color',
      cols: 100,
      rows: 28,
      cwd: launchCwd,
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
    sessionCwds.delete(input.paneId);
    input.onExit({ exitCode, signal });
  });

  sessions.set(input.paneId, session);
  sessionCwds.set(input.paneId, launchCwd);

  return { ok: true, paneId: input.paneId, pid: session.pid };
}

/**
 * The resolved launch cwd of a live pane session, or null when none (issue #41).
 * The handoff send uses this to confirm the builder PTY is actually running in the
 * run's worktree before delivering the prompt — never into a shared checkout.
 */
export function getPtySessionCwd(paneId: string): string | null {
  return sessionCwds.get(paneId) ?? null;
}

/**
 * Write bytes to a role PTY and return a typed delivery result (issue #57). Unlike
 * {@link writeToPtySession}, an unknown pane id or a pane with no live session does
 * not silently disappear — it returns a typed failure the renderer can surface so
 * an operator's "Send" never looks delivered when nothing was written.
 */
export function writeToPtySessionResult(paneId: string, data: string): PtyWriteResult {
  if (!allowedPaneIds.has(paneId)) {
    return { ok: false, paneId, code: 'unknown_pane', error: `Unknown pane id: ${paneId}` };
  }
  const session = sessions.get(paneId);
  if (!session) {
    return {
      ok: false,
      paneId,
      code: 'no_live_session',
      error: `No live ${paneId} session to deliver to. Start (or restart) the session and retry.`,
    };
  }
  try {
    session.write(data);
    return { ok: true, paneId, bytes: Buffer.byteLength(data) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, paneId, code: 'write_failed', error: `Failed to write to ${paneId}: ${reason}` };
  }
}

/**
 * Fire-and-forget PTY write retained for the internal callers (handoff/fix/reviewer
 * prompt delivery) that already gate on {@link hasPtySession}. Delegates to
 * {@link writeToPtySessionResult} so there is a single write code path; the result
 * is intentionally ignored here.
 */
export function writeToPtySession(paneId: string, data: string): void {
  writeToPtySessionResult(paneId, data);
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
  sessionCwds.delete(paneId);
}

export function killAllPtySessions(): string[] {
  const killed: string[] = [];
  for (const [paneId, session] of sessions.entries()) {
    session.kill();
    sessions.delete(paneId);
    sessionCwds.delete(paneId);
    killed.push(paneId);
  }
  return killed;
}

export function resizePtySession(paneId: string, cols: number, rows: number): void {
  const session = sessions.get(paneId);
  if (!session) return;
  session.resize(cols, rows);
}
