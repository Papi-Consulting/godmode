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

`handleStartReviewers` accepts only a run at `pr_opened` (or `reviewers_running`
for an idempotent relaunch). Before launching anything it **re-runs
`getCommitVerification` live** and records the result on the run, then refuses to
launch unless the status is `verified` with a matched PR. Plain PR existence, a
PR URL, or an agent self-report is never sufficient — the launch path consumes
the same evidence layer the merge-ready decision does. The verification is
returned with the result so a `not_verified` rejection explains itself with the
live message.

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
launch argument (`openPtySession`'s `extraArgs`, one argv element, no shell) and
is present when the process starts; an interactive agent stays live, so the prompt
is written into the PTY after spawn (`writeToPtySession`). Writing into a PTY whose
one-shot process had already exited would silently no-op and drop the prompt — the
argv path avoids that race.

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
still visible. Advancing `pr_opened → reviewers_running` also records the PR
number/branch on the run so the later comment post has its coordinates.

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
retrying a failed post.

A successful post mutates the PR, so the operated project's GitHub snapshot is now
stale. The main process emits `godmode:github:changed`, and the GitHub pane
refetches in place (same project, newer data) so the new comment/status shows
without a manual refresh.

## Errors and async updates

Every failure mode — launch failure, output-capture failure, a `gh` post failure,
or a missing PR number — is recorded on the reviewer as `failed` with a visible
reason and **never** collapsed into `completed`. A reviewer already marked `failed`
mid-session (a capture failure) keeps that status on exit — the exit handler
records the exit code but does not flip it to `completed` or post a marker that
references an artifact it failed to write. So the dashboard never shows a
silently-finished review. Because
the session-exit and comment-post updates happen asynchronously after the IPC call
returns, the main process pushes the latest snapshot over `godmode:run:changed`
(mirroring `projectChanged`); the renderer treats it as authoritative and the
GitHub pane refreshes its snapshot on the same signal.

## Tests

`test/reviewer.test.js` covers `composeReviewerLaunch` (pointer-first prompt bound
to PR/reviewer/role-doc with no pasted diff, `missingVariables`, the verified gate)
and `reviewerCommentBody` (role-signed, artifact-referencing, no merge-readiness
claim). `test/artifacts.test.js` covers the artifact path/dir/append helpers over a
temp dir, the captured-write success/failure return, and the reviewer-id
path-confinement guard. `test/run.test.js` covers the reviewer-session reducers
(immutability + lifecycle transitions). All are pure — no Electron, no real spawn,
no `gh`. Run with `npm test`.
