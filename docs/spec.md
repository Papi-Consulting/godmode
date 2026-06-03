# GodMode Project Specification

*Living document. Update this when product scope, architecture, workflow, or verification changes.*

## What This Is

GodMode is a local, macOS-first, tmux-style multi-agent coding dashboard. It opens on a project harness, lets a human operator command and chat with an agent team, runs an automatic build-review-fix PR loop, and keeps final merge authority with the human.

The product is inspired by QuadWork's multi-agent dashboard feel, but GodMode is explicitly bring-your-own-agent native and harness-driven.

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
3. Builder is told to work on the issue and read the harness.
4. Builder opens a PR.
5. Reviewers automatically review.
6. If blockers exist, builder automatically fixes and comments.
7. Reviewers re-review after fix commits.
8. Loop continues until merge-ready, max cycles, failure, pause, or human intervention.
9. Operator manually approves/merges or asks for more changes.

## Current Build Phases

- [x] Product spec drafted.
- [x] Initial harness and tech stack selected.
- [ ] Electron/React/xterm scaffold.
- [ ] Static tmux-style dashboard shell.
- [ ] One real PTY terminal pane.
- [ ] Project harness detection.
- [ ] GitHub read-only issue/PR pane.
- [ ] Agent adapter registry.
- [ ] Claude builder run.
- [ ] Codex reviewer runs.
- [ ] Automatic review/fix loop.
- [ ] Dogfood GodMode on itself.

## Open Questions

| Question | Status |
| --- | --- |
| Hermes integration: CLI subprocess, API, MCP/ACP, or in-dashboard adapter? | Open |
| Codex default mode: interactive PTY or one-shot exec? | Open |
| Should reviewer findings be dashboard-only first or posted to GitHub comments in v1? | Open |
| Default max fix cycles: 2 or 3? | Recommend 2 until dogfooding says otherwise |
| Manual merge only in v1 or optional approved merge button? | Manual merge first |

## Spec Drift Convention

Every PR that changes architecture, role behavior, source-of-truth rules, setup, or verification must update this file and/or `AGENTS.md` in the same PR.

## Links

- Full v1 product spec: `docs/godmode-v1-product-spec.md`
- Architecture docs: `docs/architecture/`
- Review role docs: `docs/review/`
- Conventions: `docs/conventions/`
- Friction log: `docs/friction/`
