# Commit Verification (Evidence Layer)

GodMode is an **agent harness**, not a prompt router that trusts what an agent
says it did. Issue #9 adds the non-negotiable **evidence layer**: before any
later state treats builder output as valid, GodMode must prove the expected
builder commit is actually present on the remote PR branch — read from `gh`/`git`,
never from agent self-report or PTY transcript content.

This is the verification that reviewer (#10) and merge-ready (#11) logic must
consume. Those states read the recorded/derived verification status, not plain
PR existence or a reviewer's claim.

## Boundaries

| Concern | Owner |
| --- | --- |
| Verification result + run log types crossing IPC | `CommitVerification`, `RunVerificationLogEntry`, `RunVerificationResult` in `src/shared/types.ts` |
| Pure status derivation + commit-list comparison | `deriveVerification`, `commitMatches`, `summarizeChecks` in `src/main/verify.ts` |
| Impure evidence gathering (`git`/`gh`) | `getCommitVerification` in `src/main/github.ts` |
| Run-recorded expected commit + verification history | `RunSnapshot.expectedCommit` / `RunSnapshot.verifications`, `recordVerification` in `src/main/run.ts` |
| IPC: run the gate and record it on the run | `godmode:run:verify` (`handleVerifyRun`) in `src/main/index.ts` |
| Pure PR-candidate matching + ambiguity decision (#38) | `matchPrCandidates`, `referencesIssue`, `selectPrCandidate` in `src/main/discovery.ts` |
| Impure PR discovery fetch (`gh pr list`, #38) | `discoverRunPrCandidates` in `src/main/github.ts` |
| IPC: discover + confirm an evidence-bound `open_pr` (#38) | `godmode:run:pr:discover` / `godmode:run:pr:confirm` / `godmode:run:pr:discovered` in `src/main/index.ts` |
| Operator-facing evidence panel + PR discovery UI | `src/renderer/components/VerificationPane.tsx`, `src/renderer/components/RunControlPane.tsx` |

The pure core (`deriveVerification`, `commitMatches`, `summarizeChecks`) is
Electron/`gh`-free and unit-tested directly (`test/verify.test.js`). The impure
gathering function shells out read-only (like the rest of `github.ts`) and then
calls the pure derivation, so the state table — not whichever `gh` field happened
to be present — governs the outcome.

## Expected commit

The commit being verified comes from one of two sources, surfaced as
`expectedCommitSource` so the operator can see what was checked:

1. **`run_recorded`** — a commit recorded on the run during the builder phase
   (`RunSnapshot.expectedCommit`, set via `applyAction`'s `expectedCommit` option
   on e.g. `open_pr` / `push_fix`). This is the authoritative source once the
   builder pipeline records it.
2. **`local_head`** — fallback to the operated project's local `HEAD`
   (`git rev-parse HEAD`) when no run-recorded commit exists yet.

If neither resolves, the status is `needs_human` (nothing to verify).

## Evidence gathered

For the operated-project root only (never the GodMode app repo):

- current branch (`git branch --show-current`),
- the expected commit (above),
- the PR for that branch via `gh pr view <branch> --json
  number,state,url,headRefName,headRefOid,commits,statusCheckRollup` — its state,
  URL, remote head SHA (`headRefOid`), full commit list (`commits[].oid`), and
  normalized checks.

`gh pr view` exiting non-zero because no PR exists is treated as "no PR", not a
failed query. Any other failure marks the evidence `partial`, and the underlying
`gh` reason (auth, missing CLI, network) replaces the generic copy so the
operator knows whether to authenticate, install `gh`, or just retry.

## Status derivation

`deriveVerification` returns one deterministic status (first match wins):

1. `needs_refresh` — a query failed; evidence is partial, retry.
2. `needs_human` — no commit could be resolved to verify.
3. `no_pr_for_branch` — no PR exists for the current branch.
4. `missing_remote_commit` — a PR exists but the expected commit is absent from
   both its commit list and its head (typically an unpushed local commit).
5. `needs_human` — the PR was closed without merging.
6. `verified` — the PR is confirmed merged (checks are moot post-merge).
7. `checks_failed` / `checks_pending` — commit matched, checks block/are running.
8. `verified` — the expected commit is on the remote PR and checks are clear.

Commit comparison (`commitMatches`) tolerates short/long SHA forms: a 7+ char
prefix counts, so a run-recorded abbreviated SHA still matches `gh`'s full oids,
while sub-7-char inputs are rejected to avoid false matches.

`mergeConfirmed` is exposed independently (`prState === 'MERGED'`) so a
merge/close *claim* is re-checked against live GitHub state before any success is
reported.

## Persistence

Every run of the gate against an active run is appended to
`RunSnapshot.verifications` (`RunVerificationLogEntry`: timestamp, status,
expected commit + source, PR number/state, summary). This gives the run an
auditable history of *what was verified when*, so a later merge-ready decision
consumes recorded evidence rather than re-trusting a transient query. With no
active run, the gate still runs (branch + local HEAD) but records nothing.

## PR discovery (#38)

Before the gate can verify anything, the run needs to know *which* PR to verify.
While a run is `builder_running`, **PR discovery** binds the builder's PR from
read-only GitHub evidence instead of a blind operator click, mirroring this
module's pure/impure split:

- **Pure matching** — `src/main/discovery.ts`. `matchPrCandidates(prs, context)`
  classifies fetched PRs into candidates:
  - `issue_link` — the PR title or body references the run's issue via `#N`
    (covering `Closes #N` / `Fixes #N` / a bare `#N`). `referencesIssue` uses a
    trailing-digit negative lookahead so `#12` never matches `#123`.
  - `recent_unlinked` — a conservative fallback for a forgotten link: open PRs
    created at/after the handoff send time. Only produced when that time is known
    (the first builder prompt on the run); a PR already matched by link is never
    double-counted.
  `selectPrCandidate` then decides ambiguity: exactly one `issue_link` candidate
  is the unambiguous, confirmed-pending pick (even alongside recent-unlinked
  noise); anything else (zero, multiple links, or recent-unlinked-only) requires
  an explicit operator pick. Discovery never auto-selects a weak match.
- **Impure fetch** — `discoverRunPrCandidates` in `src/main/github.ts`. Issues a
  single read-only `gh pr list --state open --json number,title,body,url,headRefName,headRefOid,author,createdAt`,
  scoped to the operated project root, and folds every failure into a non-fatal
  `status`/`message` with empty candidates (the run stays in `builder_running`).
  Each candidate carries number, URL, head branch, head SHA, author, created-at,
  and match reason.

Confirming a candidate (`godmode:run:pr:confirm`) dispatches `open_pr` with
`branch`/`prNumber`/expected head commit pre-bound, then runs this gate
immediately and records it. The builder PTY exiting during `builder_running`
pushes a non-blocking hint plus one discovery pass (`godmode:run:pr:discovered`)
but never transitions the run. A periodic poll is intentionally out of scope for
v1 — discovery is on-demand plus the builder-exit pass only.

## UI

`VerificationPane` (run-state area) surfaces branch, expected commit + source,
PR number/state/URL, remote-head match status, check counts, the derived status
chip, and the message. Per the PR #12 direction, green is reserved for the
`verified` state; `missing_remote_commit` / `checks_failed` / `needs_human` read
as error, and `no_pr_for_branch` / `needs_refresh` / `checks_pending` as warn. A
`partial` result is flagged so a failed query never reads as a confident result.
