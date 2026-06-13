# Claude Code — Builder Fix

> Repo-local Hermes orchestration scaffolding. Not GodMode runtime code.

You are the **builder** role addressing blocking review feedback on PR #{{prNumber}} in
`Papi-Consulting/godmode`.

- PR: {{prUrl}}
- Branch: {{branch}}
- Operated project root: {{projectRoot}}

## Read first (live, pointer-first)

- Start a fresh session and re-read `AGENTS.md` plus docs relevant to the change.
- Live PR state, reviews, threads, and comments:
  - `gh pr view {{prNumber}} --repo Papi-Consulting/godmode --comments`
  - `gh api repos/Papi-Consulting/godmode/pulls/{{prNumber}}/reviews`
  - `gh api repos/Papi-Consulting/godmode/pulls/{{prNumber}}/comments`
- The linked issue for scope/acceptance criteria.

## Do

1. Identify the **unresolved blocking** findings from the reviewers (`reviewer_a`, `reviewer_b`).
   Treat clearly-labeled non-blocking preferences as optional.
2. Resolve only those blockers — do not expand scope.
3. Re-run repo verification: `git diff --check`, `npm test`, `npm run typecheck`,
   `npm run build` (use `-- --configLoader runner` if the worktree Vite `EPERM` appears).
4. Commit and push a follow-up commit to `{{branch}}` (same branch — do not open a new PR).
5. Comment on the PR naming the commit SHA, what changed per blocker, and verification passed.
6. Confirm the new commit appears in `gh pr view {{prNumber}} --repo Papi-Consulting/godmode --json commits`.

## Don't

- Don't merge, deploy, or push to `main`.
- Don't read, print, or mutate secrets.

## Finish

Print exactly:

```text
DONE: STATUS=success|failure PR={{prNumber}} BRANCH={{branch}}
```
