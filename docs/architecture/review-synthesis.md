# Review Synthesis, Merge Gate, and the First Fix Cycle

Issue #11 turns reviewer output into structured harness state: it parses each
reviewer session's captured output into normalized findings, computes a
merge-readiness gate from those findings **and** the verified #9 commit evidence,
and drives the first verified blocker-fix cycle through the existing run state
machine. It builds on the run state machine (#7), the builder handoff (#8), the
commit-verification evidence layer (#9), and reviewer launch/capture (#10).

GodMode is an agent harness, not a self-report trust layer. Parsed reviewer
findings are **advisory**: they surface blockers and drive the fix loop, but the
merge gate still requires the verified #9 evidence — a reviewer's own marker or
PASS line is never enough to reach `merge_ready`.

## Boundaries

| Concern | Owner |
| --- | --- |
| Finding/result/merge-gate/findings types | `src/shared/types.ts` (`ReviewerFinding`, `ReviewerResult`, `MergeReadiness`, `RunFindings`, `ReviewSynthesisResult`, `ReviewerFallbackVerdict`, `FallbackVerdictOutcome`, `ReviewerEvidenceSource`) |
| Pure parsing + merge gate + blocker text + current-head evidence | `src/main/findings.ts` (`parseReviewerOutput`, `computeMergeReadiness`, `acceptedBlockers`, `renderBlockersText`, `reviewerHeadEvidence`, `currentHeadResults`) |
| Pure fallback verdict parsing + evidence reconciliation (issue #60) | `src/main/findings.ts` (`parseReviewerVerdictComments`, `reconcileReviewerEvidence`) |
| Reviewer fallback-verdict prompt grammar (issue #60) | `src/main/reviewer.ts` (`reviewerVerdictExampleLine`, `REVIEWER_VERDICT_MARKER`) |
| Read-only PR comment fetch (issue #60) | `src/main/github.ts` (`getPrComments`) |
| Pointer-first fix handoff | `composeFixHandoff` in `src/main/handoff.ts` |
| Findings persistence + reviewer-artifact read | `src/main/artifacts.ts` (`writeRunFindings`, `readReviewerArtifact`) |
| Findings on the run snapshot | `setRunFindings` / `setCurrentRunFindings` in `src/main/run.ts` |
| Synthesis + fix orchestration (impure: `gh`/PTY/fs) | `handleSynthesizeReviews` / `handleSendFix` in `src/main/index.ts` |
| Dashboard surfacing | `src/renderer/components/ReviewSynthesisPane.tsx` |

The pure core (`findings.ts`, `composeFixHandoff`) is Electron/`gh`/filesystem-free
and unit-tested directly (`test/findings.test.js`). The IO half reads captured
artifacts, re-runs #9, persists findings, and dispatches transitions.

## Parsing reviewer output

`parseReviewerOutput` consumes one reviewer session's captured log (the local
attempt-specific
`.godmode/runs/<run-id>/reviewers/<reviewer-id>-<attempt-id>.log` artifact — issue
#59, read by the session's recorded `artifactPath`) and produces a `ReviewerResult`
with status `pass` / `fail` / `ambiguous`. It recognizes the shapes the reviewer
role docs and the product spec define:

- the completion marker `DONE: ROLE=reviewer STATUS=pass|fail BLOCKING=<count>`,
- a reviewer `PASS` line (e.g. `Reviewer A: PASS — …`),
- `BLOCKING A-1` / `BLOCKING B-1` blocks with `File:` (with optional `:line`),
  `Issue:`, `Why it blocks:`, and `Suggested fix:`.

Markers help parsing but are not proof, so the parser cross-checks them against
the parsed blocks. Anything missing, malformed, contradictory, or internally
inconsistent is `ambiguous` — never a silent pass:

- empty/unparseable output;
- a `pass` marker with a non-zero count or a parsed `BLOCKING` block;
- a `fail` marker with zero parseable blocks;
- a `PASS` line and a `BLOCKING` block together;
- conflicting `DONE` markers.

Cleanly-parsed blocking findings on a `fail` are marked `accepted` (this first
slice accepts clear blockers by default); on an `ambiguous` result they are
marked `needs_human`, so ambiguous output never feeds accepted blockers into a
fix cycle.

## Current-head evidence gating (issue #59)

Synthesis consumes **only** reviewer evidence for the PR head it is actually
deciding about. After re-running the #9 gate it reads the live PR head SHA
(`verification.pr.headSha`) and builds per-reviewer head evidence with the pure
`reviewerHeadEvidence(session, currentHeadSha)`: a reviewer attempt is usable only
when its `targetHeadSha` equals the current head **and** it reached a completed/
parseable state (`completed` / `comment_posted`). `currentHeadResults` drops every
other attempt, so a reviewer whose latest attempt reviewed a *previous* head — a
re-review never ran after a fix push — or has not finished is treated as having no
usable result. Both the merge gate and the accepted-blocker set are computed over
the current-head subset, so a stale attempt's clear *or* its blockers never feed
the decision for the new head. The synthesis records `prHeadSha`/`prHeadShaShort`
and the `reviewerHeads` evidence on `RunFindings` for audit and the UI, which
labels any stale attempt and shows the head being evaluated.

## Role-signed fallback verdict comments (issue #60)

Formal GitHub reviews are the primary reviewer signal, but GitHub refuses
**same-author approval** — and dogfooding routinely runs several logically-distinct
GodMode roles through one local GitHub account that also owns the PR branch. In
that case a reviewer cannot submit a formal approving review, so the harness
recognizes a documented, role-signed **fallback verdict comment** instead. It is
deliberately distinct from GodMode's automatic marker comment
(`reviewerCommentBody`), which never asserts a verdict.

The verdict line (one line, anywhere in a PR comment body):

```text
GODMODE_REVIEW_VERDICT reviewer=<id> pane=<reviewer_a|reviewer_b> pr=<n> head=<7-or-40-char-sha> status=<approved|blocked> blocking=<count>
```

A `blocked` verdict carries the same `BLOCKING A-1:` blocks the captured-output
parser understands, so its blockers normalize into the existing accepted-blocker
fix cycle. The reviewer prompts and role docs instruct reviewers to try a formal
review first and only fall back to this comment when GitHub refuses same-account
approval; `src/main/reviewer.ts` builds the example line from
`reviewerVerdictExampleLine` so prompt and parser share one grammar.

`parseReviewerVerdictComments` (pure) turns a PR's comments into per-pane outcomes,
accepting only verdicts for **configured reviewers**, the **bound PR**, and the
**current head**. Its safety rules, in order, for each comment carrying the
`GODMODE_REVIEW_VERDICT` token:

- not attributable to a configured `pane=`/`reviewer=` → **ignored** (unknown/
  unrelated); an inconsistent pane/reviewer pair is unknown too;
- a `pr=` naming a different PR → **ignored** (wrong-PR);
- a `head=` that is a real SHA not matching the current head → **ignored**
  (stale-head);
- otherwise attributed to the pane and validated. A current-head verdict that is
  malformed (missing/non-numeric fields, unknown status, `approved` with
  `blocking>0`, or `blocked` with no `BLOCKING` blocks) → **ambiguous**, never a
  silent pass;
- two or more current-head verdicts for a pane that disagree on status/count →
  **ambiguous** (duplicate-conflicting); agreeing duplicates collapse to one.

When there is no verified PR head, no fallback evidence is produced at all — a
verdict can only ever be tied to a current head.

`reconcileReviewerEvidence` (pure) then merges each reviewer's captured-output
artifact with its fallback outcome into one effective evidence record (result +
head evidence + `ReviewerEvidenceSource`):

- a fallback **ambiguous** outcome routes the reviewer to needs-human even if its
  artifact looks clean — a current-head verdict must never pass silently;
- a valid fallback **verdict** with a *conclusive* current-head artifact that
  **conflicts** → **ambiguous** (never the more favorable result); when they
  **agree** the gate consumes the agreement (`source: reconciled`);
- a valid fallback **verdict** with no usable current-head artifact (the
  same-account case) → the gate consumes the verdict (`source: fallback_comment`)
  with current/completed head evidence;
- no fallback verdict → the artifact result and session head are used unchanged
  (`source: artifact`), preserving pre-#60 behavior.

Synthesis feeds the reconciled results + head evidence into the same merge gate, so
a fallback verdict can clear a reviewer gate **only when the PR head is current AND
the #9 commit-verification gate is verified**. The `source` is recorded on each
`ReviewerHeadEvidence` and surfaced in the dashboard (a "role-signed comment" /
"artifact + comment" chip plus an explanatory note) so an operator never mistakes a
role-signed harness verdict for a GitHub-native approval.

## The merge gate

`computeMergeReadiness` is `merge_ready` only when **all** hold:

1. Reviewer A passed (or has zero accepted blocking findings) and is not ambiguous,
2. Reviewer B likewise,
3. the latest #9 commit verification is `verified`,
4. no accepted blockers remain,
5. every reviewer has a completed attempt for the **current** PR head (issue #59) —
   a stale or unfinished attempt holds the gate (`hold`, "relaunch reviewers")
   with an ordered reason naming the reviewer and the head it last reviewed, so an
   old review can never read as current approval. When no head evidence is supplied
   (pre-#59 callers/tests) the gate keeps its prior behavior.

It returns an ordered `reasons[]` explaining any unmet condition and a
`recommendation`:

- `needs_human` — any ambiguous/contradictory reviewer output;
- `request_fix` — accepted blockers remain **and** the #9 commit verification is
  `verified`. A fix cycle only ever targets verified PR coordinates;
- `merge_ready` — every gate satisfied;
- `hold` — a non-reviewer gate is unmet and nothing can auto-fire: either no
  blockers and no ambiguity but the PR is unverified, **or** accepted blockers
  remain while the PR is unverified (`no_pr_for_branch` / `needs_refresh` /
  `checks_failed` / no verification). In the blockers case the gate holds rather
  than requesting a fix against a stale target; once the operator re-verifies it
  recomputes to `request_fix`. Nothing auto-fires.

## Driving the state machine

`handleSynthesizeReviews` runs from `reviewers_running` / `reviewers_rerunning`:

1. re-run the #9 gate live and record it (with the same stale-context guard the
   reviewer launch/comment paths use). Because that re-verification is an `await`,
   synthesis also fingerprints the run's reviewer attempts (`reviewerAttemptFingerprint`,
   the set of `<paneId>:<attemptId>`) *before* the await and re-checks it after
   (`reviewerAttemptsReplaced`): a concurrent operator reviewer relaunch can replace
   `run.reviewers` while keeping the run in `reviewers_running` (an idempotent
   relaunch), which neither the status guard nor the loop-generation guard would
   catch. If the attempts changed, synthesis aborts as `preempted` rather than
   building findings from — or transitioning over — the freshly relaunched reviewers
   while they are still running (issue #59, blocker A-2);
2. parse each tracked reviewer's captured output AND fetch the bound PR's comments
   (`getPrComments`, read-only, in the same await window the stale/preemption
   guards protect), parse role-signed fallback verdicts
   (`parseReviewerVerdictComments`), and reconcile artifact-vs-verdict evidence per
   reviewer (`reconcileReviewerEvidence`) — issue #60;
3. compute the merge gate from the reconciled results + head evidence;
4. persist `RunFindings` on the run and to `.godmode/runs/<run-id>/findings.json`;
5. advance `synthesize_reviews → review_synthesis`, then route by recommendation:
   - `merge_ready` → `mark_merge_ready`,
   - `request_fix` → `request_fix` (→ `builder_fixing`) when the cycle budget has
     room, else `exceed_max_cycles` (→ `max_cycles_exceeded`),
   - `needs_human` → `flag_needs_human`,
   - `hold` → stay in `review_synthesis`.

Max-cycle handling stays authoritative in the state machine: `request_fix`
increments `cycle` and the guard refuses it once `cycle >= maxCycles`, so the
loop deterministically stops at the budget.

The `mark_merge_ready` transition this step dispatches is itself evidence-gated in
the state machine (issue #62): `canMarkMergeReady(run)` permits it only when the
run's recorded `findings.merge.mergeReady` is true for the current head and the
latest #9 verification is current-head `verified`. The automatic path above
satisfies this by construction — it records the verification and persists the
positive findings *before* dispatching `mark_merge_ready` — but the same gate also
blocks any out-of-band operator/IPC attempt to force `merge_ready` from
`review_synthesis`/`needs_human`/`max_cycles_exceeded` on ambiguous, missing, or
stale evidence. There is no evidence-free manual merge override in v1. See
`docs/architecture/run-state-machine.md` (“Merge-ready evidence gate”).

## The fix cycle

On `request_fix`, `composeFixHandoff` renders the `builder_fix` template with the
verified PR coordinates and the normalized accepted-blocker text, so `{{blockers}}`
is never left unresolved. Like every GodMode handoff it is **pointer-first**: the
blockers travel as a compact capsule, but the builder is pointed back to the live
PR diff/threads/reviews and the operated project's canonical docs — not a pasted
reviewer transcript. The rendered handoff is returned for operator review and sent
into the builder session via `handleSendFix`. It does **no** live `gh` round trip
— the synthesis that opened this cycle already ran the #9 gate, and the pushed
commit is re-verified later before reviewers re-review. Instead it re-checks the
recorded findings as a defense-in-depth gate: it refuses to send unless the stored
merge gate is `prVerified` and a PR URL is bound, then recomposes the fix prompt
from those verified coordinates. Sending records that the fix prompt was
*delivered*, never that the fix succeeded.

After the builder pushes, the operator dispatches `push_fix` (recording the new
expected commit), then reruns reviewers. The rerun path (`handleStartReviewers`
from `fix_pushed`) re-runs the #9 gate and refuses to launch unless the pushed
commit is `verified` on the PR branch — so reviewers only re-review a verified
fix. This is the "verify the pushed commit before rerunning reviewers" guarantee.

## Out of scope (v1)

Multi-cycle polish beyond the first re-review loop, a rich blocker dismissal
UI/audit trail, inline review comments, and auto-merge. Karan/manual GitHub merge
remains the only merge path — `merge_ready` is a gate, not a merge.
