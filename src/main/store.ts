import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import type BetterSqlite3 from 'better-sqlite3';
import type { RunSnapshot, RunStorageBackend } from '../shared/types.js';
import { isTerminalStatus } from './run.js';

/**
 * Per-operated-project run persistence (issue #40).
 *
 * The current run snapshot is written through to a small store inside the
 * **operated project** root (a sibling of the existing `.godmode/runs/`
 * artifacts), so quitting GodMode mid-run never loses the run: on relaunch the
 * operator is offered an explicit Resume/Discard choice for the project.
 *
 * Backend: SQLite via `better-sqlite3` (already a dependency; synchronous writes
 * so "killing the app right after a transition loses nothing"). `better-sqlite3`
 * is a native module — when it cannot load inside the host (e.g. an Electron ABI
 * mismatch with no `electron-rebuild`) the store transparently falls back to a
 * JSON file with the **same interface**, so the write-through + resume contract
 * holds either way. The chosen backend is reported so the gap is visible/auditable.
 *
 * Kept dependency-light and testable over a temp project root (mirroring
 * `artifacts.test.js`); the resume/discard wiring lives in `src/main/index.ts`.
 */

/** `.godmode` directory under the operated project root (shared with artifacts). */
const STORE_DIR = '.godmode';
/** SQLite database filename (the preferred backend). */
export const STORE_DB_FILENAME = 'godmode.db';
/** JSON fallback filename, used only when the native SQLite module cannot load. */
export const STORE_JSON_FILENAME = 'godmode.db.json';

/** Project-relative path to the SQLite database. */
export function storeDbRelPath(): string {
  return path.posix.join(STORE_DIR, STORE_DB_FILENAME);
}

/** Result of a persistence write — `ok:false` degrades the UI to in-memory mode. */
export type StoreWriteResult = { ok: true; backend: RunStorageBackend } | { ok: false; backend: RunStorageBackend; error: string };

/** A loaded unfinished run plus the backend it came from. */
export type StoreLoadResult = { run: RunSnapshot; backend: RunStorageBackend };

// --- Snapshot validation gate ------------------------------------------------
//
// Used only to REJECT a corrupt/foreign persisted snapshot on load. On success
// the caller returns the faithful original parsed-JSON object (not zod's output),
// so unmodelled audit fields are never silently stripped on a resume round-trip.

const runStatusValues = [
  'idle', 'issue_selected', 'needs_spec', 'ready_to_build', 'builder_running',
  'pr_opened', 'reviewers_running', 'review_synthesis', 'builder_fixing',
  'fix_pushed', 'reviewers_rerunning', 'merge_ready', 'karan_merged', 'closed',
  'paused', 'cancelled', 'needs_human', 'agent_failed', 'max_cycles_exceeded',
] as const;

/**
 * Shape gate for a persisted run snapshot. The core fields the state machine and
 * resume surface depend on are validated strictly; deep audit structures
 * (`log`, `prompts`, `verifications`, `reviewers`, `findings`, `sourceDetail`,
 * `worktree`) are accepted as loose arrays/objects so a valid future field never
 * fails the gate. Validation success only confirms the snapshot is GodMode's;
 * the original object is what gets returned.
 */
export const runSnapshotSchema = z
  .object({
    id: z.string().min(1),
    sourceType: z.string().min(1),
    sourceId: z.string().min(1),
    issueNumber: z.number().int().optional(),
    status: z.enum(runStatusValues),
    cycle: z.number().int(),
    maxCycles: z.number().int(),
    isolation: z.enum(['shared', 'worktree']),
    availableActions: z.array(z.string()),
    log: z.array(z.unknown()),
    prompts: z.array(z.unknown()),
    verifications: z.array(z.unknown()),
    reviewers: z.array(z.unknown()).optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .passthrough();

/** Validate a parsed object as a run snapshot; returns it faithfully or null. */
export function validateRunSnapshot(value: unknown): RunSnapshot | null {
  const parsed = runSnapshotSchema.safeParse(value);
  if (!parsed.success) return null;
  return value as RunSnapshot;
}

// --- Backend abstraction -----------------------------------------------------

type StoreRow = {
  id: string;
  status: string;
  issueNumber: number | null;
  branch: string | null;
  prNumber: number | null;
  archived: number;
  createdAt: string;
  updatedAt: string;
  snapshot: string;
};

type Backend = {
  kind: RunStorageBackend;
  upsert(row: StoreRow): void;
  loadUnfinished(): RunSnapshot | null;
  archive(runId: string): boolean;
  close(): void;
};

function toRow(run: RunSnapshot): StoreRow {
  return {
    id: run.id,
    status: run.status,
    issueNumber: run.issueNumber ?? null,
    branch: run.branch ?? null,
    prNumber: run.prNumber ?? null,
    archived: 0,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    snapshot: JSON.stringify(run),
  };
}

/** Pick the most recent non-archived, non-terminal snapshot from candidate rows. */
function pickUnfinished(rows: { snapshot: string; archived: number; status: string; updatedAt: string }[]): RunSnapshot | null {
  const candidates = rows
    .filter((row) => row.archived === 0 && !isTerminalStatus(row.status as RunSnapshot['status']))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  for (const row of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.snapshot);
    } catch {
      continue;
    }
    const valid = validateRunSnapshot(parsed);
    // Defend against a stale `status` column drifting from the snapshot body.
    if (valid && !isTerminalStatus(valid.status)) return valid;
  }
  return null;
}

// --- SQLite backend ----------------------------------------------------------

const require = createRequire(import.meta.url);

/** Lazily load the native SQLite constructor; null when it cannot be required. */
let sqliteCtor: typeof BetterSqlite3 | null | undefined;
function loadSqlite(): typeof BetterSqlite3 | null {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    sqliteCtor = require('better-sqlite3') as typeof BetterSqlite3;
  } catch {
    sqliteCtor = null;
  }
  return sqliteCtor;
}

function openSqliteBackend(dir: string): Backend | null {
  const Ctor = loadSqlite();
  if (!Ctor) return null;
  let db: BetterSqlite3.Database;
  try {
    db = new Ctor(path.join(dir, STORE_DB_FILENAME));
    db.pragma('journal_mode = WAL');
    db.exec(
      `CREATE TABLE IF NOT EXISTS runs (
         id TEXT PRIMARY KEY,
         status TEXT NOT NULL,
         issue_number INTEGER,
         branch TEXT,
         pr_number INTEGER,
         archived INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         snapshot TEXT NOT NULL
       )`,
    );
  } catch {
    return null;
  }
  return {
    kind: 'sqlite',
    upsert(row) {
      db.prepare(
        `INSERT INTO runs (id, status, issue_number, branch, pr_number, archived, created_at, updated_at, snapshot)
         VALUES (@id, @status, @issueNumber, @branch, @prNumber, @archived, @createdAt, @updatedAt, @snapshot)
         ON CONFLICT(id) DO UPDATE SET
           status=excluded.status,
           issue_number=excluded.issue_number,
           branch=excluded.branch,
           pr_number=excluded.pr_number,
           updated_at=excluded.updated_at,
           snapshot=excluded.snapshot`,
      ).run(row);
    },
    loadUnfinished() {
      const rows = db
        .prepare(`SELECT snapshot, archived, status, updated_at AS updatedAt FROM runs`)
        .all() as { snapshot: string; archived: number; status: string; updatedAt: string }[];
      return pickUnfinished(rows);
    },
    archive(runId) {
      const info = db.prepare(`UPDATE runs SET archived=1 WHERE id=?`).run(runId);
      return info.changes > 0;
    },
    close() {
      db.close();
    },
  };
}

// --- JSON fallback backend ---------------------------------------------------

type JsonShape = { runs: Record<string, StoreRow> };

function openJsonBackend(dir: string): Backend {
  const file = path.join(dir, STORE_JSON_FILENAME);
  const read = (): JsonShape => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonShape;
      if (parsed && typeof parsed === 'object' && parsed.runs) return parsed;
    } catch {
      /* fall through to empty */
    }
    return { runs: {} };
  };
  const write = (data: JsonShape) => {
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  };
  return {
    kind: 'json',
    upsert(row) {
      const data = read();
      const existing = data.runs[row.id];
      data.runs[row.id] = { ...row, archived: existing?.archived ?? row.archived };
      write(data);
    },
    loadUnfinished() {
      return pickUnfinished(Object.values(read().runs));
    },
    archive(runId) {
      const data = read();
      if (!data.runs[runId]) return false;
      data.runs[runId] = { ...data.runs[runId], archived: 1 };
      write(data);
      return true;
    },
    close() {
      /* nothing to release for the JSON backend */
    },
  };
}

// --- Backend cache + public API ----------------------------------------------

/** Open backends cached per resolved `.godmode` dir so writes reuse one handle. */
const backends = new Map<string, Backend>();

/**
 * Backend selection override for tests/diagnostics, read from the environment so
 * the JSON fallback path can be exercised without a native ABI mismatch:
 *   - `sqlite`  force SQLite (and fail to JSON only if it truly cannot open)
 *   - `json`    force the JSON file backend
 *   - unset/`auto`  prefer SQLite, fall back to JSON
 */
function backendPreference(): 'sqlite' | 'json' | 'auto' {
  const value = process.env.GODMODE_STORE_BACKEND;
  if (value === 'json' || value === 'sqlite') return value;
  return 'auto';
}

function ensureDir(projectRoot: string): string {
  const dir = path.resolve(projectRoot, STORE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getBackend(projectRoot: string): Backend {
  const dir = ensureDir(projectRoot);
  const cached = backends.get(dir);
  if (cached) return cached;

  const pref = backendPreference();
  let backend: Backend | null = null;
  if (pref === 'json') {
    backend = openJsonBackend(dir);
  } else if (pref === 'sqlite') {
    backend = openSqliteBackend(dir) ?? openJsonBackend(dir);
  } else {
    // auto: keep using an existing JSON store rather than creating a parallel DB,
    // otherwise prefer SQLite and fall back to JSON when the native module fails.
    const hasJson = fs.existsSync(path.join(dir, STORE_JSON_FILENAME));
    const hasDb = fs.existsSync(path.join(dir, STORE_DB_FILENAME));
    backend = hasJson && !hasDb ? openJsonBackend(dir) : openSqliteBackend(dir) ?? openJsonBackend(dir);
  }
  backends.set(dir, backend);
  return backend;
}

/** Whether a persisted store already exists for a project (without creating one). */
function storeExists(projectRoot: string): boolean {
  const dir = path.resolve(projectRoot, STORE_DIR);
  return (
    fs.existsSync(path.join(dir, STORE_DB_FILENAME)) || fs.existsSync(path.join(dir, STORE_JSON_FILENAME))
  );
}

/**
 * The backend GodMode would use for a project, computed without touching disk.
 * Used for the resume/storage status before any read/write has opened a store, so
 * selecting a project never eagerly creates an empty `.godmode/godmode.db`.
 */
export function preferredBackendKind(): RunStorageBackend {
  const pref = backendPreference();
  if (pref === 'json') return 'json';
  return loadSqlite() ? 'sqlite' : 'json';
}

/**
 * Persist the current run snapshot for the operated project (write-through). One
 * synchronous upsert per accepted mutation; returns `ok:false` with the backend
 * kind so the caller can surface a one-time degradation warning and keep running
 * in-memory rather than crash. Never throws.
 */
export function saveRun(projectRoot: string, run: RunSnapshot): StoreWriteResult {
  let backend: Backend;
  try {
    backend = getBackend(projectRoot);
  } catch (error) {
    return { ok: false, backend: 'none', error: describeError(error) };
  }
  try {
    backend.upsert(toRow(run));
    return { ok: true, backend: backend.kind };
  } catch (error) {
    return { ok: false, backend: backend.kind, error: describeError(error) };
  }
}

/**
 * Load the most recent unfinished (non-archived, non-terminal) run persisted for
 * the operated project, or null when there is none / the store is unreadable.
 * Never throws — a missing or corrupt store reads as "no run to resume".
 */
export function loadUnfinishedRun(projectRoot: string): StoreLoadResult | null {
  // A pure read must never create the store: if nothing has been persisted yet,
  // there is simply nothing to resume.
  if (!storeExists(projectRoot)) return null;
  let backend: Backend;
  try {
    backend = getBackend(projectRoot);
  } catch {
    return null;
  }
  try {
    const run = backend.loadUnfinished();
    return run ? { run, backend: backend.kind } : null;
  } catch {
    return null;
  }
}

/**
 * Archive a persisted run (the Discard outcome): it stays in the store as history
 * (`archived=1`) and is never offered for resume again — nothing is deleted.
 * Returns whether a row was archived; never throws.
 */
export function archiveRun(projectRoot: string, runId: string): boolean {
  if (!storeExists(projectRoot)) return false;
  try {
    return getBackend(projectRoot).archive(runId);
  } catch {
    return false;
  }
}

/** The backend kind currently in use for a project (without forcing a write). */
export function storeBackendKind(projectRoot: string): RunStorageBackend {
  try {
    return getBackend(projectRoot).kind;
  } catch {
    return 'none';
  }
}

/** Close and forget all cached backends (test cleanup / project teardown). */
export function closeAllRunStores(): void {
  for (const backend of backends.values()) {
    try {
      backend.close();
    } catch {
      /* best-effort */
    }
  }
  backends.clear();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
