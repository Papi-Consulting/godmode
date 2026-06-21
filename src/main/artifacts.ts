import fs from 'node:fs';
import path from 'node:path';
import type { RunFindings, RunSnapshot } from '../shared/types.js';

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

/** `.godmode/runs/<run-id>/<reviewer-id>.log` — the legacy single-artifact path. */
export function reviewerArtifactRelPath(runId: string, reviewerId: string): string {
  return path.posix.join('.godmode', 'runs', safeArtifactSegment(runId), `${safeArtifactSegment(reviewerId)}.log`);
}

/**
 * `.godmode/runs/<run-id>/reviewers/<reviewer-id>-<attempt-id>.log` — the
 * **attempt-specific** captured-output artifact path (issue #59). Each reviewer
 * launch/relaunch gets a distinct attempt id, so a post-fix relaunch against a new
 * PR head writes to a new file rather than overwriting the prior attempt's
 * evidence. Both id segments are path-confined like every other artifact path, so
 * a crafted reviewer id or attempt id can never escape the run dir.
 */
export function reviewerAttemptArtifactRelPath(runId: string, reviewerId: string, attemptId: string): string {
  return path.posix.join(
    '.godmode',
    'runs',
    safeArtifactSegment(runId),
    'reviewers',
    `${safeArtifactSegment(reviewerId)}-${safeArtifactSegment(attemptId)}.log`,
  );
}

/** Absolute path to one reviewer **attempt's** captured-output log (issue #59). */
export function reviewerAttemptArtifactPath(
  projectRoot: string,
  runId: string,
  reviewerId: string,
  attemptId: string,
): string {
  return path.resolve(projectRoot, reviewerAttemptArtifactRelPath(runId, reviewerId, attemptId));
}

/**
 * Resolve and create the per-run `reviewers/` subdir holding attempt-specific
 * reviewer artifacts (issue #59), returning its absolute path. `mkdir -p`
 * semantics under the operated-project root.
 */
export function ensureReviewerArtifactDir(projectRoot: string, runId: string): string {
  const dir = path.resolve(projectRoot, '.godmode', 'runs', safeArtifactSegment(runId), 'reviewers');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

/**
 * Read a reviewer's captured-output artifact (issue #11). Returns the file's text,
 * or null when it is absent/unreadable — a reviewer whose output was never
 * captured parses to an ambiguous result rather than crashing synthesis.
 */
export function readReviewerArtifact(projectRoot: string, runId: string, reviewerId: string): string | null {
  try {
    return fs.readFileSync(reviewerArtifactPath(projectRoot, runId, reviewerId), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read a captured artifact by its **project-relative** path (issue #59). Reviewer
 * sessions record their own attempt-specific `artifactPath`, so synthesis reads
 * exactly the attempt's file rather than recomputing a single per-reviewer path
 * (which would let a relaunch's parse pick up a prior attempt). The path is
 * resolved under the operated-project root and confined to the run-artifact dir:
 * a relative path that escapes `.godmode/runs/` (e.g. via `..`) reads as null
 * rather than reaching outside it. Absent/unreadable files also return null, so a
 * reviewer whose output was never captured parses to an ambiguous result.
 */
export function readArtifactByRelPath(projectRoot: string, relPath: string): string | null {
  try {
    const runsRoot = path.resolve(projectRoot, '.godmode', 'runs');
    const abs = path.resolve(projectRoot, relPath);
    const rel = path.relative(runsRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** `.godmode/runs/<run-id>/findings.json` — the persisted parsed-findings doc path. */
export function runFindingsRelPath(runId: string): string {
  return path.posix.join('.godmode', 'runs', safeArtifactSegment(runId), 'findings.json');
}

/** Absolute path to a run's `findings.json` under the operated project. */
export function runFindingsPath(projectRoot: string, runId: string): string {
  return path.resolve(projectRoot, '.godmode', 'runs', safeArtifactSegment(runId), 'findings.json');
}

/**
 * Persist a run's parsed findings + merge-gate doc to
 * `.godmode/runs/<run-id>/findings.json` (issue #11), returning whether the write
 * succeeded. Best-effort like {@link appendArtifact}: a failed write is reported
 * (so the caller can note it) but never throws — the findings already live on the
 * in-memory run snapshot, so a lost file does not lose the synthesis.
 */
export function writeRunFindings(projectRoot: string, runId: string, findings: RunFindings): boolean {
  try {
    ensureRunArtifactDir(projectRoot, runId);
    fs.writeFileSync(runFindingsPath(projectRoot, runId), `${JSON.stringify(findings, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** `.godmode/runs/<run-id>/run.json` — the human-readable run-snapshot mirror path. */
export function runSnapshotRelPath(runId: string): string {
  return path.posix.join('.godmode', 'runs', safeArtifactSegment(runId), 'run.json');
}

/** Absolute path to a run's `run.json` snapshot mirror under the operated project. */
export function runSnapshotPath(projectRoot: string, runId: string): string {
  return path.resolve(projectRoot, '.godmode', 'runs', safeArtifactSegment(runId), 'run.json');
}

/**
 * Mirror the latest run snapshot to `.godmode/runs/<run-id>/run.json` (issue #40),
 * returning whether the write succeeded. Best-effort like {@link writeRunFindings}:
 * the authoritative persisted copy lives in the run store (`store.ts`); this is the
 * human-readable mirror alongside the reviewer logs and `findings.json`, written
 * through the same path-confinement helpers so it stays inside the run dir. A failed
 * write is reported (so the caller can note it) but never throws.
 */
export function writeRunSnapshot(projectRoot: string, runId: string, run: RunSnapshot): boolean {
  try {
    ensureRunArtifactDir(projectRoot, runId);
    fs.writeFileSync(runSnapshotPath(projectRoot, runId), `${JSON.stringify(run, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
