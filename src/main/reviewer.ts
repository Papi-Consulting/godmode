import type {
  ReviewerHandoff,
  ReviewerLaunchPlan,
  ReviewerSessionStatus,
  RunAction,
  RunSnapshot,
  RunStatus,
} from '../shared/types.js';
import { DEFAULT_TEMPLATES, buildRoleResolutions, renderTemplate } from './agents.js';
import type { GodmodeConfig } from './config.js';

/**
 * Reviewer launch composition (issue #10). This binds a run's **verified** PR
 * into the exact pointer-first prompts GodMode would write into each configured
 * reviewer session, plus the concise role-signed marker comment GodMode posts on
 * the PR after a reviewer session runs. Producing a plan never launches anything
 * — it is the auditable artifact behind the dashboard's reviewer pane, mirroring
 * the builder handoff (issue #8).
 *
 * Like the builder handoff, reviewer prompts are deliberately **pointer-first**:
 * GodMode is an agent harness, not a prompt-injection layer, so each reviewer is
 * directed to read the operated project's canonical sources (AGENTS.md, its role
 * doc) and the live PR diff/threads/checks itself via `gh` — rather than pasting
 * the full diff or PR thread into the prompt. Every source is scoped to the
 * **operated project** (the repo opened in GodMode), never the GodMode app repo.
 *
 * Launch is gated on a real bound PR **and** the run's commit verification being
 * `verified` (issue #9): plain PR existence or an agent self-report is never
 * enough evidence to start reviewers.
 *
 * The core here is pure and Electron/PTY/`gh`-free so it can be unit-tested
 * directly; the launch/capture/comment mechanics live in `src/main/index.ts`.
 */

/** Coordinates of the verified PR reviewers are launched against. */
export type ReviewerPrTarget = {
  number: number;
  url: string;
  branch: string;
};

export type ComposeReviewerOptions = {
  projectName?: string;
  /** Verified PR coordinates, resolved from the #9 verification at launch time. */
  pr?: ReviewerPrTarget;
  /** Whether the run's commit verification passed (the #9 launch gate). */
  verified: boolean;
};

function deliveryFor(mode: string): ReviewerHandoff['delivery'] {
  return mode === 'oneshot' ? 'oneshot' : 'interactive';
}

/**
 * The pointer-first required-reading block appended to each reviewer prompt. It
 * directs a FRESH reviewer to read the operated project's own sources and the
 * live PR itself (never a pasted diff/thread) before reviewing, then names the
 * review target and how to sign findings.
 */
function groundingBlock(
  reviewerId: string,
  displayName: string,
  roleDoc: string | undefined,
  projectName: string | undefined,
  pr: ReviewerPrTarget,
  issueNumber: number | undefined,
): string {
  const project = projectName ? `"${projectName}"` : '(unnamed)';
  const lines: string[] = [];
  lines.push('== Reviewer handoff (GodMode) ==');
  lines.push(
    `Start a FRESH review session as ${reviewerId} (${displayName}) for the OPERATED PROJECT ${project} — ` +
      'the repo opened in GodMode and worked on by agents, NOT the GodMode app repo. Your working ' +
      "directory is that project's root. Read its canonical sources and the live PR yourself before reviewing:",
  );
  lines.push('- AGENTS.md — process, authority, and safety rules');
  if (roleDoc) lines.push(`- ${roleDoc} — your review role and what to block on`);
  lines.push(
    `- gh pr view ${pr.number} --json title,body,comments,reviews,statusCheckRollup — PR description, threads, and checks`,
  );
  lines.push(`- gh pr diff ${pr.number} — the code under review (read it yourself; it is not pasted here)`);
  if (issueNumber !== undefined) {
    lines.push(`- gh issue view ${issueNumber} --comments — the linked issue and its acceptance criteria`);
  }
  lines.push('');
  lines.push('Review target:');
  lines.push(`- PR #${pr.number}: ${pr.url}`);
  lines.push(`- Branch: ${pr.branch}`);
  lines.push('');
  lines.push(
    `Post your findings as PR comments on #${pr.number}, signed as ${reviewerId}. Block only per your role ` +
      'doc; do not approve on unverified claims.',
  );
  return lines.join('\n');
}

/**
 * Compose the reviewer launch plan for a run (or a mock when none is bound).
 * Pure: given a config, the run snapshot, and the verified PR coordinates, it
 * renders the configured `reviewer_start` template per reviewer, appends the
 * pointer-first grounding block, and reports whether launch is allowed.
 *
 * A plan is startable only when a real verified PR is bound (`verified` and a PR
 * number), there is at least one configured reviewer, and every reviewer's
 * template left no unresolved variables (e.g. a reviewer with no role doc stays
 * blocked rather than launching with an unbound `{{roleDoc}}`).
 */
export function composeReviewerLaunch(
  config: GodmodeConfig,
  run: RunSnapshot | null,
  options: ComposeReviewerOptions,
): ReviewerLaunchPlan {
  const { projectName, pr, verified } = options;
  const templates = { ...DEFAULT_TEMPLATES, ...config.commands };
  const resolutions = buildRoleResolutions(config);
  const issueNumber = run?.sourceType === 'github_issue' ? run.issueNumber : undefined;

  const reviewers: ReviewerHandoff[] = config.roles.reviewers.map((reviewer) => {
    const resolution = resolutions.find((role) => role.role === reviewer.pane);
    const agent = config.agents[reviewer.agent];
    const displayName = resolution?.displayName ?? reviewer.display_name;
    const roleDoc = reviewer.role_doc;

    const vars: Record<string, string> = { reviewerId: reviewer.id };
    if (pr) {
      vars.prNumber = String(pr.number);
      vars.prUrl = pr.url;
      vars.branch = pr.branch;
    }
    if (roleDoc) vars.roleDoc = roleDoc;
    const { prompt: templatePrompt, missingVariables } = renderTemplate(templates.reviewer_start, vars);

    const prompt = pr
      ? `${templatePrompt}\n\n${groundingBlock(reviewer.id, displayName, roleDoc, projectName, pr, issueNumber)}`
      : templatePrompt;

    return {
      reviewerId: reviewer.id,
      paneId: reviewer.pane,
      displayName,
      agentId: reviewer.agent,
      adapter: agent.adapter,
      delivery: deliveryFor(agent.mode),
      roleDoc,
      commandLine: `${agent.command} --project ${projectName ?? '<selected-project>'}`,
      prompt,
      missingVariables,
    };
  });

  const isMock = run === null || pr === undefined;
  const allResolved = reviewers.length > 0 && reviewers.every((r) => r.missingVariables.length === 0);
  const canStart = !isMock && verified && allResolved;

  let blockedReason: string | undefined;
  if (isMock) {
    blockedReason =
      'No verified PR is bound. Open a PR for this run and pass the branch/PR/commit verification (#9) before launching reviewers.';
  } else if (!verified) {
    blockedReason =
      'The PR is not verified. Run the commit-verification gate (#9) and resolve it before launching reviewers — plain PR existence is not enough evidence.';
  } else if (reviewers.length === 0) {
    blockedReason = 'No reviewers are configured for this project.';
  } else if (!allResolved) {
    const blocked = reviewers
      .filter((r) => r.missingVariables.length > 0)
      .map((r) => `${r.reviewerId} (${r.missingVariables.join(', ')})`)
      .join('; ');
    blockedReason = `Unresolved reviewer template variables: ${blocked}.`;
  }

  return {
    isMock,
    prNumber: pr?.number,
    prUrl: pr?.url,
    branch: pr?.branch,
    reviewers,
    canStart,
    blockedReason,
  };
}

/** Inputs for the role-signed marker comment GodMode posts per reviewer. */
export type ReviewerCommentInput = {
  reviewerId: string;
  displayName: string;
  roleDoc?: string;
  prNumber: number;
  branch?: string;
  /** Project-relative captured-output artifact path. */
  artifactRelPath: string;
};

/**
 * The concise, role-signed marker comment GodMode posts on a PR after a reviewer
 * session runs (issue #10). It is deliberately a **factual marker**, not a
 * verdict: it records that the reviewer session ran and where its output was
 * captured, and explicitly disclaims that it asserts merge-readiness. The
 * reviewer's actual findings are the reviewer's own PR comments — GodMode never
 * pastes captured agent output here or treats a self-report as verified evidence.
 */
/**
 * How a reviewer launch relates to the run state machine for a given status:
 * the forward action that advances the run when starting fresh, an idempotent
 * relaunch (no transition) while reviewers are already running, or disallowed.
 *
 * Reviewers launch at two points in the lifecycle — after the first PR
 * (`pr_opened → start_reviewers → reviewers_running`) and after a builder fix
 * (`fix_pushed → rerun_reviewers → reviewers_rerunning`). Both the initial-launch
 * statuses and their already-running relaunch statuses are allowed, so a fix
 * cycle can re-review the new commit rather than advancing to synthesis with
 * stale reviewer evidence.
 */
export type ReviewerLaunchTransition =
  | { allowed: true; action: Extract<RunAction, 'start_reviewers' | 'rerun_reviewers'>; relaunch: false }
  | { allowed: true; action: null; relaunch: true }
  | { allowed: false };

export function reviewerLaunchTransition(status: RunStatus): ReviewerLaunchTransition {
  switch (status) {
    case 'pr_opened':
      return { allowed: true, action: 'start_reviewers', relaunch: false };
    case 'fix_pushed':
      return { allowed: true, action: 'rerun_reviewers', relaunch: false };
    case 'reviewers_running':
    case 'reviewers_rerunning':
      return { allowed: true, action: null, relaunch: true };
    default:
      return { allowed: false };
  }
}

/**
 * What a reviewer session's exit means for its tracked state:
 * - `keep_failed`: the session was already `failed` mid-run (e.g. a capture
 *   failure); record the exit code but never flip it back to a success state.
 * - `failed`: a non-zero exit — the reviewer command itself failed, so it must be
 *   surfaced visibly and must NOT auto-post a marker (which the UI reads as the
 *   confirmed-success state).
 * - `completed`: a clean (zero) exit — mark completed and auto-post the marker.
 */
export type ReviewerExitOutcome =
  | { kind: 'keep_failed' }
  | { kind: 'failed'; error: string }
  | { kind: 'completed' };

/**
 * Whether a reviewer session is in a state where posting (or re-posting) its
 * role-signed marker comment is allowed. Only sessions that actually ran are
 * postable: a clean-exited `completed` session, an already-`comment_posted` one
 * (re-post), or a still-live `running` interactive reviewer the operator chooses
 * to mark. A `failed` session (launch/capture/non-zero exit) or one still
 * `launching` is NOT postable — otherwise the operator override could convert a
 * failed reviewer into the confirmed-success `comment_posted` state, breaking the
 * "failures never collapse into complete/comment-posted" contract.
 */
const POSTABLE_REVIEWER_STATUSES: readonly ReviewerSessionStatus[] = ['completed', 'comment_posted', 'running'];

export function canPostReviewerMarker(status: ReviewerSessionStatus): boolean {
  return POSTABLE_REVIEWER_STATUSES.includes(status);
}

/**
 * Whether the live run/operated-project context has drifted from what an async
 * reviewer operation captured before it `await`ed a live `gh`/`git` call. The
 * operator can switch projects, clear the run, or start another run mid-await
 * (which clears the current run and kills sessions), so every reviewer side
 * effect after an await — spawning a PTY, writing an artifact, patching reviewer
 * state, emitting a snapshot — must first confirm it is still acting on the same
 * run in the same root. A stale context (no current run, a different run id, or a
 * changed root) means the operation must abort without mutating whatever run is
 * now current. Pure so both the launch and comment-post guards share one tested
 * predicate.
 */
export function isReviewerRunContextStale(
  current: { runId: string | null; root: string },
  captured: { runId: string; root: string },
): boolean {
  return current.runId !== captured.runId || current.root !== captured.root;
}

export function resolveReviewerExit(status: ReviewerSessionStatus, exitCode: number): ReviewerExitOutcome {
  if (status === 'failed') return { kind: 'keep_failed' };
  if (exitCode !== 0) {
    return { kind: 'failed', error: `Reviewer session exited with code ${exitCode}; no marker comment posted.` };
  }
  return { kind: 'completed' };
}

export function reviewerCommentBody(input: ReviewerCommentInput): string {
  const lines: string[] = [];
  lines.push(`**GodMode · ${input.displayName}** — \`${input.reviewerId}\``);
  lines.push('');
  const branch = input.branch ? ` on branch \`${input.branch}\`` : '';
  lines.push(`Automated review session ran for PR #${input.prNumber}${branch}.`);
  if (input.roleDoc) lines.push(`Role doc: \`${input.roleDoc}\`.`);
  lines.push(`Captured output (local): \`${input.artifactRelPath}\`.`);
  lines.push('');
  lines.push(
    '_Posted by the GodMode harness. This marks that the reviewer session ran; the reviewer’s own ' +
      'findings are its separate PR comments. It does not assert merge-readiness._',
  );
  return lines.join('\n');
}
