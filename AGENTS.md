# GodMode Agent Harness

This repository is the execution harness for **GodMode**, a local tmux-style, bring-your-own-agent coding dashboard.

GodMode is being built to dogfood itself. Treat this file as the operating contract for any agent working in this repo.

## Core Product Direction

- GodMode is a **local macOS desktop app** first.
- V1 should feel like **QuadWork/tmux**: split panes, terminal streams, live agent chat/control, and visible PR state.
- V1 does **not** need polished SaaS UI. Reliability, visibility, and controllable agent sessions matter more.
- The app must be **bring-your-own-agent native**: Hermes, Claude, Codex, OpenClaw, OpenCode, Gemini, or custom CLIs can be mapped to roles.
- Karan's default configuration is:
  - Head/operator: Hermes
  - Builder/dev: Claude Code
  - Reviewer A: Codex focused on correctness/security/tests
  - Reviewer B: Codex focused on architecture/spec/harness compliance
- The product must not hardcode that default. Code should model **roles** separately from **agents/adapters**.

## Source of Truth

Agents must use repo-local source of truth before inventing behavior:

1. `AGENTS.md` — process and authority rules.
2. `docs/spec.md` — current product/technical specification.
3. `docs/godmode-v1-product-spec.md` — full v1 product spec.
4. `.agentic/godmode.yaml` — default local role/workflow config.
5. GitHub Issues/PRs/comments — task and review state.
6. `docs/friction/` — running lessons from things that broke.

Do not encode durable project rules only in one-off prompts. If a rule should guide future agents, put it in the harness docs.

## Roles

| Role | Default Agent | Responsibility |
| --- | --- | --- |
| Human | Karan | Product direction, final approval, merge authority |
| Head | Hermes | Orchestration, specing, synthesis, safety gates, verification |
| Builder | Claude Code | Implement issues, test, commit, push, open PR, fix blockers |
| Reviewer A | Codex | Correctness, tests, security, regressions |
| Reviewer B | Codex | Architecture, maintainability, spec drift, harness compliance |

Role names in code should be generic: `head`, `builder`, `reviewer_a`, `reviewer_b`. Do not name core abstractions `HermesPane`, `ClaudePane`, or `CodexPane` unless they are display labels only.

## Default Tech Stack

- Desktop shell: Electron.
- Language: TypeScript.
- Renderer: React + Vite.
- Terminal panes: xterm.js.
- PTY/process layer: Node.js main process + `node-pty`.
- Persistence: SQLite via `better-sqlite3`.
- GitHub: `git` + `gh` CLI first.
- Config: `.agentic/godmode.yaml` project-local config.

Prefer simple, boring implementation over clever abstractions.

## Workflow Contract

### Issue-to-PR Loop

1. Karan or the head role selects an issue/task.
2. Builder starts a fresh session for the task, then reads this harness, `docs/spec.md`, the issue, and relevant docs/comments.
3. Builder creates a branch, implements, verifies, pushes, and opens a PR.
4. Once a PR is detected, Reviewer A and Reviewer B start fresh review sessions, read `AGENTS.md`, the PR, linked issues, comments, and relevant docs, then review.
5. If blockers are found, the builder starts a fresh fix session, receives accepted blockers, fixes them, pushes, and comments on the PR.
6. Reviewers start fresh re-review sessions after fix commits and re-read PR state before responding.
7. Loop continues until merge-ready, max cycles, failure, pause, or human intervention.
8. Karan retains final merge authority. No automatic merge to `main` in v1.

### Completion Evidence

Agent self-reports are not proof. Verify with tools:

- After push: verify expected commit appears in `gh pr view <PR> --json commits`.
- After PR creation: verify PR exists and branch matches.
- After merge, if ever performed/claimed: re-query GitHub and confirm merged/closed.
- For app changes: run the repo's verification commands before reporting success.

## Branch and PR Rules

- Do not push directly to `main`.
- Use one branch per task.
- Keep PRs scoped to one issue/task.
- Every PR must be tied to a GitHub issue. PR descriptions should use `Closes #N`, `Fixes #N`, or explicitly link the governing issue when auto-closing is not desired.
- Do not open free-floating PRs for implementation work; if no suitable issue exists, create or ask for a focused issue first.
- Do not bundle unrelated refactors.
- Update docs in the same PR when behavior, architecture, setup, or harness rules change.
- PR descriptions should include summary, verification, and linked issue.
- After pushing a commit to a PR branch, leave a PR comment that names the commit, summarizes what changed, states verification performed, and calls out any remaining caveats. Then verify the commit appears in the PR commit list before reporting completion.

Suggested branch prefixes:

- `feat/<slug>` for features.
- `fix/<slug>` for bug fixes.
- `docs/<slug>` for documentation-only changes.
- `chore/<slug>` for tooling/scaffold work.

## Review Standards

Reviewer A should block on:

- broken behavior,
- type/build/test failures,
- security issues,
- unsafe shell/process handling,
- unverified GitHub state,
- regression risks.

Reviewer B should block on:

- architecture that breaks BYOA role separation,
- hardcoded Hermes/Claude/Codex assumptions in core abstractions,
- spec/harness drift,
- poor state-machine boundaries,
- hidden source-of-truth rules outside docs/config,
- UI changes that move away from tmux-style operator workflow.

Non-blocking preferences should be clearly labeled as non-blocking.

## Safety Rules

- No production deploy automation in v1.
- No auto-merge to main in v1.
- No credential scraping from local env files or unrelated profiles.
- Agent commands must run inside the selected project directory unless explicitly configured otherwise.
- Destructive git actions require explicit human approval.
- Preserve user control: pause/cancel/override must be possible for long-running agent sessions.

## Implementation Guidelines

- Keep head/builder/reviewer roles agent-agnostic.
- Keep CLI adapter interfaces small and capability-based.
- Use deterministic state transitions for the PR loop; do not let LLM output alone decide workflow state.
- Store run artifacts under `.godmode/runs/` or a clearly configured location.
- Prefer `gh`/`git` CLI for v1 GitHub operations.
- Avoid premature SaaS/multi-tenant concerns.
- Build the smallest useful slice that can be dogfooded.

## Verification Commands

Current scaffold verification:

```bash
npm run typecheck
npm run build
```

If dependencies are not installed yet:

```bash
npm install
npm run typecheck
npm run build
```

Update this section when the real test suite is added.

## Friction Log

When a non-obvious issue is discovered, add a short note in `docs/friction/` with:

- what happened,
- root cause,
- fix/workaround,
- whether `AGENTS.md`, `docs/spec.md`, or config should change.

If the lesson is reusable across projects, tell Hermes so the relevant skill can be patched.
