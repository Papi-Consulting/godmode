# Run State Machine

GodMode drives the issue-to-PR workflow through a single, deterministic run
state machine (issue #7). Every phase change goes through one transition guard,
so the workflow is governed by the table — not by agent self-report or by
transition rules scattered across UI components. This is the state/control
foundation the builder (#8), PR detection (#9), reviewer (#10), and blocker-loop
(#11) work builds on.

The branch/PR/commit verification gate (#9) is the **evidence layer** layered on
top of this machine: it proves the expected builder commit is present on the
remote PR (read from `gh`/`git`, never agent self-report) and records the result
on the run. Later `merge_ready`/reviewer logic must consume that verified status,
not plain PR existence — see `docs/architecture/commit-verification.md`.

## Boundaries

| Concern | Owner |
| --- | --- |
| Run snapshot model + transition log | `RunSnapshot` / `RunTransitionLogEntry` in `src/shared/types.ts` |
| Transition table, guard, and pure `applyAction`/`createRun` | `src/main/run.ts` |
| In-memory single-run controller (`getCurrentRun`/`selectIssueRun`/`dispatchRunAction`/`clearRun`) | `src/main/run.ts` |
| IPC: get/select-issue/dispatch/clear with Zod-validated payloads | `godmode:run:*` in `src/main/index.ts` |
| Live state + operator actions derived from `availableActions` | `src/renderer/components/RunControlPane.tsx`, issue selection in `GithubPane.tsx` |

The pure core (`createRun`, `applyAction`, `computeAvailableActions`,
`TRANSITION_TABLE`) is Electron-free and unit-tested directly
(`test/run.test.js`). The mutable controller holds one run in memory and funnels
every accepted mutation through a single setter that fires a **write-through
persistence hook** (issue #40): the snapshot is plain serializable data and is
persisted to the per-operated-project run store (`.godmode/godmode.db`) on each
accepted transition, with the latest snapshot also mirrored to human-readable
`.godmode/runs/<run-id>/run.json`. Rejected transitions return the unchanged run
and never reach the setter, so they are never persisted. On relaunch a persisted
unfinished run is offered for Resume (`adoptResumedRun` restores it, marking live
sessions dead and recomputing `availableActions`) or Discard. See
`docs/architecture/run-persistence.md`.

## The guard

`applyAction(run, action, options)` is the only way state changes:

- It looks up `TRANSITION_TABLE[run.status][action]` for the next status.
- An illegal action returns `{ ok: false, code: 'invalid_transition', error, run }`
  with the **unchanged** snapshot — no mutation. The input snapshot is never
  mutated even on success (a new snapshot is returned).
- Every successful transition appends a log entry (`at`, `from`, `to`, `action`,
  `reason`, `actor`) and recomputes `availableActions`.

`availableActions` is computed from the table, so the renderer renders exactly
the legal actions and never invents transitions.

The log entry's `actor` (`ApplyActionOptions.actor`, default `operator`) records
who initiated the transition. The automatic review/fix loop controller (issue
#39) passes `loop` so the dashboard and audit can tell automatic progress apart
from operator clicks. It is **audit-only** — the actor never affects which
transitions are legal; the transition table here stays the single authority. The
controller advances a run only by dispatching these same named actions, never by
duplicating transition rules. See `docs/architecture/review-fix-loop.md`.

## States and transitions

Forward happy path:

```text
idle → issue_selected → (needs_spec) → ready_to_build → builder_running
     → pr_opened → reviewers_running → review_synthesis
     → merge_ready → karan_merged → closed
```

Fix loop:

```text
review_synthesis → builder_fixing → fix_pushed → reviewers_rerunning → review_synthesis
```

### Evidence-bound `builder_running → pr_opened` (#38)

The `open_pr` edge is **evidence-bound**: rather than a blind operator click, the
run control pane discovers the builder's PR from read-only GitHub evidence while
`builder_running` and confirms it. PR discovery (`discoverRunPrCandidates` in
`src/main/github.ts`, with pure matching in `src/main/discovery.ts`) lists the
operated project's open PRs and classifies candidates by issue link (`#N`) or a
conservative recent-unlinked fallback (open PRs created at/after the handoff send).
Confirming a candidate dispatches `open_pr` through this same guard with
`branch`/`prNumber`/expected head commit pre-bound and a transition-log reason that
names the PR and how it matched, then immediately runs the #9 commit-verification
gate (`getCommitVerification` → `recordCurrentRunVerification`).

So the transition log can name the PR, `applyAction` records the reason supplied
for *any* transition (not only the sticky-reason interrupt actions); the sticky
`run.reason` banner stays governed by `REASON_BEARING_ACTIONS`, so clean forward
progress never leaves a stale warn/blocker on the snapshot. The builder pane's PTY
exiting during `builder_running` surfaces a non-blocking hint and triggers one
discovery pass, but **never** transitions the run by itself. The old evidence-free
click survives only as a manual fallback, visibly labeled unverified and still
requiring a PR number. See `docs/architecture/commit-verification.md`.

Review synthesis (#11) is what computes these forward edges from evidence: it
parses the reviewer sessions into normalized findings, computes the merge gate
from those findings plus the verified #9 status, and dispatches `synthesize_reviews`
then one of `mark_merge_ready` / `request_fix` / `flag_needs_human` /
`exceed_max_cycles` accordingly. See `docs/architecture/review-synthesis.md`.

`request_fix` increments the `cycle` counter (the fix-loop iteration) and is
bounded by `maxCycles`: once `cycle >= maxCycles` the guard drops `request_fix`
from `availableActions` and rejects it if attempted, so the loop stops
deterministically at the budget. The operator/orchestrator then routes to
`max_cycles_exceeded`, `merge_ready`, or `needs_human`.

Interrupts are available from every **active** (non-terminal, non-paused) status
and are merged into the table in one place:

- `pause` → `paused` (records the status to resume to) / `resume` returns to it
- `cancel` → `cancelled`
- `flag_needs_human` → `needs_human`
- `report_agent_failed` → `agent_failed`
- `exceed_max_cycles` → `max_cycles_exceeded`

`needs_human`, `agent_failed`, and `max_cycles_exceeded` are recoverable: the
operator can route back to `ready_to_build`, force `merge_ready`, `cancel`, or
`close` as appropriate.

## Reconciling the spec states

The spec (section 8) lists more state names than `RunStatus` carries. They are
reconciled explicitly, never left ambiguous:

- **Added as first-class statuses:** `karan_merged` and `closed`. These are
  distinct terminal lifecycle endpoints (a human merged; the run is filed away)
  that cannot be expressed as a reason on another status.
- **Mapped onto `needs_human` via a `blocker` reason:** `pr_conflicted`,
  `tests_failed`, `checks_unstable`, `harness_missing`, `repo_dirty`. Each is a
  "stop and get a human" condition; collapsing them onto one operator-actionable
  status keeps the graph small and deterministic while still recording exactly
  which blocker fired (`RunSnapshot.blocker: RunBlockerKind`).

## Run scope

A run belongs to the operated project it was started in (its issue/branch/PR all
live in that repo). The main process discards the current run on a project
change, and the renderer reloads run state on `projectChanged` — mirroring how
config and the GitHub snapshot are scoped.

The "cleared" outcome (`clearRun` / `godmode:run:clear`) discards the run so the
dashboard returns to a no-run state. This is distinct from the `close` action,
which records a terminal `closed` status while keeping the run and its log
visible.

A still-live run is never silently discarded: `selectIssueRun` rejects a new
issue selection while a non-terminal run exists (only `closed`, `cancelled`, and
`karan_merged` runs may be replaced), so its in-memory log/evidence survives
until the operator closes, cancels, or clears it. The dashboard reflects this by
disabling "Start run" on other issues while a run is live.
