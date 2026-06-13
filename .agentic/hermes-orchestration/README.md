# Hermes Orchestration (Repo-Local Scaffolding)

Repo-local prompt templates for running the **Hermes → Claude Code → Codex reviewer** loop
against the GodMode repo (`Papi-Consulting/godmode`) when GodMode is operated by Hermes.

> [!IMPORTANT]
> **This folder is operational scaffolding, not product runtime code.**
> Nothing here is loaded, imported, executed, or exposed by the GodMode app. These are
> human/agent-facing prompt templates that Hermes copies into live agent sessions. Do not
> wire these files into `src/`, IPC channels, config loaders, the run state machine, or any
> runtime behavior. If the product ever needs to load or surface these templates, that
> requires its own scoped GitHub issue — it is explicitly out of scope here (see issue #45).

## Why this lives in the repo

The generic, product-agnostic plan and the canonical source templates live **outside** any
product repo at `/Users/creator/projects/hermes-orchestration/`. For repos that Hermes
operates repeatedly — like GodMode dogfooding itself — the approved repo-local home is:

```text
.agentic/hermes-orchestration/
  README.md            # this file
  templates/
    claude-builder-start.md
    claude-builder-fix.md
    codex-reviewer-start.md
    codex-reviewer-rereview.md
    hermes-roll-call.md
    verify-pr-ready.md
```

The explicit `hermes-orchestration/` name (not a vague `.agentic/commands/`) keeps future
agents from confusing this orchestration scaffolding with product runtime commands.

## How these templates are meant to be used

- **Role-first:** each template addresses a role (builder, reviewer, head), matching the
  generic role model in `AGENTS.md` and `.agentic/godmode.yaml` (`head`, `builder`,
  `reviewer_a`, `reviewer_b`). They do not hardcode that a specific role must be a specific
  vendor's CLI beyond GodMode's documented default mapping.
- **Pointer-first:** templates reference **live** issue/PR URLs, `gh` commands, and repo docs
  (`AGENTS.md`, `docs/spec.md`, `docs/architecture/`, `docs/conventions/`, `docs/review/`)
  rather than embedding transcripts or stale copies. Agents must read current state with `gh`
  before acting.
- `{{placeholder}}` tokens (e.g. `{{issueNumber}}`, `{{prNumber}}`, `{{branch}}`) are filled
  in at dispatch time by Hermes.

## Guardrails (inherited from `AGENTS.md`)

- No auto-merge to `main` and no deploy automation in v1.
- Agents verify GitHub state with `gh`/`git` — self-reports are not proof.
- No reading, printing, or mutating of secrets or env files.
- Builder work runs inside the operated-project directory, one branch per task, scoped to one
  issue.

## Source of truth

These templates are convenience scaffolding. The authoritative process rules remain in
`AGENTS.md`, the specs under `docs/`, `.agentic/godmode.yaml`, and the live GitHub issues/PRs.
If a template and those sources ever disagree, the sources win — update the template.
