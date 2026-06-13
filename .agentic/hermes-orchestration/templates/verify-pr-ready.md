# Verify PR Ready Template

Use this checklist before reporting a PR as ready for Karan.

Required checks:

```bash
# Inspect PR state
gh pr view {{prNumber}} --repo {{repo}} \
  --json number,title,state,headRefName,baseRefName,commits,comments,reviews,latestReviews,statusCheckRollup,mergeStateStatus,url

# Verify expected commit appears on the PR
LOCAL=$(git rev-parse HEAD)
REMOTE=$(gh pr view {{prNumber}} --repo {{repo}} --json commits --jq '.commits[-1].oid')
test "$LOCAL" = "$REMOTE"

# Inspect review surfaces
gh api repos/{{owner}}/{{name}}/pulls/{{prNumber}}/reviews
gh api repos/{{owner}}/{{name}}/pulls/{{prNumber}}/comments

# Verify merge after approval, if merge was performed
gh pr view {{prNumber}} --repo {{repo}} --json state,mergedAt,mergeCommit \
  --jq '{state, merged:(.mergedAt != null), mergeCommit:.mergeCommit.oid}'
```

Do not claim pushed, reviewed, ready, or merged from local state or agent summaries alone.
