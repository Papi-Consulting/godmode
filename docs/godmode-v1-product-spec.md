# GodMode — V1 Product Spec

Status: Draft v1 product specification  
Owner: Karan  
Primary operator persona: Hermes as head/operator  
Default local workflow: Hermes + Claude Code builder + two Codex reviewers  
Architecture principle: Bring Your Own Agent / agent-agnostic

---

## 1. Product Thesis

GodMode is a local-first, dashboard-first, tmux-style multi-agent coding command center.

It lets a human operator open a project harness, command an agent team, watch and chat with each agent live, and run a disciplined issue-to-PR-to-review loop without losing final authority over merge decisions.

For Karan's default use case:

- Hermes acts as the head/operator and thought partner.
- Claude Code acts as the lead builder/dev.
- Codex Reviewer A performs correctness, tests, security, and regression review.
- Codex Reviewer B performs architecture, maintainability, spec-drift, and harness-compliance review.
- Karan stays in the loop, can interact with every agent, and approves/delegates/merges himself.

GodMode should feel closer to a terminal multiplexer plus mission-control dashboard than a SaaS kanban board.

---

## 2. North Star

> Open a repo/project harness, pick or spec work, tell an agent team to execute, watch each agent pane like tmux, chat with any agent mid-run, and let the PR quality loop continue automatically until the work is merge-ready — while the human remains the final gate.

GodMode is not primarily an autonomous overnight shipper. It is a human-in-the-loop agent workbench that makes multi-agent coding workflows visible, interactive, and governable.

---

## 3. Core Goals

### 3.1 Dashboard-first v1

V1 must be useful and visually recognizable as a tmux-like agent workspace.

The dashboard is not an afterthought. It is the product surface.

The operator should be able to:

- open GodMode on a project/harness,
- see Hermes, Claude, Codex A, and Codex B as live panes,
- chat with each agent,
- see terminal output and agent state,
- pick issues or PRs,
- launch work,
- watch automatic review/fix loops,
- see merge readiness,
- manually approve/delegate/merge.

### 3.2 Source of truth lives in the project harness and trackers

GodMode should not rely on huge one-off prompts from Hermes.

The durable source of truth is:

- the opened project/repo,
- `AGENTS.md`,
- `docs/spec.md`,
- project docs and conventions,
- GitHub Issues,
- GitHub PRs,
- PR comments/reviews,
- optional Linear issues,
- run logs/artifacts.

Hermes should be able to issue lightweight commands such as:

- “Work on issue #12. Read the harness.”
- “Review PR #37 using your reviewer role.”
- “Re-review after Claude's latest commit.”
- “Fix the accepted blockers and comment on the PR.”

The harness carries the details. Hermes operates the system.

### 3.3 Bring Your Own Agent native

GodMode must be agent-agnostic from the start.

Karan's default role map is:

- Head: Hermes
- Builder: Claude Code
- Reviewer A: Codex
- Reviewer B: Codex

But the product must support alternate mappings:

- OpenClaw as head instead of Hermes,
- Claude as head instead of Hermes,
- Codex as builder and Claude as reviewer,
- Gemini/OpenCode/OpenClaw/custom CLI agents as any role,
- one reviewer, two reviewers, or more reviewers later,
- human-only/manual role for any slot.

GodMode should define roles and capabilities, not hardcode specific model vendors.

### 3.4 Automatic PR review/fix loop

After the builder completes a build and opens a PR, reviewers should automatically begin.

The loop should continue until merge-ready or stopped:

1. Builder works on issue.
2. Builder opens PR.
3. Reviewer A and Reviewer B automatically review.
4. If blockers exist, builder automatically picks them up.
5. Builder fixes blockers, pushes commits, and comments on the PR.
6. Reviewers automatically re-review.
7. Repeat until:
   - merge-ready,
   - max review/fix cycles exceeded,
   - agent failure,
   - conflict/ambiguity requires human input,
   - Karan pauses/cancels.

Automation owns the quality loop. Karan owns final merge authority.

### 3.5 Self-dogfooding

Once a working prototype exists, GodMode should be used to build GodMode.

Therefore the GodMode repo harness must be optimized from the beginning for agents to read and act correctly with minimal Hermes micromanagement.

GodMode must keep two repository contexts distinct at all times:

- **GodMode app repo** — the repo that ships the Electron app, its docs, and config defaults.
- **Operated project** — the external repo opened inside GodMode and worked on by agents.

Harness detection, PTY working directories, and GitHub issue/PR lookups always scope to the **operated project root**, never implicitly to the GodMode app repo. Self-dogfooding is the special case where both point at the same directory; the contexts coincide on disk but the conceptual boundary must not collapse. The app surfaces a "dogfooding" badge for this case, but no harness/PTY/GitHub behavior branches on it. See `docs/architecture/app-vs-operated-project.md`.

---

## 4. V1 Technical Direction

GodMode v1 starts as a local macOS desktop app with a bare-bones tmux-style interface. It does not need to be fancy; it needs to reliably run and display multiple interactive agent sessions.

Recommended v1 stack:

- **Desktop shell:** Electron macOS app.
- **Language:** TypeScript end-to-end.
- **Renderer:** React + Vite.
- **Terminal panes:** xterm.js with fit addon.
- **Process/PTY layer:** Node.js main process + `node-pty` for interactive CLI agents.
- **Persistence:** SQLite via `better-sqlite3` for projects, runs, sessions, findings, and events.
- **Git/GitHub:** `git` and `gh` CLI first; REST/GraphQL only when CLI is insufficient.
- **Config:** project-local `.agentic/godmode.yaml` plus optional global app config under macOS Application Support.
- **Agent integration:** role-based CLI adapters first; Hermes/Claude/Codex are defaults, not hardcoded assumptions.
- **Packaging:** Electron Builder later, once the core run loop works.

Why Electron for v1:

1. GodMode needs live PTYs, local process management, filesystem access, keyboard-friendly panes, and a packageable Mac app.
2. Electron + Node keeps the CLI orchestration path straightforward because Hermes, Claude Code, Codex, `git`, and `gh` are already command-line tools.
3. Tauri or Swift may be attractive later, but both add early friction around PTY/process orchestration and terminal UI iteration.
4. A terminal-only TUI could be useful as a spike, but the product goal is dashboard-first, QuadWork/tmux-like, and app-native enough to grow.

V1 implementation should stay boring and practical: make the panes work, make agents run, make PR state visible, persist logs, and dogfood early.

---

## 5. Non-goals for V1

V1 should not attempt to be everything.

Out of scope for V1:

- unattended auto-merge to main,
- production deployment automation,
- client-facing message sending,
- replacing GitHub or Linear as source of truth,
- complex visual workflow builder,
- general-purpose agent marketplace,
- remote multi-tenant SaaS,
- deeply polished kanban/project management UI,
- perfect support for every agent CLI on day one,
- autonomous “agents pick next work forever” mode.

GodMode v1 should be narrow, local, visible, and reliable.

---

## 5. Primary Personas

### 5.1 Karan — human operator / final gate

Karan wants to stay in the loop and drive the system visually.

He wants to say things like:

- “Hermes, pick up issue 12.”
- “Spec out an issue for this feature.”
- “Open a PR for these local changes.”
- “Claude, explain your approach before coding.”
- “Codex A, focus on security.”
- “Codex B, re-review the latest commit.”
- “Hermes, is this safe to merge?”

Karan approves, delegates, pauses, overrides, or merges.

### 5.2 Hermes — default head/operator for Karan

Hermes is the default head in Karan's configuration.

Responsibilities:

- orient on project harness,
- help Karan spec work,
- start agent runs,
- monitor workflow state,
- summarize agent output,
- classify/normalize review blockers,
- enforce safety gates,
- detect when human input is required,
- keep dashboard state honest,
- verify push/PR/merge state when asked or after relevant events.

Hermes should not become a hidden source of project truth. The harness and tracker artifacts should carry that load.

### 5.3 Builder agent

Default: Claude Code.

Responsibilities:

- read the harness and assigned issue,
- create or use the correct branch,
- implement the issue,
- run required verification,
- self-review,
- commit and push,
- open a PR,
- fix accepted review blockers,
- comment on the PR after fixes.

### 5.4 Reviewer agents

Default: two Codex reviewers.

Reviewer A default lens:

- correctness,
- tests,
- security,
- runtime behavior,
- regression risk.

Reviewer B default lens:

- architecture,
- maintainability,
- spec drift,
- harness compliance,
- unwanted coupling or unrelated changes.

Reviewers should output blocking issues with file/line references whenever possible.

### 5.5 Alternate agent users

GodMode should also support users who want different agent stacks:

- OpenClaw as head,
- Codex as builder,
- Claude as reviewer,
- custom shell scripts as agents,
- local LLM CLIs,
- remote ACP/MCP-driven agents,
- human/manual placeholders.

---

## 6. V1 User Experience

## 6.1 Visual feel

GodMode should look and feel like a terminal multiplexer for agents.

Target vibe:

- tmux/split-pane layout,
- dark terminal-first UI,
- live process output,
- compact status bars,
- keyboard-friendly commands,
- agent panes with chat/control inputs,
- visible GitHub/PR state,
- minimal glossy SaaS chrome.

## 6.2 Default V1 layout

A default 2x2 or 2x3 layout:

```text
┌──────────────────────── Hermes / Head ────────────────────────┐
│ orchestration chat, command log, recommendations, state         │
├──────────────────── Claude Builder ───────┬──── Codex A ───────┤
│ terminal stream + chat/control input       │ review stream/chat │
├──────────────────── Codex B ──────────────┴──── PR/GitHub ─────┤
│ review stream/chat                         │ issue/PR/checks    │
└──────────────────── Global Command Bar / Actions ──────────────┘
```

Panes should be resizable eventually, but fixed useful defaults are acceptable in v1.

## 6.3 Agent pane anatomy

Each agent pane includes:

- role label,
- configured agent name/command,
- current phase,
- terminal output stream,
- chat/control history,
- input box for direct operator messages,
- pause/interrupt controls where supported,
- status badge: idle/running/waiting/failed/done.

## 6.4 PR/GitHub pane

The PR/GitHub pane shows:

- selected project/repo,
- selected issue,
- active branch,
- active PR,
- PR status,
- latest commits,
- check/build/test status,
- reviewer results,
- mergeability,
- links to GitHub,
- merge-ready indicator.

## 6.5 Global command bar

The command bar lets the operator talk to the configured head agent or route messages to a specific agent.

Examples:

- `Hermes: pick up issue #12`
- `Hermes: spec this Linear issue into GitHub implementation issues`
- `Claude: pause and explain your current plan`
- `Codex A: re-review only the latest commit`
- `Codex B: focus on docs/spec drift`

## 6.6 Human action controls

Important actions should be visible as buttons:

- Pick up issue
- Spec issue
- Start build
- Pause run
- Resume run
- Cancel run
- Re-run reviewers
- Ask builder to fix blockers
- Mark blocker dismissed
- Mark merge-ready manually
- Open PR in GitHub
- Verify merge
- Mark run closed

V1 should not auto-merge to main.

---

## 7. Default Workflow: Issue to Merge-ready PR

## 7.1 Start work

Karan selects a project and issue, then tells Hermes or the dashboard:

```text
Pick up issue #N.
```

GodMode verifies:

- project path exists,
- repo is clean or safe to work in,
- harness files exist,
- issue is readable,
- builder role is configured,
- reviewers are configured.

If the issue is too vague, Hermes should flag it and offer to spec it before build.

## 7.2 Builder run

The builder receives a minimal command:

```text
Work on issue #N. Read AGENTS.md, docs/spec.md, and the issue. Follow the project harness. Create a branch, implement, verify, push, and open a PR.
```

The builder is expected to rely on the harness for detailed rules.

## 7.3 PR opened

When the builder opens a PR, GodMode detects the PR by:

- parsing agent output marker,
- checking GitHub CLI/API,
- matching branch to PR,
- verifying pushed commit appears on remote.

Then reviewers start automatically.

## 7.4 Reviewers run automatically

Reviewer A and Reviewer B run independently.

Default Reviewer A command:

```text
Review PR #N using the project harness and your Reviewer A role. Focus on correctness, tests, security, and regressions. Output only blocking issues and concise non-blocking notes.
```

Default Reviewer B command:

```text
Review PR #N using the project harness and your Reviewer B role. Focus on architecture, maintainability, spec drift, and harness compliance. Output only blocking issues and concise non-blocking notes.
```

## 7.5 Blocker handling

If either reviewer reports blockers:

1. GodMode normalizes findings.
2. Hermes may dedupe and classify if configured as head.
3. Clear accepted blockers are sent to the builder automatically.
4. Ambiguous/risky blockers can pause for Karan.
5. Builder fixes, commits, pushes, and comments on the PR.
6. GodMode verifies the new commit landed on the remote PR branch.
7. Reviewers re-run.

## 7.6 Merge-ready

A PR becomes merge-ready when:

- builder completed successfully,
- latest commits are pushed and verified,
- required tests/checks pass or are explicitly waived,
- Reviewer A has no blocking findings,
- Reviewer B has no blocking findings,
- Hermes/head has no unresolved safety concerns,
- max-cycle policy was not exceeded,
- PR is mergeable or known merge state is acceptable.

GodMode then marks the run as `MERGE_READY` and surfaces it to Karan.

Karan can:

- open GitHub and merge manually,
- later approve GodMode/Hermes to merge if policy allows,
- request changes,
- pause,
- close/supersede.

---

## 8. Run State Machine

Primary states:

```text
IDLE
ISSUE_SELECTED
NEEDS_SPEC
READY_TO_BUILD
BUILDER_RUNNING
PR_OPENED
REVIEWERS_RUNNING
REVIEW_SYNTHESIS
BUILDER_FIXING
FIX_PUSHED
REVIEWERS_RERUNNING
MERGE_READY
KARAN_MERGED
CLOSED
```

Interrupt/failure states:

```text
PAUSED
CANCELLED
NEEDS_HUMAN
MAX_CYCLES_EXCEEDED
AGENT_FAILED
PR_CONFLICTED
TESTS_FAILED
CHECKS_UNSTABLE
HARNESS_MISSING
REPO_DIRTY
```

State transitions should be explicit and logged.

---

## 9. Bring Your Own Agent Architecture

## 9.1 Role-based, not vendor-based

GodMode should define role slots:

- head,
- builder,
- reviewer_a,
- reviewer_b,
- optional reviewer_n,
- optional operator/human.

Each role maps to an agent adapter.

Roles bind to a generic `pane` and reference an agent by key; agents are
defined once in a separate `agents` map (adapter, command, mode). This keeps
roles vendor-neutral and lets multiple roles reuse one agent definition.

Example Karan default config:

```yaml
roles:
  head:
    agent: hermes
    pane: head
    display_name: Hermes
  builder:
    agent: claude-code
    pane: builder
    display_name: Claude Code
  reviewers:
    - id: reviewer-a
      agent: codex
      pane: reviewer_a
      display_name: Codex A
      role_doc: docs/review/reviewer-a-correctness.md
    - id: reviewer-b
      agent: codex
      pane: reviewer_b
      display_name: Codex B
      role_doc: docs/review/reviewer-b-architecture.md

agents:
  hermes:
    adapter: cli
    command: hermes
    mode: interactive
  claude-code:
    adapter: cli
    command: claude
    mode: interactive
  codex:
    adapter: cli
    command: codex exec
    mode: oneshot
```

Alternate config example (different agents, same role slots):

```yaml
roles:
  head:
    agent: openclaw
    pane: head
    display_name: OpenClaw
  builder:
    agent: codex
    pane: builder
    display_name: Codex Builder
  reviewers:
    - id: reviewer-a
      agent: claude-code
      pane: reviewer_a
      display_name: Claude Reviewer

agents:
  openclaw:
    adapter: cli
    command: openclaw
    mode: interactive
  codex:
    adapter: cli
    command: codex
    mode: interactive
  claude-code:
    adapter: cli
    command: claude
    mode: oneshot
```

## 9.2 Agent adapter contract

Each agent adapter should expose a common lifecycle:

```ts
type AgentAdapter = {
  id: string;
  displayName: string;
  capabilities: AgentCapabilities;
  startSession(input: StartSessionInput): Promise<AgentSession>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  parseOutput?(chunk: string): ParsedAgentEvent[];
};
```

Capabilities:

```ts
type AgentCapabilities = {
  interactive: boolean;
  supportsPty: boolean;
  supportsPrintMode: boolean;
  canEditFiles: boolean;
  canReviewOnly: boolean;
  canUseGitHubCli: boolean;
  canOpenPr: boolean;
  canCommentOnPr: boolean;
};
```

## 9.3 Agent command templates

Commands should be configured per role and per project.

Example:

```yaml
commands:
  builder_start: |
    Work on issue {{issue_id}}.
    Read AGENTS.md, docs/spec.md, relevant docs/architecture and docs/conventions files, and the issue.
    Follow the project harness.
    Create a branch, implement, verify, push, and open a PR.

  reviewer_a_start: |
    Review PR {{pr_number}} using your Reviewer A role and the project harness.
    Focus on correctness, tests, security, and regressions.

  reviewer_b_start: |
    Review PR {{pr_number}} using your Reviewer B role and the project harness.
    Focus on architecture, maintainability, spec drift, and harness compliance.

  builder_fix: |
    Address the accepted blocking findings on PR {{pr_number}}.
    Push fixes and comment on the PR with what changed.
```

These are intentionally small. Detailed behavior belongs in the harness.

---

## 10. Harness Contract

GodMode requires a project harness to make agent-agnostic operation reliable.

Minimum harness files:

```text
AGENTS.md
README.md or docs/spec.md
```

Recommended harness:

```text
AGENTS.md
docs/
  spec.md
  architecture/
    README.md
  build-plan.md
  conventions/
    README.md
    branch-pr-policy.md
    testing.md
    code-style.md
  review/
    reviewer-a-correctness.md
    reviewer-b-architecture.md
    blocking-vs-nonblocking.md
  friction/
    README.md
.agentic/
  godmode.yaml
```

## 10.1 `AGENTS.md` requirements

`AGENTS.md` should define:

- project roles,
- source-of-truth rules,
- branch policy,
- PR policy,
- review loop policy,
- test/verification expectations,
- forbidden actions,
- merge policy,
- how agents should report completion.

## 10.2 `docs/spec.md` requirements

`docs/spec.md` should define:

- product purpose,
- current architecture,
- tech stack,
- core constraints,
- active implementation priorities,
- known risks,
- links to detailed docs.

## 10.3 Architecture and convention docs

Architecture and convention folders are part of the recommended harness so agents can find standing design and workflow rules without relying on one-off prompts.

- `docs/architecture/` should hold durable technical design, module boundaries, data flow, state-machine notes, and adapter decisions.
- `docs/conventions/` should hold standing branch, PR, testing, code style, and issue-to-PR workflow rules.
- Both folders should include a `README.md` that explains what belongs there and should be updated in the same PR as rules or architecture that affect future agents.

## 10.4 Reviewer docs

Reviewer docs should define standing lenses so Hermes does not need to over-prompt.

Example:

- `docs/review/reviewer-a-correctness.md`
- `docs/review/reviewer-b-architecture.md`

## 10.5 GodMode project config

`.agentic/godmode.yaml` can define:

```yaml
project:
  name: GodMode
  default_branch: main

harness:
  agents_file: AGENTS.md
  spec_file: docs/spec.md
  product_spec_file: docs/godmode-v1-product-spec.md
  architecture_dir: docs/architecture
  conventions_dir: docs/conventions
  review_dir: docs/review
  friction_dir: docs/friction

roles:
  head:
    agent: hermes
    pane: head
    display_name: Hermes
  builder:
    agent: claude-code
    pane: builder
    display_name: Claude Code
  reviewers:
    - id: reviewer-a
      agent: codex
      pane: reviewer_a
      display_name: Codex A
      role_doc: docs/review/reviewer-a-correctness.md
    - id: reviewer-b
      agent: codex
      pane: reviewer_b
      display_name: Codex B
      role_doc: docs/review/reviewer-b-architecture.md

workflow:
  auto_start_reviewers_after_pr: true
  auto_send_blockers_to_builder: true
  max_fix_cycles: 3
  auto_merge: false

agents:
  hermes:
    adapter: cli
    command: hermes
    mode: interactive
  claude-code:
    adapter: cli
    command: claude
    mode: interactive
  codex:
    adapter: cli
    command: codex exec
    mode: oneshot
```

This is the schema the main-process loader validates (see `docs/spec.md`);
`roles` reference agent keys defined in the `agents` map, and unknown
references are rejected as invalid config.

---

## 11. Data Model

## 11.1 Project

```ts
type Project = {
  id: string;
  name: string;
  localPath: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  harness: HarnessConfig;
  roleConfig: RoleConfig;
};
```

## 11.2 Run

```ts
type Run = {
  id: string;
  projectId: string;
  sourceType: 'github_issue' | 'linear_issue' | 'manual_task' | 'pr_review';
  sourceId: string;
  status: RunStatus;
  branch?: string;
  prNumber?: number;
  cycle: number;
  maxCycles: number;
  createdAt: string;
  updatedAt: string;
};
```

## 11.3 Agent session

```ts
type AgentSession = {
  id: string;
  runId: string;
  role: string;
  adapter: string;
  status: 'idle' | 'running' | 'waiting' | 'failed' | 'done';
  command?: string;
  logPath: string;
  startedAt?: string;
  endedAt?: string;
};
```

## 11.4 Finding

```ts
type Finding = {
  id: string;
  runId: string;
  reviewerRole: string;
  severity: 'blocking' | 'non_blocking' | 'note';
  status: 'open' | 'accepted' | 'dismissed' | 'fixed' | 'needs_human';
  file?: string;
  line?: number;
  title: string;
  details: string;
  suggestedFix?: string;
};
```

## 11.5 Chat event

```ts
type ChatEvent = {
  id: string;
  runId: string;
  from: 'karan' | 'head' | 'system' | string;
  to: string;
  message: string;
  phase: RunStatus;
  createdAt: string;
};
```

---

## 12. Persistence and Logs

Every run should persist artifacts locally.

Suggested layout:

```text
.godmode/
  runs/
    2026-06-02-issue-12/
      run.json
      events.jsonl
      chats.jsonl
      hermes.log
      builder.log
      reviewer-a.log
      reviewer-b.log
      findings.json
      verification.json
      final-summary.md
```

Logs should make it possible to reconstruct:

- who was asked to do what,
- what each agent output,
- what PR/branch was created,
- what reviewers found,
- what Claude fixed,
- which commits were pushed,
- why the run became merge-ready or blocked.

---

## 13. GitHub Integration Requirements

V1 should support:

- read issues,
- read PRs,
- detect PR for branch,
- create PR if builder does not,
- read PR comments/reviews,
- post comments on behalf of agents where needed,
- check mergeability,
- check commits on PR,
- verify pushed commits,
- optionally verify merge after Karan merges manually.

Mandatory verification policies:

- After any push, verify the expected commit appears in the remote PR commit list.
- After any merge, re-query PR state and confirm merged/closed before reporting merged.
- Never report PR success based only on an agent's self-report.

---

## 14. Linear Integration Requirements

Linear can be optional in V1 but should be planned.

Support later or as stretch:

- read Linear issue,
- show linked GitHub repo/issue/PR,
- create GitHub implementation issues from Linear packet after approval,
- comment back with PR link/status,
- move Linear issue to In Progress/In Review/Done based on policy.

For Karan's consulting/client workflow, Linear can remain parent task management while GitHub remains implementation and PR source of truth.

---

## 15. Safety and Approval Policy

V1 default policy:

Allowed without extra confirmation once a run is started:

- builder creates branch,
- builder commits to branch,
- builder pushes branch,
- builder opens PR,
- reviewers review PR,
- builder fixes review blockers,
- agents comment on PR with signatures,
- reviewers re-review.

Requires Karan approval or manual action:

- merge to main,
- production deployment,
- credential or secret changes,
- destructive git actions beyond the run branch,
- client-facing communication,
- live account mutations,
- closing parent Linear issues,
- broadening agent permissions.

GodMode should make risk level visible for each action.

---

## 16. Completion Markers and Structured Output

Agents should be encouraged to produce machine-readable markers, but GodMode should also verify externally.

Builder completion marker:

```text
DONE: ROLE=builder STATUS=success|failure ISSUE=<id> PR=<number> BRANCH=<branch>
```

Reviewer completion marker:

```text
DONE: ROLE=reviewer STATUS=pass|fail BLOCKING=<count>
```

Fix completion marker:

```text
DONE: ROLE=builder-fix STATUS=success|failure PR=<number> BRANCH=<branch>
```

Markers help parsing. They are not proof.

---

## 17. Self-dogfooding Plan

GodMode should be built with its own harness as early as possible.

Initial repo should include:

- this product spec,
- `AGENTS.md`,
- `docs/spec.md`,
- role docs for Hermes/head, builder, reviewer A, reviewer B,
- branch/PR policy,
- review-loop policy,
- friction log directory,
- test/verification commands,
- `.agentic/godmode.yaml` default config.

Dogfooding sequence:

1. Build dashboard shell manually/with normal assistance.
2. Add project harness detection.
3. Add static panes and mock run state.
4. Add real process spawning for one agent.
5. Add Claude builder pane.
6. Add PR detection.
7. Add Codex reviewer panes.
8. Add automatic review/fix loop.
9. Use GodMode to build the next GodMode issue.

---

## 18. V1 Acceptance Criteria

GodMode v1 is successful when:

1. Karan can open the dashboard on a local project repo.
2. The dashboard shows tmux-style panes for head, builder, reviewer A, reviewer B, and PR/GitHub state.
3. Karan can chat/control each configured agent pane.
4. GodMode can read the project harness and selected GitHub issue.
5. Karan can start a builder run from an issue.
6. The builder can open a PR or GodMode can detect/create one from the builder branch.
7. Reviewer A and Reviewer B automatically start after PR detection.
8. Review blockers are parsed/displayed.
9. If blockers exist, the builder automatically receives the blockers and attempts fixes.
10. The builder comments on the PR after fixes.
11. Reviewers automatically re-review after fix commits.
12. The loop continues until merge-ready, max cycles, failure, or pause.
13. GodMode verifies remote commits/PR state rather than trusting agent self-reports.
14. Karan can see a merge-ready summary and choose to merge manually.
15. The GodMode repo harness is strong enough to begin dogfooding the tool on itself.

---

## 19. Open Design Questions

1. Should the first implementation use Node/Express + Next.js like QuadWork, or a smaller local Tauri/Electron shell?
2. Should agent sessions be true interactive PTYs, print-mode one-shots, or both depending on adapter capability?
3. Should Hermes integration be a native Hermes API call, CLI subprocess, MCP/ACP adapter, or dashboard-internal head role at first?
4. How much Linear support is needed in v1 versus GitHub-only first?
5. How should mid-run human chat be injected into agents that do not support interactive session continuation?
6. Should reviewer findings be posted as GitHub review comments, PR comments, or dashboard-only artifacts in v1?
7. What is the default max fix cycle count: 2 or 3?
8. Should `MERGE_READY` require all GitHub checks green, or allow warnings when checks are pending/unstable?
9. Should Karan's final merge be manual in GitHub for v1, or should GodMode offer “Approve Hermes to merge” behind a confirmation button?

---

## 20. Recommended Build Order

1. Create GodMode repo harness and docs.
2. Build tmux-style dashboard shell with static panes.
3. Add project selector and local harness detection.
4. Add GitHub issue/PR read-only integration.
5. Add agent role config and adapter abstraction.
6. Add one interactive/PTY agent pane.
7. Add Claude builder launch flow.
8. Add PR detection and commit verification.
9. Add Codex reviewer A/B launch flow.
10. Add blocker parsing and findings UI.
11. Add automatic builder fix loop.
12. Add merge-ready summary.
13. Add run persistence/log artifacts.
14. Dogfood GodMode on its own next issue.

---

## 21. One-sentence Product Definition

GodMode is a local, tmux-style, bring-your-own-agent coding dashboard where a human operator can command and chat with an agent team, run an automatic build-review-fix PR loop from a project harness, and retain final merge authority.
