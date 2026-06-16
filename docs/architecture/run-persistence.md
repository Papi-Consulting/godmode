# Run persistence and resume after restart (issue #40)

GodMode persists the active run so quitting or restarting the app mid-run never
loses it, and the operator can deliberately **Resume** or **Discard** it on
relaunch. This is a hard requirement for self-dogfooding: rebuilding GodMode with
GodMode means restarting the app while a run is in flight.

Before this, the entire run — status, issue binding, branch/PR evidence, cycle
count, transition log, prompts, verifications, findings — lived only in
main-process memory (`src/main/run.ts`) and died with the app.

## Storage location and layout

- The run store lives **per operated project** at `.godmode/godmode.db` inside the
  operated-project root — a sibling of the existing `.godmode/runs/` artifacts and
  gitignored the same way. It is never created in the GodMode app repo unless the
  app repo *is* the operated project (dogfooding).
- Backend: **SQLite via `better-sqlite3`** (already a dependency; synchronous
  writes, so killing the app immediately after a transition loses nothing). A
  single `runs` table keyed by run id holds the serialized snapshot plus a few
  queryable columns (`status`, `issue_number`, `branch`, `pr_number`, `archived`,
  `created_at`, `updated_at`). The append-only transition log stays embedded in the
  snapshot JSON — no separate `events` table, no ORM.
- The latest snapshot is also mirrored as human-readable
  `.godmode/runs/<run-id>/run.json` through the existing `artifacts.ts`
  path-confinement helpers, alongside the reviewer logs and `findings.json`. The
  authoritative copy is the store; `run.json` is a convenience mirror.

### Native module / JSON fallback

`better-sqlite3` is a native module. It loads cleanly under Node (so the test
suite uses SQLite), but inside Electron it must match the Electron ABI
(`electron-rebuild`). To avoid that yak-shave blocking the write-through + resume
contract, `store.ts` loads the native module defensively (`createRequire` in a
`try/catch`) and, when it cannot load, transparently falls back to a **JSON file**
(`.godmode/godmode.db.json`) with the *same interface*. The backend in use is
reported (`sqlite` | `json`) so the gap stays visible/auditable. Selection can be
forced for tests/diagnostics via `GODMODE_STORE_BACKEND=sqlite|json|auto`.

To get SQLite (not the JSON fallback) inside the packaged/dev Electron app, run
`electron-rebuild` for `better-sqlite3`; until then the app uses the JSON fallback
and behaves identically from the operator's perspective.

## Write-through persistence

`run.ts` funnels every current-run replacement through one internal setter
(`setCurrentRun`), which fires an injected **persist hook** (`setRunPersistHook`,
installed from `index.ts`). This guarantees no mutation path can forget to
persist:

- Persisted on: `applyAction` success (via `dispatchRunAction`/`selectIssueRun`/
  `selectManualTaskRun`), `recordPromptSent`, `recordVerification`, reviewer
  session updates (`setReviewerSessions`/`updateReviewerSession`),
  `setRunFindings`, isolation/worktree updates, and resume restore.
- **Never** persisted on a rejected/illegal transition: `applyAction` returns the
  unchanged snapshot and never reaches the setter.
- `clearRun()` (in-memory reset, e.g. on project switch) deliberately does **not**
  touch the store, so the run survives to be offered for resume when the project is
  reselected. Permanent removal from the offer is the explicit Discard/archive path.

Writes are synchronous and **failure-visible**: if the store cannot be written
(read-only project, missing dir), `saveRun` returns `ok:false`; `index.ts` flips a
one-time visible degradation warning and keeps operating in-memory rather than
crashing or pretending to persist. The warning is per operated project and resets
on a project switch.

## Resume on startup / project select

- When a project is selected and an unfinished (non-terminal, non-archived) run
  exists, GodMode surfaces an explicit **Resume / Discard** choice in the run
  control pane (`godmode:run:resume:get` + the `godmode:run:resume:changed` push).
  It **never auto-resumes**. The offer is mutually exclusive with an active
  in-memory run.
- **Resume** (`adoptResumedRun`) restores the snapshot through the normal model:
  the transition log is intact, all previously-live PTY/reviewer sessions are
  marked dead/stale (`markRunSessionsDead` — running/launching reviewers become
  `failed` with a restart reason; terminal sessions keep their captured outcome),
  and `availableActions` is recomputed from the transition table so the operator
  sees exactly what is legal/relaunchable. The loop controller is reset to manual
  so nothing auto-advances across a restart.
- **Revalidation:** after restore, if the run has a recorded PR, GodMode runs the
  read-only #9 commit-verification gate. A *definitive* mismatch — the recorded PR
  is not found for the branch, the branch's PR number differs, or the PR is
  closed/merged when the run expected it open — routes the resumed run to
  `needs_human` with a visible reason instead of continuing blind. Incomplete
  evidence (GitHub unreachable: `partial`/`needs_refresh`) is surfaced but does not
  escalate.
- **Discard** archives the run (`archived=1`) — it stays in the store as history,
  nothing is silently deleted — and returns to a clean no-run state.

Live PTY sessions and agent transcripts are intentionally **not** resumed
(out of scope): a resumed `reviewers_running` run with dead sessions does not wait
forever — `availableActions` offers synthesize-from-captured-artifacts and the
interrupt edges, and the captured reviewer logs under `.godmode/runs/<run-id>/`
remain available.

## History (minimal)

Terminal and archived runs stay in the store as history. A full history-browser UI
is out of scope; the schema (a `runs` table with `status`/`archived`/timestamps)
does not preclude a future history view.

## Key code

- `src/main/store.ts` — open/init store, `saveRun`, `loadUnfinishedRun`,
  `archiveRun`, backend selection + JSON fallback, snapshot validation gate.
- `src/main/run.ts` — `setRunPersistHook`/`setCurrentRun` funnel,
  `markRunSessionsDead`, `adoptResumedRun`.
- `src/main/artifacts.ts` — `writeRunSnapshot` (the `run.json` mirror).
- `src/main/index.ts` — persist hook wiring, resume offer on project select, the
  `godmode:run:resume:*` handlers, PR revalidation, degradation warning.
- `src/shared/types.ts` / `ipcChannels.ts` / `src/preload/index.ts` /
  `src/renderer/components/RunControlPane.tsx` — the Resume/Discard surface.

## Out of scope

- Resuming live PTY sessions or agent transcripts across restart.
- Multi-run concurrency or cross-project run aggregation.
- Cloud sync, export, or telemetry.
- A full run-history browsing UI.
- Migrating reviewer log/findings artifacts into SQLite (they stay as files).
