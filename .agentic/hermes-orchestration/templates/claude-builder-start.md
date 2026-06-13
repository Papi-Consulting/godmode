# Claude Code — Builder Start

> Repo-local Hermes orchestration scaffolding. Not GodMode runtime code.

You are the **builder** role for GitHub issue #{{issueNumber}} in `Papi-Consulting/godmode`.

- Issue: {{issueUrl}}
- Operated project root: {{projectRoot}}

## Read first (live, pointer-first)

- Repo harness and process rules: `AGENTS.md`.
- Spec/architecture/conventions as relevant: `docs/spec.md`, `docs/architecture/`,
  `docs/conventions/`.
- The live issue and its comments: `gh issue view {{issueNumber}} --repo Papi-Consulting/godmode --comments`.
- Role/workflow config: `.agentic/godmode.yaml`.
- CodeGraph orientation for the area you will touch (read-first, not authority):
  `npx -y @colbymchenry/codegraph@0.9.9 sync . && npx -y @colbymchenry/codegraph@0.9.9 query <symbol> -p .`

## Do

1. Work **only** on issue #{{issueNumber}}. Do not bundle unrelated refactors.
2. Create one branch from latest `origin/main` (e.g. `feat/<slug>`, `fix/<slug>`, `docs/<slug>`).
3. Implement the smallest maintainable change that satisfies the acceptance criteria.
4. Run repo verification and capture output:
   - `git diff --check`
   - `npm test`
   - `npm run typecheck`
   - `npm run build` (if a Vite temp-file `EPERM` appears in worktree setups, rerun with
     `npm run build -- --configLoader runner` and note the workaround).
5. Commit with a clear message, push the branch, and open a PR to `main` linked to the issue
   (`Closes #{{issueNumber}}` unless auto-close is undesired — then link explicitly).
6. Comment on the PR: commit SHA, verification performed, and any caveats. Then confirm the
   commit appears in `gh pr view <PR> --json commits`.

## Don't

- Don't push to `main`, merge, or deploy.
- Don't read, print, or mutate secrets or env files.
- Don't change core role abstractions to hardcode a specific vendor.

## Finish

Print exactly:

```text
DONE: STATUS=success|failure PR=<number|none> BRANCH=<branch|none>
```
