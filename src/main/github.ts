import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  GithubActivePullRequest,
  GithubCheck,
  GithubComment,
  GithubIssue,
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
    message,
    repo: null,
    branch: null,
    activePr: null,
    issues: [],
    pulls: [],
    fetchedAt,
  };
}

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

async function fetchIssues(cwd: string): Promise<GithubIssue[]> {
  const result = await runGh(
    ['issue', 'list', '--state', 'open', '--limit', String(LIST_LIMIT), '--json', 'number,title,state,updatedAt,labels'],
    cwd,
  );
  if (!result.ok) return [];
  type Raw = { number: number; title: string; state: string; updatedAt: string; labels?: RawLabel[] };
  return parseJson<Raw[]>(result.stdout, []).map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    updatedAt: issue.updatedAt,
    labels: mapLabels(issue.labels),
  }));
}

async function fetchPulls(cwd: string): Promise<GithubPullRequest[]> {
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
  if (!result.ok) return [];
  return parseJson<GithubPullRequest[]>(result.stdout, []).map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    updatedAt: pr.updatedAt,
    headRefName: pr.headRefName,
    isDraft: Boolean(pr.isDraft),
    reviewDecision: pr.reviewDecision ?? '',
  }));
}

type RawCheck = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
};

function normalizeCheck(raw: RawCheck): GithubCheck {
  const name = raw.name ?? raw.context ?? 'check';
  // CheckRun uses status/conclusion; legacy StatusContext uses state.
  const conclusionRaw = (raw.conclusion || raw.state || raw.status || '').toUpperCase();
  let conclusion = conclusionRaw;
  if (conclusionRaw === 'IN_PROGRESS' || conclusionRaw === 'QUEUED' || conclusionRaw === 'PENDING' || conclusionRaw === 'EXPECTED') {
    conclusion = 'PENDING';
  }
  return { name, conclusion };
}

async function fetchActivePr(cwd: string, branch: string | null): Promise<GithubActivePullRequest | null> {
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
  if (!result.ok) return null;

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
  if (!raw) return null;

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

  return {
    status: 'ok',
    repo,
    branch,
    activePr,
    issues,
    pulls,
    fetchedAt,
  };
}
