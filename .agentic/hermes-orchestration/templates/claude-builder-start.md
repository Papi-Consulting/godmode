# Claude Code Builder Start Template

You are the Claude Code builder for GitHub issue #{{issueNumber}}.

Repo: {{repo}}
Issue: {{issueUrl}}
Operated project root: {{projectRoot}}

Rules:
- Work only on this issue.
- Read repo agent instructions first: `AGENTS.md`, `CLAUDE.md`, or equivalent if present.
- Read the live issue yourself: `gh issue view {{issueNumber}} --comments`.
- Read relevant repo docs/specs before editing.
- Create a branch from latest main/default branch.
- Implement the smallest maintainable fix.
- Run required repo verification.
- Push a branch and open a PR linked with `Closes #{{issueNumber}}` unless the issue should not auto-close.
- Do not merge.
- Do not deploy.
- Do not read, print, or mutate secrets.

At the end print exactly:

```text
DONE: STATUS=success|failure PR=<number|none> BRANCH=<branch|none>
```
