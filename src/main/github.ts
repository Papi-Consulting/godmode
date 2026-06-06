import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
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
} from '../shared/types.js';

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
    'number,title,state,updatedAt,headRefName,isDraft,reviewDecision,url,reviews,comments,statusCheckRollup',
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

/** Join a short list with commas and a trailing "and": ["a","b","c"] → "a, b, and c". */
function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
