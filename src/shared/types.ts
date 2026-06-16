export type AgentRole = 'head' | 'builder' | 'reviewer_a' | 'reviewer_b';

/**
 * Workspace isolation mode for a run's builder/fix sessions (issue #41).
 * - `shared`: builder works directly in the operated-project checkout (today's
 *   behavior, the default for one release of soak time).
 * - `worktree`: GodMode gives the run its own `git worktree` of the operated
 *   project so an agent switching branches / rewriting files can never collide
 *   with the running app's checkout or another session's uncommitted work.
 */
export type WorkspaceIsolation = 'shared' | 'worktree';

/**
 * A run-scoped git worktree of the operated project (issue #41). The worktree
 * **is** the operated project at a different path (same repo, same conceptual
 * context), created on its own branch so the primary checkout is never touched by
 * the builder. Serializable like the rest of {@link RunSnapshot}.
 */
export type RunWorktree = {
  /** Absolute path to the worktree directory (a sibling of the primary checkout). */
  path: string;
  /** Branch the worktree was created on (the run's working branch). */
  branch: string;
  /** ISO timestamp the worktree was created (main owns the clock). */
  createdAt: string;
};

/** Whether a managed worktree is safe to remove, with the reasons when it is not. */
export type WorktreeCleanliness = {
  /** True only when there are no uncommitted changes and no unpushed commits. */
  clean: boolean;
  /** True when `git status` shows uncommitted/untracked changes. */
  dirty: boolean;
  /** True when HEAD has commits not present on any remote-tracking branch. */
  unpushed: boolean;
  /** Human-readable reasons cleanup is refused, when not clean. */
  reasons: string[];
};

/**
 * A GodMode-managed worktree discovered for the operated project (issue #41),
 * with its cleanliness so the UI can offer cleanup with the same dirty-check
 * rules. Used to list orphaned worktrees on app start / project select.
 */
export type ManagedWorktree = {
  path: string;
  branch: string | null;
  head: string | null;
  cleanliness: WorktreeCleanliness;
  /** True when this worktree belongs to the currently-active run. */
  isCurrentRun: boolean;
};

/** Result of a worktree cleanup attempt (issue #41). */
export type WorktreeCleanupResult =
  | { ok: true; removedPath: string }
  | { ok: false; error: string };

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

/**
 * Where the expected commit being verified came from. `branch_tip` is the tip of
 * the run's working branch (correct for worktree runs, where the primary checkout
 * stays on another branch); `local_head` is the primary checkout's HEAD fallback.
 */
export type ExpectedCommitSource = 'run_recorded' | 'branch_tip' | 'local_head' | 'unknown';

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
 * How a discovered PR was matched to the run (issue #38).
 * - `issue_link`: the PR title/body references the run's issue (`Closes #N` /
 *   `Fixes #N` / a bare `#N`) — the strong, explicit-link evidence.
 * - `recent_unlinked`: a conservative fallback for when the builder forgot the
 *   link — an open PR created at/after the handoff send time.
 */
export type PrCandidateMatchReason = 'issue_link' | 'recent_unlinked';

/**
 * A pull request discovered as a candidate for binding to a `builder_running`
 * run (issue #38), with the evidence the evidence-bound `open_pr` transition
 * records: number, URL, head branch, head commit SHA, author, created-at, and
 * how it matched. Read-only — produced from `gh pr list`, never agent self-report.
 */
export type PrCandidate = {
  number: number;
  url: string;
  /** Head branch of the PR (`headRefName`). */
  headRefName: string;
  /** Remote PR head commit SHA (`headRefOid`), bound as the expected commit. */
  headSha: string;
  /** PR author login, or '' when unresolved. */
  author: string;
  /** ISO timestamp the PR was created. */
  createdAt: string;
  title: string;
  matchReason: PrCandidateMatchReason;
};

/**
 * Outcome of discovering the builder's PR for a run from GitHub evidence (issue
 * #38). Like {@link GithubState} this never throws across IPC: every failure mode
 * folds into `status`/`message` with empty candidates so the operator gets
 * actionable, non-fatal guidance and the run stays in `builder_running`.
 *
 * `recommendedPrNumber` is the single unambiguous `issue_link` candidate's number
 * when one exists (the confirmed-pending candidate the UI pre-selects), else null
 * — multiple candidates or recent-unlinked-only matches require an explicit
 * operator pick; discovery never auto-selects.
 */
export type PrDiscoveryResult = {
  status: GithubStatus;
  /** User-readable guidance, set whenever `status` is not `ok`. */
  message?: string;
  /** The run's issue number the discovery was scoped to, when one is bound. */
  issueNumber?: number;
  candidates: PrCandidate[];
  /** PR number of the single unambiguous issue-linked candidate, else null. */
  recommendedPrNumber: number | null;
  /** ISO timestamp the discovery was produced (main owns the clock). */
  fetchedAt: string;
};

/**
 * Pushed to the renderer on `godmode:run:pr:discovered` (issue #38) when main
 * runs a discovery pass on its own — specifically after the builder PTY exits
 * during `builder_running`. Carries a non-blocking `hint` so the cockpit can
 * prompt "builder session ended — check for PR" without ever transitioning the
 * run: PTY exit alone never changes run state.
 */
export type PrDiscoveryEvent = {
  /** Non-blocking operator hint, when main initiated the pass (e.g. on builder exit). */
  hint?: string;
  discovery: PrDiscoveryResult;
};

/**
 * Result of confirming a discovered PR candidate (issue #38): bind its
 * branch/number/head commit to the run through the `open_pr` guard and
 * immediately run the #9 commit-verification gate. On success the updated run
 * (now `pr_opened`, with the evidence recorded and a transition-log entry naming
 * the PR and how it matched) and the verification are returned; on failure
 * nothing transitioned and `run` is the unchanged snapshot.
 */
export type ConfirmPrCandidateResult =
  | { ok: true; run: RunSnapshot; verification: CommitVerification }
  | {
      ok: false;
      code: 'no_run' | 'invalid_state' | 'invalid_payload' | 'invalid_transition';
      error: string;
      run: RunSnapshot | null;
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

/**
 * Who initiated a run transition (issue #39). Manual operator dispatches and
 * operator-triggered IPC handlers are attributed to `operator`; transitions the
 * deterministic review/fix loop controller drove automatically are attributed to
 * `loop`. This is an audit marker only — it never affects which transitions are
 * legal (the transition table is the single authority).
 */
export type TransitionActor = 'operator' | 'loop';

/** One logged state change, appended on every successful transition. */
export type RunTransitionLogEntry = {
  /** ISO timestamp the transition was applied. */
  at: string;
  from: RunStatus;
  to: RunStatus;
  action: RunAction;
  /** Operator/system note or blocker explanation, when one was supplied. */
  reason?: string;
  /**
   * Who initiated the transition (issue #39). Defaults to `operator`; the loop
   * controller stamps `loop` on every transition it drives, so the dashboard and
   * audit can tell automatic progress apart from operator clicks.
   */
  actor?: TransitionActor;
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
  /**
   * Effective workspace isolation for this run (issue #41). Bound at run creation
   * from `workspace.isolation` config (default `shared`), and toggleable via the
   * dogfooding nudge before the builder starts. When `worktree`, the builder/fix
   * sessions run in {@link worktree} rather than the operated-project checkout.
   */
  isolation: WorkspaceIsolation;
  /**
   * The run-scoped git worktree, once created (issue #41). Present only when
   * {@link isolation} is `worktree` and the builder session has been prepared.
   * Carries the working branch so verification/reviewers scope to it.
   */
  worktree?: RunWorktree;
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
  /**
   * Tracked reviewer sessions launched for this run's PR (issue #10), one per
   * configured reviewer. Present once `start_reviewers` has launched them; each
   * entry carries its own lifecycle (launch → run → complete → comment) so the
   * dashboard can show independent reviewer state and a failure never silently
   * reads as complete.
   */
  reviewers?: ReviewerSessionState[];
  /**
   * Parsed reviewer findings + merge-gate decision from the most recent review
   * synthesis (issue #11). Present once `synthesize_reviews` has parsed the
   * reviewer sessions' captured output for this run. Stored on the run for the
   * dashboard and mirrored to `.godmode/runs/<run-id>/findings.json`. Self-reports
   * are advisory: the merge gate still requires the verified #9 evidence.
   */
  findings?: RunFindings;
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
 * Result of the operator's "Clear run" request (issue #41). Clearing discards the
 * run record, so it is a guarded terminal-only operation: it is refused while a
 * run is still active, still owns a git worktree, or has a live builder session —
 * which would otherwise orphan the worktree/PTY with no run record protecting it.
 * On refusal the run is preserved and `error` explains the lifecycle step to take
 * first (cancel/close, then clean up the worktree).
 */
export type ClearRunResult =
  | { ok: true; run: null }
  | { ok: false; error: string; run: RunSnapshot };

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
  /**
   * The run worktree path named as the working root, when the run is isolated
   * (issue #41). Undefined for a shared-checkout run; surfaced so the operator
   * preview shows exactly where the builder will work.
   */
  worktreePath?: string;
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
  | 'worktree_failed'
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

/**
 * Lifecycle of a single tracked reviewer session (issue #10).
 * - `idle`: configured but not yet launched.
 * - `launching`: a launch was attempted (artifact dir prepared, PTY opening).
 * - `running`: the reviewer session is live and its output is being captured.
 * - `completed`: the session exited (e.g. a oneshot reviewer finished) — its
 *   output is captured, but GodMode has not yet posted its marker comment.
 * - `comment_posted`: GodMode posted its role-signed marker PR comment.
 * - `failed`: launch, capture, or comment posting failed; surfaced visibly and
 *   never collapsed into `completed` so review is never silently marked done.
 */
export type ReviewerSessionStatus =
  | 'idle'
  | 'launching'
  | 'running'
  | 'completed'
  | 'comment_posted'
  | 'failed';

/**
 * Tracked state of one reviewer session bound to a run's PR. Serializable like
 * the rest of {@link RunSnapshot} so it can later persist to `.godmode/runs/`.
 * Vendor names only ever appear in {@link displayName}; the pane/reviewer keys
 * stay generic.
 */
export type ReviewerSessionState = {
  /** Reviewer slug, e.g. "reviewer-a". */
  reviewerId: string;
  /** PTY pane/role the reviewer runs in. */
  paneId: AgentRole;
  /**
   * Opaque per-launch identity, regenerated every time reviewers are launched
   * (including an idempotent same-run relaunch). An async marker post captures
   * this before its `gh` call and re-confirms it after; if a relaunch replaced
   * the session under the same pane/run/root, the token differs and the stale
   * post is refused — it can never patch the freshly relaunched session.
   */
  sessionToken: string;
  /** Resolved reviewer display name (vendor label only; role stays generic). */
  displayName: string;
  /** Project-relative role doc the reviewer was pointed at, when configured. */
  roleDoc?: string;
  status: ReviewerSessionStatus;
  /** Local run-artifact path the reviewer's output is captured to. */
  artifactPath?: string;
  /** Character length of the prompt written into the reviewer session. */
  promptChars?: number;
  /** Live PID once the session is running. */
  pid?: number;
  /** Exit code once the session has exited. */
  exitCode?: number;
  /** True once GodMode's role-signed marker comment has been posted. */
  commentPosted: boolean;
  /** URL of the posted marker comment, when `gh` reported one. */
  commentUrl?: string;
  /**
   * Visible reason for a `failed` status: a terminal *session* failure (launch
   * failure, output-capture failure, or non-zero exit). Distinct from
   * {@link commentError} so a session failure can never be cleared by a later
   * marker post — a failed reviewer never collapses into a success state.
   */
  error?: string;
  /**
   * Visible reason a marker *comment post* failed (or was refused), kept separate
   * from {@link error} so it stays retryable via the operator override without
   * masking — or being masked by — the session's own outcome.
   */
  commentError?: string;
  /** ISO timestamp this session state last changed. */
  updatedAt: string;
};

/**
 * The exact prompt GodMode would write into one reviewer session, bound to the
 * run's verified PR (issue #10). Deliberately **pointer-first**: the reviewer is
 * directed to read the operated project's canonical sources and the live PR
 * diff/threads/checks itself, rather than having them pasted in. Mirrors
 * {@link BuilderHandoff} (issue #8).
 */
export type ReviewerHandoff = {
  reviewerId: string;
  paneId: AgentRole;
  /** Resolved reviewer display name (vendor label only; role stays generic). */
  displayName: string;
  agentId: string;
  adapter: AgentAdapter;
  /** How the prompt would reach the reviewer, derived from the agent's mode. */
  delivery: 'interactive' | 'oneshot';
  /** Project-relative role doc the reviewer must read first, when configured. */
  roleDoc?: string;
  /** Auditable command line for the bound reviewer agent. */
  commandLine: string;
  /** The fully composed pointer-first prompt for this reviewer. */
  prompt: string;
  /** Template variables left unbound; a non-empty list blocks launch. */
  missingVariables: string[];
};

/**
 * The reviewer launch plan for the current run: the bound PR coordinates, every
 * configured reviewer's pointer-first prompt, and whether launch is allowed.
 * Producing it never launches anything — it is the auditable artifact behind the
 * dashboard's reviewer pane. Launch is gated on a real bound PR **and** the run's
 * latest commit-verification being `verified` (ties #10 to the #9 evidence gate),
 * so plain PR existence or an agent self-report is never enough.
 */
export type ReviewerLaunchPlan = {
  /** True when no real run/PR backs this plan (mock/demo preview). */
  isMock: boolean;
  prNumber?: number;
  prUrl?: string;
  branch?: string;
  reviewers: ReviewerHandoff[];
  /** True only when a verified PR is bound and every prompt is fully resolved. */
  canStart: boolean;
  /** Why launch is blocked, for the UI to surface when `canStart` is false. */
  blockedReason?: string;
};

/** Why starting reviewers / posting a reviewer comment was rejected. */
export type ReviewerRejectionCode =
  | 'no_run'
  | 'invalid_state'
  // A loop-driven launch was preempted by an operator/manual dispatch, pause, or
  // mode toggle while its live verification was in flight (issue #39, blocker
  // B-1). Distinct from `invalid_state` so the controller treats it as a clean
  // operator hand-off, not a stage failure to halt/retry on.
  | 'preempted'
  | 'not_verified'
  | 'not_startable'
  | 'no_reviewers_configured'
  | 'unknown_reviewer'
  | 'no_pr'
  | 'comment_failed';

/**
 * Result of launching the reviewer sessions for a run (issue #10). On success the
 * updated run snapshot (now `reviewers_running`, with per-reviewer sessions
 * tracked) is returned; on failure nothing was launched and `run` is the
 * unchanged snapshot. The commit-verification run as the launch gate is returned
 * so the UI can explain a `not_verified` rejection with the live evidence.
 */
export type StartReviewersResult =
  | { ok: true; run: RunSnapshot; verification: CommitVerification }
  | {
      ok: false;
      code: ReviewerRejectionCode;
      error: string;
      run: RunSnapshot | null;
      verification?: CommitVerification;
    };

/**
 * Result of posting one reviewer's role-signed marker comment (auto on session
 * exit, or via the operator override). On success the updated run snapshot (the
 * reviewer now `comment_posted`) is returned; on failure the reviewer is marked
 * `failed` with a visible reason and `run` carries that recorded failure.
 */
export type ReviewerCommentResult =
  | { ok: true; run: RunSnapshot; commentUrl?: string }
  | { ok: false; code: ReviewerRejectionCode; error: string; run: RunSnapshot | null };

// --- Reviewer findings, merge gate, and the first fix cycle (issue #11) -------

/**
 * Severity of a normalized reviewer finding.
 * - `blocking`: must be addressed before merge (a `BLOCKING A-n`/`B-n` block, or
 *   a reviewer `fail` marker). Only blocking findings gate merge in v1.
 * - `non_blocking`: a finding the reviewer raised without blocking on it.
 * - `note`: an informational remark.
 */
export type FindingSeverity = 'blocking' | 'non_blocking' | 'note';

/**
 * Lifecycle of a normalized finding through the first fix cycle.
 * - `open`: parsed but not yet acted on.
 * - `accepted`: GodMode is driving a fix for it. In this first slice, every
 *   cleanly-parsed blocking finding is accepted by default.
 * - `fixed`: addressed by a verified fix push (reserved for later cycles).
 * - `needs_human`: ambiguous/contradictory; a person must decide.
 */
export type FindingStatus = 'open' | 'accepted' | 'fixed' | 'needs_human';

/**
 * One normalized reviewer finding, parsed from a reviewer session's captured
 * output. Reviewer/role keys stay generic; the parsed `marker` (e.g. `A-1`) is
 * the reviewer's own label, retained so the dashboard and fix prompt can name it.
 */
export type ReviewerFinding = {
  /** Reviewer slug that raised it, e.g. "reviewer-a". */
  reviewerId: string;
  /** PTY pane/role of the reviewer, e.g. "reviewer_a". */
  paneId: AgentRole;
  /** The reviewer's own block label when present, e.g. "A-1". */
  marker?: string;
  severity: FindingSeverity;
  status: FindingStatus;
  /** Project-relative file path the finding points at, when parsed. */
  file?: string;
  /** 1-based line number within {@link file}, when parsed. */
  line?: number;
  title: string;
  /** The "Issue:" body / why-it-blocks text, when present. */
  details?: string;
  /** The reviewer's suggested fix, when present. */
  suggestedFix?: string;
};

/**
 * Parsed outcome of a single reviewer's captured output.
 * - `pass`: the reviewer cleanly passed (a `pass` marker or a PASS line, with no
 *   blocking findings).
 * - `fail`: the reviewer cleanly failed with at least one visible blocking finding.
 * - `ambiguous`: missing, malformed, contradictory, or internally inconsistent
 *   output — routed to `needs_human`, never treated as a pass.
 */
export type ReviewerResultStatus = 'pass' | 'fail' | 'ambiguous';

/**
 * The normalized result of parsing one reviewer session's captured output
 * (issue #11). Agent self-reports are advisory: this drives blocker surfacing and
 * the fix loop, but the merge gate still requires the verified #9 evidence.
 */
export type ReviewerResult = {
  reviewerId: string;
  paneId: AgentRole;
  status: ReviewerResultStatus;
  /** Status declared by a `DONE: ROLE=reviewer STATUS=…` marker, when present. */
  declaredStatus?: 'pass' | 'fail';
  /** Blocking count declared by the `DONE` marker, when present. */
  declaredBlocking?: number;
  /** Normalized blocking/non-blocking findings parsed from the output. */
  findings: ReviewerFinding[];
  /**
   * Human-readable notes explaining why a result is `ambiguous` (or any
   * discrepancy between the declared marker and the parsed findings), surfaced so
   * the operator sees *why* a reviewer routed to needs-human.
   */
  notes: string[];
};

/**
 * Whether one reviewer clears its half of the merge gate, with the reason.
 * A reviewer clears when it passed (or raised zero accepted blocking findings)
 * and its output was not ambiguous.
 */
export type ReviewerGateState = {
  reviewerId: string;
  paneId: AgentRole;
  status: ReviewerResultStatus;
  cleared: boolean;
  /** Count of accepted blocking findings for this reviewer. */
  acceptedBlockers: number;
};

/**
 * What the review synthesis recommends the run do next:
 * - `merge_ready`: both reviewers cleared and the #9 evidence is verified.
 * - `request_fix`: accepted blockers remain on a VERIFIED PR and the cycle budget
 *   has room — a fix cycle only ever targets verified PR coordinates.
 * - `needs_human`: ambiguous/contradictory reviewer output, or blockers with no
 *   cycle budget left.
 * - `hold`: a non-reviewer gate is not yet met and nothing can auto-fire — either
 *   no blockers but the PR is unverified, OR blockers exist but the PR is
 *   unverified (held until the operator re-verifies, then it becomes request_fix).
 */
export type MergeRecommendation = 'merge_ready' | 'request_fix' | 'needs_human' | 'hold';

/**
 * The computed merge-readiness gate for a run (issue #11). Merge-ready requires
 * BOTH reviewers cleared AND the verified #9 commit evidence AND no accepted
 * blockers remaining — a reviewer self-report alone is never enough. Every
 * unmet condition is listed in {@link reasons} so the dashboard explains the gate.
 */
export type MergeReadiness = {
  /** True only when every gate below is satisfied. */
  mergeReady: boolean;
  reviewerA: ReviewerGateState | null;
  reviewerB: ReviewerGateState | null;
  /** True when the latest #9 verification status is `verified`. */
  prVerified: boolean;
  /** True when no accepted blocking findings remain across reviewers. */
  noAcceptedBlockers: boolean;
  /** True when any reviewer result was ambiguous (forces needs-human). */
  anyAmbiguous: boolean;
  recommendation: MergeRecommendation;
  /** Human-readable, ordered list of why merge is (not) ready. */
  reasons: string[];
};

/**
 * The parsed-findings + merge-gate document for a run, stored on the run snapshot
 * and mirrored to `.godmode/runs/<run-id>/findings.json` (issue #11). Carries the
 * cycle it was produced in so a later re-review can be told apart from the first.
 */
export type RunFindings = {
  runId: string;
  /** Fix-loop cycle this synthesis was produced in. */
  cycle: number;
  results: ReviewerResult[];
  merge: MergeReadiness;
  /** Accepted blocking findings, flattened across reviewers, for the fix prompt. */
  acceptedBlockers: ReviewerFinding[];
  /**
   * PR URL of the verified PR this synthesis was computed against, bound here so
   * the fix handoff can be (re)composed without another `gh` round-trip.
   */
  prUrl?: string;
  /** ISO timestamp the synthesis was produced (main owns the clock). */
  fetchedAt: string;
};

/** Why a review synthesis was rejected, so the UI can explain precisely. */
export type ReviewSynthesisRejectionCode =
  | 'no_run'
  | 'invalid_state'
  // A loop-driven synthesis was preempted by an operator/manual dispatch, pause,
  // or mode toggle while its live verification was in flight (issue #39, blocker
  // B-1). Distinct from `invalid_state` so the controller treats it as a clean
  // operator hand-off rather than a stage failure.
  | 'preempted'
  | 'no_reviewers'
  | 'no_findings';

/**
 * Result of synthesizing the reviewer sessions for a run (issue #11): parse each
 * reviewer's captured output, re-run the #9 evidence gate, compute the merge gate,
 * persist the findings, and drive the run to the recommended next state. On
 * success the updated run snapshot is returned with the parsed findings and the
 * verification used as the gate; a fix handoff is included when the run advanced
 * to `builder_fixing` so the operator can review and send it.
 */
export type ReviewSynthesisResult =
  | {
      ok: true;
      run: RunSnapshot;
      findings: RunFindings;
      verification: CommitVerification;
      /** Rendered fix handoff, present only when the run advanced to builder_fixing. */
      fixHandoff?: BuilderHandoff;
    }
  | {
      ok: false;
      code: ReviewSynthesisRejectionCode;
      error: string;
      run: RunSnapshot | null;
      verification?: CommitVerification;
    };

// --- Automatic review/fix loop controller (issue #39) ------------------------

/**
 * Per-run mode of the deterministic review/fix loop controller (issue #39).
 * - `manual` (default): the controller takes no action; every stage stays
 *   operator-triggered exactly as before — the regression-safe default.
 * - `auto`: once a run has a verified PR, the controller chains reviewer launch →
 *   synthesis → fix handoff → re-verification → re-review by calling the same
 *   IPC-layer functions, so the operator supervises instead of clicking each step.
 *   Operator authority gates still hold: fix-send stays operator-approved by
 *   default, merge stays manual, and pause/cancel always preempt.
 */
export type LoopMode = 'manual' | 'auto';

/**
 * What the loop controller is currently doing or waiting on, as a stable machine
 * key (the human-readable form is {@link LoopState.label}).
 * - `inactive`: manual mode, or no run / pre-PR run — the loop is not driving.
 * - `working`: a stage action is in flight (launching reviewers, synthesizing…).
 * - `waiting_pr`: auto, but the run has not reached a verified PR yet.
 * - `waiting_reviewers`: waiting for both reviewer sessions to reach a terminal state.
 * - `waiting_fix_approval`: a fix cycle is open and `autoSendFix` is off — waiting
 *   for the operator to approve & send the composed fix handoff.
 * - `watching_fix_commit`: a fix is in progress; watching the PR for the new commit.
 * - `synthesis_hold`: synthesis held (e.g. an unverified PR); operator must act.
 * - `stopped`: the loop reached a stop state (merge_ready / needs_human /
 *   max_cycles_exceeded / terminal) — nothing more to auto-advance.
 * - `halted`: a stage failed; auto-advancement stopped until the run state changes
 *   or the operator re-arms the loop (no silent retry loops).
 */
export type LoopWaitReason =
  | 'inactive'
  | 'working'
  | 'waiting_pr'
  | 'waiting_reviewers'
  | 'waiting_fix_approval'
  | 'watching_fix_commit'
  | 'synthesis_hold'
  | 'stopped'
  | 'halted';

/**
 * Renderer-facing snapshot of the loop controller (issue #39), pushed on
 * `godmode:run:loop:changed` and returned by `godmode:run:loop:get`. Display-only:
 * the run state machine remains the single transition authority.
 */
export type LoopState = {
  mode: LoopMode;
  /** Stable machine key for what the controller is doing/waiting on. */
  waitingOn: LoopWaitReason;
  /** Human-readable description of {@link waitingOn} for the run control pane. */
  label: string;
  /** Visible reason the loop halted on a stage failure, when relevant. */
  lastError: string | null;
  /** ISO timestamp this loop state last changed (main owns the clock). */
  updatedAt: string;
};

/**
 * Result of setting the loop mode over IPC (issue #39). Returns the new loop
 * state on success; a typed rejection when there is no active run to attach a
 * mode to.
 */
export type LoopModeResult =
  | { ok: true; loop: LoopState }
  | { ok: false; code: 'no_run'; error: string };
