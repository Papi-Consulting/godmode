export type AgentRole = 'head' | 'builder' | 'reviewer_a' | 'reviewer_b';

export type AgentMode = 'interactive' | 'oneshot' | 'oneshot_or_interactive';

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
  adapter: 'cli' | 'mcp' | 'acp' | 'custom';
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
  | 'paused'
  | 'cancelled'
  | 'needs_human'
  | 'agent_failed'
  | 'max_cycles_exceeded';
