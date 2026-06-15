# Automatic review/fix loop controller (issue #39)

The review/fix loop controller is the deterministic main-process module that,
once a run has a verified PR, drives reviewer launch → synthesis → fix handoff →
re-verification → re-review **automatically**, so the operator supervises the
loop instead of clicking every stage. It is the last large piece of the core
product loop before GodMode can dogfood itself end to end.

It lives in `src/main/loop.ts`. Like the rest of the codebase it is split into a
**pure decision core** (Electron-free, unit-tested in `test/loop.test.js`) and a
**stateful controller** wired by `src/main/index.ts` with the existing IPC-layer
functions.

## Non-negotiable: the state machine stays the single authority

`AGENTS.md` requires deterministic state transitions — **workflow state is never
decided by LLM output alone**. The loop controller is therefore *plain code
reacting to observable events*, not a head-agent prompt:

- It advances a run **only** by calling the existing operator-triggered handlers
  (`handleStartReviewers`, `handleSynthesizeReviews`, `handleSendFix`) and
  `dispatchRunAction`. It **duplicates no transition rules**: the transition table
  in `src/main/run.ts` (`applyAction`) remains the only mutation path.
- It **never interprets agent prose**. It consumes the same normalized
  `findings.ts` outputs and live `verify.ts`/`github.ts` evidence the manual
  handlers do. A reviewer self-report is never enough — every gate re-runs the #9
  commit-verification evidence check live.
- It is **fully interruptible**. Manual mode (the default) makes it a no-op;
  pausing or any manual operator dispatch preempts it; it re-syncs from the run
  snapshot rather than fighting the operator.

## Per-run mode

Each run carries an explicit loop mode held by the controller:

- `manual` (default) — the controller takes no action; every stage stays
  operator-triggered exactly as before. This is the regression-safe default and
  is what ships unless a project opts in.
- `auto` — the controller chains the stages below.

The mode resets to the project's configured default (`loop.auto`) whenever the
bound run changes. Toggling the mode mid-run is allowed and takes effect at the
next event boundary (`godmode:run:loop:set-mode`); toggling to `auto` ticks the
controller immediately.

## Event sources

The controller reacts only to **observable events**, never to agent text:

| Event | Where it fires | What the controller does |
| --- | --- | --- |
| Run transition (operator or loop) | `handleDispatchRun`, handoff/fix send | Re-syncs from the snapshot and advances if the new state has an automatic next step |
| Reviewer session exit | `handleReviewerExit` | When **both** reviewers reach a terminal state, runs synthesis |
| Fix handoff delivered | `handleSendFix` → `notifyFixDelivered` | Arms the fix-commit watcher |
| Fix-commit watcher poll | `loop.ts` interval | Detects a new commit on the PR, then advances to re-review |
| Mode toggle | `setLoopMode` | Re-arms and ticks |

Every entry point calls `tickLoop()`, which is a no-op in manual mode and
coalesces re-entrant calls (one stage runs at a time; a tick during a stage
re-evaluates once it completes).

## Chaining rules (auto mode)

The pure `decideLoopAction(run, mode, { autoSendFix, fixDelivered })` decides the
next move from the snapshot alone:

1. **`pr_opened`** → launch Reviewer A/B (`start_reviewers`). The existing launch
   path re-runs the #9 verification gate live and refuses unless the PR is
   `verified`.
2. **`reviewers_running` / `reviewers_rerunning`** → wait until **both** reviewer
   sessions are terminal (`completed` / `comment_posted` / `failed`), then run
   synthesis (`synthesize`).
3. **Synthesis outcomes** follow the existing `findings.ts` semantics, unchanged:
   - clean + verified → `merge_ready` (**stop** — merge is always manual);
   - accepted blockers + verified → enter the fix cycle and compose the
     pointer-first fix handoff;
   - ambiguous / malformed / contradictory → `needs_human` (**stop**);
   - a non-reviewer gate unmet (e.g. an unverified PR) → `review_synthesis`
     **hold** (the controller never converts a hold into progress).
4. **`builder_fixing`** → fix-handoff send stays **operator-approved by default**.
   - `loop.autoSendFix: false` (default) → wait at `waiting_fix_approval` for the
     operator to approve & send.
   - `loop.autoSendFix: true` → auto-send the fix, but only when the builder
     session is live and the prompt fully resolves (the same `handleSendFix`
     gates apply).
5. **Fix delivered** (auto-sent, or operator-sent which notifies the controller)
   → **watch the PR** for the new commit (see below).
6. **`fix_pushed`** → relaunch reviewers (`rerun_reviewers` via the same launch
   handler), which re-runs the #9 gate against the new commit. The state machine
   increments the cycle.
7. **Stop states**: `merge_ready`, `needs_human`, `max_cycles_exceeded`,
   `agent_failed`, `paused`, and every terminal status. `maxCycles` stays
   authoritative in the state machine — the controller never re-requests a fix
   past the budget.

## Fix-commit watcher

After a fix is delivered, auto mode watches the PR for the builder's fix commit
without operator transcription (depends on #38 evidence-bound PR discovery). The
watcher polls `getCommitVerification` scoped to the run and uses the pure
`detectFixLanded(run, verification)`: a fresh fix has landed when the PR's live
head SHA no longer matches the run's recorded `expectedCommit` (the pre-fix
baseline). On detection it dispatches `push_fix` — recording the new head as the
expected commit and attributing it to the `loop` actor — and the normal chaining
relaunches reviewers. A partial/incomplete query is never read as a landed fix.

A partial query (or a thrown watcher error) is a **transient failure**, not "no
commit yet": the watcher logs and retries it **at most once** (the same
single-retry budget the stage actions use), and a second consecutive failure
**halts the controller visibly and disarms the watcher** rather than polling
`gh`/network/auth forever with no dashboard error. A complete poll that simply
finds no new commit yet resets the budget and keeps watching (watching a PR is
inherently a repeated check). Before each poll's side effects the watcher also
re-checks the live run is still `builder_fixing` in `auto` mode, so a pause or
manual preemption tears the watcher down instead of dispatching `push_fix`.

## Failure routing

Any **stage** failure (reviewer launch failure, capture failure, `gh` errors,
verification regression, synthesis ambiguity) stops auto-advancement and routes
to the existing visible failure surface — there are **no silent retries and no
retry loops**. The controller halts at the failed status and will not retry the
same stage until the run status changes or the operator re-arms the mode. The one
exception is **at most one automatic retry per stage for a transient `gh`/network
failure**, and only when logged.

`needs_human`, `max_cycles_exceeded`, and held synthesis are all stop states: the
controller never converts ambiguity into progress.

### Preemption of in-flight loop stages

A loop-driven stage (`handleStartReviewers` / `handleSynthesizeReviews`) captures
the run and then `await`s the live #9 commit-verification. Pausing or any manual
operator dispatch during that await advances the run **without changing its id or
operated-project root**, so the run/root stale guard alone would still pass and
let the stage spawn reviewer PTYs, write artifacts/findings, or transition onto an
already-preempted run — breaking the operator-authority boundary. After the
verification await each stage therefore **re-reads the live run status and aborts
before any side effect** when it is no longer a launch-legal
(`isReviewerLaunchPreempted`) / synthesis-legal (`isReviewSynthesisPreempted`)
status. The controller treats such a preemption (run reached a stop status mid
stage) as a **stop, not a stage failure**: it re-syncs and surfaces the stop
state rather than recording a halt error or retrying. This keeps pause/manual
dispatch authoritative over the loop even mid-stage.

## Audit and visibility

- Every controller-initiated dispatch is recorded in the run's transition log
  with `actor: 'loop'`; operator dispatches and operator-triggered IPC handlers
  default to `actor: 'operator'` (`RunTransitionLogEntry.actor`,
  `ApplyActionOptions.actor`). The actor is **audit-only** — it never affects
  which transitions are legal.
- The run control pane shows the current mode (manual/auto), what the controller
  is waiting on (a stable `LoopWaitReason` key plus a human label — e.g.
  "Waiting for the reviewer sessions to finish", "watching the PR for the new
  commit"), any halt error, and a prominent manual/auto toggle. Pause/cancel are
  the existing run actions and always preempt.
- Loop state is pushed to the renderer on `godmode:run:loop:changed` and fetched
  via `godmode:run:loop:get`.

## Config

Optional `.agentic/godmode.yaml` block, validated with the existing Zod schema
and resolved by `resolveLoopConfig` (the single resolver both run creation and
the controller read, so config and runtime never drift):

```yaml
loop:
  auto: false          # default manual (regression-safe)
  autoSendFix: false   # fix-handoff send stays operator-approved by default
  maxCycles: 3         # the existing fix-cycle budget, surfaced here
```

Only an exact `true` enables `auto`/`autoSendFix` (no truthy coercion). With no
block present, the run is manual with the standard budget.

## What this is not

- **No auto-merge** to `main` (never in v1) and no auto-closing runs.
- **No head-agent (LLM) orchestration** of workflow state.
- **No parallel/multiple concurrent runs.**
- **No retrying failed agent sessions with modified prompts.**

See also `docs/architecture/run-state-machine.md`,
`docs/architecture/reviewer-launch.md`, `docs/architecture/review-synthesis.md`,
and `docs/architecture/commit-verification.md`.
