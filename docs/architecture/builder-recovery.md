# Stale builder-session detection and recovery (issue #55)

GodMode's live agent sessions (the PTYs) live only in main-process memory
(`src/main/pty.ts`: `sessions` / `sessionCwds`). A run's lifecycle state, by
contrast, is persisted and can be resumed after a restart (see
[run-persistence.md](./run-persistence.md)). These two facts can drift apart: a
reset, a window reload, or an app restart can leave a run persisted as
`builder_running` while the builder PTY is gone — no process is actually building,
yet the cockpit previously only labeled the sent-but-stale handoff a generic
`blocked`, with no recovery path.

This doc describes how GodMode makes that stale-session loss **visible** and
**recoverable** without ever pretending a process state that is not true.

## Detection

`evaluateBuilderRecovery(run, hasLiveBuilderSession)` in `src/main/run.ts` is the
single, pure source of truth. It is Electron/PTY-free (the caller passes
`hasPtySession('builder')`) so it is directly unit-testable.

A run is **stale** exactly when:

- its status is `builder_running`, **and**
- no live builder PTY exists.

Any other status, or a live builder, is not stale. The returned
`BuilderRecoveryState` carries a human-readable `message` (only when stale) that
adapts to whether a PR is already bound — a builder that died before opening a PR
is still worth a read-only discovery pass.

Main exposes this over IPC as `runBuilderRecoveryGet` and pushes
`runBuilderRecoveryChanged` whenever liveness can change relative to a
`builder_running` run:

- the builder PTY starts (`handleStartPty`) or dies (its `onExit`),
- a `builder_running` run is resumed after restart (`handleResume`, issue #40),
- a recovery relaunch succeeds.

The renderer also re-fetches on `runChanged` (a status change can clear staleness)
and on project switch.

## Recovery actions

The recovery banner (Run Control) renders **only when the run is stale** and offers
two explicit operator actions. GodMode never auto-relaunches or silently re-sends.

### 1. Relaunch builder and re-deliver the handoff

`runBuilderRelaunch` (`handleRelaunchBuilder`) relaunches the builder PTY and
re-delivers the *existing* pointer-first handoff prompt. Its contract:

- **Lost-session only, re-checked across the async boundary.** It refuses
  (`invalid_state`) when a builder PTY is still live. Recovery is for a genuinely
  lost session; restarting a live builder stays the builder pane's own job. This
  mirrors the detection helper and the UI gate, so a stale-renderer or race can
  never kill-and-replace a running builder. Because `ensureRunWorktree` awaits (it
  yields the event loop), the live-PTY check alone would be a pre-await snapshot —
  the operator could start the builder, switch projects, or move to another run
  during that await, and `openPtySession` would then kill any existing builder PTY
  and spawn from a stale context. So **immediately before the destructive spawn**
  the handler re-reads the authoritative state and refuses (`invalid_state`) if any
  of these changed since the snapshot: the current run is no longer the same run id,
  the run is no longer `builder_running`, the selected project root changed, or a
  builder PTY became live. The guard is the authority just before the spawn, not a
  stale snapshot.
- **Same cwd safety gate as the original send.** For an isolated run (issue #41)
  the worktree is re-validated/re-created via `ensureRunWorktree` and the PTY is
  launched **inside** it before any prompt is written, so re-delivery can never land
  in the shared checkout. (`openPtySession` independently enforces the cwd
  allowlist as defense-in-depth.)
- **Worktree *recording* is identity-aware, not just the spawn.** `ensureRunWorktree`
  awaits `createWorktree`, then records the prepared worktree on the current run via
  `setCurrentRunWorktree`, which writes to the global current-run pointer. If the
  operator cancels/replaces the run or switches projects during that await, recording
  would attach this run's worktree/branch to an unrelated run (or another project's
  tree) and persist/emit that corrupted snapshot — *before* the handler's own
  pre-spawn guard runs. So `ensureRunWorktree` re-checks the run id and selected
  project root after the await and refuses to record on drift, and
  `setCurrentRunWorktree` takes an `expectedRunId` so the write itself is refused
  unless the same run is still current. Recovery (and any other worktree consumer)
  thus never mutates run/worktree ownership across the async gate; a drifted relaunch
  records nothing and the caller refuses with `worktree_failed`/`invalid_state`.
- **Same sendability gate as the original send.** The recomposed handoff must be
  `canSend` (a bound GitHub issue with no unresolved variables); a manual task stays
  blocked exactly as on first send.
- **Same renderer ownership and pane state as a normal start.** The relaunch
  registers the same `destroyed` / `did-start-navigation` cleanup as
  `handleStartPty` (so a window destroy/navigation stops the recovered builder
  rather than orphaning it) and emits `pty:started` so the builder pane reflects the
  live session — Stop/Restart enabled — instead of showing an idle pane while a real
  process runs.
- **Auditable.** The re-delivery is recorded on the run's prompt log
  (`recordCurrentRunPrompt`). The run stays `builder_running`: re-delivery records
  that the prompt was *sent*, never that the task succeeded.

### 2. Mark the agent failed

The existing `report_agent_failed` interrupt edge (legal from `builder_running`)
routes the run to `agent_failed` with an operator-supplied reason, recorded as a
transition-log entry. This is the path when the operator does not want to retry.

## PR discovery stays available

PR discovery (`runPrDiscover`, issue #38) remains read-only and is still offered
while `builder_running`, including when stale — a builder may have opened a PR
before dying, and confirming it is the normal forward path out of `builder_running`.

## Why detection is pure

Keeping `evaluateBuilderRecovery` pure (run + a liveness boolean) means the
stale/recoverable contract is unit-tested without spawning a PTY, including the
resumed/persisted `builder_running`-with-no-live-PTY case, and the relaunch
handler's live-session guard is the same predicate the UI renders on.
