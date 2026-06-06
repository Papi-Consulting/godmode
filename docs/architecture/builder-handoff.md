# Builder Handoff

GodMode binds a selected GitHub issue (or an operator-entered manual task) into a
reviewed builder handoff prompt, lets the operator approve it, and writes the
approved prompt into the configured builder session (issue #8). This sits on top
of the run state machine (#7) and the agent adapter registry (#5): it does not
recreate those seams, it grounds them in real task data and adds the explicit
operator approve-send gate.

## Boundaries

| Concern | Owner |
| --- | --- |
| Selected issue detail (body/comments/URL/labels) | `getIssueDetail` in `src/main/github.ts` (`godmode:github:issue:get`) |
| Run source detail + prompt-sent audit log | `RunSourceDetail` / `RunPromptLogEntry` on `RunSnapshot` in `src/shared/types.ts` |
| Manual task run + prompt recording | `selectManualTaskRun` / `recordPromptSent` in `src/main/run.ts` |
| Handoff composition (pure) + current-run wrapper | `composeBuilderHandoff` / `getCurrentHandoff` in `src/main/handoff.ts` |
| Approve-send orchestration (validate → write PTY → log → advance) | `handleSendHandoff` in `src/main/index.ts` (`godmode:run:handoff:send`) |
| Operator review + manual approve gate, manual task input | `src/renderer/components/HandoffPane.tsx` |

The composition core (`composeBuilderHandoff`) is pure — config + run snapshot in,
`BuilderHandoff` out — and unit-tested directly (`test/handoff.test.js`). The
filesystem/PTY-touching parts (issue fetch, doc pointers, PTY write) live in the
main process around it.

## Composition — pointer-first, operated-project-scoped

GodMode is an **agent harness, not a prompt-injection layer**. The handoff
GodMode *sends* is therefore **pointer-first**: it directs a fresh builder to
read the canonical sources itself and gives a compact task capsule, rather than
pasting the full issue body/comments into the PTY. This is more token-efficient,
keeps GitHub/docs as the live source of truth, reduces stale context and
prompt-injection surface, and matches the `AGENTS.md` rule that fresh agents read
repo-local source of truth before implementing.

A handoff is the rendered `builder_start` template (from the registry, including
any project `commands:` override) bound to the run's `projectName` /
`issueNumber` / `issueTitle`, followed by a grounded block that:

- names the **operated project** and states the working dir is that project's
  root — explicitly *not* the GodMode app repo (see
  [`app-vs-operated-project.md`](./app-vs-operated-project.md)). Every source the
  builder reads is the operated project's own repo-local file/issue;
- tells the builder to start a **fresh** session and read `AGENTS.md`,
  `docs/spec.md`, the relevant `docs/architecture/` and `docs/conventions/`
  pointers, and — for a GitHub issue — `gh issue view <N> --comments`, before
  implementing;
- gives a compact **task capsule**: operated project name, issue
  number/title/URL/labels (the title is the goal summary; no body text is
  derived into the capsule), and the closing instruction to implement only that
  issue, then verify/commit/push/open a PR linked to it.

A **manual task** has no GitHub issue to point at, so its (bounded) text is kept
in the capsule — it is the only source of truth for that task — and it stays
blocked from direct send regardless (no issue number), so this only grounds the
operator preview and the `needs_spec` route.

### Sent prompt vs preview/audit

The two are deliberately split:

- **Sent prompt** (`BuilderHandoff.prompt`, written to the PTY): pointers +
  capsule only — never the full issue body/comments.
- **Preview/audit** (the UI): GodMode still fetches full issue detail
  (`getIssueDetail` → `RunSourceDetail` on the run) and the cockpit shows it in a
  collapsible "full issue context · fetched for audit, not sent" section, so the
  operator can read everything without that text being injected into the builder.

Full-context injection into the sent prompt is left as a deliberate **future**
option (one-shot mode, agents without GitHub/repo access, or operator-selected
"include full context"); it is not the default.

## Sendability and the manual gate

`canSend` is true only when a real source is bound (`!isMock`) **and** the
template left no unresolved variables. This is what enforces the safety rules:

- A **GitHub issue** binds `issueNumber`/`issueTitle`/`projectName`, so the
  template resolves fully and the handoff is sendable — with no unresolved
  `{{issueNumber}}`/`{{issueTitle}}` tokens.
- A **manual task** has no issue number, so `{{issueNumber}}` stays unresolved
  and send is blocked. The operator routes a vague task to `needs_spec` through
  the existing state machine instead of sending it blindly. (Automatic spec
  generation is out of scope.)
- With **no run bound**, the handoff is a clearly-labeled mock/demo preview with
  issue tokens left visible, and cannot be sent.

Producing or viewing a handoff never sends anything. Sending requires an explicit
operator click on "Approve & send to builder" in the cockpit.

## Send orchestration

`handleSendHandoff` is atomic in spirit — nothing is written unless every gate
passes:

1. require a current run, then recompute the handoff and require `canSend`;
2. require a status from which the builder can start (`issue_selected`,
   `needs_spec`, or `ready_to_build`);
3. require a **live builder PTY session** (`hasPtySession('builder')`) — the
   operator starts the builder pane first; there is no silent auto-spawn;
4. write the approved prompt into the builder session (trailing `\r` submits it);
5. record a prompt-sent entry (`role`, `sourceType`/`sourceId`, single-line
   `digest`, `promptChars`, timestamp) on the run for audit;
6. advance the run to `builder_running` via the deterministic guard
   (`mark_ready` if needed, then `start_builder`), each step logged.

Reaching `builder_running` records that the prompt was **sent** — never that the
task succeeded. Completion evidence still comes from GitHub state, per
`AGENTS.md`.
