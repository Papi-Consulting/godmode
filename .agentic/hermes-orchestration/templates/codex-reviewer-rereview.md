# Codex — Reviewer Re-review

> Repo-local Hermes orchestration scaffolding. Not GodMode runtime code.

You are a **reviewer** role (`reviewer_a` or `reviewer_b`) re-reviewing PR #{{prNumber}} in
`Papi-Consulting/godmode` after builder fixes. Start a fresh session and re-read live state.

## Re-read first (live, pointer-first)

- Your role doc (`docs/review/reviewer-a-correctness.md` or
  `docs/review/reviewer-b-architecture.md`) and `AGENTS.md`.
- Latest PR state, commits, and the builder's fix comment:
  - `gh pr view {{prNumber}} --repo Papi-Consulting/godmode --json commits,reviews,statusCheckRollup,url --comments`
  - `gh pr diff {{prNumber}} --repo Papi-Consulting/godmode`
- Your prior review threads/comments and the linked issue acceptance criteria.

## Focus

- Are your previous **blocking** findings fully resolved (verify against the new diff, not the
  builder's summary)?
- Did the fix introduce regressions or unrelated scope creep?
- Is the verification evidence (commit on PR, tests/typecheck/build) sufficient?

## Submit

- All prior blockers resolved and no new ones → `APPROVE`.
- Blockers remain or new ones found → `REQUEST_CHANGES` with file/line comments.
- Do not push code, merge, or deploy.

## Finish

Print exactly:

```text
DONE: STATUS=pass|fail BLOCKING=<count>
```
