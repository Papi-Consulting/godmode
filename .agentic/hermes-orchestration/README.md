# Hermes Orchestration Templates

This folder is not product runtime code.

It contains repo-local prompt and command templates used by Hermes when orchestrating Claude Code and CodexReviewer while working on this repository.

## Authority order

1. `AGENTS.md` or repo agent instructions
2. Repo spec/docs
3. GitHub Issue / PR under work
4. These templates as operational helpers only

Do not implement features from these templates unless a GitHub Issue explicitly asks for that work.

A product may later learn to read project-local orchestration templates, but this folder's presence alone is not a product requirement.

## Scope boundary

These files are Hermes-owned operational scaffolding. They should stay pointer-first and role-first: reference live issues, PRs, repo docs, and `gh` commands rather than embedding long transcripts by default.

Out of scope for this folder unless separately approved:

- runtime product behavior;
- template-loading features;
- GitHub webhook servers;
- autonomous queue picking;
- automatic merge/deploy behavior;
- credential management.
