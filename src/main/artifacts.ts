import fs from 'node:fs';
import path from 'node:path';

/**
 * Local run-artifact helpers (issue #10). Reviewer session output is captured to
 * `.godmode/runs/<run-id>/<reviewer-id>.log` under the **operated project** root
 * (the repo opened in GodMode, never the GodMode app repo). `.godmode/runs/` is
 * gitignored, so these never enter the operated project's history.
 *
 * Kept tiny and dependency-free so the path logic can be unit-tested over a temp
 * dir (mirroring `pty.test.js`); the capture wiring itself lives in
 * `src/main/index.ts`.
 */

/**
 * Reduce an id to a single safe path segment. Reviewer ids come from project
 * config, where the schema only guarantees a non-empty string, so a value
 * containing `/`, `\`, or `..` could otherwise escape `.godmode/runs/<run-id>/`.
 * Mapping every character outside `[A-Za-z0-9_-]` to `_` keeps the artifact
 * confined to the run dir by construction (a defense-in-depth complement to the
 * id slug check in the config schema). Empty input collapses to `_`.
 */
export function safeArtifactSegment(segment: string): string {
  const safe = segment.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe.length > 0 ? safe : '_';
}

/** Project-relative directory holding a run's artifacts. */
export function runArtifactRelDir(runId: string): string {
  return path.posix.join('.godmode', 'runs', safeArtifactSegment(runId));
}

/** `.godmode/runs/<run-id>/<reviewer-id>.log` — the captured-output artifact path. */
export function reviewerArtifactRelPath(runId: string, reviewerId: string): string {
  return path.posix.join('.godmode', 'runs', safeArtifactSegment(runId), `${safeArtifactSegment(reviewerId)}.log`);
}

/**
 * Resolve and create the absolute artifact directory for a run under the operated
 * project root, returning its absolute path. `mkdir -p` semantics; the run id is
 * treated as a single path segment (it is harness-generated, not user input).
 */
export function ensureRunArtifactDir(projectRoot: string, runId: string): string {
  const dir = path.resolve(projectRoot, '.godmode', 'runs', safeArtifactSegment(runId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path to one reviewer's captured-output log under the operated project. */
export function reviewerArtifactPath(projectRoot: string, runId: string, reviewerId: string): string {
  return path.resolve(projectRoot, '.godmode', 'runs', safeArtifactSegment(runId), `${safeArtifactSegment(reviewerId)}.log`);
}

/**
 * Append captured session output to an artifact file, returning whether the write
 * succeeded. A failure (e.g. the dir was removed) never throws into the PTY data
 * callback — a lost write must not crash the live session — but the boolean lets
 * the caller record a *visible* capture failure on the reviewer rather than
 * silently marking the review complete (issue #10 acceptance).
 */
export function appendArtifact(absPath: string, data: string): boolean {
  try {
    fs.appendFileSync(absPath, data);
    return true;
  } catch {
    return false;
  }
}
