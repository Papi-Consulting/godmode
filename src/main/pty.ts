import fs from 'node:fs';
import path from 'node:path';
import * as pty from 'node-pty';
import type { AgentRole, PaneSessionLifecycle, PaneSessionState, PtyWriteResult } from '../shared/types.js';

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

/** Every role pane the PTY layer tracks. Order is the renderer display order. */
const PANE_IDS: readonly AgentRole[] = ['head', 'builder', 'reviewer_a', 'reviewer_b'];
const allowedPaneIds = new Set<string>(PANE_IDS);
const sessions = new Map<string, pty.IPty>();
/** The launch cwd per live pane, so the handoff send can confirm isolation (issue #41). */
const sessionCwds = new Map<string, string>();

// --- Pane session-state registry (issue #63) ---------------------------------
// The single source of truth for each role pane's PTY lifecycle. Every launch path
// (renderer Start, builder recovery relaunch, reviewer launch) funnels through
// openPtySession/stopPtySession/killAllPtySessions, so updating state here keeps
// all panes consistent without each caller re-deriving it. Main subscribes via
// setPaneSessionListener and pushes snapshots to the renderer.

type PaneSessionListener = (states: PaneSessionState[]) => void;

let paneSessionListener: PaneSessionListener | null = null;
/** Rolling tail of recent output per pane, for conservative prompt detection. */
const outputTails = new Map<string, string>();
const TAIL_LIMIT = 600;

function freshPaneState(paneId: AgentRole): PaneSessionState {
  return {
    paneId,
    lifecycle: 'never_started',
    live: false,
    pid: null,
    exitCode: null,
    signal: null,
    cwd: null,
    error: null,
    awaitingInput: false,
    changedAt: new Date().toISOString(),
  };
}

const paneSessionStates = new Map<AgentRole, PaneSessionState>(
  PANE_IDS.map((paneId) => [paneId, freshPaneState(paneId)]),
);

/**
 * Register the single listener notified whenever any pane's session state changes
 * (issue #63). Main wires this to push `godmode:pty:state` to the renderer. Passing
 * null detaches it (e.g. in tests).
 */
export function setPaneSessionListener(listener: PaneSessionListener | null): void {
  paneSessionListener = listener;
}

/** Current session state for one pane (defaults to never_started for a known pane). */
export function getPaneSessionState(paneId: string): PaneSessionState | null {
  if (!allowedPaneIds.has(paneId)) return null;
  return paneSessionStates.get(paneId as AgentRole) ?? freshPaneState(paneId as AgentRole);
}

/** Snapshot of every tracked pane's session state, in display order. */
export function getPaneSessionStates(): PaneSessionState[] {
  return PANE_IDS.map((paneId) => paneSessionStates.get(paneId) ?? freshPaneState(paneId));
}

/**
 * Merge a patch into a pane's session state and notify the listener. `live` is
 * always derived from the lifecycle so it can never drift from the truth, and
 * `changedAt` is re-stamped on every accepted change.
 */
function updatePaneSession(paneId: AgentRole, patch: Partial<PaneSessionState>): void {
  const current = paneSessionStates.get(paneId) ?? freshPaneState(paneId);
  const lifecycle: PaneSessionLifecycle = patch.lifecycle ?? current.lifecycle;
  const next: PaneSessionState = {
    ...current,
    ...patch,
    paneId,
    lifecycle,
    live: lifecycle === 'running',
    changedAt: new Date().toISOString(),
  };
  paneSessionStates.set(paneId, next);
  paneSessionListener?.(getPaneSessionStates());
}

/**
 * Record a launch rejection that happens BEFORE {@link openPtySession} is reached
 * (issue #63). Some callers refuse a Start/Restart in a preflight step — no agent
 * configured / non-cli adapter (`resolveRoleLaunch`), a one-shot reviewer blocked
 * by the generic-start gate, or a builder run-worktree setup failure — and return
 * a typed error without ever entering the spawn path. Without this, main's
 * authoritative pane state stays `never_started`/`exited`/`stopped` and the header
 * falls back to a static `ready`/`watching` while the terminal shows an error,
 * breaking #63's single-source-of-truth model.
 *
 * This mirrors the in-spawn `failed` transition so EVERY launch path funnels the
 * lifecycle through this registry. Guarded exactly like a failed restart: it never
 * clobbers a still-live session for the pane (an unknown pane id is ignored).
 */
export function recordPaneLaunchFailure(paneId: string, error: string): void {
  if (!allowedPaneIds.has(paneId)) return;
  if (sessions.has(paneId)) return;
  updatePaneSession(paneId as AgentRole, {
    lifecycle: 'failed',
    error,
    pid: null,
    exitCode: null,
    signal: null,
    awaitingInput: false,
  });
}

/**
 * Whether a chunk of recent PTY output looks like the agent is blocked on operator
 * input (issue #63 scope 3). Deliberately conservative and vendor-neutral: it only
 * fires on the trailing line, on a small set of documented, generic
 * permission/confirmation shapes (e.g. `[y/N]`, `(yes/no)`, "Do you want to
 * proceed?", "Press Enter to continue", "Allow this action?"). Pure and exported so
 * the heuristic is unit-testable and easy to tune/override. False positives only
 * cost a benign "needs operator" hint that clears on the next output or input — it
 * never gates delivery.
 */
export function detectPromptAttention(text: string): boolean {
  if (!text) return false;
  // Strip ANSI escapes and trailing whitespace, then look at the last non-empty line.
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');
  const lines = cleaned.split(/\r?\n/).map((line) => line.trimEnd());
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const tail = lines[lines.length - 1] ?? '';
  if (!tail) return false;
  const patterns: RegExp[] = [
    /\[y\/n\]\s*$/i,
    /\(y\/n\)\s*$/i,
    /\[yes\/no\]\s*$/i,
    /\(yes\/no\)\s*$/i,
    /\by\/n\?\s*$/i,
    /\bproceed\?\s*$/i,
    /do you want to .+\?\s*$/i,
    /press enter to continue/i,
    /allow this (action|command|edit)\??\s*$/i,
    /waiting for (your )?(approval|confirmation|input)/i,
    /\?\s*\(y\/n\)/i,
  ];
  return patterns.some((re) => re.test(tail));
}

/**
 * Feed live PTY output through the conservative prompt detector and update the
 * pane's attention flag only when it changes (issue #63). Keeps a small rolling
 * tail so a prompt split across chunks is still seen.
 */
function observePaneOutput(paneId: AgentRole, data: string): void {
  const tail = ((outputTails.get(paneId) ?? '') + data).slice(-TAIL_LIMIT);
  outputTails.set(paneId, tail);
  const awaiting = detectPromptAttention(tail);
  const current = paneSessionStates.get(paneId);
  if (current && current.lifecycle === 'running' && current.awaitingInput !== awaiting) {
    updatePaneSession(paneId, { awaitingInput: awaiting });
  }
}

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
  // Record a launch failure as `failed` session state (issue #63) and return the
  // typed result. A failed *restart* must never clobber a session that is still
  // live (the existing session is only killed once the new command is validated),
  // so skip the state write when a live session remains for the pane.
  const fail = (error: string): PtyStartResult => {
    recordPaneLaunchFailure(input.paneId, error);
    return { ok: false, paneId: input.paneId, error };
  };

  if (!allowedPaneIds.has(input.paneId)) {
    return fail(`Unknown pane id: ${input.paneId}`);
  }
  const paneId = input.paneId as AgentRole;

  const { file, args } = splitCommand(input.command);
  if (!file) {
    return fail('No command is configured for this role.');
  }

  // Restrict the launch cwd to the selected operated-project root OR the active
  // run's registered worktree (issue #41) — nothing else — and confirm it is a
  // readable directory before spawning anything.
  const projectRoot = path.resolve(input.projectRoot);
  const launchCwd = path.resolve(input.cwd ?? projectRoot);
  if (!isAllowedPtyCwd(projectRoot, input.worktreePath, launchCwd)) {
    return fail(`Refusing to launch outside the operated project root or its run worktree: ${launchCwd}`);
  }
  try {
    if (!fs.statSync(launchCwd).isDirectory()) {
      return fail(`Launch directory is not a directory: ${launchCwd}`);
    }
  } catch {
    return fail(`Launch directory is not accessible: ${launchCwd}`);
  }

  const env = buildSafeEnv();
  // Resolve a path-bearing command against the actual launch dir (the worktree
  // when isolated), so a project-relative executable resolves where it runs.
  const executable = resolveExecutable(file, launchCwd, env);
  if (!executable) {
    return fail(`Command not found: ${file}`);
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
    return fail(`Failed to launch ${file}: ${reason}`);
  }

  session.onData((data) => {
    observePaneOutput(paneId, data);
    input.onData(data);
  });
  session.onExit(({ exitCode, signal }) => {
    if (sessions.get(input.paneId) !== session) return;
    sessions.delete(input.paneId);
    sessionCwds.delete(input.paneId);
    outputTails.delete(paneId);
    // The process ended on its own (a one-shot reviewer finished, an agent quit).
    // Distinct from operator `stopped` so the UI can show the real exit code.
    updatePaneSession(paneId, {
      lifecycle: 'exited',
      pid: null,
      exitCode,
      signal: signal ?? null,
      error: null,
      awaitingInput: false,
    });
    input.onExit({ exitCode, signal });
  });

  sessions.set(input.paneId, session);
  sessionCwds.set(input.paneId, launchCwd);
  outputTails.set(paneId, '');
  updatePaneSession(paneId, {
    lifecycle: 'running',
    pid: session.pid,
    exitCode: null,
    signal: null,
    cwd: launchCwd,
    error: null,
    awaitingInput: false,
  });

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
    // Input was just delivered, so any "needs operator" prompt is being answered;
    // clear the conservative attention flag (issue #63) until the next prompt.
    const current = paneSessionStates.get(paneId as AgentRole);
    if (current && current.awaitingInput) {
      outputTails.set(paneId, '');
      updatePaneSession(paneId as AgentRole, { awaitingInput: false });
    }
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
  outputTails.delete(paneId);
  // The onExit handler bails out (the session was removed above), so record the
  // operator-initiated end here as `stopped` — distinct from a self-exit (#63).
  updatePaneSession(paneId as AgentRole, {
    lifecycle: 'stopped',
    pid: null,
    exitCode: null,
    signal: null,
    error: null,
    awaitingInput: false,
  });
}

export function killAllPtySessions(): string[] {
  const killed: string[] = [];
  for (const [paneId, session] of sessions.entries()) {
    session.kill();
    sessions.delete(paneId);
    sessionCwds.delete(paneId);
    outputTails.delete(paneId);
    killed.push(paneId);
  }
  // Project switch / app quit tears these down; reflect them as `stopped` (#63).
  for (const paneId of killed) {
    updatePaneSession(paneId as AgentRole, {
      lifecycle: 'stopped',
      pid: null,
      exitCode: null,
      signal: null,
      error: null,
      awaitingInput: false,
    });
  }
  return killed;
}

export function resizePtySession(paneId: string, cols: number, rows: number): void {
  const session = sessions.get(paneId);
  if (!session) return;
  session.resize(cols, rows);
}
