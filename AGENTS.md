# GodMode Agent Harness

This repository is the **GodMode app repo** — the execution harness and source for **GodMode**, a local tmux-style, bring-your-own-agent coding dashboard.

GodMode is being built to dogfood itself. Treat this file as the operating contract for any agent working in this repo.

## App Repo vs Operated Project

GodMode always distinguishes two repository contexts, and so must every agent:

- **GodMode app repo** — this repository: the Electron app code, docs, config defaults, and development tasks.
- **Operated project** — the external repo/project opened inside GodMode and worked on by configured agents.

Harness detection, PTY working directories, and GitHub issue/PR lookups all scope to the **operated project root** — never implicitly to the GodMode app repo. Issues and PRs shown in the GitHub pane belong to the operated project.

**Self-dogfooding is the special case:** when GodMode is opened on its own repo, the operated project and the app repo point at the same directory. The contexts coincide on disk but stay conceptually distinct — agents act on it as the *operated project*, exactly as for any external repo. The app surfaces this with a "dogfooding" badge (`ProjectState.isAppRepo`); nothing branches behavior on it. See `docs/architecture/app-vs-operated-project.md` for the full model.

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
4. `docs/architecture/` — durable technical design and module boundaries.
5. `docs/conventions/` — standing branch, PR, testing, and coding conventions.
6. `.agentic/godmode.yaml` — default local role/workflow config and harness doc locations.
7. GitHub Issues/PRs/comments — task and review state.
8. `docs/friction/` — running lessons from things that broke.

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

## CodeGraph Usage

Builder and reviewer agents should use CodeGraph as a read-first repo intelligence layer when it can answer a concrete implementation or review question.

CodeGraph is for:

- orienting around feature, IPC, component, config, and process flows;
- finding symbols, callers, callees, and impact before edits;
- expanding reviewer blast-radius checks before writing review comments.

CodeGraph is **not** authority. It does not replace `AGENTS.md`, specs, GitHub Issues/PRs, source diff review, tests, or Karan's final approval.

### Index hygiene

- Keep generated CodeGraph indexes local. Do not commit `.codegraph/`.
- `.codegraph/` is intentionally ignored in `.gitignore` so local builder/reviewer indexing does not dirty the repo.
- Refresh or initialize the local index before using it:

```bash
npx -y @colbymchenry/codegraph@0.9.9 sync .
# If no index exists yet:
npx -y @colbymchenry/codegraph@0.9.9 init .
```

### Builder expectations

Before implementation, the builder should ask CodeGraph at least one concrete orientation question tied to the task. Before changing an existing exported function, component, IPC handler, config loader, or adapter boundary, check impact/call relationships where useful:

```bash
npx -y @colbymchenry/codegraph@0.9.9 query <symbol> -p .
npx -y @colbymchenry/codegraph@0.9.9 impact <symbol> -p .
npx -y @colbymchenry/codegraph@0.9.9 callers <symbol> -p .
npx -y @colbymchenry/codegraph@0.9.9 callees <symbol> -p .
```

PR descriptions for implementation work should include a short section when CodeGraph was used:

```md
CodeGraph context used:
- Query/flow checked: ...
- Symbols/files inspected: ...
- Blast-radius notes: ...
- Limitations: ...
```

### Reviewer expectations

Reviewers should use CodeGraph for triage around changed symbols/files, then verify with the actual diff and source. Blocking comments still require concrete file/line evidence and an actionable risk.

Review summaries should include whether CodeGraph found extra graph-linked blast radius or found no additional graph-linked risk.

Known limitation: CodeGraph does not fully model Electron IPC string channels yet. Reviewers must manually pair `ipcRenderer.invoke/send(...)` and `ipcMain.handle/on(...)` channels when IPC behavior changes. IPC code should use shared channel constants and named handlers so CodeGraph can still find the relevant boundary symbols; see `docs/conventions/codegraph-ipc.md`.

## Workflow Contract

### Issue-to-PR Loop

1. Karan or the head role selects an issue/task.
2. Builder starts a fresh session for the task, then reads this harness, `docs/spec.md`, the issue, and relevant docs/comments, including `docs/architecture/` and `docs/conventions/` when the task touches design or standing workflow rules.
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
- Agent commands must run inside the selected operated-project directory (not the GodMode app repo) unless explicitly configured otherwise.
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
