# GodMode Project Specification

*Living document. Update this when product scope, architecture, workflow, or verification changes.*

## What This Is

GodMode is a local, macOS-first, tmux-style multi-agent coding dashboard. It opens on a project harness, lets a human operator command and chat with an agent team, runs an automatic build-review-fix PR loop, and keeps final merge authority with the human.

The product is inspired by QuadWork's multi-agent dashboard feel, but GodMode is explicitly bring-your-own-agent native and harness-driven.

## App Repo vs Operated Project

GodMode keeps two repository contexts distinct at all times:

- **GodMode app repo** — the repository that ships the Electron app, its docs, and config defaults (this repo while developing GodMode).
- **Operated project** — the external repo opened inside GodMode and worked on by configured agents.

Harness detection, PTY working directories, and GitHub issue/PR lookups all scope to the **operated project root**, never implicitly to the GodMode app repo. Issues/PRs in the GitHub pane belong to the operated project. The main process exposes the app repo's identity (name/version/root) separately over IPC (`godmode:app:get`) so the UI can show both contexts.

**Self-dogfooding** — building GodMode by running GodMode on its own repo — is a deliberate special case: the operated project and the app repo point at the same directory. The contexts coincide on disk but the conceptual boundary holds; agents treat the directory as the operated project. `ProjectState.isAppRepo` flags this and the project bar shows a "dogfooding" badge, but no harness/PTY/GitHub behavior branches on it. See `docs/architecture/app-vs-operated-project.md`.

## Default Karan Workflow

- **Head/operator:** Hermes
- **Builder/dev:** Claude Code
- **Reviewer A:** Codex focused on correctness, tests, security, and regressions
- **Reviewer B:** Codex focused on architecture, maintainability, spec drift, and harness compliance
- **Final gate:** Karan approves/delegates/merges himself

## Bring Your Own Agent Requirement

Core code must model roles independently from concrete agents.

Examples:

- `head` can be Hermes, Claude, OpenClaw, Codex, or a custom CLI.
- `builder` can be Claude Code, Codex, OpenCode, OpenClaw, or another CLI.
- `reviewer_a` and `reviewer_b` can be Codex, Claude, Gemini, or any configured review-capable agent.

Do not hardcode Hermes/Claude/Codex into core abstractions. They are defaults in config and display labels only.

## V1 Tech Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Desktop shell | Electron | macOS app first; local-only by default |
| Language | TypeScript | Shared between main, renderer, and core modules |
| Renderer | React + Vite | Bare-bones dashboard, no SaaS polish needed |
| Terminal panes | xterm.js | tmux-like live agent panes |
| PTY/process orchestration | Node.js + node-pty | Interactive CLI agent sessions |
| Persistence | SQLite via better-sqlite3 | Runs, sessions, findings, events |
| Git/GitHub | git + gh CLI | Prefer CLI for v1 auth/reliability |
| Config | `.agentic/godmode.yaml` | Project-local role/workflow config |
| Packaging | Electron Builder | Add when the core loop works |

## Architecture Overview

```text
Electron main process
  ├─ project/harness detector
  ├─ agent adapter registry
  ├─ PTY/session manager
  ├─ GitHub service via git/gh
  ├─ run state machine
  ├─ review/fix loop controller
  └─ SQLite/log persistence

React renderer
  ├─ tmux-style pane layout
  ├─ head pane
  ├─ builder pane
  ├─ reviewer A pane
  ├─ reviewer B pane
  ├─ PR/GitHub state pane
  └─ global command/action bar
```

## Harness Detection

GodMode opens on a selected project root (resolved and validated in the Electron main process) and classifies its harness into four states surfaced in the project bar:

- `valid` — required files all present.
- `partial` — some required files present.
- `missing` — no required files present.
- `unreadable` — the path is not a readable directory (or none selected).

Required: `AGENTS.md` plus `README.md` or `docs/spec.md`. Optional (reported but non-gating): `.agentic/godmode.yaml`, `docs/review/`, `docs/architecture/`, `docs/conventions/`, `docs/friction/`. Detection is path-relative to the selected **operated-project** root, not hardcoded to (or implicitly the) GodMode app repo's own layout. PTY sessions launch with the selected operated-project root as their working directory; changing the operated project tears down live PTY sessions so a terminal never outlives the project it was spawned in.

## Role/Agent Config

The Electron main process loads `.agentic/godmode.yaml` from the selected project root, validates it with Zod, and sends a sanitized, renderer-facing view over IPC (`godmode:config:get`). The renderer derives pane labels, display names, command hints, and role docs from this config; it re-loads whenever the selected project changes (`godmode:project:changed`). Config resolves to one of:

- `loaded` — file present and valid; panes come from config.
- `default` — no file found; panes fall back to built-in safe defaults.
- `invalid` — file present but failed parse/validation; the error is surfaced in the UI and panes fall back to defaults (never crashing).
- `unreadable` — the selected root could not be read.

Role and pane keys stay generic (`head`/`builder`/`reviewer_a`/`reviewer_b`). Hermes/Claude/Codex appear only as default display names and command hints, never as core identifiers. Command hints render project-agnostically (`<selected-project>`) until real selected-project command wiring exists.

## Agent Adapter Registry

On top of the same loaded config, the main process resolves a role-based **adapter registry** and sends it over IPC (`godmode:registry:get`, re-loaded on `godmode:project:changed`). Each role resolves through config/adapter objects — never a hardcoded vendor branch — to an `adapter` (`cli`/`mcp`/`acp`/`custom`), a `mode`, and effective `capabilities` (an adapter baseline plus per-agent overrides). Only the `cli` adapter is launch-wired in v1 (the safe shell PTY); the others describe intent so core code can reason about lifecycle without branching on a transport.

The registry also renders **command templates** for the builder/reviewer lifecycle steps (`builder_start`, `reviewer_start`, `builder_fix`) with `{{variable}}` placeholders bound from issue/PR/role context. Built-in safe defaults lead with the harness reading rules; a project may override any kind via an optional `commands:` config block. Rendering a command never launches it: the renderer shows each command role-first and marked `preview · mock until launched`, with unbound variables left as visible placeholders and listed per card. Invalid/unreadable config yields safe defaults plus a visible error. See `docs/architecture/agent-adapter-registry.md`.

## Role Session Launch

Starting a pane launches the configured agent for that role, not a generic shell. On `godmode:pty:start`, the main process maps the pane/role to its bound agent command via `resolveRoleLaunch` (only `cli` adapters launch in v1; an unconfigured role or non-cli adapter returns a visible reason). The command runs in a `node-pty` session whose working directory is restricted by an allowlist to exactly the selected operated-project root **or** the active run's registered git worktree (issue #41) — nothing else, with anything outside rejected visibly. The same sanitized/minimal environment applies. The executable is resolved on the safe `PATH` (or against the launch directory for a path-bearing command) up front, so an invalid/missing command yields a visible error inside the pane rather than a crash. Each pane has start/restart/stop controls — restart reuses start, since launching replaces any live session for that pane. Sessions stop on UI stop, renderer teardown, and app quit. See `docs/architecture/role-session-launch.md`.

When `workspace.isolation: worktree` is configured (default `shared`), the builder/fix sessions for a run launch in a per-run `git worktree` of the operated project instead of the primary checkout, so an agent switching branches or rewriting files can never collide with the running app's checkout or another session's uncommitted work. Reviewer sessions, GitHub state, and harness detection continue to scope to the operated-project root. See `docs/architecture/run-worktree-isolation.md`.

## Run State Machine

The issue-to-PR workflow is governed by a single deterministic run state machine in the main process, not by agent self-report or by transition rules scattered across the UI. A `RunSnapshot` carries the current status, selected issue, branch/PR, cycle/`maxCycles`, any blocker/reason, the available operator actions, and an append-only transition log. Every phase change goes through one guard (`applyAction`): it consults a central transition table, rejects illegal transitions with a typed error and **no** state mutation, and on success logs the transition (`from`/`to`/`action`/`reason`) and recomputes `availableActions`. The dashboard renders operator controls from `availableActions` and selects an issue from the GitHub pane via `godmode:run:*` IPC (Zod-validated). Spec states beyond the `RunStatus` union are reconciled explicitly: `karan_merged` and `closed` are added as terminal statuses, while `pr_conflicted`, `tests_failed`, `checks_unstable`, `harness_missing`, and `repo_dirty` map onto `needs_human` with a recorded `blocker`. Persistence is in-memory for v1 but the snapshot is serializable for later `.godmode/runs/`/SQLite storage. See `docs/architecture/run-state-machine.md`.

## Builder Handoff

Selecting a GitHub issue (or entering a manual task) binds it to a reviewed
**builder handoff** prompt that the operator must explicitly approve before it is
sent. The main process fetches full issue detail (body, comments, URL, labels) on
selection (`godmode:github:issue:get`) and stores it on the run, then composes the
handoff (`godmode:run:handoff:get`) by rendering the `builder_start` template
bound to the issue/task plus a grounded block.

The sent prompt is **pointer-first**: GodMode is an agent harness, not a
prompt-injection layer, so it directs a fresh builder to read the **operated
project's** own repo-local sources itself — `AGENTS.md`, `docs/spec.md`, the
relevant `docs/architecture/`/`docs/conventions/` docs, and (for a GitHub issue)
`gh issue view <N> --comments` — and gives a compact task capsule (operated
project name, issue number/title/URL/labels). It does **not** paste the full
issue body/comments into the PTY by default; the operated project (the repo
opened in GodMode, not the GodMode app repo) is named explicitly so the builder
is never ambiguous about where it works. The full fetched detail stays in the
operator preview/audit only (shown collapsibly, labeled "not sent"). Full-context
injection is a deliberate future option, not the default.

The handoff is sendable only when a real source is bound and no template
variables are unresolved. A GitHub issue resolves fully (no leftover
`{{issueNumber}}`/`{{issueTitle}}`); a manual task has no issue number, so send is
blocked and the operator routes a vague task to `needs_spec` rather than sending
it blindly. With no run bound, the preview is clearly labeled mock/demo.

For an isolated run (issue #41), sending the handoff first creates (or reuses, on
fix cycles) the run-scoped worktree on its branch and names that worktree path as
the working root in the prompt while still naming the operated project. A worktree
creation failure is a visible error and the run does not advance as if the handoff
were ready; the builder PTY must already be running in that worktree (restart the
pane if it was started before the worktree existed) before the prompt is delivered.

Sending (`godmode:run:handoff:send`) is gated behind an explicit operator
approval and a live builder session: the approved prompt is written into the
configured builder PTY (in the operated-project root, or the run worktree when
isolated), a prompt-sent event (timestamp, source, single-line digest, length) is
recorded in the run's audit log, and the run advances to `builder_running`.
Reaching `builder_running`
records that the prompt was *sent*, never that the task succeeded. See
`docs/architecture/builder-handoff.md`.

### Reviewer launch and PR comments

From a `pr_opened` run, `godmode:run:reviewers:start` launches Reviewer A and B
as independent tracked sessions. It first **re-runs the commit-verification gate
(#9) live** and refuses to launch unless the PR is `verified` — plain PR
existence or an agent self-report is never enough evidence. Each reviewer gets a
**pointer-first** fresh-session prompt bound to the verified PR (number/URL/branch),
its reviewer id, and its role doc, directing it to read `AGENTS.md`, the live PR
diff/threads/checks (`gh pr view`/`gh pr diff`), and the linked issue itself — the
diff is never pasted. Sessions launch in the operated-project root (the configured
reviewer panes) and their stdout/stderr is captured to a local artifact under
`.godmode/runs/<run-id>/<reviewer-id>.log` (gitignored), linked from the run state
and shown in the dashboard. On each reviewer's session exit GodMode auto-posts one
concise **role-signed marker** comment via `gh pr comment` (the one mutating `gh`
call) — a factual marker that the session ran and where its output was captured,
explicitly *not* a merge-readiness claim, and never the agent's pasted output; the
reviewer's own findings are its separate PR comments. A successful post refreshes
the operated project's GitHub snapshot so the new comment shows without a manual
refresh. An operator override re-posts or covers interactive reviewers that do not
exit. Launch, capture, and comment failures are surfaced visibly per reviewer and
never collapse into "complete". One-shot reviewers use the agent's non-interactive
command (the default Codex reviewer ships `codex exec`) so they run to completion
and auto-post. See `docs/architecture/reviewer-launch.md`.

After reviewers run, GodMode **synthesizes** their captured output into normalized
findings: it parses each reviewer's `DONE` marker, PASS line, and `BLOCKING` blocks
(title, file/line, issue, suggested fix) into `pass`/`fail`/`ambiguous` results, and
routes missing/malformed/contradictory output to `needs_human` rather than ever
treating it as a pass. The **merge gate** is reached only when both reviewers clear
**and** the #9 commit evidence is verified **and** no accepted blockers remain — a
reviewer self-report alone is never enough. When accepted blockers exist **and the
#9 gate is verified**, GodMode opens a fix cycle and renders a pointer-first
`builder_fix` handoff carrying the normalized blocker text (never a transcript dump)
plus pointers back to the live PR/review artifacts; blockers with an unverified PR
hold until re-verification rather than fixing a stale target. The verified-commit gate runs again before reviewers re-review
the fix, and max-cycle limits stay authoritative in the run state machine. Findings
are stored on the run and mirrored to `.godmode/runs/<run-id>/findings.json`. See
`docs/architecture/review-synthesis.md`.

### Automatic review/fix loop

Once a run has a verified PR, an optional **review/fix loop controller** in the
main process drives reviewer launch → synthesis → fix handoff → re-verification →
re-review automatically, so the operator supervises the loop instead of clicking
every stage. It holds an explicit per-run mode — `manual` (the default; every
stage stays operator-triggered, regression-safe) or `auto` — and reacts only to
**observable events** (run transitions, reviewer session exits, live verification
results). It is plain code, not a head-agent prompt: it advances a run *only* by
calling the existing operator-triggered handlers / `dispatchRunAction`, never
duplicating transition rules and never interpreting agent prose (it consumes the
same `findings.ts`/verification outputs). The run state machine remains the single
transition authority.

Operator authority gates hold in auto mode: fix-handoff send stays
operator-approved by default (`loop.autoSendFix: false`), merge stays manual
(the loop **stops** at `merge_ready`), and pause/cancel or any manual dispatch
always preempt. After a fix is sent, the controller watches the PR for the new
commit (reusing the #9 evidence gate / #38 discovery), re-verifies, and relaunches
reviewers for the next cycle; `maxCycles` stays authoritative. Stage failures stop
auto-advancement and route to the existing visible failure surface — no silent
retries (at most one automatic retry for a transient `gh` failure, logged), and
ambiguous/missing reviewer output still routes to `needs_human`. Every
controller-initiated transition is attributed to the `loop` actor in the
transition log; operator actions remain `operator`. Optional config lives under a
`loop:` block in `.agentic/godmode.yaml`. See
`docs/architecture/review-fix-loop.md`.

## V1 UX Shape

V1 should feel like a terminal multiplexer with agent-specific panes:

```text
┌──────────────────────── Head / Operator ───────────────────────┐
│ chat, orchestration notes, commands, state                      │
├──────────────────── Builder ─────────────┬──── Reviewer A ──────┤
│ terminal stream + chat/control input      │ review stream/chat   │
├──────────────────── Reviewer B ──────────┴──── PR/GitHub ───────┤
│ review stream/chat                        │ issue/PR/checks      │
└──────────────────── Global Command Bar / Actions ───────────────┘
```

## V1 Workflow

1. Operator opens GodMode on a local repo/harness.
2. Operator selects or specs an issue.
3. Builder starts a fresh session for the task, then reads the harness, spec, issue, and relevant docs/comments before implementing.
4. Builder opens a PR.
5. Reviewers automatically start fresh review sessions and read `AGENTS.md`, the PR, linked issues, comments, and relevant docs before reviewing.
6. If blockers exist, builder starts a fresh fix session, receives accepted blockers, fixes them, pushes, and comments on the PR.
7. Reviewers start fresh re-review sessions after fix commits and re-read the PR state before responding.
8. Loop continues until merge-ready, max cycles, failure, pause, or human intervention.
9. Operator manually approves/merges or asks for more changes.

## Current Build Phases

- [x] Product spec drafted.
- [x] Initial harness and tech stack selected.
- [x] Electron/React/xterm scaffold.
- [x] Static tmux-style dashboard shell.
- [x] One real PTY terminal pane.
- [x] Project harness detection.
- [ ] GitHub read-only issue/PR pane.
- [x] Agent adapter registry.
- [x] Builder handoff: bind selected issue/manual task to a reviewed prompt and send to the builder.
- [x] Commit verification: prove the expected builder commit is on the remote PR before trusting builder output (`docs/architecture/commit-verification.md`).
- [ ] Claude builder run.
- [x] Reviewer launch: launch Reviewer A/B from a verified PR, capture their output, and post role-signed PR comments (`docs/architecture/reviewer-launch.md`).
- [x] Review synthesis: parse reviewer findings, compute the verified merge gate, and drive the first blocker-fix cycle (`docs/architecture/review-synthesis.md`).
- [x] Automatic review/fix loop: a deterministic main-process controller chains reviewer launch → synthesis → fix handoff → re-verification → re-review once a run has a verified PR (`docs/architecture/review-fix-loop.md`).
- [ ] Dogfood GodMode on itself.

## Continuous Integration

GitHub Actions (`.github/workflows/ci.yml`) runs the documented verification
commands (`npm ci`, `npm run typecheck`, `npm test`, `npm run build`) on every
pull request and push to `main`. The resulting GitHub check is neutral,
per-commit verification evidence: it feeds the commit-verification gate
(`summarizeChecks` in `src/main/verify.ts`) and the run state machine's
`tests_failed`/`checks_unstable` blockers, and a local pass never overrides a
red check on the pushed commit.

### Live-Electron smoke (`npm run smoke`)

Beyond the CI commands, `npm run smoke` builds the app and launches **real
Electron** against the production renderer to assert the operator-visible wiring
end to end (preload `window.godmode` bridge — the #34 regression — project
selection/harness detection, dogfooding badge, config-derived role panes, GitHub
`gh_missing` degradation, a fake-CLI PTY in the operated-project root, and
run/handoff binding). It runs with **fake agents and no network/mutating `gh`
calls** (the launched app gets an empty PATH so `gh` is deterministically
absent). It is separate from `npm test` (which stays GUI-free) and is required
when a change touches preload/IPC/main-process wiring and before any dogfood run.
Failures drop a screenshot + console log under `.godmode/smoke/` (gitignored).
The smoke is not part of CI yet; wiring it in (via `xvfb-run`) is a follow-up.

## Open Questions

| Question | Status |
| --- | --- |
| Hermes integration: CLI subprocess, API, MCP/ACP, or in-dashboard adapter? | Prefer CLI for v1; keep adapter boundary flexible until dogfooding clarifies pros/cons. |
| Codex default mode: interactive PTY or one-shot exec? | Try one-shot exec for v1 review runs; every run must first load relevant docs, issues, PRs, and comments. |
| Should reviewer findings be dashboard-only first or posted to GitHub comments in v1? | Post reviewer findings as GitHub PR comments in v1. |
| Default max fix cycles: 2 or 3? | Use 3 until dogfooding says otherwise. |
| Manual merge only in v1 or optional approved merge button? | Manual merge only in v1. |

## Spec Drift Convention

Every PR that changes architecture, role behavior, source-of-truth rules, setup, or verification must update this file and/or `AGENTS.md` in the same PR.

## Links

- Full v1 product spec: `docs/godmode-v1-product-spec.md`
- Architecture docs: `docs/architecture/`
- Review role docs: `docs/review/`
- Conventions: `docs/conventions/`
- Friction log: `docs/friction/`
