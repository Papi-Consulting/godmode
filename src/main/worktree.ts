import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ManagedWorktree, WorktreeCleanliness } from '../shared/types.js';

/**
 * Run-scoped git worktree lifecycle for dogfood-safe builder sessions (issue
 * #41). When `workspace.isolation: worktree` is enabled, each run gets its own
 * `git worktree` of the operated project so an agent switching branches, stashing,
 * or rewriting files can never collide with the running app's checkout or sweep
 * away another session's uncommitted work (the 2026-06-04 friction collision).
 *
 * A run worktree **is** the operated project at a different path — same repo, same
 * conceptual context — so it extends the AGENTS.md "agent commands run in the
 * operated-project directory" rule rather than violating it.
 *
 * The pure path-derivation helpers ({@link deriveWorktreePlan},
 * {@link isManagedWorktreePath}, {@link safeWorktreeSegment}) are separated from
 * the git-shelling helpers so they can be unit-tested without a repo. The git
 * helpers shell out with the same spawn discipline as `github.ts` (execFile, no
 * shell, bounded timeout/buffer) and never throw — every failure folds into a
 * typed `{ ok: false, error }` so callers can surface a visible reason.
 */

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Sibling directory (next to the primary checkout) that holds all GodMode-managed
 * worktrees. Deliberately OUTSIDE the checkout so Vite/electron file watchers and
 * harness detection never see it — a worktree inside the root would otherwise
 * trip the dev server's watcher and the harness scan.
 */
export const MANAGED_WORKTREES_DIRNAME = '.godmode-worktrees';

/** Minimal, read-only-ish environment for `git`. Mirrors github.ts. */
function buildGitEnv(): Record<string, string> {
  const keys = ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME'];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

type GitOk = { ok: true; stdout: string };
type GitErr = { ok: false; error: string };
type GitResult = GitOk | GitErr;

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: buildGitEnv(),
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, stdout };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err?.code === 'ENOENT') {
      return { ok: false, error: 'git was not found on PATH.' };
    }
    const stderr = (err?.stderr ?? '').trim();
    return { ok: false, error: stderr || err?.message || 'git command failed.' };
  }
}

// --- Pure path derivation (unit-tested without a repo) ------------------------

/**
 * Reduce an arbitrary string to a single safe path/branch segment: everything
 * outside `[A-Za-z0-9_-]` becomes `-`, runs of `-` collapse, and edges are
 * trimmed. Empty input collapses to `project` so a directory name always exists.
 */
export function safeWorktreeSegment(segment: string): string {
  const safe = segment
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return safe.length > 0 ? safe : 'project';
}

/** Absolute path to the managed-worktrees parent dir for a project (a sibling). */
export function managedWorktreesParent(projectRoot: string): string {
  const root = path.resolve(projectRoot);
  return path.join(path.dirname(root), MANAGED_WORKTREES_DIRNAME);
}

/**
 * Canonicalize a path so symlinked roots compare equal — `git worktree list`
 * reports realpaths (e.g. `/private/var/...` for a `/var/...` tmp dir on macOS),
 * while our derived paths use the as-given root. Falls back to `path.resolve`
 * when the path does not exist yet (nothing to canonicalize).
 */
function canonical(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export type WorktreePlan = {
  /** Absolute worktree directory path. */
  dir: string;
  /** Branch the worktree is created on. */
  branch: string;
  runId: string;
};

/**
 * Derive the deterministic worktree directory + branch for a run. The directory
 * is `<project-parent>/.godmode-worktrees/<project-name>-<run-id>` and the branch
 * is `godmode/<run-id>` — both stable per run so a fix cycle reuses the same pair.
 */
export function deriveWorktreePlan(projectRoot: string, runId: string): WorktreePlan {
  const root = path.resolve(projectRoot);
  const projectName = safeWorktreeSegment(path.basename(root));
  const safeRun = safeWorktreeSegment(runId);
  const dir = path.join(managedWorktreesParent(root), `${projectName}-${safeRun}`);
  const branch = `godmode/${safeRun}`;
  return { dir, branch, runId };
}

/**
 * Whether a path is inside this project's managed-worktrees parent dir. Used as a
 * safety gate before any `git worktree remove` so cleanup can never be pointed at
 * an arbitrary directory.
 */
export function isManagedWorktreePath(projectRoot: string, candidate: string): boolean {
  const parent = canonical(managedWorktreesParent(projectRoot));
  const rel = path.relative(parent, canonical(candidate));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// --- Git-backed lifecycle ----------------------------------------------------

/** Whether the operated project root is inside a git work tree. */
export async function isGitRepo(projectRoot: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--is-inside-work-tree'], path.resolve(projectRoot));
  return result.ok && result.stdout.trim() === 'true';
}

/** Whether a local branch already exists (so we attach rather than re-create). */
async function localBranchExists(projectRoot: string, branch: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], path.resolve(projectRoot));
  return result.ok;
}

export type CreateWorktreeResult =
  | { ok: true; dir: string; branch: string; reused: boolean }
  | { ok: false; error: string };

/**
 * Create (or idempotently reuse) a run worktree on its branch. If the directory
 * already exists it is reused; otherwise `git worktree add` runs — creating the
 * branch with `-b` when it does not yet exist, or attaching to the existing branch
 * on a fix-cycle reuse. Never throws; a failure (not a git repo, branch checked
 * out elsewhere, dir conflict) returns a visible reason.
 */
export async function createWorktree(input: {
  projectRoot: string;
  dir: string;
  branch: string;
}): Promise<CreateWorktreeResult> {
  const projectRoot = path.resolve(input.projectRoot);
  const dir = path.resolve(input.dir);

  if (fs.existsSync(dir)) {
    // Reuse: the run already has this worktree (fix cycle, or a re-prepare after
    // the builder pane was restarted).
    return { ok: true, dir, branch: input.branch, reused: true };
  }

  try {
    fs.mkdirSync(managedWorktreesParent(projectRoot), { recursive: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not create the worktrees directory: ${reason}` };
  }

  const hasBranch = await localBranchExists(projectRoot, input.branch);
  const args = hasBranch
    ? ['worktree', 'add', dir, input.branch]
    : ['worktree', 'add', '-b', input.branch, dir];
  const result = await runGit(args, projectRoot);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, dir, branch: input.branch, reused: false };
}

/**
 * Inspect whether a worktree is safe to remove: clean only when there are no
 * uncommitted/untracked changes AND no commits on HEAD that are absent from every
 * remote-tracking branch (unpushed work). Conservative by construction — a query
 * failure marks it dirty so cleanup never silently removes unverified work.
 */
export async function inspectWorktree(dir: string): Promise<WorktreeCleanliness> {
  const worktreeDir = path.resolve(dir);
  const reasons: string[] = [];

  if (!fs.existsSync(worktreeDir)) {
    return { clean: false, dirty: false, unpushed: false, reasons: ['Worktree directory does not exist.'] };
  }

  const status = await runGit(['status', '--porcelain'], worktreeDir);
  let dirty = false;
  if (!status.ok) {
    dirty = true;
    reasons.push(`Could not read worktree status: ${status.error}`);
  } else if (status.stdout.trim().length > 0) {
    dirty = true;
    reasons.push('Worktree has uncommitted or untracked changes.');
  }

  // Commits reachable from HEAD but not from any remote-tracking ref are unpushed.
  // Works without an upstream being configured.
  const unpushedCount = await runGit(['rev-list', '--count', 'HEAD', '--not', '--remotes'], worktreeDir);
  let unpushed = false;
  if (!unpushedCount.ok) {
    unpushed = true;
    reasons.push(`Could not determine unpushed commits: ${unpushedCount.error}`);
  } else if (Number.parseInt(unpushedCount.stdout.trim(), 10) > 0) {
    unpushed = true;
    reasons.push('Worktree has commits not pushed to any remote.');
  }

  const clean = !dirty && !unpushed;
  return { clean, dirty, unpushed, reasons };
}

export type RemoveWorktreeResult = { ok: true } | { ok: false; error: string };

/**
 * Remove a worktree via `git worktree remove`. The caller is responsible for the
 * dirty-check ({@link inspectWorktree}) and the managed-path gate
 * ({@link isManagedWorktreePath}) first — this only performs the removal. Never
 * uses `--force` so git itself refuses to drop a dirty tree as a backstop.
 */
export async function removeWorktree(input: { projectRoot: string; dir: string }): Promise<RemoveWorktreeResult> {
  const result = await runGit(['worktree', 'remove', path.resolve(input.dir)], path.resolve(input.projectRoot));
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}

type ParsedWorktreeEntry = { path: string; branch: string | null; head: string | null };

/** Parse `git worktree list --porcelain` into per-worktree entries. */
function parseWorktreeList(stdout: string): ParsedWorktreeEntry[] {
  const entries: ParsedWorktreeEntry[] = [];
  let current: ParsedWorktreeEntry | null = null;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length), branch: null, head: null };
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * List GodMode-managed worktrees for the operated project (those under the managed
 * parent dir), each with its cleanliness so the UI can offer cleanup with the same
 * dirty-check rules. Used to surface orphaned worktrees on app start / project
 * select. The active run's worktree is flagged via {@link currentRunWorktreePath}.
 */
export async function listManagedWorktrees(
  projectRoot: string,
  currentRunWorktreePath?: string,
): Promise<ManagedWorktree[]> {
  const root = path.resolve(projectRoot);
  const result = await runGit(['worktree', 'list', '--porcelain'], root);
  if (!result.ok) return [];

  const managed = parseWorktreeList(result.stdout).filter((entry) => isManagedWorktreePath(root, entry.path));
  const current = currentRunWorktreePath ? canonical(currentRunWorktreePath) : undefined;

  const out: ManagedWorktree[] = [];
  for (const entry of managed) {
    const cleanliness = await inspectWorktree(entry.path);
    out.push({
      path: entry.path,
      branch: entry.branch,
      head: entry.head,
      cleanliness,
      isCurrentRun: current !== undefined && canonical(entry.path) === current,
    });
  }
  return out;
}
