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

export type ProjectState = {
  /** Absolute, resolved project root, or null when none/invalid. */
  root: string | null;
  /** Display name (basename of the root). */
  name: string | null;
  harness: ProjectHarnessState;
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
 * A read-only snapshot of the selected repo's GitHub state. Always returns a
 * value (never throws across IPC); `status` carries why a partial/empty result
 * was produced so the UI can render user-readable guidance.
 */
export type GithubState = {
  status: GithubStatus;
  /** User-readable guidance, set whenever `status` is not `ok`. */
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
