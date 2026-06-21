import type {
  AgentMode,
  AgentRole,
  ReviewerHandoff,
  ReviewerLaunchPlan,
  ReviewerSessionState,
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

/** The reviewer panes, by their generic role ids (not vendor-specific). */
export function isReviewerPane(paneId: AgentRole): boolean {
  return paneId === 'reviewer_a' || paneId === 'reviewer_b';
}

/**
 * The actionable message shown in a reviewer pane when its generic Start/Restart
 * control is refused. It points the operator at the run-bound launch path rather
 * than failing as a generic app error.
 */
export const ONESHOT_REVIEWER_GENERIC_START_MESSAGE =
  'This reviewer runs one-shot and needs its full review prompt at process start. ' +
  'Launch reviewers from a verified PR via the run-bound "Start reviewers" action — ' +
  'the generic Start/Restart control would spawn the reviewer command with no prompt ' +
  '(e.g. an empty `codex exec` that exits immediately) and produce no review.';

export type GenericPaneLaunchDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Whether the generic pane Start/Restart control (issue #58) may spawn a session
 * for this pane without a run-bound prompt. A **one-shot reviewer** needs its full
 * review prompt at process start — the run-bound reviewer launch
 * (`handleStartReviewers`) delivers it as a launch argument. Starting such a pane
 * generically would spawn the configured reviewer command with no prompt (for the
 * default `codex exec` reviewer, it exits immediately with a no-prompt error),
 * making the pane look actionable while producing no review. That path is refused
 * before spawn with an actionable message instead.
 *
 * Interactive reviewers (and every non-reviewer pane) keep their generic launch —
 * an interactive reviewer is a normal live shell the operator may start directly.
 *
 * Keys off role + mode only (no vendor branch): the gate applies to any one-shot
 * reviewer-capable agent, not just the default Codex reviewer.
 */
export function classifyGenericPaneLaunch(
  paneId: AgentRole,
  mode: AgentMode,
): GenericPaneLaunchDecision {
  if (isReviewerPane(paneId) && mode === 'oneshot') {
    return { allowed: false, reason: ONESHOT_REVIEWER_GENERIC_START_MESSAGE };
  }
  return { allowed: true };
}

/**
 * The launch arguments a run-bound reviewer session receives at process start
 * (issue #10/#58). A one-shot reviewer reads its prompt and exits, so the
 * pointer-first review prompt MUST be present at spawn (passed as argv) rather
 * than written into the PTY afterward, which could no-op against an already-exited
 * process and lose the prompt. Interactive reviewers stay live and receive the
 * prompt over the PTY instead, so they take no launch argument here.
 *
 * Centralizing this keeps the "one-shot reviewer always launches with its prompt"
 * invariant in one tested place, away from Electron.
 */
export function reviewerLaunchArgs(mode: AgentMode, prompt: string): string[] | undefined {
  return mode === 'oneshot' ? [prompt] : undefined;
}

/** Inputs to {@link reviewerAttemptId}. */
export type ReviewerAttemptIdInput = {
  cycle: number;
  /** Short (or full) PR head SHA the attempt targets. */
  headShaShort: string;
  reviewerId: string;
  /** ISO launch timestamp; its digits make the id unique across same-head relaunches. */
  launchedAt: string;
};

/**
 * Compose a reviewer attempt's first-class id (issue #59):
 * `<cycle>-<shortSha>-<reviewerId>-<timestamp>`. Every character outside
 * `[A-Za-z0-9_-]` is mapped to `_` so the id is safe to embed directly in an
 * artifact filename (the artifact layer re-confines it regardless). The timestamp
 * digits keep an idempotent same-head relaunch distinct from the prior attempt, so
 * two attempts for the same cycle+head never collide on one artifact path. Pure so
 * the id shape is unit-tested away from Electron.
 */
export function reviewerAttemptId(input: ReviewerAttemptIdInput): string {
  const sanitize = (value: string): string => {
    const safe = value.replace(/[^A-Za-z0-9_-]/g, '_');
    return safe.length > 0 ? safe : '_';
  };
  const stamp = input.launchedAt.replace(/[^0-9]/g, '');
  return [
    sanitize(String(input.cycle)),
    sanitize(input.headShaShort),
    sanitize(input.reviewerId),
    sanitize(stamp),
  ].join('-');
}

/** The token a role-signed fallback verdict line must contain (issue #60). */
export const REVIEWER_VERDICT_MARKER = 'GODMODE_REVIEW_VERDICT';

/**
 * The example role-signed fallback verdict line a reviewer posts when a *formal*
 * GitHub review is unavailable (issue #60) — typically a dogfood run where the
 * same authenticated account owns the PR branch, so GitHub refuses same-author
 * approval. The `{{head}}` placeholder is left literal because the reviewer must
 * fill in the PR's current head SHA itself (read from `gh pr view`), tying the
 * verdict to the exact commit under review. Pure so the grammar is unit-tested and
 * stays the single source the parser and prompts agree on.
 */
export function reviewerVerdictExampleLine(reviewerId: string, paneId: AgentRole, prNumber: number): string {
  return `${REVIEWER_VERDICT_MARKER} reviewer=${reviewerId} pane=${paneId} pr=${prNumber} head=<current-head-sha> status=approved blocking=0`;
}

/**
 * The fallback-verdict guidance appended to a reviewer prompt (issue #60). It
 * tells the reviewer to prefer a formal GitHub review, and ONLY when GitHub
 * refuses (e.g. same-account) to post a single role-signed verdict comment for the
 * current head — explicitly framed as harness evidence, not a GitHub-native
 * approval, and distinct from GodMode's automatic marker comment.
 */
function fallbackVerdictBlock(reviewerId: string, paneId: AgentRole, pr: ReviewerPrTarget): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Recording your verdict:');
  lines.push(
    '- Prefer a FORMAL GitHub review (approve / request changes). If GitHub refuses ' +
      'because the same account owns the PR branch (common in dogfooding), fall back to ' +
      'ONE role-signed verdict comment for the CURRENT head:',
  );
  lines.push('');
  lines.push('```text');
  lines.push(reviewerVerdictExampleLine(reviewerId, paneId, pr.number));
  lines.push('```');
  lines.push(
    `- Set head=<current-head-sha> from \`gh pr view ${pr.number} --json headRefOid\` (7- or 40-char), ` +
      'status=approved|blocked, and blocking=<count>. For a blocked verdict, list each blocker as a ' +
      '`BLOCKING ' +
      (paneId === 'reviewer_a' ? 'A' : 'B') +
      '-1:` block (File:/Issue:/Why it blocks:/Suggested fix:) after the verdict line.',
  );
  lines.push(
    '- This verdict comment is role-signed HARNESS evidence for the current head, NOT a ' +
      'GitHub-native approval, and is distinct from GodMode’s automatic marker comment. A ' +
      'stale-head, wrong-PR, malformed, or conflicting verdict is ignored or routed to a human.',
  );
  return lines.join('\n');
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
  paneId: AgentRole,
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
  lines.push(fallbackVerdictBlock(reviewerId, paneId, pr));
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
      ? `${templatePrompt}\n\n${groundingBlock(reviewer.id, displayName, roleDoc, projectName, pr, issueNumber, reviewer.pane)}`
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

/** Statuses a review synthesis can legally run from (reviewers ran this cycle). */
const REVIEW_SYNTHESIS_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'reviewers_running',
  'reviewers_rerunning',
]);

/** Whether a review synthesis is legal from the given run status. */
export function canSynthesizeReviews(status: RunStatus): boolean {
  return REVIEW_SYNTHESIS_STATUSES.has(status);
}

/**
 * Whether a loop- or operator-driven reviewer launch must abort because the run
 * was preempted while its live #9 commit-verification was in flight (issue #39).
 *
 * The launch handler captures the run, then `await`s `getCommitVerification`.
 * Pausing or any manual dispatch during that await advances the run *without*
 * changing its id or operated-project root, so {@link isReviewerRunContextStale}
 * alone would still pass and let the stage spawn reviewer PTYs / write artifacts /
 * transition onto an already-paused or otherwise-preempted run — breaking the
 * operator-authority boundary. Re-reading the live status and refusing the stage
 * when it is no longer a launch-legal status closes that gap. A null status (no
 * current run) is preempted by definition. Pure so the gate is unit-tested.
 */
export function isReviewerLaunchPreempted(liveStatus: RunStatus | null): boolean {
  if (liveStatus === null) return true;
  return !reviewerLaunchTransition(liveStatus).allowed;
}

/**
 * Whether a **loop-driven** reviewer launch must abort after its awaited #9
 * verification (issue #39, blocker B-1). Combines two independent preemption
 * signals:
 *
 *  - `generationStale`: an operator/manual dispatch, pause, or loop-mode toggle
 *    bumped the controller's loop-stage generation while this stage's verification
 *    was in flight (see `captureLoopStageGeneration`/`preemptLoopStages` in
 *    `loop.ts`). This is the authority for loop stages because it catches a manual
 *    dispatch that advanced the run into another **launch-legal** status — e.g.
 *    the operator manually starting reviewers takes `pr_opened → reviewers_running`,
 *    which {@link reviewerLaunchTransition} treats as an idempotent relaunch, so
 *    {@link isReviewerLaunchPreempted} alone returns `false` and would let the
 *    stale loop stage re-install reviewer records, re-prep artifacts, re-spawn
 *    PTYs, and re-transition. A status-only guard cannot distinguish "this loop
 *    stage is still valid" from "the operator already performed the stage."
 *  - {@link isReviewerLaunchPreempted}: the status-legality fallback, so a stop
 *    transition (paused/cancelled/terminal) that did not bump the generation still
 *    aborts the stage.
 *
 * Operator-driven launches pass `generationStale = false` (they hold authority and
 * are never preempted by the generation), reducing this to the plain status guard.
 * Pure so the combined gate is unit-tested without Electron.
 */
export function isLoopReviewerLaunchPreempted(
  liveStatus: RunStatus | null,
  generationStale: boolean,
): boolean {
  return generationStale || isReviewerLaunchPreempted(liveStatus);
}

/**
 * The synthesis-stage analogue of {@link isReviewerLaunchPreempted}: whether a
 * loop- or operator-driven synthesis must abort because the run left the
 * reviewers-running window (paused, cancelled, or otherwise advanced) while its
 * live verification was in flight, so it must not write findings or transition.
 */
export function isReviewSynthesisPreempted(liveStatus: RunStatus | null): boolean {
  if (liveStatus === null) return true;
  return !canSynthesizeReviews(liveStatus);
}

/**
 * The synthesis-stage analogue of {@link isLoopReviewerLaunchPreempted} (issue
 * #39, blocker B-1): a loop-driven synthesis aborts when either its captured
 * loop-stage generation went stale (an operator/manual dispatch preempted it
 * mid-await) or the live status left the reviewers-running window. Operator-driven
 * synthesis passes `generationStale = false`. Pure for unit testing.
 */
export function isLoopReviewSynthesisPreempted(
  liveStatus: RunStatus | null,
  generationStale: boolean,
): boolean {
  return generationStale || isReviewSynthesisPreempted(liveStatus);
}

/**
 * A stable, order-independent identity of a run's tracked reviewer attempts: the
 * set of `<paneId>:<attemptId>` pairs. Every reviewer launch/relaunch mints a
 * fresh `attemptId` (issue #59), so comparing this fingerprint across an `await`
 * proves whether a relaunch replaced the sessions in between. Pure for testing.
 */
export function reviewerAttemptFingerprint(
  reviewers: ReviewerSessionState[] | undefined,
): string {
  if (!reviewers || reviewers.length === 0) return '';
  return reviewers
    .map((session) => `${session.paneId}:${session.attemptId}`)
    .sort()
    .join('|');
}

/**
 * Whether a run's reviewer attempts changed between a captured fingerprint and a
 * later snapshot (issue #59, blocker A-2). Synthesis re-runs the live #9 gate via
 * an `await`; a concurrent operator reviewer relaunch can replace `run.reviewers`
 * during that window without changing the run status (an idempotent relaunch keeps
 * `reviewers_running`), so the status-only preemption guard would wave the stale
 * synthesis through and let it build findings from — and transition over — the
 * freshly relaunched reviewers while they are still running. Comparing attempt
 * fingerprints catches exactly that, for operator- and loop-driven synthesis alike.
 */
export function reviewerAttemptsReplaced(
  capturedFingerprint: string,
  reviewers: ReviewerSessionState[] | undefined,
): boolean {
  return reviewerAttemptFingerprint(reviewers) !== capturedFingerprint;
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

/**
 * Whether the tracked reviewer session for a pane has been replaced since an
 * async marker post captured it. {@link isReviewerRunContextStale} only catches a
 * changed run id or operated-project root, but reviewers relaunch idempotently
 * *within the same run and root* (`reviewers_running`/`reviewers_rerunning`),
 * replacing the tracked sessions under the same pane ids. If an old auto/manual
 * post is in flight when that happens, the run/root guard alone would still let
 * its result patch the freshly relaunched session (e.g. stamp it `comment_posted`
 * with the previous comment URL). Comparing the per-launch `sessionToken` — the
 * value the post captured against the value now tracked for the pane — catches
 * that same-run case. A missing current token (no session, or one tracked before
 * tokens existed) counts as stale. Pure so the post-path guard is unit-tested.
 */
export function isReviewerSessionStale(
  currentToken: string | undefined,
  capturedToken: string,
): boolean {
  return currentToken !== capturedToken;
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
