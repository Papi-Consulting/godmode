# Reviewer Launch and PR Comments

GodMode launches Reviewer A and B from a **verified** PR, captures each one's
output to a local run artifact, and posts a concise role-signed marker comment
per reviewer (issue #10). This is the step after the run state machine (#7),
builder handoff (#8), and commit verification (#9): the run reaches `pr_opened`,
the #9 gate proves the builder's commit is really on the PR, and this wiring then
runs the reviewers against it. Core code stays role/adapter-driven — it never
branches on a specific vendor beyond display labels.

## Boundaries

| Concern | Owner |
| --- | --- |
| Compose pointer-first reviewer prompts + the marker comment body | `composeReviewerLaunch` / `reviewerCommentBody` in `src/main/reviewer.ts` |
| Track per-reviewer session lifecycle on the run | `setReviewerSessions` / `updateReviewerSession` in `src/main/run.ts` |
| Resolve a reviewer pane → its launchable command (cli-only gate) | `resolveRoleLaunch` in `src/main/agents.ts` |
| Spawn/track the reviewer PTY in the operated-project root | `openPtySession` in `src/main/pty.ts` |
| Capture session output to a local artifact | `src/main/artifacts.ts` |
| Post the marker comment (the one mutating `gh` call) | `postPrComment` in `src/main/github.ts` |
| Orchestrate verify → launch → capture → comment + push `runChanged` | `godmode:run:reviewers:start` / `:comment` in `src/main/index.ts` |
| Operator launch/lifecycle UI + override button | `src/renderer/components/ReviewLaunchPane.tsx` |

## The #9 verified-PR gate

`handleStartReviewers` accepts a run at one of the reviewer-launch statuses (see
the lifecycle section). Before launching anything it **re-runs
`getCommitVerification` live** and records the result on the run, then refuses to
launch unless the status is `verified` with a matched PR. Plain PR existence, a
PR URL, or an agent self-report is never sufficient — the launch path consumes
the same evidence layer the merge-ready decision does. The verification is
returned with the result so a `not_verified` rejection explains itself with the
live message.

Because that verification is `await`ed, the operator could switch the operated
project (or clear the run) mid-call — `selectProjectAndResetSessions` clears the
run and kills sessions. So after the await, before any side effect, the handler
**re-confirms the same run id and selected root** captured at the start; if either
changed it aborts without spawning a PTY or writing an artifact, honoring the
AGENTS.md rule that agent commands only ever run in the currently selected
operated-project root. The same guard wraps the comment-post path (`gh pr comment`
is also awaited): the pure `isReviewerRunContextStale(current, captured)` predicate
is shared by both so neither mutates — nor pushes a snapshot for — whatever run is
current after the await if it has drifted.

The run/root guard alone does not catch a relaunch **within the same run and
root**: reviewers relaunch idempotently (`reviewers_running` /
`reviewers_rerunning`), replacing the tracked sessions under the same pane ids. So
each launch stamps every session with a fresh per-launch `sessionToken`, and any
deferred work bound to one launch re-confirms it with
`isReviewerSessionStale(currentToken, capturedToken)` before it patches reviewer
state:

- **Marker posts** capture the token before the `gh pr comment` await and re-check
  it after, so an in-flight post from an earlier launch cannot stamp a freshly
  relaunched session `comment_posted`/`commentError` with the previous comment.
- **PTY lifecycle callbacks** (`onData` capture-failure, `onExit`) close over
  their launch's token. A prior launch's PTY is killed only when its pane's
  `openPtySession` runs, so on a relaunch an old PTY can still exit or emit during
  the spawn window; carrying the token lets `handleReviewerExit` and the
  capture-failure path refuse a stale callback rather than `complete`/post — or
  fail — the just-installed session.

## Pointer-first prompts

`composeReviewerLaunch` renders the configured `reviewer_start` template per
reviewer (config override → built-in default) bound to the verified PR
number/URL/branch, the reviewer id, and its role doc, then appends a grounding
block that directs a FRESH reviewer to read the **operated project's** sources and
the live PR itself:

- `AGENTS.md` and the reviewer's role doc,
- `gh pr view <N> --json …` / `gh pr diff <N>` for the threads/checks and the code
  under review — the diff is **not** pasted into the prompt,
- the linked issue (`gh issue view <N> --comments`) for acceptance criteria.

A reviewer whose template leaves any variable unbound (e.g. no `role_doc`
configured) is reported in `missingVariables` and blocks the plan rather than
launching with an unresolved token. Everything is scoped to the operated project
(the repo opened in GodMode), never the GodMode app repo.

## Launch, capture, lifecycle

Each configured reviewer is launched independently in its existing pane
(`reviewer_a` / `reviewer_b`). `resolveRoleLaunch` provides the command and
enforces the same cli-adapter gate as a manual pane launch — a non-cli adapter
fails *visibly* on that reviewer rather than silently. `openPtySession` runs the
command with the operated-project root as cwd and the sanitized env.

**Prompt delivery is mode-aware** so a one-shot reviewer never loses its prompt: a
`oneshot` agent reads its prompt and exits, so the prompt is passed as a final
launch argument (`openPtySession`'s `extraArgs`, one argv element, no shell, derived
by the pure `reviewerLaunchArgs(mode, prompt)` helper) and is present when the
process starts; an interactive agent stays live, so the prompt is written into the
PTY after spawn (`writeToPtySession`). Writing into a PTY whose one-shot process had
already exited would silently no-op and drop the prompt — the argv path avoids that
race.

**The generic pane Start/Restart control never launches a one-shot reviewer
(issue #58).** The run-bound path above is the *only* path that has a review prompt
to deliver at process start; the generic `godmode:pty:start` (`handleStartPty`) has
none. Starting a one-shot reviewer there would spawn its command with no prompt — for
the default `codex exec` reviewer, an empty invocation that exits immediately with a
no-prompt error — making the pane look actionable while producing no review. So
`handleStartPty` consults the pure `classifyGenericPaneLaunch(paneId, mode)` helper
and, for a one-shot reviewer pane, refuses **before spawn** with an actionable
message (`ONESHOT_REVIEWER_GENERIC_START_MESSAGE`) telling the operator to launch
reviewers from a verified PR via the run-bound "Start reviewers" action. The refusal
returns the standard `{ ok: false, error }` so the reviewer pane surfaces it inline
(its `[launch error: …]` line), not as a generic app failure. The gate keys off
role + mode only (no vendor branch): an **interactive** reviewer — and every
non-reviewer pane — keeps its generic interactive-shell launch, preserving
intentional interactive reviewer support.

The one-shot command itself must be the agent's **non-interactive** invocation, or
it never exits and the reviewer sits in `running` forever. The default Codex
reviewer therefore ships `command: codex exec` (the non-interactive path that runs
a prompt to completion), not plain `codex` (which opens the interactive CLI). This
stays in config (default + per-project), not core code, so the harness never
hardcodes a vendor's exec syntax.

The session's `onData` both streams to the renderer (`godmode:pty:data`, so the
reviewer pane shows it) and appends to `.godmode/runs/<run-id>/<reviewer-id>.log`.
Capture never throws into the data callback, but a capture *failure* is **not**
swallowed: `appendArtifact` returns whether the write succeeded, and the first
failed write flips the reviewer to `failed` with a visible reason. The reviewer-id
segment is sanitized to a single safe path component (config only guarantees a
slug — see the schema regex — but the path layer confines it regardless), so a bad
id can never escape the run dir. `.godmode/runs/` is gitignored.

Each reviewer is tracked on `RunSnapshot.reviewers` with an independent status:
`launching → running → completed → comment_posted`, or `failed`. The state is set
to `launching` for every reviewer before any spawn, so a launch that fails is
still visible.

Reviewers launch at **two** points in the run lifecycle, resolved by the pure
`reviewerLaunchTransition(status)`: the first PR (`pr_opened → start_reviewers →
reviewers_running`) and after a builder fix (`fix_pushed → rerun_reviewers →
reviewers_rerunning`), plus an idempotent relaunch while reviewers are already
running in either cycle. Without the fix-cycle path the operator could not
re-review a fix commit and the run could reach synthesis with stale reviewer
evidence. The matching forward action is dispatched once at least one reviewer
launches, recording the PR number/branch so the later comment post has its
coordinates; a relaunch has no transition and keeps those coordinates.

When a reviewer session **exits**, `resolveReviewerExit(status, exitCode)` decides
its fate: a clean (zero) exit marks it `completed` and auto-posts the marker; a
**non-zero** exit marks it `failed` with a visible reason and posts **nothing** (a
failed one-shot command must never become the green `comment_posted` state); a
session already `failed` mid-run (a capture failure) stays failed, recording only
the exit code.

## Marker comment (auto + override)

On a reviewer's session exit, `handleReviewerExit` marks it `completed` and
auto-posts via `postReviewerCommentAndRecord`. The body (`reviewerCommentBody`) is
a **factual marker**, not a verdict: it records the reviewer id/role, PR/branch,
role doc, and the captured-artifact path, and explicitly disclaims that it asserts
merge-readiness. The reviewer's actual findings are the reviewer's own PR comments
— GodMode never pastes captured agent output here. `postPrComment` is the only
mutating `gh` call in the codebase; `execFile` passes the body as a single argv
element (no shell), so there is no quoting/injection surface.

`godmode:run:reviewers:comment` is the operator override: it re-posts the marker
for a named reviewer pane, covering interactive reviewers that never exit and
retrying a failed post. The override is gated by `canPostReviewerMarker(status)`:
only a session that actually ran (`completed` / `comment_posted` / `running`) is
postable, so a `failed` (launch/capture/non-zero-exit) or still-`launching`
reviewer can **never** be turned into the green `comment_posted` state from the UI
or IPC. A *comment-post* failure is recorded on a separate `commentError` field
(not the session `error`/status), so it stays retryable without masking — or being
masked by — the session's own outcome.

A successful post mutates the PR, so the operated project's GitHub snapshot is now
stale. The main process emits `godmode:github:changed`, and the GitHub pane
refetches in place (same project, newer data) so the new comment/status shows
without a manual refresh.

## Errors and async updates

Every failure mode — launch failure, a **non-zero session exit**, an output-capture
failure, a `gh` post failure, or a missing PR number — is recorded on the reviewer
as `failed` with a visible reason and **never** collapsed into `completed`. A
reviewer already marked `failed` mid-session (a capture failure) keeps that status
on exit — the exit handler records the exit code but does not flip it to
`completed` or post a marker that references an artifact it failed to write. So the
dashboard never shows a silently-finished review. Because
the session-exit and comment-post updates happen asynchronously after the IPC call
returns, the main process pushes the latest snapshot over `godmode:run:changed`
(mirroring `projectChanged`); the renderer treats it as authoritative and the
GitHub pane refreshes its snapshot on the same signal.

## Tests

`test/reviewer.test.js` covers `composeReviewerLaunch` (pointer-first prompt bound
to PR/reviewer/role-doc with no pasted diff, `missingVariables`, the verified gate),
`reviewerCommentBody` (role-signed, artifact-referencing, no merge-readiness claim),
`reviewerLaunchTransition` (initial + fix-cycle launch/relaunch, disallowed
statuses), `resolveReviewerExit` (non-zero exit → failed/no-post, clean exit →
completed, already-failed kept), `canPostReviewerMarker` (only a ran session is
postable; failed/launching are not), `isReviewerRunContextStale` (run cleared,
different run, or changed root across an await → stale), and
`isReviewerSessionStale` (a same-run relaunch's fresh `sessionToken` across an
await → stale). `test/artifacts.test.js`
covers the artifact
path/dir/append helpers over a
temp dir, the captured-write success/failure return, and the reviewer-id
path-confinement guard. `test/run.test.js` covers the reviewer-session reducers
(immutability + lifecycle transitions). All are pure — no Electron, no real spawn,
no `gh`. Run with `npm test`.
