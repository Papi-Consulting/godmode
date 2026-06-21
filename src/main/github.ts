import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  CommitVerification,
  ExpectedCommitSource,
  GithubActivePullRequest,
  GithubCheck,
  GithubComment,
  GithubIssue,
  GithubIssueDetail,
  GithubIssueDetailResult,
  GithubPullRequest,
  GithubRepo,
  GithubReview,
  GithubState,
  GithubStatus,
  PrDiscoveryResult,
} from '../shared/types.js';
import { deriveVerification, type VerificationEvidence, type VerifiedPr } from './verify.js';
import { matchPrCandidates, selectPrCandidate, type DiscoveryContext, type DiscoveryPr } from './discovery.js';

const execFileAsync = promisify(execFile);

const LIST_LIMIT = 10;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Minimal, read-only environment for `gh`/`git`. PATH locates the binaries, HOME
 * lets `gh` read its stored credentials, and any GH_ / GITHUB_TOKEN values are
 * forwarded so token-based auth keeps working. Nothing here can mutate remote
 * state — callers only ever pass read subcommands (view/list).
 */
function buildGithubEnv(): Record<string, string> {
  const keys = [
    'HOME',
    'PATH',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'XDG_CONFIG_HOME',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_HOST',
    'GH_CONFIG_DIR',
    'GH_ENTERPRISE_TOKEN',
  ];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

type RunOk = { ok: true; stdout: string };
type RunErr = { ok: false; status: Exclude<GithubStatus, 'ok'>; message: string };
type RunResult = RunOk | RunErr;

function classifyError(error: unknown): RunErr {
  const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };

  if (err?.code === 'ENOENT') {
    return {
      ok: false,
      status: 'gh_missing',
      message: 'GitHub CLI (`gh`) was not found on PATH. Install it from https://cli.github.com to show live GitHub state.',
    };
  }

  const stderr = (err?.stderr ?? '').trim();
  const haystack = `${stderr}\n${err?.message ?? ''}`.toLowerCase();

  if (
    haystack.includes('auth login') ||
    haystack.includes('not logged in') ||
    haystack.includes('authentication') ||
    haystack.includes('http 401') ||
    haystack.includes('gh auth')
  ) {
    return {
      ok: false,
      status: 'unauthenticated',
      message: 'GitHub CLI is not authenticated. Run `gh auth login` in a terminal, then refresh.',
    };
  }

  if (
    haystack.includes('not a git repository') ||
    haystack.includes('no git remotes') ||
    haystack.includes('none of the git remotes') ||
    haystack.includes('no remotes') ||
    haystack.includes('could not find any remote') ||
    haystack.includes('no github')
  ) {
    return {
      ok: false,
      status: 'no_repo',
      message: 'The selected project has no GitHub remote. Open a repo cloned from GitHub to see issues and PRs.',
    };
  }

  return {
    ok: false,
    status: 'error',
    message: stderr || (err?.message ?? 'Failed to query GitHub.'),
  };
}

async function runGh(args: string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      cwd,
      env: buildGithubEnv(),
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, stdout };
  } catch (error) {
    return classifyError(error);
  }
}

function emptyState(fetchedAt: string, status: GithubStatus, message?: string): GithubState {
  return {
    status,
    partial: false,
    message,
    repo: null,
    branch: null,
    activePr: null,
    issues: [],
    pulls: [],
    fetchedAt,
  };
}

/**
 * Carries a sub-query's data alongside whether the underlying `gh` call failed.
 * Lets `getGithubState` distinguish "genuinely empty" from "query failed" so a
 * partial snapshot is never reported as fully live. `failed` is only true for an
 * actual error — a legitimately absent active PR is `{ value: null, failed: false }`.
 */
type Fetched<T> = { value: T; failed: boolean };

function parseJson<T>(stdout: string, fallback: T): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return fallback;
  }
}

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd,
      env: buildGithubEnv(),
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the operated project's local `HEAD` commit SHA, or null when it can't
 * be read (empty repo, not a git repo, detached with no commit). Used as the
 * fallback "expected commit" when a run has not recorded one from the builder
 * phase. Read-only.
 */
async function headCommit(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      env: buildGithubEnv(),
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    const sha = stdout.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the tip commit of a local branch, or null when it can't be read (the
 * branch does not exist locally, not a git repo). Used as the "expected commit"
 * for an isolated run (issue #41): the run's working branch lives on the worktree,
 * so the primary checkout's `HEAD` is the wrong thing to verify — the branch tip is
 * correct for both shared and worktree runs. Read-only.
 */
async function branchCommit(cwd: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      {
        cwd,
        env: buildGithubEnv(),
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      },
    );
    const sha = stdout.trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

type RawLabel = { name?: string; color?: string };

function mapLabels(labels: RawLabel[] | undefined): { name: string; color: string }[] {
  return (labels ?? []).map((label) => ({ name: label.name ?? '', color: label.color ?? '' }));
}

async function fetchIssues(cwd: string): Promise<Fetched<GithubIssue[]>> {
  const result = await runGh(
    ['issue', 'list', '--state', 'open', '--limit', String(LIST_LIMIT), '--json', 'number,title,state,updatedAt,labels'],
    cwd,
  );
  if (!result.ok) return { value: [], failed: true };
  type Raw = { number: number; title: string; state: string; updatedAt: string; labels?: RawLabel[] };
  const value = parseJson<Raw[]>(result.stdout, []).map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    updatedAt: issue.updatedAt,
    labels: mapLabels(issue.labels),
  }));
  return { value, failed: false };
}

async function fetchPulls(cwd: string): Promise<Fetched<GithubPullRequest[]>> {
  const result = await runGh(
    [
      'pr',
      'list',
      '--state',
      'all',
      '--limit',
      String(LIST_LIMIT),
      '--json',
      'number,title,state,updatedAt,headRefName,isDraft,reviewDecision',
    ],
    cwd,
  );
  if (!result.ok) return { value: [], failed: true };
  const value = parseJson<GithubPullRequest[]>(result.stdout, []).map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    updatedAt: pr.updatedAt,
    headRefName: pr.headRefName,
    isDraft: Boolean(pr.isDraft),
    reviewDecision: pr.reviewDecision ?? '',
  }));
  return { value, failed: false };
}

type RawCheck = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
};

// Still-running states (CheckRun.status / legacy StatusState) that resolve to PENDING.
const PENDING_STATES = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'EXPECTED', 'WAITING', 'REQUESTED']);
// Terminal states that are genuinely non-blocking and count as passing for a gate.
const PASSING_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/**
 * Collapse the many raw GitHub check states into the closed set the renderer
 * buckets on: SUCCESS / PENDING / FAILURE. Anything terminal that is not a
 * clear pass (FAILURE, ERROR, CANCELLED, TIMED_OUT, ACTION_REQUIRED,
 * STARTUP_FAILURE, STALE, or any unknown value) normalizes to FAILURE so the
 * manual merge gate can never hide a blocked check behind an unrecognized
 * conclusion.
 */
function normalizeCheck(raw: RawCheck): GithubCheck {
  const name = raw.name ?? raw.context ?? 'check';
  // CheckRun uses status/conclusion; legacy StatusContext uses state.
  const conclusionRaw = (raw.conclusion || raw.state || raw.status || '').toUpperCase();
  let conclusion: string;
  if (PENDING_STATES.has(conclusionRaw)) {
    conclusion = 'PENDING';
  } else if (PASSING_STATES.has(conclusionRaw)) {
    conclusion = conclusionRaw;
  } else {
    conclusion = 'FAILURE';
  }
  return { name, conclusion };
}

async function fetchActivePr(cwd: string, branch: string | null): Promise<Fetched<GithubActivePullRequest | null>> {
  // `gh pr view` with no positional argument resolves the PR for the current
  // branch; it exits non-zero when none exists, which we treat as "no active PR"
  // rather than an error.
  const args = ['pr', 'view'];
  if (branch) args.push(branch);
  args.push(
    '--json',
    // Issue #61: `headRefOid` so the refresh observes the live PR head and main can
    // reconcile it against the run's latest recorded verification (stale on drift).
    'number,title,state,updatedAt,headRefName,headRefOid,isDraft,reviewDecision,url,reviews,comments,statusCheckRollup',
  );
  const result = await runGh(args, cwd);
  if (!result.ok) {
    // "no PR for this branch" is the expected non-error exit — not a failed
    // query. Anything else (timeout, bad field, scopes, network) is a real
    // failure that must mark the snapshot partial rather than show empty.
    const noPr = result.message.toLowerCase().includes('no pull requests found') ||
      result.message.toLowerCase().includes('no open pull requests') ||
      result.message.toLowerCase().includes('no closed pull requests');
    return { value: null, failed: !noPr };
  }

  type RawReview = { author?: { login?: string }; state?: string; body?: string; submittedAt?: string };
  type RawComment = { author?: { login?: string }; body?: string; createdAt?: string };
  type Raw = {
    number: number;
    title: string;
    state: string;
    updatedAt: string;
    headRefName: string;
    headRefOid?: string;
    isDraft?: boolean;
    reviewDecision?: string;
    url?: string;
    reviews?: RawReview[];
    comments?: RawComment[];
    statusCheckRollup?: RawCheck[];
  };

  const raw = parseJson<Raw | null>(result.stdout, null);
  // gh exited 0 but output didn't parse — an anomaly, not an absent PR.
  if (!raw) return { value: null, failed: true };

  const reviews: GithubReview[] = (raw.reviews ?? [])
    // Keep only reviews that carry signal (a verdict or a body comment).
    .filter((review) => (review.state && review.state !== 'PENDING') || (review.body ?? '').trim().length > 0)
    .map((review) => ({
      author: review.author?.login ?? 'unknown',
      state: review.state ?? 'COMMENTED',
      body: review.body ?? '',
      submittedAt: review.submittedAt ?? '',
    }));

  const comments: GithubComment[] = (raw.comments ?? []).map((comment) => ({
    author: comment.author?.login ?? 'unknown',
    body: comment.body ?? '',
    createdAt: comment.createdAt ?? '',
  }));

  const checks: GithubCheck[] = (raw.statusCheckRollup ?? []).map(normalizeCheck);

  return {
    value: {
      number: raw.number,
      title: raw.title,
      state: raw.state,
      updatedAt: raw.updatedAt,
      headRefName: raw.headRefName,
      headSha: raw.headRefOid ?? '',
      isDraft: Boolean(raw.isDraft),
      reviewDecision: raw.reviewDecision ?? '',
      url: raw.url ?? '',
      reviews,
      comments,
      checks,
    },
    failed: false,
  };
}

/**
 * Produce a read-only GitHub snapshot for the given project root. This shells
 * out to `gh`/`git` with read subcommands only and never throws: every failure
 * mode is folded into the returned `status`/`message` so the renderer can show
 * actionable guidance. `fetchedAt` is supplied by the caller (the main process
 * owns the clock) to keep this function deterministic.
 */
export async function getGithubState(projectRoot: string, fetchedAt: string): Promise<GithubState> {
  const cwd = path.resolve(projectRoot);

  // `repo view` doubles as our auth/remote probe: if it fails we know why and
  // can stop before issuing the heavier list queries.
  const repoResult = await runGh(['repo', 'view', '--json', 'owner,name,defaultBranchRef'], cwd);
  if (!repoResult.ok) {
    return emptyState(fetchedAt, repoResult.status, repoResult.message);
  }

  type RawRepo = { owner?: { login?: string }; name?: string; defaultBranchRef?: { name?: string } };
  const rawRepo = parseJson<RawRepo>(repoResult.stdout, {});
  const repo: GithubRepo = {
    owner: rawRepo.owner?.login ?? '',
    name: rawRepo.name ?? '',
    defaultBranch: rawRepo.defaultBranchRef?.name ?? '',
  };

  const branch = await currentBranch(cwd);

  const [issues, pulls, activePr] = await Promise.all([
    fetchIssues(cwd),
    fetchPulls(cwd),
    fetchActivePr(cwd, branch),
  ]);

  // The repo probe succeeded, but an individual sub-query can still fail (a
  // timeout, a field/scopes error, a transient network blip). Surface that as a
  // partial snapshot so the UI never presents incomplete data as fully live.
  const failed: string[] = [];
  if (issues.failed) failed.push('issues');
  if (pulls.failed) failed.push('pull requests');
  if (activePr.failed) failed.push('the active PR');
  const partial = failed.length > 0;

  return {
    status: 'ok',
    partial,
    message: partial
      ? `Showing a partial snapshot — could not load ${formatList(failed)}. Refresh to retry.`
      : undefined,
    repo,
    branch,
    activePr: activePr.value,
    issues: issues.value,
    pulls: pulls.value,
    fetchedAt,
  };
}

/**
 * Fetch full detail for a single issue (body, comments, URL, labels) for the
 * given project root. Like {@link getGithubState} this shells out to `gh` with a
 * read-only subcommand and never throws: failures fold into `status`/`message`
 * with a null `issue`. Used to ground a builder handoff prompt in the real task,
 * since the issue *list* only carries summary metadata.
 */
export async function getIssueDetail(
  projectRoot: string,
  issueNumber: number,
): Promise<GithubIssueDetailResult> {
  const cwd = path.resolve(projectRoot);
  const result = await runGh(
    ['issue', 'view', String(issueNumber), '--json', 'number,title,body,url,state,updatedAt,labels,comments'],
    cwd,
  );
  if (!result.ok) {
    return { status: result.status, message: result.message, issue: null };
  }

  type RawComment = { author?: { login?: string }; body?: string; createdAt?: string };
  type Raw = {
    number?: number;
    title?: string;
    body?: string;
    url?: string;
    state?: string;
    updatedAt?: string;
    labels?: RawLabel[];
    comments?: RawComment[];
  };
  const raw = parseJson<Raw | null>(result.stdout, null);
  if (!raw || typeof raw.number !== 'number') {
    return { status: 'error', message: `Could not read issue #${issueNumber} detail.`, issue: null };
  }

  const comments: GithubComment[] = (raw.comments ?? []).map((comment) => ({
    author: comment.author?.login ?? 'unknown',
    body: comment.body ?? '',
    createdAt: comment.createdAt ?? '',
  }));

  const issue: GithubIssueDetail = {
    number: raw.number,
    title: raw.title ?? '',
    body: raw.body ?? '',
    url: raw.url ?? '',
    state: raw.state ?? '',
    updatedAt: raw.updatedAt ?? '',
    labels: mapLabels(raw.labels),
    comments,
  };
  return { status: 'ok', issue };
}

/**
 * Outcome of fetching a PR's comments. Mirrors the never-throw contract: every
 * failure folds into `status`/`message` with an empty `comments` list, so
 * synthesis can treat a failed fetch as "no fallback verdicts available" without
 * crashing or guessing.
 */
export type PrCommentsResult = {
  status: GithubStatus;
  message?: string;
  comments: GithubComment[];
};

/**
 * Fetch a PR's issue comments for the operated project (issue #60). Read-only
 * (`gh pr view <n> --json comments`), scoped to the operated-project root, and
 * never throws. Used by review synthesis to parse role-signed fallback verdict
 * comments when formal GitHub reviews are unavailable (e.g. the same authenticated
 * account owns the PR branch in a dogfood run). `fetchedAt` is not needed — the
 * caller already owns the clock for the surrounding synthesis.
 */
export async function getPrComments(projectRoot: string, prNumber: number): Promise<PrCommentsResult> {
  const cwd = path.resolve(projectRoot);
  const result = await runGh(['pr', 'view', String(prNumber), '--json', 'comments'], cwd);
  if (!result.ok) {
    return { status: result.status, message: result.message, comments: [] };
  }
  type RawComment = { author?: { login?: string }; body?: string; createdAt?: string };
  type Raw = { comments?: RawComment[] };
  const raw = parseJson<Raw | null>(result.stdout, null);
  const comments: GithubComment[] = (raw?.comments ?? []).map((comment) => ({
    author: comment.author?.login ?? 'unknown',
    body: comment.body ?? '',
    createdAt: comment.createdAt ?? '',
  }));
  return { status: 'ok', comments };
}

/** Options for the commit-verification gate. */
export type CommitVerificationOptions = {
  /**
   * The run-recorded expected commit from the builder phase, if any. When
   * provided it is the SHA verified against the remote PR; when omitted, the
   * operated project's local `HEAD` is used as the fallback.
   */
  expectedCommit?: string;
  /**
   * The run's working branch to verify against (issue #41). When a run is isolated
   * in a worktree the primary checkout stays on its own branch, so the branch
   * cannot be read from the project root — the caller passes the run's branch.
   * When omitted, the operated project's current branch is used (shared behavior).
   */
  branch?: string;
};

/**
 * Fetch the PR matched to a branch with the commit/check evidence the
 * verification gate compares. `gh pr view <branch>` exits non-zero when no PR
 * exists, which is treated as "no PR" (`{ value: null, failed: false }`) rather
 * than an error — every other failure marks the evidence partial.
 */
async function fetchVerificationPr(cwd: string, branch: string | null): Promise<Fetched<VerifiedPr | null>> {
  const args = ['pr', 'view'];
  if (branch) args.push(branch);
  args.push('--json', 'number,state,url,headRefName,headRefOid,commits,statusCheckRollup');
  const result = await runGh(args, cwd);
  if (!result.ok) {
    const lower = result.message.toLowerCase();
    const noPr =
      lower.includes('no pull requests found') ||
      lower.includes('no open pull requests') ||
      lower.includes('no closed pull requests');
    return { value: null, failed: !noPr };
  }

  type RawCommit = { oid?: string };
  type Raw = {
    number?: number;
    state?: string;
    url?: string;
    headRefName?: string;
    headRefOid?: string;
    commits?: RawCommit[];
    statusCheckRollup?: RawCheck[];
  };
  const raw = parseJson<Raw | null>(result.stdout, null);
  if (!raw || typeof raw.number !== 'number') return { value: null, failed: true };

  const pr: VerifiedPr = {
    number: raw.number,
    state: (raw.state ?? '').toUpperCase(),
    url: raw.url ?? '',
    headRefName: raw.headRefName ?? '',
    headSha: raw.headRefOid ?? '',
    commits: (raw.commits ?? []).map((commit) => commit.oid ?? '').filter(Boolean),
    checks: (raw.statusCheckRollup ?? []).map(normalizeCheck),
  };
  return { value: pr, failed: false };
}

/**
 * Run the builder branch/PR/commit verification gate for the operated project
 * (issue #9). This is GodMode's evidence layer: it resolves the branch and the
 * expected commit (run-recorded, else local `HEAD`), reads the PR for that branch
 * from `gh` with its commit list and checks, and derives a deterministic
 * {@link CommitVerification} via {@link deriveVerification}. Like the rest of this
 * module it shells out read-only and never throws — every failure folds into the
 * returned status (`needs_refresh`/`needs_human`) and `partial` flag so the UI
 * never presents a failed query as a confident result. `fetchedAt` is supplied by
 * the caller so the function stays deterministic.
 */
export async function getCommitVerification(
  projectRoot: string,
  options: CommitVerificationOptions,
  fetchedAt: string,
): Promise<CommitVerification> {
  const cwd = path.resolve(projectRoot);

  // A run-recorded branch wins (issue #41: an isolated run's branch lives in its
  // worktree, not the primary checkout); otherwise read the project's current branch.
  const branch = options.branch ?? (await currentBranch(cwd));

  // Run-recorded commit wins. Otherwise resolve the tip of the run's working
  // branch (issue #41): in worktree mode the primary checkout intentionally stays
  // on another branch, so `git rev-parse HEAD` from the project root would verify
  // the wrong commit and could reject a valid PR as missing_remote_commit. The
  // branch tip is correct for both shared and worktree runs (in shared mode it *is*
  // HEAD). Only when no branch is known, or its tip is unreadable, do we fall back
  // to local HEAD. The source is surfaced so the operator can see what was checked.
  let expectedCommit: string | null;
  let expectedCommitSource: ExpectedCommitSource;
  if (options.expectedCommit) {
    expectedCommit = options.expectedCommit;
    expectedCommitSource = 'run_recorded';
  } else if (branch) {
    expectedCommit = await branchCommit(cwd, branch);
    if (expectedCommit) {
      expectedCommitSource = 'branch_tip';
    } else {
      expectedCommit = await headCommit(cwd);
      expectedCommitSource = expectedCommit ? 'local_head' : 'unknown';
    }
  } else {
    expectedCommit = await headCommit(cwd);
    expectedCommitSource = expectedCommit ? 'local_head' : 'unknown';
  }

  const pr = await fetchVerificationPr(cwd, branch);

  const evidence: VerificationEvidence = {
    branch,
    expectedCommit,
    expectedCommitSource,
    queryFailed: pr.failed,
    pr: pr.value,
  };

  const verification = deriveVerification(evidence, fetchedAt);

  // When the PR query genuinely failed, surface the underlying `gh` reason in
  // place of the generic needs_refresh copy so the operator knows whether to
  // authenticate, install `gh`, or just retry.
  if (pr.failed) {
    const probe = await runGh(['repo', 'view', '--json', 'name'], cwd);
    if (!probe.ok) verification.message = probe.message;
  }

  return verification;
}

/** How many recent PRs the discovery query inspects (read-only). */
const DISCOVERY_LIMIT = 20;

/**
 * Discover the builder's PR for a `builder_running` run from GitHub evidence
 * (issue #38). Lists the operated project's open PRs with the fields the
 * evidence-bound `open_pr` transition records (number, branch, head SHA, author,
 * created-at, title/body for matching), then classifies candidates via the pure
 * {@link matchPrCandidates}: PRs that link the run's issue (`#N`), plus a
 * conservative recent-unlinked fallback for PRs created at/after the handoff send.
 *
 * Read-only: only `gh pr list … --json …` is issued, scoped to the operated
 * project root (never the GodMode app repo unless dogfooding makes them the same).
 * Like the rest of this module it never throws — every failure folds into the
 * returned `status`/`message` with empty candidates so the run stays in
 * `builder_running` and the operator sees actionable, non-fatal guidance.
 * `fetchedAt` is supplied by the caller so the function stays deterministic.
 */
export async function discoverRunPrCandidates(
  projectRoot: string,
  context: DiscoveryContext,
  fetchedAt: string,
): Promise<PrDiscoveryResult> {
  const cwd = path.resolve(projectRoot);
  const result = await runGh(
    [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      String(DISCOVERY_LIMIT),
      '--json',
      'number,title,body,url,headRefName,headRefOid,author,createdAt',
    ],
    cwd,
  );
  if (!result.ok) {
    return {
      status: result.status,
      message: result.message,
      issueNumber: context.issueNumber,
      candidates: [],
      recommendedPrNumber: null,
      fetchedAt,
    };
  }

  type RawAuthor = { login?: string };
  type Raw = {
    number?: number;
    title?: string;
    body?: string;
    url?: string;
    headRefName?: string;
    headRefOid?: string;
    author?: RawAuthor;
    createdAt?: string;
  };
  const prs: DiscoveryPr[] = parseJson<Raw[]>(result.stdout, [])
    .filter((pr): pr is Raw & { number: number } => typeof pr.number === 'number')
    .map((pr) => ({
      number: pr.number,
      title: pr.title ?? '',
      body: pr.body ?? '',
      url: pr.url ?? '',
      headRefName: pr.headRefName ?? '',
      headSha: pr.headRefOid ?? '',
      author: pr.author?.login ?? '',
      createdAt: pr.createdAt ?? '',
    }));

  const candidates = matchPrCandidates(prs, context);
  const selection = selectPrCandidate(candidates);
  return {
    status: 'ok',
    issueNumber: context.issueNumber,
    candidates,
    recommendedPrNumber: selection.kind === 'unambiguous' ? selection.candidate.number : null,
    fetchedAt,
  };
}

/** Outcome of posting a PR comment — the one mutating `gh` call in this module. */
export type PostCommentResult =
  | { ok: true; url: string }
  | { ok: false; status: Exclude<GithubStatus, 'ok'>; message: string };

/**
 * Post a comment to a pull request via `gh pr comment <N> --body <body>` (issue
 * #10). This is the **only** mutating GitHub call in GodMode — every other path
 * is read-only — so it is isolated and explicitly named. `execFile` passes the
 * body as a single argv element (no shell), so there is no quoting/injection
 * surface despite the body being free-form markdown. Like the read paths it never
 * throws: failures fold into a classified `status`/`message` so the caller can
 * mark the reviewer session `failed` visibly instead of silently dropping the
 * post. On success `gh` prints the new comment URL, which is returned for linking.
 */
export async function postPrComment(
  projectRoot: string,
  prNumber: number,
  body: string,
): Promise<PostCommentResult> {
  const cwd = path.resolve(projectRoot);
  try {
    const { stdout } = await execFileAsync('gh', ['pr', 'comment', String(prNumber), '--body', body], {
      cwd,
      env: buildGithubEnv(),
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, url: stdout.trim() };
  } catch (error) {
    const classified = classifyError(error);
    return { ok: false, status: classified.status, message: classified.message };
  }
}

/** Join a short list with commas and a trailing "and": ["a","b","c"] → "a, b, and c". */
function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
