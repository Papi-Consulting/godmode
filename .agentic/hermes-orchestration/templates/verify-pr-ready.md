# Verify PR Ready

> Repo-local Hermes orchestration scaffolding. Not GodMode runtime code.

Run this checklist before reporting PR #{{prNumber}} (`Papi-Consulting/godmode`) as ready for
Karan. Self-reports and local state are **not** proof — confirm against live GitHub.

```bash
REPO=Papi-Consulting/godmode

# 1. Inspect live PR state
gh pr view {{prNumber}} --repo "$REPO" \
  --json number,title,state,headRefName,baseRefName,commits,comments,reviews,latestReviews,statusCheckRollup,mergeStateStatus,url

# 2. Verify your local HEAD is actually on the PR
LOCAL=$(git rev-parse HEAD)
REMOTE=$(gh pr view {{prNumber}} --repo "$REPO" --json commits --jq '.commits[-1].oid')
test "$LOCAL" = "$REMOTE" && echo "commit on PR: OK" || echo "commit MISMATCH"

# 3. Confirm PR author identity is the expected GitHub account
gh pr view {{prNumber}} --repo "$REPO" --json author --jq '.author.login'

# 4. Inspect review surfaces
gh api repos/Papi-Consulting/godmode/pulls/{{prNumber}}/reviews
gh api repos/Papi-Consulting/godmode/pulls/{{prNumber}}/comments

# 5. Repo verification for the change (docs/scaffold-only may justify a lighter set)
git diff --check
npm test
npm run typecheck
npm run build   # if Vite worktree EPERM: npm run build -- --configLoader runner
```

Ready-for-Karan requires: commit verified on PR, required reviews `APPROVE`d, CI green,
`auto_merge: false` honored (no merge performed). Do not claim pushed, reviewed, ready, or
merged from agent summaries alone.
