export type AgentRole = 'head' | 'builder' | 'reviewer_a' | 'reviewer_b';

export type AgentMode = 'interactive' | 'oneshot' | 'oneshot_or_interactive';

/**
 * How an agent is driven. Only `cli` is wired for v1 (safe shell PTY); the rest
 * are reserved so config and the registry can describe them without core code
 * branching on a specific vendor or transport.
 */
export type AgentAdapter = 'cli' | 'mcp' | 'acp' | 'custom';

export type AgentCapabilities = {
  interactive: boolean;
  supportsPty: boolean;
  canEditFiles: boolean;
  canReview: boolean;
  canOpenPr: boolean;
  canCommentOnPr: boolean;
};

export type AgentDefinition = {
  id: string;
  adapter: AgentAdapter;
  command: string;
  mode: AgentMode;
  capabilities?: Partial<AgentCapabilities>;
};

export type RoleBinding = {
  role: AgentRole;
  agentId: string;
  displayName: string;
  paneId: string;
  roleDoc?: string;
};

/**
 * The command templates GodMode can render for a run. Kept role-scoped and
 * generic — `head` orchestrates and gets no launch template in v1; only the
 * builder and reviewer lifecycle steps map to renderable commands.
 */
export type CommandTemplateKind = 'builder_start' | 'reviewer_start' | 'builder_fix';

/**
 * Variables a command/prompt template can interpolate, sourced from the selected
 * issue/PR and role config. All optional: a render with a missing variable is
 * still produced (placeholder left intact) and the gap is reported via
 * {@link RenderedCommand.missingVariables} so previews stay auditable.
 */
export type TemplateContext = {
  projectName?: string;
  issueNumber?: number;
  issueTitle?: string;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  /** Reviewer slug (e.g. "reviewer-a") for reviewer templates. */
  reviewerId?: string;
  /** Project-relative role doc the agent must read first. */
  roleDoc?: string;
  /** Accepted blockers handed to the builder for a fix cycle. */
  blockers?: string;
};

/**
 * A single, fully-resolved command rendering. Never executed by producing it —
 * this is the auditable preview the operator inspects before any send/launch.
 */
export type RenderedCommand = {
  kind: CommandTemplateKind;
  role: AgentRole;
  agentId: string;
  displayName: string;
  adapter: AgentAdapter;
  mode: AgentMode;
  /** Base command/binary for the bound agent (e.g. "claude", "codex"). */
  command: string;
  /** Auditable command line GodMode would launch (prompt delivered per mode). */
  commandLine: string;
  /** How the prompt reaches the agent, derived from {@link mode}. */
  delivery: 'interactive' | 'oneshot';
  /** Rendered prompt/instructions for the agent. */
  prompt: string;
  /** Template variable names left unbound in this render, for visible auditing. */
  missingVariables: string[];
};

/** A role resolved through config/adapter objects — never a hardcoded vendor branch. */
export type RoleResolution = {
  role: AgentRole;
  agentId: string;
  displayName: string;
  adapter: AgentAdapter;
  mode: AgentMode;
  capabilities: AgentCapabilities;
  /** Reviewer slug for reviewer roles. */
  reviewerId?: string;
  roleDoc?: string;
};

/**
 * Outcome of resolving the agent registry for the selected project. Mirrors
 * {@link ConfigStatus} so unknown adapter/role configs surface a visible error
 * while the UI keeps working on safe defaults.
 * - `ready`: resolved from a valid config file.
 * - `default`: no config file; resolved from built-in safe defaults.
 * - `invalid`: config present but invalid; defaults used and `error` set.
 * - `unreadable`: the selected root could not be read.
 */
export type AgentRegistryStatus = 'ready' | 'default' | 'invalid' | 'unreadable';

/**
 * Renderer-facing view of the resolved adapter registry and its auditable
 * command previews. Role/agent keys stay generic; vendor names appear only as
 * display labels and command hints.
 */
export type AgentRegistryState = {
  status: AgentRegistryStatus;
  source: 'config' | 'default';
  /** Set when status is `invalid` or `unreadable`. */
  error?: string;
  roles: RoleResolution[];
  /**
   * Preview command renderings (builder start, each reviewer start, builder
   * fix). Marked mock in the UI until a real run is launched.
   */
  preview: RenderedCommand[];
};

export type HarnessFileKind = 'required' | 'optional';

export type HarnessRequirement = {
  /** Stable key for the check. */
  id: string;
  /** Human-readable label, e.g. "AGENTS.md" or "README.md or docs/spec.md". */
  label: string;
  kind: HarnessFileKind;
  /** Whether the requirement was satisfied by the project root. */
  present: boolean;
  /** Project-relative paths that satisfy (or would satisfy) the requirement. */
  candidates: string[];
};

/**
 * Harness readiness for a selected project root.
 * - `valid`: all required harness files present.
 * - `partial`: some but not all required files present.
 * - `missing`: no required harness files present.
 * - `unreadable`: the root is not a readable directory (or no project selected).
 */
export type HarnessStatus = 'valid' | 'partial' | 'missing' | 'unreadable';

export type ProjectHarnessState = {
  status: HarnessStatus;
  /** Set when status is `unreadable` or a path could not be accessed. */
  error?: string;
  requirements: HarnessRequirement[];
  /** Labels of required requirements that were not satisfied. */
  missingRequired: string[];
};

/**
 * Identity of the GodMode **application repository** — the repo that ships the
 * Electron app, its docs, and config defaults. This is deliberately distinct
 * from the **operated project** (`ProjectState`), the external repo opened
 * inside GodMode and worked on by agents. The two only coincide while
 * self-dogfooding GodMode on its own repo; even then the conceptual boundary
 * holds — see docs/architecture/app-vs-operated-project.md.
 */
export type AppRepoState = {
  /** Absolute path to the GodMode app repo root (where the app runs from). */
  root: string;
  /** App name, from the GodMode package.json. */
  name: string;
  /** App version, from the GodMode package.json. */
  version: string;
};

/**
 * State of the **operated project** — the repo currently opened inside GodMode
 * and acted on by agents, harness detection, PTY launches, and GitHub lookups.
 * This is never assumed to be the GodMode app repo (see {@link AppRepoState}).
 */
export type ProjectState = {
  /** Absolute, resolved operated-project root, or null when none/invalid. */
  root: string | null;
  /** Display name (basename of the root). */
  name: string | null;
  harness: ProjectHarnessState;
  /**
   * True when the operated-project root resolves to the GodMode app repo itself
   * (self-dogfooding). The two contexts coincide on disk but stay conceptually
   * distinct: agents still treat this as the operated project, not as the app.
   */
  isAppRepo: boolean;
};

/**
 * Why a GitHub snapshot could not be produced, used to give the operator
 * actionable, read-only guidance instead of a silent empty pane.
 * - `ok`: a snapshot was produced (it may still be empty).
 * - `gh_missing`: the `gh` CLI is not installed / not on PATH.
 * - `unauthenticated`: `gh` is installed but not logged in.
 * - `no_repo`: the selected root has no GitHub remote (or is not a git repo).
 * - `error`: any other failure (network, rate limit, unexpected output).
 */
export type GithubStatus = 'ok' | 'gh_missing' | 'unauthenticated' | 'no_repo' | 'error';

export type GithubLabel = { name: string; color: string };

export type GithubIssue = {
  number: number;
  title: string;
  state: string;
  updatedAt: string;
  labels: GithubLabel[];
};

export type GithubPullRequest = {
  number: number;
  title: string;
  /** OPEN, CLOSED, or MERGED. */
  state: string;
  updatedAt: string;
  headRefName: string;
  isDraft: boolean;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or '' when none. */
  reviewDecision: string;
};

export type GithubReview = {
  author: string;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING. */
  state: string;
  body: string;
  submittedAt: string;
};

export type GithubComment = {
  author: string;
  body: string;
  createdAt: string;
};

/**
 * Full detail for a single GitHub issue, fetched on demand when an issue is
 * selected for a run. The issue *list* model ({@link GithubIssue}) only carries
 * summary metadata; this adds the body, comments, and URL needed to ground a
 * builder handoff prompt in the actual task. Read-only, like the rest of the
 * GitHub snapshot.
 */
export type GithubIssueDetail = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  updatedAt: string;
  labels: GithubLabel[];
  comments: GithubComment[];
};

/**
 * Outcome of fetching a single issue's detail. Mirrors {@link GithubState}'s
 * never-throw contract: every failure mode is folded into `status`/`message` so
 * the renderer can show actionable guidance, and `issue` is null unless the
 * fetch succeeded.
 */
export type GithubIssueDetailResult = {
  status: GithubStatus;
  message?: string;
  issue: GithubIssueDetail | null;
};

export type GithubCheck = {
  name: string;
  /** Normalized: SUCCESS, FAILURE, PENDING, SKIPPED, NEUTRAL. */
  conclusion: string;
};

/** The PR (if any) whose head matches the selected repo's current branch. */
export type GithubActivePullRequest = GithubPullRequest & {
  url: string;
  reviews: GithubReview[];
  comments: GithubComment[];
  checks: GithubCheck[];
};

export type GithubRepo = {
  owner: string;
  name: string;
  defaultBranch: string;
};

/**
 * Outcome of the builder branch/PR/commit verification gate (issue #9). This is
 * GodMode's **evidence layer**: it compares an expected commit (the run-recorded
 * builder commit, or the operated project's local `HEAD` as a fallback) against
 * the commit list of the PR for the current branch, read live from `gh`. The
 * harness must never treat builder output as valid on agent self-report or PTY
 * transcript content alone — later reviewer and merge-ready logic consume this
 * verified status, not raw PR existence or agent claims.
 *
 * - `verified`: the expected commit appears on the remote PR and checks are not
 *   blocking (or the PR is confirmed merged).
 * - `missing_remote_commit`: a PR exists, but the expected commit is not in its
 *   commit list / head — typically a local commit that was never pushed.
 * - `no_pr_for_branch`: no PR was found for the current branch.
 * - `needs_refresh`: a `gh`/`git` query failed, so the evidence is incomplete and
 *   the operator should retry rather than trust a partial result.
 * - `checks_pending`: the commit matched but PR checks are still running.
 * - `checks_failed`: the commit matched but one or more PR checks failed.
 * - `needs_human`: an ambiguous/blocking condition that needs a person — no
 *   commit could be resolved, or the PR was closed without merging.
 */
export type CommitVerificationStatus =
  | 'verified'
  | 'missing_remote_commit'
  | 'no_pr_for_branch'
  | 'needs_refresh'
  | 'checks_pending'
  | 'checks_failed'
  | 'needs_human';

/** Bucketed counts of a PR's normalized checks, for a compact status display. */
export type CommitCheckSummary = {
  total: number;
  passing: number;
  pending: number;
  failing: number;
};

/** Where the expected commit being verified came from. */
export type ExpectedCommitSource = 'run_recorded' | 'local_head' | 'unknown';

/**
 * A single commit-verification result for the operated project's current
 * branch/PR, produced by reading live `gh`/`git` state (never agent self-report).
 * Always returns a value across IPC; `partial` flags incomplete evidence so the
 * UI never presents a failed query as a confident result.
 */
export type CommitVerification = {
  status: CommitVerificationStatus;
  /** User-readable, single-line explanation of the derived status. */
  message: string;
  /** Operated-project branch the verification was scoped to, when resolvable. */
  branch: string | null;
  /** Full expected commit SHA being verified, or null when unresolved. */
  expectedCommit: string | null;
  /** 7-char form of {@link expectedCommit} for compact display. */
  expectedCommitShort: string | null;
  expectedCommitSource: ExpectedCommitSource;
  /** The PR matched to the branch, with the head SHA read from the remote. */
  pr: {
    number: number;
    /** OPEN, MERGED, or CLOSED, read live from GitHub. */
    state: string;
    url: string;
    headRefName: string;
    /** Remote PR head commit SHA (`headRefOid`). */
    headSha: string;
    headShaShort: string;
  } | null;
  /** True when the expected commit appears in the PR's commit list. */
  commitInList: boolean;
  /** True when the expected commit equals the remote PR head commit. */
  matchesHead: boolean;
  checks: CommitCheckSummary;
  /** PR merge/close state confirmed from GitHub: OPEN, MERGED, CLOSED, or null. */
  prState: string | null;
  /** True only when GitHub confirms the PR is merged (not merely closed). */
  mergeConfirmed: boolean;
  /**
   * True when a `gh`/`git` query failed so the evidence is incomplete. The UI
   * must not present a partial verification as a confident result.
   */
  partial: boolean;
  /** ISO timestamp the verification was produced (main owns the clock). */
  fetchedAt: string;
};

/**
 * A read-only snapshot of the **operated project's** GitHub state — the repo
 * opened inside GodMode, never the GodMode app repo itself unless the operator
 * has explicitly opened GodMode on its own repo (self-dogfooding). Issues and
 * PRs here belong to the operated project. Always returns a value (never throws
 * across IPC); `status` carries why a partial/empty result was produced so the
 * UI can render user-readable guidance.
 */
export type GithubState = {
  status: GithubStatus;
  /**
   * True when the repo probe succeeded (`status: 'ok'`) but one or more of the
   * issue/PR/active-PR sub-queries failed, so the snapshot is incomplete. The
   * UI must not present a partial snapshot as fully `live`. Always false when
   * `status` is not `ok`.
   */
  partial: boolean;
  /** User-readable guidance, set whenever `status` is not `ok` or `partial` is true. */
  message?: string;
  repo: GithubRepo | null;
  /** Current branch of the selected repo, when resolvable. */
  branch: string | null;
  activePr: GithubActivePullRequest | null;
  issues: GithubIssue[];
  pulls: GithubPullRequest[];
  /** ISO timestamp the snapshot was taken, for stale/live distinction in UI. */
  fetchedAt: string;
};

/**
 * Outcome of loading `.agentic/godmode.yaml` for the selected project.
 * - `loaded`: config file present and valid; panes come from config.
 * - `default`: no config file found; panes fall back to safe defaults.
 * - `invalid`: config file present but failed parse/validation; panes fall
 *   back to safe defaults and `error` describes what was wrong (non-crashing).
 * - `unreadable`: no project selected or the root could not be read.
 */
export type ConfigStatus = 'loaded' | 'default' | 'invalid' | 'unreadable';

/**
 * A single role pane derived from config (or defaults). Pane/role keys stay
 * generic (`head`/`builder`/`reviewer_a`/`reviewer_b`); Hermes/Claude/Codex only
 * ever appear as display names or command hints, never as core identifiers.
 */
export type RolePaneConfig = {
  /** Pane id used by the PTY/IPC layer. Matches AgentRole. */
  paneId: AgentRole;
  /** Generic role key. */
  roleKey: AgentRole;
  /** Short display label, e.g. "HEAD" or "REV A". */
  roleLabel: string;
  /** Human display name from config, e.g. "Hermes". */
  displayName: string;
  /** Agent id this pane is bound to, e.g. "hermes". */
  agentId: string;
  /** Base command hint for the bound agent, e.g. "hermes". */
  commandHint: string;
  /** Reviewer id (e.g. "reviewer-a") for reviewer roles. */
  reviewerId?: string;
  /** Project-relative role doc path, if configured. */
  roleDoc?: string;
};

/** Sanitized, renderer-facing view of the loaded role/agent config. */
export type ProjectConfigState = {
  status: ConfigStatus;
  /** Whether panes were derived from config or from built-in defaults. */
  source: 'config' | 'default';
  /** Set when status is `invalid` or `unreadable`. */
  error?: string;
  /** Project display name (from config, falling back to the root basename). */
  projectName?: string;
  panes: RolePaneConfig[];
};

export type RunStatus =
  | 'idle'
  | 'issue_selected'
  | 'needs_spec'
  | 'ready_to_build'
  | 'builder_running'
  | 'pr_opened'
  | 'reviewers_running'
  | 'review_synthesis'
  | 'builder_fixing'
  | 'fix_pushed'
  | 'reviewers_rerunning'
  | 'merge_ready'
  // Terminal lifecycle endpoints from the spec state machine (section 8). These
  // are distinct outcomes (a human merged; the run is filed away) that cannot be
  // expressed by a reason on another status, so they are first-class states.
  | 'karan_merged'
  | 'closed'
  | 'paused'
  | 'cancelled'
  | 'needs_human'
  | 'agent_failed'
  | 'max_cycles_exceeded';

/**
 * Where a run's work originates. Mirrors the spec `Run.sourceType` (section
 * 11.2). Only `github_issue` and `manual_task` are exercised by the v1
 * dashboard; the others are reserved so the model does not need reshaping later.
 */
export type RunSourceType = 'github_issue' | 'linear_issue' | 'manual_task' | 'pr_review';

/**
 * The spec lists several environment/PR blocker conditions as state-machine
 * states (`PR_CONFLICTED`, `TESTS_FAILED`, `CHECKS_UNSTABLE`, `HARNESS_MISSING`,
 * `REPO_DIRTY`). Rather than multiply near-identical terminal states, GodMode
 * represents them as *reasons* carried on a single operator-actionable status
 * (`needs_human`): every one of these is a "stop and get a human" condition, and
 * collapsing them keeps the transition graph small and deterministic while still
 * recording exactly which blocker fired. The mapping is explicit here so it is
 * never ambiguous.
 */
export type RunBlockerKind =
  | 'pr_conflicted'
  | 'tests_failed'
  | 'checks_unstable'
  | 'harness_missing'
  | 'repo_dirty';

/**
 * Operator/system actions that drive run transitions. Every state change goes
 * through one of these via the central guard — the renderer never invents its
 * own transition rules. Forward-workflow actions advance the happy path;
 * `pause`/`resume`/`cancel`/`flag_needs_human`/`report_agent_failed`/
 * `exceed_max_cycles`/`close` are the interrupts and endpoints.
 */
export type RunAction =
  | 'select_issue'
  | 'require_spec'
  | 'mark_ready'
  | 'start_builder'
  | 'open_pr'
  | 'start_reviewers'
  | 'synthesize_reviews'
  | 'request_fix'
  | 'push_fix'
  | 'rerun_reviewers'
  | 'mark_merge_ready'
  | 'mark_merged'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'flag_needs_human'
  | 'report_agent_failed'
  | 'exceed_max_cycles'
  | 'close';

/**
 * Selected-source detail bound to a run, used to ground the builder handoff
 * prompt in the real task. For a `github_issue` run these come from
 * {@link GithubIssueDetail}; for a `manual_task` run, `body` carries the operator's
 * task text. All optional: a run can exist with only summary metadata (e.g. when
 * issue-detail fetch failed), and the handoff degrades visibly rather than lying.
 */
export type RunSourceDetail = {
  /** Issue/PR URL, when the source is a GitHub issue. */
  url?: string;
  /** Issue body or manual task description. */
  body?: string;
  /** Label names on the source issue. */
  labels?: string[];
  /** Issue comments, oldest first. */
  comments?: { author: string; body: string }[];
};

/**
 * One audited prompt send (a builder handoff or a fix prompt) recorded on the
 * run so the operator can see what text was dispatched to which role and when.
 * The full prompt is not retained in v1 — `digest` is a single-line preview and
 * `promptChars` the full length — which is enough for audit without bloating the
 * in-memory snapshot.
 */
export type RunPromptLogEntry = {
  /** ISO timestamp the prompt was sent. */
  at: string;
  /** Role the prompt was sent to (e.g. `builder`). */
  role: AgentRole;
  /** Source the prompt was grounded in, copied for a self-contained audit line. */
  sourceType: RunSourceType;
  sourceId: string;
  /** Single-line preview of the prompt sent, for audit. */
  digest: string;
  /** Character length of the full prompt sent. */
  promptChars: number;
};

/**
 * One recorded commit-verification check against the run, appended whenever the
 * operator (or, later, the orchestrator) runs the branch/PR/commit evidence gate
 * (issue #9). Persisting the derived status with a timestamp and the source of
 * the expected commit gives the run an auditable history of *what was verified
 * when*, so a later `merge_ready` decision consumes recorded evidence rather than
 * re-trusting a transient query or an agent claim.
 */
export type RunVerificationLogEntry = {
  /** ISO timestamp the verification was recorded. */
  at: string;
  /** Derived verification status at that moment. */
  status: CommitVerificationStatus;
  /** Expected commit (full SHA) that was checked, or null when unresolved. */
  expectedCommit: string | null;
  /** Where the expected commit came from (run-recorded vs local HEAD). */
  source: ExpectedCommitSource;
  /** PR number the commit was checked against, when one was found. */
  prNumber?: number;
  /** PR state confirmed from GitHub (OPEN/MERGED/CLOSED), when a PR was found. */
  prState?: string;
  /** Single-line human summary mirroring {@link CommitVerification.message}. */
  summary: string;
};

/** One logged state change, appended on every successful transition. */
export type RunTransitionLogEntry = {
  /** ISO timestamp the transition was applied. */
  at: string;
  from: RunStatus;
  to: RunStatus;
  action: RunAction;
  /** Operator/system note or blocker explanation, when one was supplied. */
  reason?: string;
};

/**
 * In-memory snapshot of the current run. Shaped after the spec `Run` type
 * (section 11.2) plus the fields the dashboard needs to render valid actions and
 * recent history. Persistence is in-memory for this issue, but the shape is
 * directly serializable so it can later be written to `.godmode/runs/` or
 * SQLite without reshaping.
 */
export type RunSnapshot = {
  id: string;
  sourceType: RunSourceType;
  /** Stable source identifier (issue number as string, task id, etc.). */
  sourceId: string;
  /** Convenience copy of the GitHub issue number when source is an issue. */
  issueNumber?: number;
  issueTitle?: string;
  /**
   * Selected-source detail (issue body/comments/URL/labels, or manual task
   * text) used to ground the builder handoff prompt. Populated at selection time.
   */
  sourceDetail?: RunSourceDetail;
  status: RunStatus;
  /** Working branch, once known. */
  branch?: string;
  /** PR number, once opened. */
  prNumber?: number;
  /**
   * The commit GodMode expects to verify on the remote PR — recorded from the
   * builder phase (e.g. when the builder opens a PR or pushes a fix). When unset,
   * the verification gate falls back to the operated project's local `HEAD`. This
   * is the "run-recorded expected commit" half of the issue #9 evidence gate.
   */
  expectedCommit?: string;
  /** 1-based fix-loop counter; advances each time a fix cycle is requested. */
  cycle: number;
  maxCycles: number;
  /** Why the run is paused/blocked/failed/needs-human, when relevant. */
  reason?: string;
  /** Which spec blocker condition mapped onto `needs_human`, when relevant. */
  blocker?: RunBlockerKind;
  /** Status to return to on `resume`; set only while `paused`. */
  resumeStatus?: RunStatus;
  /** Actions valid from the current state — the renderer renders only these. */
  availableActions: RunAction[];
  /** Append-only transition history (in memory for this issue). */
  log: RunTransitionLogEntry[];
  /** Append-only audit of prompts sent to agents (builder handoffs, fixes). */
  prompts: RunPromptLogEntry[];
  /** Append-only history of commit-verification checks against this run (#9). */
  verifications: RunVerificationLogEntry[];
  createdAt: string;
  updatedAt: string;
};

/** Why a run action was rejected, so the UI can explain the failure precisely. */
export type RunRejectionCode = 'no_run' | 'invalid_transition' | 'invalid_payload';

/**
 * Result of a run mutation. On success the new snapshot is returned; on failure
 * the action was rejected with no state mutation and `run` is the unchanged
 * current snapshot (or null when there is no run at all).
 */
export type RunActionResult =
  | { ok: true; run: RunSnapshot }
  | { ok: false; code: RunRejectionCode; error: string; run: RunSnapshot | null };

/**
 * The reviewed builder handoff for the current run: the exact prompt GodMode
 * would write into the configured builder session, bound to the selected
 * issue/task and grounded in the harness reading rules. Producing it never sends
 * anything — it is the auditable artifact the operator reviews before the
 * explicit approve-send gate. When no real source is bound, `isMock` is true and
 * the prompt is a clearly-labeled demo with issue tokens left unresolved.
 */
export type BuilderHandoff = {
  /** True when no selected run/source backs this handoff (mock/demo preview). */
  isMock: boolean;
  /** Source type of the bound run, when one exists. */
  sourceType?: RunSourceType;
  /** Stable source id (issue number as string, manual task id). */
  sourceId?: string;
  /** Human label for the bound source, e.g. "issue #8 — Title". */
  sourceLabel?: string;
  /** Issue URL, when grounded in a GitHub issue. */
  issueUrl?: string;
  /** Resolved builder display name (vendor label only; role stays generic). */
  displayName: string;
  /** Agent id bound to the builder role. */
  agentId: string;
  adapter: AgentAdapter;
  /** How the prompt would reach the builder, derived from the agent's mode. */
  delivery: 'interactive' | 'oneshot';
  /** Auditable command line for the bound builder agent. */
  commandLine: string;
  /** The fully composed prompt that would be written to the builder session. */
  prompt: string;
  /** Template variables left unbound; a non-empty list blocks send. */
  missingVariables: string[];
  /** True only when a real source is bound and no template variables are missing. */
  canSend: boolean;
  /** Why send is blocked, for the UI to surface when `canSend` is false. */
  blockedReason?: string;
};

/** Why a handoff send was rejected, so the UI can explain precisely. */
export type HandoffRejectionCode =
  | 'no_run'
  | 'not_sendable'
  | 'invalid_state'
  | 'no_builder_session'
  | 'invalid_transition'
  | 'invalid_payload';

/**
 * Result of sending the approved builder handoff. On success the updated run
 * snapshot (now `builder_running`, with a recorded prompt-sent entry) is
 * returned; on failure nothing was sent and `run` is the unchanged snapshot.
 */
export type HandoffSendResult =
  | { ok: true; run: RunSnapshot }
  | { ok: false; code: HandoffRejectionCode; error: string; run: RunSnapshot | null };

/**
 * Result of running the commit-verification evidence gate (issue #9). The
 * `verification` is always present (it never throws across IPC — failures fold
 * into its `status`/`partial`). `run` carries the snapshot with the verification
 * appended to its history when an active run exists, or null when verification was
 * run without a bound run (branch/local-HEAD only).
 */
export type RunVerificationResult = {
  verification: CommitVerification;
  run: RunSnapshot | null;
};
