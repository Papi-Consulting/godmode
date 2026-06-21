# Pane Session State (Terminal Lifecycle Truth)

GodMode surfaces **truthful, actionable terminal/session state** for each role
pane (issue #63). The live PTY sessions exist only in the main process's memory,
so before this the renderer inferred pane status from its own optimistic button
clicks (`idle` / `running`) — which collapsed materially different states into the
same look: a one-shot reviewer that already exited, a failed launch, and a
still-running agent all appeared the same, and dead panes still invited input.

The main process is now the **single source of truth** for each pane's session
lifecycle, and pushes it to the renderer. Core code stays role-generic
(`head` / `builder` / `reviewer_a` / `reviewer_b`); vendor names never enter the
lifecycle model.

## Boundaries

| Concern | Owner |
| --- | --- |
| Track lifecycle per pane, derive metadata, detect prompts | `src/main/pty.ts` (session-state registry) |
| Expose a snapshot + push changes over IPC | `godmode:pty:state:get` / `godmode:pty:state` in `src/main/index.ts` |
| Subscribe and fan state out to panes | `src/renderer/App.tsx` |
| Render status, gate Start/Restart/Stop + message Send | `src/renderer/components/AgentPane.tsx` |
| Shared model | `PaneSessionState` / `PaneSessionLifecycle` in `src/shared/types.ts` |

## Lifecycle model

`PaneSessionLifecycle` is one of:

- `never_started` — no session launched for this pane this app session.
- `running` — a live PTY exists (`live: true`, carries `pid` and launch `cwd`).
- `exited` — the process ended on its own; carries the real `exitCode` (and
  `signal` when killed by one). A one-shot reviewer finishing lands here.
- `stopped` — the operator stopped it, or a project switch / app quit tore it
  down. Distinct from `exited` so the UI can tell an operator-ended session apart
  from a process that ended itself.
- `failed` — the launch itself failed (command not found, disallowed cwd, spawn
  error); carries a visible `error`. No live process exists.

The snapshot also carries `cwd`, `error`, `awaitingInput`, and a `changedAt`
timestamp (main owns the clock).

## Why the registry lives in `pty.ts`

Every launch path funnels through the same primitives — the renderer Start button
(`godmode:pty:start`), the builder recovery relaunch (issue #55), and the reviewer
launch (issue #10) all call `openPtySession`, and all teardown goes through
`stopPtySession` / `killAllPtySessions`. Tracking lifecycle inside those functions
means every pane is consistent without each caller re-deriving state. The registry
notifies a single listener (`setPaneSessionListener`); main wires that to push
`godmode:pty:state` to the renderer.

State transitions:

- `openPtySession` success → `running`; failure → `failed` **only when no live
  session remains** (a failed *restart* must not clobber a session that is still
  alive, since the existing PTY is killed only after the new command validates).
- The tracked `onExit` → `exited` with the exit code/signal.
- `stopPtySession` → `stopped` (its `onExit` bails out because the session was
  already removed, so the stop is recorded explicitly).
- `killAllPtySessions` → `stopped` for each torn-down pane (project switch / quit).

## Conservative prompt/attention detection

Scope item 3 of the issue asks for an operator-attention signal when an agent is
blocked on a permission/confirmation prompt. Reliable semantic parsing of every
possible agent prompt is explicitly out of scope, so `detectPromptAttention` is a
deliberately **conservative, vendor-neutral heuristic**: it strips ANSI escapes,
looks only at the trailing line, and fires on a small set of documented generic
shapes (`[y/N]`, `(yes/no)`, "Do you want to …?", "Press Enter to continue",
"waiting for approval/confirmation/input", …). It is pure and unit-tested so the
patterns are easy to tune.

The flag (`awaitingInput`) is best-effort and **never gates delivery** — it only
surfaces a "waiting · needs operator" hint and an amber dot. It clears as soon as
more output arrives that no longer looks like a prompt, or as soon as input is
delivered to the pane. A false positive therefore costs only a benign,
self-clearing hint. No vendor-specific (Claude/Codex) policy lives in the core
lifecycle.

## Renderer behavior

`AgentPane` reads the pushed `PaneSessionState`, not local optimistic status:

- The header shows the live status (`running`, `exited (0)`, `stopped`,
  `launch failed`, `waiting · needs operator`), falling back to the static phase
  hint only while `never_started`.
- The status dot colours by lifecycle (green live, grey ended, red failed, amber
  waiting).
- Start is disabled while live; Stop is disabled when not live; Restart re-runs
  start. An optimistic `launching…` label covers the brief window between the
  click and main's first pushed state, then reconciles.
- The message **Send** control is disabled when there is no live PTY — typing into
  a dead pane could never execute. The typed `sendPty` result (issue #57) still
  guards the race where a session dies between render and click.
- A lightweight `⌨ focused` chip shows when keyboard focus is in the terminal, so
  a focus-only click is not mistaken for a submitted choice.

## Tests

- `test/pty.test.js` covers the registry directly: a live session reports
  `running` then `stopped`; a one-shot process reports `exited` with its code; a
  failed launch reports `failed` with a reason and no live session; the listener
  fires on every change; and `detectPromptAttention` fires only on generic
  prompts.
- `test/e2e/smoke.mjs` (assertion 7b) drives the real app: after the fake one-shot
  builder exits, the builder pane reports `exited` with the real code and the
  message Send control is disabled — the regression guard against a dead pane
  looking like a live watcher with usable send controls.
